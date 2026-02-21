import OpenAI from "openai";
import { getCodeDefinition } from "../../lib/code-definition";
import { normalizeCode } from "../../lib/code-parse";
import { extractDtcCodes, lookupDtc, type DtcLookupResult } from "../../lib/dtc-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_OUTPUT_TOKENS = 800; // hard cap to reduce TPM spikes
const MAX_RETRIES = 4;
const MAX_CONCURRENCY = 1; // prevent bursty concurrent requests

type Body = {
  code?: string;
  year?: string;
  make?: string;
  model?: string;
  engine?: string;
  symptoms?: string;
  lang?: string;
};

type CodeDefinitionPayload = {
  code: string;
  title: string;
  description: string;
  source: string | null;
};

/** Strip markdown code fences so we can parse JSON that the model wrapped in ```json ... ``` */
function stripJsonFences(raw: string): string {
  let s = raw.trim();
  const jsonBlock = /^```(?:json)?\s*([\s\S]*?)```\s*$/i;
  const m = s.match(jsonBlock);
  if (m) s = m[1].trim();
  return s;
}

function safeJsonParse(text: string) {
  for (const candidate of [text, stripJsonFences(text)]) {
    try {
      return JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(candidate.slice(start, end + 1));
        } catch {}
      }
    }
  }
  return null;
}

/** Ensure parsed has a valid causes array; normalize items so each has title, why, severity, difficulty, confirm, fix. */
function normalizeParsedResponse(parsed: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== "object") return null;
  let causes = parsed.causes;
  if (!Array.isArray(causes) || causes.length === 0) return null;
  const normalized = causes.map((c: any) => {
    if (!c || typeof c !== "object") return null;
    return {
      title: typeof c.title === "string" ? c.title : "Possible cause",
      why: typeof c.why === "string" ? c.why : "",
      severity: ["high", "medium", "low"].includes(c.severity) ? c.severity : "medium",
      difficulty: typeof c.difficulty === "string" ? c.difficulty : "DIY Moderate",
      confirm: Array.isArray(c.confirm) ? c.confirm.filter((x: unknown) => typeof x === "string") : [],
      fix: Array.isArray(c.fix) ? c.fix.filter((x: unknown) => typeof x === "string") : [],
    };
  }).filter(Boolean);
  if (normalized.length === 0) return null;
  return { ...parsed, causes: normalized };
}

/** Always return JSON (no HTML). */
function jsonResponse(body: object, status: number) {
  return Response.json(body, { status, headers: { "Content-Type": "application/json" } });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitterMs(baseMs: number) {
  const jitter = Math.floor(Math.random() * Math.min(250, Math.max(50, baseMs * 0.1)));
  return baseMs + jitter;
}

function toInt(x: unknown): number | null {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function getRetryAfterMsFromError(err: unknown): number | null {
  const e = err as any;
  const hdrs = e?.headers;
  const ra =
    (typeof hdrs?.get === "function" ? hdrs.get("retry-after") : null) ??
    hdrs?.["retry-after"] ??
    hdrs?.["Retry-After"];
  const seconds = toInt(ra);
  if (seconds !== null && seconds >= 0) return seconds * 1000;
  const raMs =
    (typeof hdrs?.get === "function" ? hdrs.get("retry-after-ms") : null) ??
    hdrs?.["retry-after-ms"] ??
    hdrs?.["Retry-After-Ms"];
  const ms = toInt(raMs);
  if (ms !== null && ms >= 0) return ms;
  return null;
}

function isRateLimit429(err: unknown): boolean {
  const e = err as any;
  return e?.status === 429 || e?.code === "rate_limit_exceeded" || e?.error?.code === "rate_limit_exceeded";
}

function truncate(s: string, maxChars: number) {
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 1)) + "…";
}

