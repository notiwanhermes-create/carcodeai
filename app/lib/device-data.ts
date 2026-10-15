/**
 * What a browser holds that an account does not: guest vehicles, and the
 * service records and saved diagnoses that earlier versions kept on the device.
 *
 * These helpers decide what can be copied into the account, build the request,
 * and work out what stays on the device afterwards. Pure functions: no storage
 * and no network, so every rule here can be tested directly.
 *
 * Nothing on the device is changed, shortened or dropped to make it fit. An
 * item the account cannot take as it is stays on the device, as it is.
 */
import { IMPORT_LIMITS, sameVehicle } from "./garage-import";

export type DeviceVehicle = { id: string; year: string; make: string; model: string; engine?: string; vin?: string; nickname?: string };

/** A service record as the page keeps it for guests. */
export type DeviceMaintenance = {
  id: string;
  vehicleId?: string;
  type: string;
  date: string;
  mileageValue?: number;
  mileageUnit?: "km" | "mi";
  mileageKm?: number;
  /** Older versions kept one value with no unit. */
  mileage?: string | number;
  notes?: string;
};

/** A saved diagnosis as the page keeps it for guests. */
export type DeviceSession = {
  id: string;
  vehicleId?: string;
  timestamp: string;
  issueText: string;
  code?: string;
  symptoms?: string;
  vehicle: { year: string; make: string; model: string; engine?: string };
  followUpAnswers?: Record<string, string>;
  finalRankedCauses?: Array<{ id?: string; title: string; whyLikely?: string[]; confirm?: string[]; fix?: string[] }>;
  confirmedFix?: { causeId?: string; causeTitle: string; fix: string };
};

/** The three places history is kept on a device. Each maps a vehicle id to its items. */
export type DeviceStores = {
  /** carcode_maintenance_v1: one map for everyone who used this browser. */
  maintenance: Record<string, DeviceMaintenance[]>;
  /** Diagnoses saved while signed out. */
  guestSessions: Record<string, DeviceSession[]>;
  /** Diagnoses an earlier version saved on the device for this account. */
  accountSessions: Record<string, DeviceSession[]>;
};

export type DevicePlanEntry = {
  clientId: string;
  /**
   * new_vehicle      : a guest vehicle that will be created in the account, with its history.
   * likely_duplicate : a guest vehicle that looks like one already in the account. The server decides;
   *                    if it agrees, nothing is copied and the vehicle stays on the device.
   * history_only     : history kept on this device for a vehicle that is already in the account.
   */
  kind: "new_vehicle" | "likely_duplicate" | "history_only";
  existingVehicleId: string | null;
  vehicle: DeviceVehicle;
  maintenance: DeviceMaintenance[];
  diagnoses: DeviceSession[];
};

export type DeviceImportOutcome = { clientId: string; outcome: "imported" | "attached" | "duplicate" | "failed"; vehicleId: string | null; maintenance: number; diagnoses: number };

const HISTORY_PREFIX = "account:";

function isText(v: unknown, max: number, required = false): boolean {
  if (v === undefined || v === null) return !required;
  if (typeof v !== "string" && typeof v !== "number") return false;
  const s = String(v).trim();
  return s.length <= max && (!required || s.length > 0);
}

function isTextList(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  return Array.isArray(v) && v.slice(0, IMPORT_LIMITS.listItems).every((item) => isText(item, IMPORT_LIMITS.listText));
}

/** The reading of a service record as a whole number, or null when it has none or it cannot be read. */
export function deviceReading(m: DeviceMaintenance): { value: number; unit: "km" | "mi" | null } | null {
  if (typeof m.mileageValue === "number" && Number.isFinite(m.mileageValue) && m.mileageValue > 0) {
    return { value: Math.round(m.mileageValue), unit: m.mileageUnit === "mi" || m.mileageUnit === "km" ? m.mileageUnit : null };
  }
  if (m.mileage !== undefined && m.mileage !== null && m.mileage !== "") {
    const n = Number(String(m.mileage).replace(/,/g, "").trim());
    // The old value had no unit. It is copied as a number with the unit unknown, never guessed.
    if (Number.isFinite(n) && n > 0) return { value: Math.round(n), unit: null };
  }
  return null;
}

