import OpenAI from "openai";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Body = {
  code?: string;
  year?: string;
  make?: string;
  model?: string;
  engine?: string;
  symptoms?: string;
  lang?: string;
};

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    // Try to extract JSON if model wrapped it
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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const year = (body.year || "").trim();
    const make = (body.make || "").trim();
    const model = (body.model || "").trim();

    if (!year || !make || !model) {
      return Response.json(
        { error: "Year, Make, and Model are required." },
        { status: 400 }
      );
    }

    const code = (body.code || "").trim();
    const engine = (body.engine || "").trim();
    const symptoms = (body.symptoms || "").trim();
    const lang = (body.lang || "en").trim();

    if (!code && !symptoms) {
      return Response.json(
        { error: "Enter a trouble code OR describe symptoms." },
        { status: 400 }
      );
    }

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
    const complaintLine = code
      ? `OBD-II code: ${code}`
      : `Symptoms: ${symptoms}`;

    const system = `
You are an automotive diagnostic assistant.
Return ONLY valid JSON. No markdown, no backticks, no extra text.
IMPORTANT: All text values in the JSON (summary_title, title, why, confirm steps, fix steps, difficulty) MUST be written in ${outputLanguage}.

Rules:
- Provide 4–6 likely causes, ranked from most to least likely.
- Each cause must have UNIQUE confirm steps and fix steps tailored to that cause (avoid repeating generic advice).
- Confirm steps should be things a DIY person can do.
- Fix steps should be practical and safe.
- Keep each bullet short (1 line).
- For severity: use "high" (most likely cause), "medium" (possible cause), or "low" (less likely).
- Do NOT include any prices or cost estimates.
- For difficulty: use "DIY Easy" (anyone can do it), "DIY Moderate" (needs some tools/knowledge), or "Mechanic Recommended" (professional needed). Translate the difficulty label into ${outputLanguage}.
`;

    const user = `
Vehicle: ${vehicleLine}
${complaintLine}

Output JSON in this exact schema (all text values in ${outputLanguage}):
{
  "vehicle": "${vehicleLine}",
  "input": { "code": "${code}", "symptoms": "${symptoms}" },
  "summary_title": "string (A concise title describing the issue in ${outputLanguage})",
  "causes": [
    {
      "title": "string",
      "why": "string (1 sentence)",
      "severity": "high | medium | low",
      "difficulty": "string (translated to ${outputLanguage})",
      "confirm": ["string","string","string"],
      "fix": ["string","string","string"]
    }
  ]
}
`;

    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // make it more consistent about JSON
      temperature: 0.2,
    });

    const text = resp.output_text || "";
    const parsed = safeJsonParse(text);

    if (!parsed || !parsed.causes) {
      return Response.json(
        {
          error:
            "AI returned unexpected format. Try again with more symptoms.",
          debug: text.slice(0, 500),
        },
        { status: 500 }
      );
    }

    return Response.json(parsed, { status: 200 });
  } catch (e: any) {
    return Response.json(
      { error: e?.message || "Server error." },
      { status: 500 }
    );
  }
}
