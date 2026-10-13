/**
 * Copying what a device holds into an account: the request the browser sends,
 * checked field by field. Pure functions: no database, no network.
 *
 * Everything here comes from browser storage, so nothing is trusted: each
 * field must be the right type and within its limit, or the request is refused.
 */
import { isOdometerUnit, parseOdometerValue, type OdometerUnit } from "./odometer";
import type { FollowUpAnswer, LegacyCause } from "./garage-types";

export const IMPORT_LIMITS = {
  vehicles: 20,
  maintenancePerVehicle: 200,
  diagnosesPerVehicle: 50,
  causes: 8,
  listItems: 8,
  followUps: 12,
  shortText: 300,
  /** The one-line label older versions kept: "Code: ... | Symptoms: ...". */
  issueText: 1000,
  listText: 500,
  symptoms: 2000,
  notes: 2000,
} as const;

export type ImportMaintenance = {
  type: string;
  date: string;
  odometerValue: number | null;
  odometerUnit: OdometerUnit | null;
  notes: string;
};

export type ImportDiagnosis = {
  /** The id the record had on the device. Stops a second import creating it again. */
  key: string;
  at: Date;
  codeInput: string;
  symptoms: string;
  issueText: string;
  vehicle: { year: string; make: string; model: string; engine: string };
  followUps: FollowUpAnswer[];
  causes: LegacyCause[];
  /** A repair the user had marked as the fix on the device, if any. */
  confirmedFix: { title: string; fix: string; causeIndex: number | null } | null;
};

export type ImportVehicle = {
  clientId: string;
  /** Set when the history belongs to a vehicle that is already in the account. */
  existingVehicleId: string | null;
  year: string;
  make: string;
  model: string;
  engine: string;
  vin: string;
  nickname: string;
  maintenance: ImportMaintenance[];
  diagnoses: ImportDiagnosis[];
};

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A trimmed string no longer than `max`, or null if it is not text or is too long. Missing means "". */
function text(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).replace(CONTROL_CHARS, " ").trim();
  return s.length > max ? null : s;
}

function textList(v: unknown, maxItems: number, maxLength: number): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v.slice(0, maxItems)) {
    const s = text(item, maxLength);
    if (s === null) return null;
    if (s) out.push(s);
  }
  return out;
}

function parseMaintenance(raw: unknown): Parsed<ImportMaintenance> {
  if (!isRecord(raw)) return fail("A service record is not valid.");
  const type = text(raw.type, 80);
  const date = text(raw.date, 40);
  const notes = text(raw.notes, IMPORT_LIMITS.notes);
  if (!type || !date || notes === null) return fail("A service record is missing its type or date, or a field is too long.");
  let odometerValue: number | null = null;
  if (raw.odometerValue !== undefined && raw.odometerValue !== null && raw.odometerValue !== "") {
    odometerValue = parseOdometerValue(typeof raw.odometerValue === "number" ? Math.round(raw.odometerValue) : raw.odometerValue);
    if (odometerValue === null) return fail("A service record has an odometer reading that is not a whole number.");
  }
  const odometerUnit = isOdometerUnit(raw.odometerUnit) ? raw.odometerUnit : null;
  return { ok: true, value: { type, date, odometerValue, odometerUnit: odometerValue === null ? null : odometerUnit, notes } };
}

/**
 * Older device records kept what the user entered as one line, in this app's own
 * format: "Code: P0300 | Symptoms: rough idle". Split it back into its two parts.
 * Text in any other shape is what the user described, so it is kept as symptoms.
 */
export function splitIssueText(issueText: string): { code: string; symptoms: string } {
  const line = issueText.trim();
  if (!line || line === "Diagnosis") return { code: "", symptoms: "" };
  const CODE = "Code: ";
  const SYMPTOMS = "Symptoms: ";
  if (line.startsWith(CODE)) {
    const rest = line.slice(CODE.length);
    const cut = rest.indexOf(` | ${SYMPTOMS}`);
    const code = (cut === -1 ? rest : rest.slice(0, cut)).trim();
    // A "code" longer than the code box ever allowed is not this app's format.
    if (code.length <= 120) return { code, symptoms: cut === -1 ? "" : rest.slice(cut + 3 + SYMPTOMS.length).trim() };
  }
  if (line.startsWith(SYMPTOMS)) return { code: "", symptoms: line.slice(SYMPTOMS.length).trim() };
  return { code: "", symptoms: line };
}