class Semaphore {
  private inUse = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.inUse < this.max) {
      this.inUse++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.inUse++;
    return () => this.release();
  }
  private release() {
    this.inUse = Math.max(0, this.inUse - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

const openAiSemaphore = new Semaphore(MAX_CONCURRENCY);

/** Split code input by comma and trim; also support single OEM hex codes. */
function parseCodeInput(raw: string): string[] {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 0) return parts;
  return [raw.trim()].filter(Boolean);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const year = (body.year || "").trim();
    const make = (body.make || "").trim();
    const model = (body.model || "").trim();

    const langMap: Record<string, string> = {
      en: "English",
      es: "Spanish",
      fr: "French",
      ar: "Arabic",
      pt: "Portuguese",
      de: "German",
      zh: "Chinese",
    };
    const outputLanguage = langMap[(body.lang || "en").trim()] || "English";

    if (!year || !make || !model) {
      return jsonResponse({ error: "Year, Make, and Model are required." }, 400);
    }

    const code = (body.code || "").trim();
    const engine = (body.engine || "").trim();
    const symptoms = truncate((body.symptoms || "").trim(), 800);
    const lang = (body.lang || "en").trim();

    if (!code && !symptoms) {
      return jsonResponse({ error: "Enter a trouble code OR describe symptoms." }, 400);
    }

    const vehicleLine = `${year} ${make} ${model}${engine ? ` (${engine})` : ""}`;

    let verifiedDefinitions: CodeDefinitionPayload[] = [];
    let dtcResults: DtcLookupResult[] = [];
    let complaintLine: string;

    if (code) {
      const codes = parseCodeInput(code);
      for (const singleCode of codes) {
        const lookup = await getCodeDefinition(singleCode, make);
        if (lookup.found && lookup.definition) {
          verifiedDefinitions.push({
            code: lookup.definition.code,
            title: lookup.definition.title,
            description: lookup.definition.description,
            source: lookup.definition.source ?? null,
          });
          dtcResults.push({
            code: lookup.definition.code,
            title: lookup.definition.title,
            found: true,
          });
        } else {
          if (lookup.parseType === "oem_hex" && !make) {
            return jsonResponse(
              {
                error: "Manufacturer-specific code requires vehicle make. We do not guess OEM code meanings.",
                code: normalizeCode(singleCode),
                next: "Select your make or paste scan-tool description.",
              },
              400
            );
          }
          if (lookup.parseType === "oem_hex") {
            return jsonResponse(
              {
                error: "Manufacturer-specific code not in our verified database yet.",
                code: normalizeCode(singleCode),
                make: make.trim() || undefined,
              },
              404
            );
          }
          if (lookup.parseType === "obd2") {
            return jsonResponse(
              {
                error: "OBD-II code not in our database. We do not invent code meanings.",
                code: normalizeCode(singleCode),
                next: "Try symptoms or describe the issue.",
              },
              404
            );
          }
          return jsonResponse(
            {
              error: "Unrecognized code format. Use OBD-II (e.g. P0300) or OEM hex (e.g. 480A12) with make.",
              code: singleCode,
              next: "Paste scan-tool description or try symptoms.",
            },
            400
          );
        }
      }

      if (verifiedDefinitions.length > 0) {
        complaintLine = verifiedDefinitions
          .map((d) => `Code: ${d.code} — ${d.title}. Description: ${d.description || ""}`)
          .join("\n");
      } else {
        const extracted = extractDtcCodes(code);
        if (extracted.length > 0) {
          dtcResults = extracted.map(lookupDtc);
          complaintLine = dtcResults.map((r) => `Code: ${r.code} — ${r.title}.`).join("\n");
        } else {
          complaintLine = `Code: ${code}`;
        }
      }
    } else {
      complaintLine = `Symptoms: ${symptoms}`;
    }

    // Budget the definition block to avoid huge prompts (TPM spikes).
    const defsForPrompt = verifiedDefinitions.slice(0, 3).map((d) => ({
      ...d,
      description: truncate(d.description || "", 240),
      title: truncate(d.title || "", 120),
    }));
    const dtcDefinitionsBlock =
      defsForPrompt.length > 0
        ? truncate(
            defsForPrompt.map((d) => `- ${d.code}: ${d.title} — ${d.description}`).join("\n"),
            1200
          )
        : "";

    const hasVerifiedDefinition = defsForPrompt.length > 0;

    const systemBase = [
      "You are an automotive diagnostic assistant.",
      "Respond with a single JSON object only. No markdown, no code fences, no explanation before or after.",
      `All text values MUST be in ${outputLanguage}.`,
      "Give 4–6 likely causes, ranked most→least likely.",
      "Each cause must have unique confirm and fix steps (no repeated generic advice).",
      "Confirm: DIY checks. Fix: practical + safe.",
      "No prices/cost estimates.",
      "severity must be: high | medium | low.",
      `difficulty must be translated into ${outputLanguage}.`,
      "If an authoritative code definition is provided, do NOT redefine it; use it exactly.",
    ].join("\n");

    const definitionInstruction = hasVerifiedDefinition
      ? `Authoritative code definition (do not redefine; use exactly):\n${dtcDefinitionsBlock}\n\nRule: Do not redefine the code. Use the provided definition exactly.\n\n`
      : "";

    const user = [
      `Vehicle: ${vehicleLine}`,
      "",
      definitionInstruction ? definitionInstruction.trimEnd() : "",
      `Complaint / codes:\n${truncate(complaintLine, 2000)}`,
      "",
      "Return JSON with this schema:",
      "{",
      `  "vehicle": "${vehicleLine}",`,
      `  "input": { "code": "${truncate(code, 80)}", "symptoms": "${truncate(symptoms, 200)}" },`,
      '  "causes": [',
      '    { "title": "…", "why": "…", "severity": "high|medium|low", "difficulty": "…", "confirm": ["…"], "fix": ["…"] }',
      "  ]",
      "}",
    ]
      .filter(Boolean)
      .join("\n");

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey?.trim()) {
      return jsonResponse({ error: "OPENAI_API_KEY not set" }, 500);
    }
    const openai = new OpenAI({ apiKey: apiKey.trim() });

    const release = await openAiSemaphore.acquire();
    try {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const system = attempt > 0
            ? systemBase + "\n\nCritical: Your entire response must be exactly one JSON object. Start with { and end with }. No ``` or other formatting."
            : systemBase;
          const resp = await openai.responses.create({
            model: "gpt-4.1-mini",
            input: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature: 0.2,
            max_output_tokens: MAX_OUTPUT_TOKENS,
          });
          const text = resp.output_text || "";
          const rawParsed = safeJsonParse(text);
          const parsed = normalizeParsedResponse(rawParsed as Record<string, unknown> | null);

          if (!parsed || !parsed.causes) {
            if (attempt < MAX_RETRIES) {
              await sleep(jitterMs(400 * (attempt + 1)));
              continue;
            }
            return jsonResponse(
              {
                error: "The diagnosis didn’t come back in the right format. Please try again or add a bit more detail (e.g. when the noise happens, where it seems to come from).",
                debug: text.slice(0, 500),
              },
              500
            );
          }

          if (dtcResults.length > 0) {
            parsed.dtcLookup = dtcResults;
            parsed.summary_title = dtcResults.map((r) => `${r.code}: ${r.title}`).join(" | ");
          }

          if (code && verifiedDefinitions.length > 0) {
            const primary = verifiedDefinitions[0];
            parsed.code_definition = {
              code: primary.code,
              title: primary.title,
              description: primary.description,
              source: primary.source,
            };
            parsed.summary_title = verifiedDefinitions.map((d) => `${d.code}: ${d.title}`).join(" | ");
          }

          return jsonResponse(parsed, 200);
        } catch (err: unknown) {
          lastErr = err;
          if (!isRateLimit429(err) || attempt === MAX_RETRIES) throw err;
          const retryAfter = getRetryAfterMsFromError(err);
          const backoff = retryAfter ?? jitterMs(1000 * Math.pow(2, attempt));
          await sleep(backoff);
        }
      }
      // Should never hit, but keeps TS happy.
      throw lastErr ?? new Error("Rate limited.");
    } finally {
      release();
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Server error.";
    const status = isRateLimit429(e) ? 429 : 500;
    return jsonResponse({ error: message }, status);
  }
}