/** Whether the account can take this service record exactly as it is. */
export function canImportMaintenance(m: unknown): m is DeviceMaintenance {
  if (!m || typeof m !== "object") return false;
  const r = m as DeviceMaintenance;
  if (!isText(r.type, 80, true) || !isText(r.date, 40, true) || !isText(r.notes, IMPORT_LIMITS.notes)) return false;
  const reading = deviceReading(r);
  return reading === null || reading.value <= 9_999_999;
}

/** Whether the account can take this saved diagnosis exactly as it is. */
export function canImportSession(s: unknown): s is DeviceSession {
  if (!s || typeof s !== "object") return false;
  const d = s as DeviceSession;
  if (!isText(d.id, 80, true) || !isText(d.code, 120) || !isText(d.symptoms, IMPORT_LIMITS.symptoms) || !isText(d.issueText, IMPORT_LIMITS.issueText)) return false;
  const v = (d.vehicle ?? {}) as DeviceSession["vehicle"];
  if (!isText(v.year, 4) || !isText(v.make, 60) || !isText(v.model, 60) || !isText(v.engine, 100)) return false;
  const causes = d.finalRankedCauses;
  if (!Array.isArray(causes) || causes.length === 0) return false;
  return causes.slice(0, IMPORT_LIMITS.causes).every((c) => !!c && isText(c.title, 200, true) && isTextList(c.whyLikely) && isTextList(c.confirm) && isTextList(c.fix));
}

function historyFor(id: string, maintenance: DeviceStores["maintenance"], sessions: Record<string, DeviceSession[]>) {
  const records = Array.isArray(maintenance[id]) ? maintenance[id].filter(canImportMaintenance) : [];
  const saved = Array.isArray(sessions[id]) ? sessions[id].filter(canImportSession) : [];
  return {
    maintenance: records.slice(0, IMPORT_LIMITS.maintenancePerVehicle),
    diagnoses: saved.slice(0, IMPORT_LIMITS.diagnosesPerVehicle),
  };
}

/**
 * What on this device can be copied into the account: each guest vehicle with
 * its history, and any history kept here for vehicles already in the account.
 * This is the list the user is shown before anything is sent.
 */
export function planDeviceImport(guestVehicles: DeviceVehicle[], accountVehicles: DeviceVehicle[], stores: DeviceStores): DevicePlanEntry[] {
  const plan: DevicePlanEntry[] = [];

  for (const guest of guestVehicles.slice(0, IMPORT_LIMITS.vehicles)) {
    if (!guest?.id || !/^\d{4}$/.test(String(guest.year ?? "").trim()) || !isText(guest.make, 60, true) || !isText(guest.model, 60, true)) continue;
    if (!isText(guest.engine, 100) || !isText(guest.vin, 17) || !isText(guest.nickname, 60)) continue;
    const twin = accountVehicles.some((a) => sameVehicle(a, guest));
    plan.push({ clientId: guest.id, kind: twin ? "likely_duplicate" : "new_vehicle", existingVehicleId: null, vehicle: guest, ...historyFor(guest.id, stores.maintenance, stores.guestSessions) });
  }

  for (const account of accountVehicles) {
    if (plan.length >= IMPORT_LIMITS.vehicles) break;
    const history = historyFor(account.id, stores.maintenance, stores.accountSessions);
    if (history.maintenance.length + history.diagnoses.length === 0) continue;
    plan.push({ clientId: `${HISTORY_PREFIX}${account.id}`, kind: "history_only", existingVehicleId: account.id, vehicle: account, ...history });
  }
  return plan;
}