function parseDiagnosis(raw: unknown): Parsed<ImportDiagnosis> {
  if (!isRecord(raw)) return fail("A saved diagnosis is not valid.");
  const key = text(raw.key, 80);
  if (!key) return fail("A saved diagnosis has no id.");
  let codeInput = text(raw.code, 120);
  let symptoms = text(raw.symptoms, IMPORT_LIMITS.symptoms);
  const issueText = text(raw.issueText, IMPORT_LIMITS.issueText);
  if (codeInput === null || symptoms === null || issueText === null) return fail("A saved diagnosis has a field that is too long.");
  if (!codeInput && !symptoms && issueText) {
    const parts = splitIssueText(issueText);
    codeInput = parts.code;
    symptoms = parts.symptoms;
  }

  const at = typeof raw.at === "string" ? new Date(raw.at) : new Date(NaN);
  const now = Date.now();
  // A missing, unreadable or future date becomes "now": the import time is the best fact available.
  const when = Number.isNaN(at.getTime()) || at.getTime() > now + 86_400_000 || at.getTime() < Date.UTC(2020, 0, 1) ? new Date(now) : at;

  const v = isRecord(raw.vehicle) ? raw.vehicle : {};
  const year = text(v.year, 4);
  const make = text(v.make, 60);
  const model = text(v.model, 60);
  const engine = text(v.engine, 100);
  if (year === null || make === null || model === null || engine === null) return fail("A saved diagnosis has vehicle details that are too long.");

  if (!Array.isArray(raw.causes) || raw.causes.length === 0) return fail("A saved diagnosis has no causes.");
  const causes: LegacyCause[] = [];
  for (const c of raw.causes.slice(0, IMPORT_LIMITS.causes)) {
    if (!isRecord(c)) return fail("A saved diagnosis has a cause that is not valid.");
    const title = text(c.title, 200);
    const why = textList(c.why, IMPORT_LIMITS.listItems, IMPORT_LIMITS.listText);
    const checks = textList(c.checks, IMPORT_LIMITS.listItems, IMPORT_LIMITS.listText);
    const fix = textList(c.fix, IMPORT_LIMITS.listItems, IMPORT_LIMITS.listText);
    if (!title || why === null || checks === null || fix === null) return fail("A saved diagnosis has a cause that is not valid.");
    causes.push({ title, why, checks, fix });
  }

  const followUps: FollowUpAnswer[] = [];
  if (Array.isArray(raw.followUps)) {
    for (const f of raw.followUps.slice(0, IMPORT_LIMITS.followUps)) {
      if (!isRecord(f)) continue;
      const question = text(f.question, IMPORT_LIMITS.shortText);
      const answer = text(f.answer, IMPORT_LIMITS.shortText);
      if (question && answer) followUps.push({ question, answer });
    }
  }

  let confirmedFix: ImportDiagnosis["confirmedFix"] = null;
  if (isRecord(raw.confirmedFix)) {
    const title = text(raw.confirmedFix.title, 200);
    const fix = text(raw.confirmedFix.fix, IMPORT_LIMITS.listText);
    if (title) {
      const index = causes.findIndex((c) => c.title === title);
      confirmedFix = { title, fix: fix || "", causeIndex: index >= 0 ? index : null };
    }
  }

  return {
    ok: true,
    value: { key, at: when, codeInput, symptoms, issueText: issueText || "", vehicle: { year: year || "", make: make || "", model: model || "", engine: engine || "" }, followUps, causes, confirmedFix },
  };
}

/** Check a whole import request. One bad field refuses the request, so nothing is half-understood. */
export function parseImportPayload(raw: unknown): Parsed<ImportVehicle[]> {
  if (!isRecord(raw) || !Array.isArray(raw.vehicles)) return fail("Invalid request.");
  if (raw.vehicles.length === 0) return fail("There is nothing to import.");
  if (raw.vehicles.length > IMPORT_LIMITS.vehicles) return fail(`Import at most ${IMPORT_LIMITS.vehicles} vehicles at a time.`);

  const vehicles: ImportVehicle[] = [];
  const seen = new Set<string>();
  for (const entry of raw.vehicles) {
    if (!isRecord(entry)) return fail("A vehicle is not valid.");
    const clientId = text(entry.clientId, 80);
    if (!clientId || seen.has(clientId)) return fail("A vehicle is missing its id, or the same vehicle is listed twice.");
    seen.add(clientId);

    const existingVehicleId = text(entry.existingVehicleId, 64);
    if (existingVehicleId === null) return fail("A vehicle is not valid.");

    const year = text(entry.year, 4);
    const make = text(entry.make, 60);
    const model = text(entry.model, 60);
    const engine = text(entry.engine, 100);
    const vin = text(entry.vin, 17);
    const nickname = text(entry.nickname, 60);
    if (year === null || make === null || model === null || engine === null || vin === null || nickname === null) {
      return fail("A vehicle has details that are too long.");
    }
    if (!existingVehicleId && (!/^\d{4}$/.test(year) || !make || !model)) {
      return fail("A vehicle needs a 4-digit year, a make and a model.");
    }

    const maintenanceRaw = Array.isArray(entry.maintenance) ? entry.maintenance : [];
    const diagnosesRaw = Array.isArray(entry.diagnoses) ? entry.diagnoses : [];
    if (maintenanceRaw.length > IMPORT_LIMITS.maintenancePerVehicle || diagnosesRaw.length > IMPORT_LIMITS.diagnosesPerVehicle) {
      return fail("A vehicle has more history than can be imported at once.");
    }
    const maintenance: ImportMaintenance[] = [];
    for (const m of maintenanceRaw) {
      const parsed = parseMaintenance(m);
      if (!parsed.ok) return parsed;
      maintenance.push(parsed.value);
    }
    const diagnoses: ImportDiagnosis[] = [];
    const keys = new Set<string>();
    for (const d of diagnosesRaw) {
      const parsed = parseDiagnosis(d);
      if (!parsed.ok) return parsed;
      if (keys.has(parsed.value.key)) continue;
      keys.add(parsed.value.key);
      diagnoses.push(parsed.value);
    }

    vehicles.push({ clientId, existingVehicleId: existingVehicleId || null, year, make, model, engine, vin, nickname, maintenance, diagnoses });
  }
  return { ok: true, value: vehicles };
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The same rule the page uses: two entries are the same vehicle when their VINs
 * match, or, when either has no VIN, when year, make, model and engine all match.
 */
export function sameVehicle(
  a: { year: string; make: string; model: string; engine?: string | null; vin?: string | null },
  b: { year: string; make: string; model: string; engine?: string | null; vin?: string | null },
): boolean {
  const vinA = norm(a.vin);
  const vinB = norm(b.vin);
  if (vinA && vinB) return vinA === vinB;
  return norm(a.year) === norm(b.year) && norm(a.make) === norm(b.make) && norm(a.model) === norm(b.model) && norm(a.engine) === norm(b.engine);
}
