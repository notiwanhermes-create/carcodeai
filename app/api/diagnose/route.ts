import OpenAI from "openai";
import { describeCodesForPrompt, hasDefinitionOnFile, lookupCodes, type DtcResult } from "../../lib/dtc";
import { parseDiagnoseBody } from "../../lib/diagnose-input";
import { checkBurst, consumeDiagnosisQuota, diagnoseLimits, type DiagnoseCaller } from "../../lib/diagnose-guard";
import { clientIpKey } from "../../lib/client-ip";
import { readJsonBody } from "../../lib/http";
import { auth } from "../../lib/auth-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_OUTPUT_TOKENS = 800; // hard cap to reduce TPM spikes
const MAX_RETRIES = 4;
const MAX_CONCURRENCY = 1; // prevent bursty concurrent requests

/** Messages that are safe to show to anyone. Internal details are only ever logged. */
const GENERIC_UNAVAILABLE = "Diagnosis is temporarily unavailable. Please try again in a moment.";
const GENERIC_BAD_RESULT =
  "We couldn't complete that diagnosis. Please try again, or add a bit more detail (e.g. when it happens, where it seems to come from).";

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
  const causes = parsed.causes;
  if (!Array.isArray(causes) || causes.length === 0) return null;
  const normalized = causes.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") return null;
    const c = raw as Record<string, unknown>;
    return {
      title: typeof c.title === "string" ? c.title : "Possible cause",
      why: typeof c.why === "string" ? c.why : "",
      severity: typeof c.severity === "string" && ["high", "medium", "low"].includes(c.severity) ? c.severity : "medium",
      difficulty: typeof c.difficulty === "string" ? c.difficulty : "DIY Moderate",
      confirm: Array.isArray(c.confirm) ? c.confirm.filter((x: unknown) => typeof x === "string") : [],
      fix: Array.isArray(c.fix) ? c.fix.filter((x: unknown) => typeof x === "string") : [],
    };
  }).filter(Boolean);
  if (normalized.length === 0) return null;
  return { ...parsed, causes: normalized };
}

