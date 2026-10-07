/**
 * Validation for the /api/diagnose request body. Every user-controlled field
 * has a type check and a hard length limit before it can reach a lookup or
 * the AI prompt.
 */

export const SUPPORTED_LANGS = ["en", "es", "fr", "ar", "pt", "de", "zh"] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

export const DIAGNOSE_LIMITS = {
  make: 60,
  model: 60,
  engine: 100,
  code: 120,
  symptoms: 800,
  maxCodes: 8,
  minYear: 1900,
} as const;

export type DiagnoseInput = {
  year: string;
  make: string;
  model: string;
  engine: string;
  code: string;
  symptoms: string;
  lang: SupportedLang;
};

export type DiagnoseParseResult =
  | { ok: true; value: DiagnoseInput }
  | { ok: false; error: string; field?: keyof DiagnoseInput | "body" };

/** Characters that have no place in a vehicle field and could break prompt structure. */
const STRUCTURAL_CHARS = /["\\`<>{}]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

function cleanLine(value: string): string {
  return value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

function cleanVehicleField(value: string): string {
  return cleanLine(value.replace(STRUCTURAL_CHARS, " "));
}

function readString(
  body: Record<string, unknown>,
  key: string,
  label: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const raw = body[key];
  if (raw === undefined || raw === null) return { ok: true, value: "" };
  if (typeof raw === "number" && Number.isFinite(raw)) return { ok: true, value: String(raw) };
  if (typeof raw !== "string") return { ok: false, error: `${label} must be text.` };
  return { ok: true, value: raw };
}

export function parseDiagnoseBody(raw: unknown, now: Date = new Date()): DiagnoseParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Invalid request.", field: "body" };
  }
  const body = raw as Record<string, unknown>;

  const fields = {
    year: readString(body, "year", "Year"),
    make: readString(body, "make", "Make"),
    model: readString(body, "model", "Model"),
    engine: readString(body, "engine", "Engine"),
    code: readString(body, "code", "Trouble code"),
    symptoms: readString(body, "symptoms", "Symptoms"),
    lang: readString(body, "lang", "Language"),
  };
  for (const [name, r] of Object.entries(fields)) {
    if (!r.ok) return { ok: false, error: r.error, field: name as keyof DiagnoseInput };
  }
  const get = (k: keyof typeof fields) => (fields[k] as { ok: true; value: string }).value;

  // Year: exactly four digits, in a sane range.
  const year = cleanLine(get("year"));
  const maxYear = now.getFullYear() + 2;
  if (!year || !get("make").trim() || !get("model").trim()) {
    return { ok: false, error: "Year, Make, and Model are required.", field: "year" };
  }
  if (!/^\d{4}$/.test(year) || Number(year) < DIAGNOSE_LIMITS.minYear || Number(year) > maxYear) {
    return { ok: false, error: `Vehicle year must be a 4-digit year between ${DIAGNOSE_LIMITS.minYear} and ${maxYear}.`, field: "year" };
  }

  // Lengths are checked on the raw text so over-long input is rejected, not trimmed.
  if (get("make").length > DIAGNOSE_LIMITS.make) {
    return { ok: false, error: `Make is too long (max ${DIAGNOSE_LIMITS.make} characters).`, field: "make" };
  }
  if (get("model").length > DIAGNOSE_LIMITS.model) {
    return { ok: false, error: `Model is too long (max ${DIAGNOSE_LIMITS.model} characters).`, field: "model" };
  }
  if (get("engine").length > DIAGNOSE_LIMITS.engine) {
    return { ok: false, error: `Engine is too long (max ${DIAGNOSE_LIMITS.engine} characters).`, field: "engine" };
  }
  if (get("code").length > DIAGNOSE_LIMITS.code) {
    return { ok: false, error: `Trouble codes are too long (max ${DIAGNOSE_LIMITS.code} characters).`, field: "code" };
  }
  if (get("symptoms").trim().length > DIAGNOSE_LIMITS.symptoms) {
    return { ok: false, error: `Symptoms are too long (max ${DIAGNOSE_LIMITS.symptoms} characters).`, field: "symptoms" };
  }

  const make = cleanVehicleField(get("make"));
  const model = cleanVehicleField(get("model"));
  const engine = cleanVehicleField(get("engine"));
  if (!make || !model) {
    return { ok: false, error: "Year, Make, and Model are required.", field: "make" };
  }

  // Codes: letters, digits and separators only. ";" and new lines count as commas.
  const codeRaw = get("code").replace(/[;\r\n]+/g, ",");
  const code = cleanLine(codeRaw)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .join(", ");
  if (code && !/^[A-Za-z0-9 ,-]+$/.test(code)) {
    return { ok: false, error: "Trouble codes can only contain letters, numbers, commas and dashes.", field: "code" };
  }
  if (code && code.split(",").length > DIAGNOSE_LIMITS.maxCodes) {
    return { ok: false, error: `Enter at most ${DIAGNOSE_LIMITS.maxCodes} trouble codes at a time.`, field: "code" };
  }

  const symptoms = cleanLine(get("symptoms"));
  if (!code && !symptoms) {
    return { ok: false, error: "Enter a trouble code OR describe symptoms.", field: "code" };
  }

  const langRaw = cleanLine(get("lang")).toLowerCase();
  const lang = (SUPPORTED_LANGS as readonly string[]).includes(langRaw) ? (langRaw as SupportedLang) : "en";

  return { ok: true, value: { year, make, model, engine, code, symptoms, lang } };
}
