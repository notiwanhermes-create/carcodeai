/**
 * Validation for the /api/diagnose request body. Every user-controlled field
 * has a type check and a hard length limit before it can reach a lookup or
 * the AI prompt.
 */
import { parseCodeInput } from "./dtc";
import { isValidVinFormat, normalizeVin } from "./vin";

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
  maxMileage: 2_000_000,
  followUps: 6,
  followUpQuestion: 240,
  followUpAnswer: 240,
  diagnosisToken: 600,
} as const;

/** An answer the user gave to a follow-up question from an earlier diagnosis. */
export type FollowUpAnswer = { question: string; answer: string };

export type DiagnoseInput = {
  year: string;
  make: string;
  model: string;
  engine: string;
  code: string;
  symptoms: string;
  lang: SupportedLang;
  /** A well-formed 17-character VIN, or "". Used only to look up vehicle details; never sent to the AI model. */
  vin: string;
  mileage: { value: number; unit: "km" | "mi" } | null;
  followUps: FollowUpAnswer[];
  /** The ticket issued with the diagnosis these follow-up answers belong to, or "". Checked by the route. */
  diagnosisToken: string;
  /**
   * The garage vehicle this diagnosis is for, or "". Only used to save the
   * result to a signed-in user's history; the route checks the user owns it.
   * It is never sent to the AI model.
   */
  vehicleId: string;
};

export type DiagnoseParseResult =
  | { ok: true; value: DiagnoseInput }
  | { ok: false; error: string; field?: keyof DiagnoseInput | "body" };

function parseMileage(body: Record<string, unknown>): { ok: true; value: DiagnoseInput["mileage"] } | { ok: false } {
  const raw = body.mileage;
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "number" && typeof raw !== "string") return { ok: false };
  const text = String(raw).replace(/[,\s]/g, "");
  if (!/^\d{1,7}$/.test(text)) return { ok: false };
  const value = Number(text);
  if (value < 1 || value > DIAGNOSE_LIMITS.maxMileage) return { ok: false };
  return { ok: true, value: { value, unit: body.mileageUnit === "mi" ? "mi" : "km" } };
}

function parseFollowUps(body: Record<string, unknown>): { ok: true; value: FollowUpAnswer[] } | { ok: false; error: string } {
  const raw = body.followUps;
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "Follow-up answers must be a list." };
  if (raw.length > DIAGNOSE_LIMITS.followUps) {
    return { ok: false, error: `Send at most ${DIAGNOSE_LIMITS.followUps} follow-up answers.` };
  }
  const value: FollowUpAnswer[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, error: "Follow-up answers must be question and answer text." };
    const { question, answer } = item as Record<string, unknown>;
    if (typeof question !== "string" || typeof answer !== "string") {
      return { ok: false, error: "Follow-up answers must be question and answer text." };
    }
    if (question.length > DIAGNOSE_LIMITS.followUpQuestion || answer.length > DIAGNOSE_LIMITS.followUpAnswer) {
      return { ok: false, error: `Follow-up answers are too long (max ${DIAGNOSE_LIMITS.followUpAnswer} characters each).` };
    }
    const q = cleanLine(question);
    const a = cleanLine(answer);
    if (q && a) value.push({ question: q, answer: a });
  }
  return { ok: true, value };
}

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

  // Codes: letters and digits, separated by spaces, commas, semicolons or new lines.
  const codeText = get("code");
  if (codeText.trim() && !/^[A-Za-z0-9\s,;.-]+$/.test(codeText)) {
    return { ok: false, error: "Trouble codes can only contain letters, numbers, spaces, commas and dashes.", field: "code" };
  }
  const codeList = parseCodeInput(codeText);
  if (codeList.length > DIAGNOSE_LIMITS.maxCodes) {
    return { ok: false, error: `Enter at most ${DIAGNOSE_LIMITS.maxCodes} trouble codes at a time.`, field: "code" };
  }
  const code = codeList.join(", ");

  const symptoms = cleanLine(get("symptoms"));
  if (!code && !symptoms) {
    return { ok: false, error: "Enter a trouble code OR describe symptoms.", field: "code" };
  }

  const langRaw = cleanLine(get("lang")).toLowerCase();
  const lang = (SUPPORTED_LANGS as readonly string[]).includes(langRaw) ? (langRaw as SupportedLang) : "en";

  // Optional context. A malformed VIN is ignored rather than failing the request:
  // it only ever adds detail, and older saved vehicles may carry odd values.
  const vinRaw = body.vin;
  if (vinRaw !== undefined && vinRaw !== null && typeof vinRaw !== "string") {
    return { ok: false, error: "VIN must be text.", field: "vin" };
  }
  const vinText = normalizeVin(typeof vinRaw === "string" ? vinRaw.slice(0, 40) : "");
  const vin = isValidVinFormat(vinText) ? vinText : "";

  const mileage = parseMileage(body);
  if (!mileage.ok) {
    return { ok: false, error: `Mileage must be a whole number between 1 and ${DIAGNOSE_LIMITS.maxMileage.toLocaleString("en-US")}.`, field: "mileage" };
  }

  const followUps = parseFollowUps(body);
  if (!followUps.ok) return { ok: false, error: followUps.error, field: "followUps" };

  const tokenRaw = body.diagnosisToken;
  if (tokenRaw !== undefined && tokenRaw !== null && (typeof tokenRaw !== "string" || tokenRaw.length > DIAGNOSE_LIMITS.diagnosisToken)) {
    return { ok: false, error: "Invalid request.", field: "diagnosisToken" };
  }
  const diagnosisToken = typeof tokenRaw === "string" ? tokenRaw.trim() : "";

  // Optional, and never a reason to refuse a diagnosis: anything odd just means "not saved".
  const vehicleRaw = body.vehicleId;
  const vehicleId = typeof vehicleRaw === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(vehicleRaw.trim()) ? vehicleRaw.trim() : "";

  return {
    ok: true,
    value: { year, make, model, engine, code, symptoms, lang, vin, mileage: mileage.value, followUps: followUps.value, diagnosisToken, vehicleId },
  };
}
