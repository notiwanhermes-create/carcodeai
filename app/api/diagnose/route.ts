import OpenAI from "openai";
import { getCodeDefinition } from "../../lib/code-definition";
import { normalizeCode } from "../../lib/code-parse";
import { extractDtcCodes, lookupDtc, type DtcLookupResult } from "../../lib/dtc-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {}
    }
    return null;
  }
}

/** Always return JSON (no HTML). */
function jsonResponse(body: object, status: number) {
  return Response.json(body, { status, headers: { "Content-Type": "application/json" } });
}

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
    const symptoms = (body.symptoms || "").trim();
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
                next: "Try symptoms or check our /codes page.",
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

    const dtcDefinitionsBlock =
      verifiedDefinitions.length > 0
        ? verifiedDefinitions
            .map((d) => `- ${d.code}: ${d.title} (${d.description || ""})`)
            .join("\n")
        : "";

    const hasVerifiedDefinition = verifiedDefinitions.length > 0;

    const system = `
You are an automotive diagnostic assistant.
Return ONLY valid JSON. No markdown, no backticks, no extra text.
IMPORTANT: All text values in the JSON (title, why, confirm steps, fix steps, difficulty) MUST be written in ${outputLanguage}.

Rules:
- Provide 4–6 likely causes, ranked from most to least likely.
- Each cause must have UNIQUE confirm steps and fix steps tailored to that cause (avoid repeating generic advice).
- Confirm steps should be things a DIY person can do.
- Fix steps should be practical and safe.
- Keep each bullet short (1 line).
- For severity: use "high" (most likely cause), "medium" (possible cause), or "low" (less likely).
- Do NOT include any prices or cost estimates.
- For difficulty: use "DIY Easy" (anyone can do it), "DIY Moderate" (needs some tools/knowledge), or "Mechanic Recommended" (professional needed). Translate the difficulty label into ${outputLanguage}.
- Do not redefine the code. Use the provided definition exactly. If a code definition is provided above, you MUST use it exactly and MUST NOT invent or replace the meaning. Your job is only to suggest likely causes, confirmation steps, and fixes.
`;

    const definitionInstruction = hasVerifiedDefinition
      ? `Authoritative code definition (do not redefine; use exactly):\n${dtcDefinitionsBlock}\n\nRule: Do not redefine the code. Use the provided definition exactly.\n\n`
      : "";

    const user = `
Vehicle: ${vehicleLine}

${definitionInstruction}Complaint / codes:\n${complaintLine}

Output JSON in this exact schema (all text values in ${outputLanguage}):
{
  "vehicle": "${vehicleLine}",
  "input": { "code": "${code}", "symptoms": "${symptoms}" },
  "causes": [
    {
      "title": "string (name of the likely cause, e.g. 'Worn Spark Plugs')",
      "why": "string (1 sentence explaining why this cause is likely)",
      "severity": "high | medium | low",
      "difficulty": "string (translated to ${outputLanguage})",
      "confirm": ["string","string","string"],
      "fix": ["string","string","string"]
    }
  ]
}
`;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey?.trim()) {
      return jsonResponse({ error: "OPENAI_API_KEY not set" }, 500);
    }
    const openai = new OpenAI({ apiKey: apiKey.trim() });

    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    });

    const text = resp.output_text || "";
    const parsed = safeJsonParse(text);

    if (!parsed || !parsed.causes) {
      return jsonResponse(
        {
          error: "AI returned unexpected format. Try again with more symptoms.",
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
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Server error.";
    return jsonResponse({ error: message }, 500);
  }
}