/** Always return JSON (no HTML). */
function jsonResponse(body: object, status: number, extraHeaders?: Record<string, string>) {
  return Response.json(body, {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

/** Signed-in user id, or null. Never throws: an auth hiccup just means "guest". */
async function getSignedInUserId(): Promise<string | null> {
  try {
    const session = await auth();
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
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

type HeaderBag = { get?: (name: string) => string | null } & Record<string, unknown>;

function getRetryAfterMsFromError(err: unknown): number | null {
  const e = err as { headers?: HeaderBag } | null;
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
  const e = err as { status?: number; code?: string; error?: { code?: string } } | null;
  return e?.status === 429 || e?.code === "rate_limit_exceeded" || e?.error?.code === "rate_limit_exceeded";
}

/** Extract plain text from OpenAI Responses API result (handles output_text or output[] items). */
function getResponseText(resp: { output_text?: string | null; output?: unknown[] }): string {
  if (typeof resp.output_text === "string" && resp.output_text.trim()) return resp.output_text.trim();
  if (Array.isArray(resp.output)) {
    const parts: string[] = [];
    for (const item of resp.output) {
      const o = item as { type?: string; content?: unknown };
      if (o?.type === "message" && Array.isArray(o.content)) {
        for (const block of o.content) {
          const b = block as { type?: string; text?: string };
          if (b?.type === "output_text" && typeof b.text === "string") parts.push(b.text);
        }
      }
    }
    if (parts.length > 0) return parts.join("\n").trim();
  }
  return "";
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

export async function POST(req: Request) {
  try {
    const limits = diagnoseLimits();
    const caller: DiagnoseCaller = { ipKey: clientIpKey(req), userId: await getSignedInUserId() };

    // 1) Flood protection: every request from an IP counts, valid or not.
    const burst = await checkBurst(caller);
    if (!burst.allowed) {
      return jsonResponse({ error: burst.error, code: burst.code }, burst.status, {
        "Retry-After": String(burst.retryAfterSeconds),
      });
    }

    // 2) Size-capped JSON body, then strict validation of every field.
    const rawBody = await readJsonBody(req, limits.maxBodyBytes);
    if (!rawBody.ok) {
      return jsonResponse({ error: rawBody.error, code: rawBody.code }, rawBody.status);
    }
    const parsedBody = parseDiagnoseBody(rawBody.data);
    if (!parsedBody.ok) {
      return jsonResponse({ error: parsedBody.error, code: "invalid_request", field: parsedBody.field }, 400);
    }
    const { year, make, model, engine, code, symptoms, lang } = parsedBody.value;

    const langMap: Record<string, string> = {
      en: "English",
      es: "Spanish",
      fr: "French",
      ar: "Arabic",
      pt: "Portuguese",
      de: "German",
      zh: "Chinese",
    };
    const outputLanguage = langMap[lang] || "English";

    const vehicleLine = `${year} ${make} ${model}${engine ? ` (${engine})` : ""}`;

    // Every code the user entered gets an explicit result. Nothing is guessed,
    // and one bad code never fails the whole request.
    const codeResults: DtcResult[] = code ? lookupCodes(code, make) : [];
    const definedCodes = codeResults.filter(hasDefinitionOnFile);

    // Nothing to reason from: no code has a definition on file (standard code we
    // can't vouch for, manufacturer-specific code, or not a code at all) and there
    // are no symptoms. Say so instead of asking the model to guess what the code
    // means. No AI call is made and no quota is used.
    if (codeResults.length > 0 && definedCodes.length === 0 && !symptoms) {
      const recognised = codeResults.filter((r) => r.status !== "invalid");
      let message: string;
      if (recognised.length === 0) {
        message = "We couldn't recognise that as a trouble code. Check it and try again, or describe the symptoms instead.";
      } else if (recognised.every((r) => r.status === "manufacturer_unavailable")) {
        message =
          "This code is manufacturer-specific and CarCode AI does not currently have a verified definition for this vehicle. Describe the symptoms as well and we can still help narrow it down.";
      } else {
        message = `CarCode AI does not have a verified definition for ${recognised.length === 1 ? "this code" : "these codes"} yet, so we won't guess what ${recognised.length === 1 ? "it means" : "they mean"}. Describe the symptoms as well and we can still help narrow it down.`;
      }
      return jsonResponse({ noDefinition: true, codes: codeResults, message }, 200);
    }

    const complaintParts: string[] = [];
    if (codeResults.length > 0) {
      complaintParts.push(["Trouble codes (follow the note on each code exactly):", describeCodesForPrompt(codeResults, make)].join("\n"));
    }
    if (symptoms) complaintParts.push(`Symptoms: ${symptoms}`);
    const complaintLine = complaintParts.join("\n\n");

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
      "Never state, guess or imply the definition of a trouble code unless that definition is given to you below. Follow the note attached to each code exactly.",
    ].join("\n");

    const user = [
      `Vehicle: ${vehicleLine}`,
      "",
      `Complaint:\n${truncate(complaintLine, 2600)}`,
      "",
      "Return JSON with this schema:",
      "{",
      // JSON.stringify keeps this example valid even when the user typed quotes.
      `  "vehicle": ${JSON.stringify(vehicleLine)},`,
      `  "input": { "code": ${JSON.stringify(truncate(code, 80))}, "symptoms": ${JSON.stringify(truncate(symptoms, 200))} },`,
      '  "causes": [',
      '    { "title": "…", "why": "…", "severity": "high|medium|low", "difficulty": "…", "confirm": ["…"], "fix": ["…"] }',
      "  ]",
      "}",
    ]
      .filter(Boolean)
      .join("\n");

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey?.trim()) {
      console.error("[POST /api/diagnose] OPENAI_API_KEY is not set");
      return jsonResponse({ error: GENERIC_UNAVAILABLE, code: "service_unavailable" }, 503);
    }

    // 3) Usage allowance. Counted only now, when the request will reach the AI model.
    const quota = await consumeDiagnosisQuota(caller);
    if (!quota.allowed) {
      return jsonResponse({ error: quota.error, code: quota.code }, quota.status, {
        "Retry-After": String(quota.retryAfterSeconds),
      });
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
          const text = getResponseText(resp as { output_text?: string | null; output?: unknown[] });
          const rawParsed = safeJsonParse(text);
          const parsed = normalizeParsedResponse(rawParsed as Record<string, unknown> | null);

          if (!parsed || !parsed.causes) {
            if (attempt < MAX_RETRIES) {
              await sleep(jitterMs(400 * (attempt + 1)));
              continue;
            }
            console.error("[POST /api/diagnose] model output could not be parsed after retries; length:", text.length);
            return jsonResponse({ error: GENERIC_BAD_RESULT, code: "bad_result" }, 502);
          }

          if (codeResults.length > 0) {
            parsed.codes = codeResults;
            const defined = codeResults.filter((r) => r.definition);
            if (defined.length > 0) parsed.summary_title = defined.map((r) => `${r.code}: ${r.definition}`).join(" | ");
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
    // The real cause goes to the server log only (Vercel logs). The browser
    // gets a generic message: no provider errors, keys, or stack details.
    const message = e instanceof Error ? e.message : String(e);
    console.error("[POST /api/diagnose]", e instanceof Error ? e.name : "Error", message);
    if (isRateLimit429(e)) {
      return jsonResponse(
        { error: "CarCode AI is very busy right now. Please try again in a minute.", code: "busy" },
        503,
        { "Retry-After": "30" },
      );
    }
    return jsonResponse({ error: GENERIC_UNAVAILABLE, code: "service_unavailable" }, 503);
  }
}