/** One plan entry as /api/garage/import expects it. */
export function toImportVehicle(entry: DevicePlanEntry) {
  const v = entry.vehicle;
  return {
    clientId: entry.clientId,
    existingVehicleId: entry.existingVehicleId ?? undefined,
    year: String(v.year ?? "").trim(),
    make: String(v.make ?? "").trim(),
    model: String(v.model ?? "").trim(),
    engine: v.engine ?? "",
    vin: v.vin ?? "",
    nickname: v.nickname ?? "",
    maintenance: entry.maintenance.map((m) => {
      const reading = deviceReading(m);
      return { type: m.type, date: m.date, odometerValue: reading?.value ?? null, odometerUnit: reading?.unit ?? null, notes: m.notes ?? "" };
    }),
    diagnoses: entry.diagnoses.map((s) => ({
      key: s.id,
      at: s.timestamp,
      code: s.code ?? "",
      symptoms: s.symptoms ?? "",
      issueText: s.issueText ?? "",
      vehicle: { year: s.vehicle?.year ?? "", make: s.vehicle?.make ?? "", model: s.vehicle?.model ?? "", engine: s.vehicle?.engine ?? "" },
      followUps: Object.entries(s.followUpAnswers ?? {}).map(([question, answer]) => ({ question, answer: String(answer) })),
      causes: (s.finalRankedCauses ?? []).slice(0, IMPORT_LIMITS.causes).map((c) => ({ title: c.title, why: c.whyLikely ?? [], checks: c.confirm ?? [], fix: c.fix ?? [] })),
      confirmedFix: s.confirmedFix ? { title: s.confirmedFix.causeTitle, fix: s.confirmedFix.fix } : undefined,
    })),
  };
}

export type ImportVehiclePayload = ReturnType<typeof toImportVehicle>;

/**
 * Split the plan into requests that each stay under the server's size limit.
 * A typical device fits in one.
 */
export function batchForUpload(plan: DevicePlanEntry[], maxChars = 300_000): ImportVehiclePayload[][] {
  const batches: ImportVehiclePayload[][] = [];
  let current: ImportVehiclePayload[] = [];
  let size = 0;
  for (const entry of plan) {
    const payload = toImportVehicle(entry);
    const weight = JSON.stringify(payload).length;
    if (current.length > 0 && size + weight > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(payload);
    size += weight;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function without<T extends { id: string }>(items: T[] | undefined, sent: Array<{ id: string }>): T[] {
  const ids = new Set(sent.map((x) => x.id));
  return (Array.isArray(items) ? items : []).filter((x) => !ids.has(x.id));
}

type StoresOf<M, S> = { maintenance: Record<string, M[]>; guestSessions: Record<string, S[]>; accountSessions: Record<string, S[]> };

/**
 * The device's stores after an import.
 *
 * What the account took is removed from the device, so the same history is not
 * kept in two places. Everything else stays: a vehicle the server called a
 * duplicate or could not import keeps all of its history here. If part of a
 * vehicle's history could not be sent, that part is kept under the account
 * vehicle's id, so it is still on the device and can be offered again.
 */
export function applyImportOutcomes<M extends DeviceMaintenance, S extends DeviceSession>(
  stores: StoresOf<M, S>,
  plan: DevicePlanEntry[],
  outcomes: DeviceImportOutcome[],
): StoresOf<M, S> {
  const maintenance = { ...stores.maintenance };
  const guestSessions = { ...stores.guestSessions };
  const accountSessions = { ...stores.accountSessions };

  for (const entry of plan) {
    const outcome = outcomes.find((o) => o.clientId === entry.clientId);
    if (!outcome || (outcome.outcome !== "imported" && outcome.outcome !== "attached") || !outcome.vehicleId) continue;

    const localId = entry.existingVehicleId ?? entry.clientId;
    const sessions = entry.existingVehicleId ? accountSessions : guestSessions;

    const recordsLeft = without(maintenance[localId], entry.maintenance);
    const sessionsLeft = without(sessions[localId], entry.diagnoses);
    delete maintenance[localId];
    delete sessions[localId];

    const target = outcome.vehicleId;
    if (recordsLeft.length > 0) maintenance[target] = [...recordsLeft.map((r) => ({ ...r, vehicleId: target })), ...(maintenance[target] ?? [])];
    if (sessionsLeft.length > 0) accountSessions[target] = [...sessionsLeft.map((s) => ({ ...s, vehicleId: target })), ...(accountSessions[target] ?? [])];
  }
  return { maintenance, guestSessions, accountSessions };
}

/** Totals for the note shown after an import. */
export function summarizeOutcomes(outcomes: DeviceImportOutcome[]) {
  const count = (kind: DeviceImportOutcome["outcome"]) => outcomes.filter((o) => o.outcome === kind).length;
  return {
    imported: count("imported"),
    attached: count("attached"),
    duplicates: count("duplicate"),
    failed: count("failed"),
    records: outcomes.reduce((n, o) => n + (o.maintenance || 0), 0),
    diagnoses: outcomes.reduce((n, o) => n + (o.diagnoses || 0), 0),
  };
}
