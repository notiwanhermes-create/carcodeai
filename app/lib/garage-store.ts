/**
 * The garage in the database: vehicles, saved diagnoses, confirmed fixes and
 * the per-vehicle history built from them. Server-only.
 *
 * Ownership: every function takes the signed-in user's id from the session and
 * puts it in the WHERE clause of every query. A record that belongs to someone
 * else is indistinguishable from one that does not exist. No function accepts a
 * user id from the browser.
 */
import prisma from "./prisma";
import type { Prisma } from "../generated/prisma/client";
import type { Diagnosis } from "./diagnosis-schema";
import type { DtcResult } from "./dtc";
import { parseCost, parseModelYear, parseOdometer, parseServiceDate } from "./maintenance-values";
import { isOdometerUnit, shouldRaiseAutomatically, type OdometerReading, type OdometerUnit } from "./odometer";
import { sameVehicle, type ImportVehicle } from "./garage-import";
import {
  buildTimeline,
  isDiagnosisStatus,
  issueTitle,
  splitCodes,
  type ConfirmedFixDto,
  type DiagnosisDetailDto,
  type DiagnosisSummaryDto,
  type FollowUpAnswer,
  type MaintenanceDto,
  type StoredResult,
  type VehicleDetailDto,
  type VehicleDto,
  type VehicleSnapshot,
  type VehicleStats,
} from "./garage-types";

type Db = Prisma.TransactionClient | typeof prisma;
const json = (value: unknown) => value as Prisma.InputJsonValue;
const unitOrNull = (u: string | null | undefined): OdometerUnit | null => (isOdometerUnit(u) ? u : null);
const day = (d: Date) => d.toISOString().slice(0, 10);

/* ───────────────────────── vehicles ───────────────────────── */

const VEHICLE_FIELDS = {
  id: true,
  year: true,
  make: true,
  model: true,
  engine: true,
  vin: true,
  nickname: true,
  trim: true,
  odometerValue: true,
  odometerUnit: true,
  odometerUpdatedAt: true,
  archivedAt: true,
} as const;

type VehicleRow = Prisma.VehicleGetPayload<{ select: typeof VEHICLE_FIELDS }>;

export function toVehicleDto(v: VehicleRow, stats?: VehicleStats): VehicleDto {
  return {
    id: v.id,
    year: v.year,
    make: v.make,
    model: v.model,
    engine: v.engine || undefined,
    vin: v.vin || undefined,
    nickname: v.nickname || undefined,
    trim: v.trim || undefined,
    odometerValue: v.odometerValue,
    odometerUnit: unitOrNull(v.odometerUnit),
    odometerUpdatedAt: v.odometerUpdatedAt ? v.odometerUpdatedAt.toISOString() : null,
    archivedAt: v.archivedAt ? v.archivedAt.toISOString() : null,
    ...(stats ? { stats } : {}),
  };
}

/** The vehicle if it belongs to this user, otherwise null. */
export async function findOwnedVehicle(userId: string, vehicleId: string, db: Db = prisma): Promise<VehicleRow | null> {
  if (!userId || !vehicleId) return null;
  return db.vehicle.findFirst({ where: { id: vehicleId, userId }, select: VEHICLE_FIELDS });
}

const EMPTY_STATS: VehicleStats = { openIssues: 0, diagnoses: 0, lastDiagnosisAt: null, maintenanceRecords: 0, lastMaintenance: null };

/** Facts about each vehicle, counted from its records. Nothing here is estimated. */
async function statsFor(userId: string, vehicleIds: string[]): Promise<Map<string, VehicleStats>> {
  const out = new Map<string, VehicleStats>(vehicleIds.map((id) => [id, { ...EMPTY_STATS }]));
  if (vehicleIds.length === 0) return out;

  const [byStatus, records] = await Promise.all([
    prisma.diagnosis.groupBy({
      by: ["vehicleId", "status"],
      where: { userId, vehicleId: { in: vehicleIds } },
      _count: { _all: true },
      _max: { diagnosedAt: true },
    }),
    prisma.maintenanceRecord.findMany({
      where: { userId, vehicleId: { in: vehicleIds } },
      select: { vehicleId: true, serviceType: true, date: true, serviceDate: true, createdAt: true },
    }),
  ]);

  for (const row of byStatus) {
    const stats = out.get(row.vehicleId);
    if (!stats) continue;
    stats.diagnoses += row._count._all;
    if (row.status === "open") stats.openIssues += row._count._all;
    const latest = row._max.diagnosedAt?.toISOString() ?? null;
    if (latest && (!stats.lastDiagnosisAt || latest > stats.lastDiagnosisAt)) stats.lastDiagnosisAt = latest;
  }

  const latestRecord = new Map<string, { at: number; serviceType: string; date: string }>();
  for (const r of records) {
    const stats = out.get(r.vehicleId);
    if (!stats) continue;
    stats.maintenanceRecords += 1;
    const at = (r.serviceDate ?? r.createdAt).getTime();
    const best = latestRecord.get(r.vehicleId);
    if (!best || at > best.at) latestRecord.set(r.vehicleId, { at, serviceType: r.serviceType, date: r.date });
  }
  for (const [vehicleId, best] of latestRecord) {
    const stats = out.get(vehicleId);
    if (stats) stats.lastMaintenance = { serviceType: best.serviceType, date: best.date };
  }
  return out;
}

/** The user's garage, newest first, with the facts each card shows. */
export async function listVehicles(userId: string, options: { archived?: boolean } = {}): Promise<VehicleDto[]> {
  const rows = await prisma.vehicle.findMany({
    where: { userId, archivedAt: options.archived ? { not: null } : null },
    orderBy: { createdAt: "desc" },
    select: VEHICLE_FIELDS,
  });
  const stats = await statsFor(userId, rows.map((r) => r.id));
  return rows.map((r) => toVehicleDto(r, stats.get(r.id)));
}

/**
 * Raise a vehicle's current reading when a newer record carries a higher one.
 * A lower or incomparable reading leaves the vehicle exactly as it is: only the
 * user, on the vehicle page, can lower it (see updateMileage).
 */
async function raiseOdometer(db: Db, vehicle: { id: string; odometerValue: number | null; odometerUnit: string | null }, reading: OdometerReading | null) {
  if (!reading) return;
  const current = vehicle.odometerValue === null ? null : { value: vehicle.odometerValue, unit: unitOrNull(vehicle.odometerUnit) };
  if (!shouldRaiseAutomatically(current, reading)) return;
  await db.vehicle.update({
    where: { id: vehicle.id },
    data: { odometerValue: reading.value, odometerUnit: reading.unit ?? vehicle.odometerUnit, odometerUpdatedAt: new Date() },
  });
}

/* ───────────────────────── diagnoses: reading ───────────────────────── */

const SUMMARY_FIELDS = {
  id: true,
  vehicleId: true,
  status: true,
  symptoms: true,
  codeInput: true,
  diagnosedAt: true,
  updatedAt: true,
  confirmedFix: { select: { description: true, fixedOn: true } },
} as const;

type SummaryRow = Prisma.DiagnosisGetPayload<{ select: typeof SUMMARY_FIELDS }>;

function toSummary(d: SummaryRow): DiagnosisSummaryDto {
  return {
    id: d.id,
    vehicleId: d.vehicleId,
    status: isDiagnosisStatus(d.status) ? d.status : "open",
    title: issueTitle(d.symptoms, d.codeInput),
    codes: splitCodes(d.codeInput),
    diagnosedAt: d.diagnosedAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    fix: d.confirmedFix ? { description: d.confirmedFix.description, fixedOn: day(d.confirmedFix.fixedOn) } : null,
  };
}

/** A user's saved diagnoses, newest first, optionally for one vehicle or one status. */
export async function listDiagnoses(userId: string, filter: { vehicleId?: string; status?: string } = {}): Promise<DiagnosisSummaryDto[]> {
  const rows = await prisma.diagnosis.findMany({
    where: { userId, ...(filter.vehicleId ? { vehicleId: filter.vehicleId } : {}), ...(isDiagnosisStatus(filter.status) ? { status: filter.status } : {}) },
    orderBy: { diagnosedAt: "desc" },
    take: 200,
    select: SUMMARY_FIELDS,
  });
  return rows.map(toSummary);
}

type FixRow = { id: string; description: string; matchedCauseRank: number | null; matchedCauseTitle: string | null; fixedOn: Date; odometerValue: number | null; odometerUnit: string | null; notes: string | null };

function toFixDto(f: FixRow): ConfirmedFixDto {
  return {
    id: f.id,
    description: f.description,
    matchedCauseRank: f.matchedCauseRank,
    matchedCauseTitle: f.matchedCauseTitle,
    fixedOn: day(f.fixedOn),
    odometerValue: f.odometerValue,
    odometerUnit: unitOrNull(f.odometerUnit),
    notes: f.notes,
  };
}

/** A stored value read back as a list of plain objects, or an empty list if it is anything else. */
function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asStoredResult(value: unknown): StoredResult {
  const v = value as Partial<StoredResult> | null;
  if (v && v.kind === "structured" && v.diagnosis && typeof v.diagnosis === "object") return v as StoredResult;
  if (v && v.kind === "legacy" && Array.isArray(v.causes)) return v as StoredResult;
  // Unreadable: show it as an empty summary rather than failing the page.
  return { kind: "legacy", issueText: "", causes: [] };
}

/**
 * One saved diagnosis, complete, from stored data only. Opening an old
 * diagnosis never calls the AI model.
 */
export async function getDiagnosis(userId: string, diagnosisId: string): Promise<DiagnosisDetailDto | null> {
  if (!userId || !diagnosisId) return null;
  const d = await prisma.diagnosis.findFirst({ where: { id: diagnosisId, userId }, include: { confirmedFix: true } });
  if (!d) return null;
  const snapshot = (d.vehicleSnapshot ?? {}) as Partial<VehicleSnapshot>;
  return {
    id: d.id,
    vehicleId: d.vehicleId,
    status: isDiagnosisStatus(d.status) ? d.status : "open",
    title: issueTitle(d.symptoms, d.codeInput),
    codes: splitCodes(d.codeInput),
    diagnosedAt: d.diagnosedAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    fix: d.confirmedFix ? { description: d.confirmedFix.description, fixedOn: day(d.confirmedFix.fixedOn) } : null,
    source: d.source === "device_import" ? "device_import" : "app",
    language: d.language,
    vehicle: { year: snapshot.year || "", make: snapshot.make || "", model: snapshot.model || "", engine: snapshot.engine || "", trim: snapshot.trim || "" },
    codeInput: d.codeInput,
    symptoms: d.symptoms,
    codeDetails: asList<DtcResult>(d.codes),
    result: asStoredResult(d.result),
    followUps: asList<FollowUpAnswer>(d.followUps),
    updateCount: d.updateCount,
    odometerValue: d.odometerValue,
    odometerUnit: unitOrNull(d.odometerUnit),
    statusChangedAt: d.statusChangedAt ? d.statusChangedAt.toISOString() : null,
    confirmedFix: d.confirmedFix ? toFixDto(d.confirmedFix) : null,
  };
}

/* ───────────────────────── diagnoses: saving ───────────────────────── */

export type DiagnosisToSave = {
  userId: string;
  vehicleId: string;
  language: string;
  /** The vehicle as it was sent with the request. */
  vehicle: { year: string; make: string; model: string; engine: string };
  codeInput: string;
  symptoms: string;
  codes: DtcResult[];
  diagnosis: Diagnosis;
  followUps: FollowUpAnswer[];
  mileage: OdometerReading | null;
  /** The id inside the follow-up ticket issued with this diagnosis, if one was issued. */
  ticketId: string | null;
};

/**
 * Save a diagnosis the AI model has just produced. Returns the new record's id,
 * or null when the vehicle is not one of this user's (nothing is saved then).
 */
export async function saveNewDiagnosis(input: DiagnosisToSave): Promise<string | null> {
  const vehicle = await findOwnedVehicle(input.userId, input.vehicleId);
  if (!vehicle || vehicle.archivedAt) return null;

  const snapshot: VehicleSnapshot = { ...input.vehicle, trim: vehicle.trim || "" };
  const result: StoredResult = { kind: "structured", diagnosis: input.diagnosis };

  return prisma.$transaction(async (tx) => {
    const created = await tx.diagnosis.create({
      data: {
        userId: input.userId,
        vehicleId: vehicle.id,
        language: input.language,
        vehicleSnapshot: json(snapshot),
        codeInput: input.codeInput,
        symptoms: input.symptoms,
        codes: json(input.codes),
        result: json(result),
        followUps: json(input.followUps),
        updateCount: input.followUps.length > 0 ? 1 : 0,
        odometerValue: input.mileage?.value ?? null,
        odometerUnit: input.mileage?.unit ?? null,
        ticketId: input.ticketId,
      },
      select: { id: true },
    });
    await raiseOdometer(tx, vehicle, input.mileage);
    return created.id;
  });
}

/**
 * A follow-up update: replace the stored answer of the diagnosis this ticket
 * belongs to. The record keeps its id, vehicle, date and status, so five
 * updates are still one diagnosis. If the original was never saved (it was run
 * before the vehicle was in the account, say), it is saved now.
 */
export async function saveFollowUpUpdate(input: DiagnosisToSave & { ticketId: string }): Promise<string | null> {
  const existing = await prisma.diagnosis.findFirst({
    where: { userId: input.userId, ticketId: input.ticketId },
    select: { id: true },
  });
  if (!existing) return saveNewDiagnosis(input);

  const result: StoredResult = { kind: "structured", diagnosis: input.diagnosis };
  await prisma.diagnosis.update({
    where: { id: existing.id },
    data: {
      result: json(result),
      codes: json(input.codes),
      followUps: json(input.followUps),
      updateCount: { increment: 1 },
      updatedAt: new Date(),
    },
  });
  return existing.id;
}

/* ───────────────────────── outcomes: "did this fix it?" ───────────────────────── */

export type OutcomeInput =
  | {
      outcome: "fixed";
      description: string;
      /** The rank of the listed cause the repair matched, if the user said it was one of them. */
      matchedCauseRank: number | null;
      /** YYYY-MM-DD, or "" for today. */
      fixedOn: string;
      mileage: OdometerReading | null;
      notes: string;
    }
  | { outcome: "not_yet" }
  | { outcome: "dismissed" }
  | { outcome: "reopen" };

export type OutcomeResult = { ok: true; diagnosis: DiagnosisDetailDto } | { ok: false; status: 400 | 404 | 409; error: string };

/** The title of the listed cause with this rank, from the stored answer. Null if there is no such cause. */
function causeTitleByRank(result: StoredResult, rank: number): string | null {
  if (result.kind === "structured") return result.diagnosis.causes.find((c) => c.rank === rank)?.title ?? null;
  return result.causes[rank - 1]?.title ?? null;
}

/**
 * Record what happened to a diagnosed problem.
 *
 *  fixed      → status "resolved", and the repair is stored as a ConfirmedFix.
 *               Saying "fixed" again edits that repair.
 *  not_yet    → stays "open"; only the time of the answer is noted.
 *  dismissed  → status "dismissed" (the problem went away).
 *  reopen     → back to "open". A recorded repair is removed, because the user
 *               is saying it did not fix the problem after all.
 *
 * The diagnosis itself (what the AI said) is never changed by any of these.
 */
export async function recordOutcome(userId: string, diagnosisId: string, input: OutcomeInput): Promise<OutcomeResult> {
  const d = await prisma.diagnosis.findFirst({
    where: { id: diagnosisId, userId },
    select: { id: true, status: true, result: true, vehicleId: true, vehicle: { select: { id: true, odometerValue: true, odometerUnit: true } } },
  });
  if (!d) return { ok: false, status: 404, error: "Diagnosis not found." };
  const now = new Date();

  if (input.outcome === "fixed") {
    const description = input.description.trim();
    if (!description) return { ok: false, status: 400, error: "Describe what fixed the problem." };
    let matchedCauseTitle: string | null = null;
    if (input.matchedCauseRank !== null) {
      matchedCauseTitle = causeTitleByRank(asStoredResult(d.result), input.matchedCauseRank);
      if (!matchedCauseTitle) return { ok: false, status: 400, error: "That cause is not part of this diagnosis." };
    }
    const fixedOn = input.fixedOn ? parseServiceDate(input.fixedOn) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (!fixedOn) return { ok: false, status: 400, error: "Enter the repair date as a real calendar day." };
    if (fixedOn.getTime() > now.getTime() + 86_400_000) return { ok: false, status: 400, error: "The repair date cannot be in the future." };

    const fix = {
      description,
      matchedCauseRank: matchedCauseTitle ? input.matchedCauseRank : null,
      matchedCauseTitle,
      fixedOn,
      odometerValue: input.mileage?.value ?? null,
      odometerUnit: input.mileage?.unit ?? null,
      notes: input.notes.trim() || null,
    };
    await prisma.$transaction(async (tx) => {
      await tx.confirmedFix.upsert({
        where: { diagnosisId: d.id },
        create: { ...fix, userId, vehicleId: d.vehicleId, diagnosisId: d.id },
        update: { ...fix, updatedAt: now },
      });
      if (d.status !== "resolved") await tx.diagnosis.update({ where: { id: d.id }, data: { status: "resolved", statusChangedAt: now, updatedAt: now } });
      await raiseOdometer(tx, d.vehicle, input.mileage);
    });
  } else if (input.outcome === "not_yet") {
    if (d.status !== "open") return { ok: false, status: 409, error: "This diagnosis is not open. Reopen it first." };
    await prisma.diagnosis.update({ where: { id: d.id }, data: { reviewedAt: now } });
  } else if (input.outcome === "dismissed") {
    if (d.status === "resolved") return { ok: false, status: 409, error: "This diagnosis has a recorded repair. Reopen it first." };
    if (d.status !== "dismissed") await prisma.diagnosis.update({ where: { id: d.id }, data: { status: "dismissed", statusChangedAt: now, updatedAt: now } });
  } else {
    await prisma.$transaction([
      prisma.confirmedFix.deleteMany({ where: { diagnosisId: d.id, userId } }),
      prisma.diagnosis.update({ where: { id: d.id }, data: { status: "open", statusChangedAt: now, updatedAt: now } }),
    ]);
  }

  const fresh = await getDiagnosis(userId, d.id);
  return fresh ? { ok: true, diagnosis: fresh } : { ok: false, status: 404, error: "Diagnosis not found." };
}

/* ───────────────────────── one vehicle's page ───────────────────────── */

const MAINTENANCE_FIELDS = {
  id: true,
  vehicleId: true,
  serviceType: true,
  date: true,
  serviceDate: true,
  odometer: true,
  odometerValue: true,
  odometerUnit: true,
  cost: true,
  notes: true,
  createdAt: true,
} as const;

type MaintenanceRow = Prisma.MaintenanceRecordGetPayload<{ select: typeof MAINTENANCE_FIELDS }>;

export function toMaintenanceDto(r: MaintenanceRow): MaintenanceDto {
  return {
    id: r.id,
    vehicleId: r.vehicleId,
    serviceType: r.serviceType,
    date: r.date,
    serviceDate: r.serviceDate ? day(r.serviceDate) : null,
    odometer: r.odometer || undefined,
    odometerValue: r.odometerValue,
    odometerUnit: unitOrNull(r.odometerUnit),
    cost: r.cost || undefined,
    notes: r.notes || undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

export { MAINTENANCE_FIELDS };

/**
 * Everything one vehicle's page shows. The timeline is built here from the
 * diagnoses, confirmed fixes and service records themselves; nothing is copied.
 */
export async function vehicleDetail(userId: string, vehicleId: string): Promise<VehicleDetailDto | null> {
  const vehicle = await findOwnedVehicle(userId, vehicleId);
  if (!vehicle) return null;

  const [diagnoses, fixes, maintenance, stats] = await Promise.all([
    prisma.diagnosis.findMany({ where: { userId, vehicleId }, orderBy: { diagnosedAt: "desc" }, take: 200, select: SUMMARY_FIELDS }),
    prisma.confirmedFix.findMany({
      where: { userId, vehicleId },
      select: { id: true, diagnosisId: true, fixedOn: true, createdAt: true, description: true, odometerValue: true, odometerUnit: true },
    }),
    prisma.maintenanceRecord.findMany({ where: { userId, vehicleId }, orderBy: { createdAt: "desc" }, take: 500, select: MAINTENANCE_FIELDS }),
    statsFor(userId, [vehicleId]),
  ]);

  return {
    vehicle: toVehicleDto(vehicle, stats.get(vehicleId)),
    openIssues: diagnoses.filter((d) => d.status === "open").map(toSummary),
    timeline: buildTimeline({ diagnoses, fixes, maintenance }),
    maintenance: maintenance.map(toMaintenanceDto),
  };
}

/* ───────────────────────── service records ───────────────────────── */

export type MaintenanceToSave = {
  vehicleId: string;
  serviceType: string;
  date: string;
  /** What the user typed for the odometer, or "". */
  odometerText: string;
  /** The unit chosen in the form, when the form has one. */
  odometerUnit: OdometerUnit | null;
  cost: string;
  notes: string;
};

/**
 * Add a service record to one of this user's vehicles. The text the user typed
 * is stored as typed; the typed copies are filled in only when it converts
 * cleanly. A clean, higher reading also becomes the vehicle's current reading.
 */
export async function addMaintenance(userId: string, input: MaintenanceToSave, db: Db = prisma): Promise<MaintenanceDto | null> {
  const vehicle = await findOwnedVehicle(userId, input.vehicleId, db);
  if (!vehicle) return null;

  const parsed = parseOdometer(input.odometerText);
  const reading: OdometerReading | null = parsed ? { value: parsed.value, unit: parsed.unit ?? input.odometerUnit } : null;

  const record = await db.maintenanceRecord.create({
    data: {
      userId,
      vehicleId: vehicle.id,
      serviceType: input.serviceType,
      notes: input.notes || null,
      date: input.date,
      serviceDate: parseServiceDate(input.date),
      odometer: input.odometerText || null,
      odometerValue: reading?.value ?? null,
      odometerUnit: reading?.unit ?? null,
      cost: input.cost || null,
      costAmount: parseCost(input.cost),
    },
    select: MAINTENANCE_FIELDS,
  });
  await raiseOdometer(db, vehicle, reading);
  return toMaintenanceDto(record);
}

/* ───────────────────────── copying a device's data into the account ───────────────────────── */

export type ImportOutcome = {
  clientId: string;
  /**
   * imported  : a new vehicle was created, with its history.
   * attached  : the history was added to a vehicle already in the account.
   * duplicate : the same vehicle is already in the account. Nothing was copied.
   * failed    : nothing was copied for this vehicle.
   */
  outcome: "imported" | "attached" | "duplicate" | "failed";
  vehicleId: string | null;
  maintenance: number;
  diagnoses: number;
  error?: string;
};

/**
 * Copy vehicles and their history from a device into the account.
 *
 * Each vehicle is all-or-nothing (one transaction). A vehicle that is already
 * in the account is reported as a duplicate and left alone: nothing is merged
 * silently. A diagnosis that was imported before is skipped, so importing twice
 * cannot create it twice.
 */
export async function importDeviceData(userId: string, vehicles: ImportVehicle[]): Promise<ImportOutcome[]> {
  const account = await prisma.vehicle.findMany({ where: { userId }, select: VEHICLE_FIELDS });
  const outcomes: ImportOutcome[] = [];

  for (const entry of vehicles) {
    try {
      let target: VehicleRow | null = null;
      let created = false;

      if (entry.existingVehicleId) {
        target = account.find((v) => v.id === entry.existingVehicleId) ?? null;
        if (!target) {
          outcomes.push({ clientId: entry.clientId, outcome: "failed", vehicleId: null, maintenance: 0, diagnoses: 0, error: "That vehicle is not in this account." });
          continue;
        }
      } else {
        const twin = account.find((v) => sameVehicle(v, entry));
        if (twin) {
          outcomes.push({ clientId: entry.clientId, outcome: "duplicate", vehicleId: twin.id, maintenance: 0, diagnoses: 0 });
          continue;
        }
      }

      const result = await prisma.$transaction(async (tx) => {
        let vehicle = target;
        if (!vehicle) {
          vehicle = await tx.vehicle.create({
            data: {
              userId,
              year: entry.year,
              modelYear: parseModelYear(entry.year),
              make: entry.make,
              model: entry.model,
              engine: entry.engine || null,
              vin: entry.vin || null,
              nickname: entry.nickname || null,
            },
            select: VEHICLE_FIELDS,
          });
          created = true;
        }

        // A record identical to one the vehicle already has is not added again,
        // so sending the same device data twice cannot double the history.
        const sameRecord = (r: { serviceType: string; date: string; odometerValue: number | null; notes: string | null }) =>
          [r.serviceType, r.date, r.odometerValue ?? "", r.notes ?? ""].join("");
        const onFile = new Set(
          created
            ? []
            : (await tx.maintenanceRecord.findMany({ where: { userId, vehicleId: vehicle.id }, select: { serviceType: true, date: true, odometerValue: true, notes: true } })).map(sameRecord),
        );
        let maintenance = 0;
        for (const m of entry.maintenance) {
          const fingerprint = sameRecord({ serviceType: m.type, date: m.date, odometerValue: m.odometerValue, notes: m.notes || null });
          if (onFile.has(fingerprint)) continue;
          onFile.add(fingerprint);
          const odometerText = m.odometerValue === null ? "" : String(m.odometerValue);
          await addMaintenance(userId, { vehicleId: vehicle.id, serviceType: m.type, date: m.date, odometerText, odometerUnit: m.odometerUnit, cost: "", notes: m.notes }, tx);
          maintenance += 1;
        }

        const known = new Set(
          (await tx.diagnosis.findMany({ where: { userId, importKey: { in: entry.diagnoses.map((d) => d.key) } }, select: { importKey: true } })).map((d) => d.importKey),
        );
        let diagnoses = 0;
        for (const d of entry.diagnoses) {
          if (known.has(d.key)) continue;
          const stored: StoredResult = { kind: "legacy", issueText: d.issueText, causes: d.causes };
          const snapshot: VehicleSnapshot = {
            year: d.vehicle.year || vehicle.year,
            make: d.vehicle.make || vehicle.make,
            model: d.vehicle.model || vehicle.model,
            engine: d.vehicle.engine || vehicle.engine || "",
            trim: "",
          };
          const row = await tx.diagnosis.create({
            data: {
              userId,
              vehicleId: vehicle.id,
              source: "device_import",
              status: d.confirmedFix ? "resolved" : "open",
              statusChangedAt: d.confirmedFix ? d.at : null,
              vehicleSnapshot: json(snapshot),
              codeInput: d.codeInput,
              symptoms: d.symptoms,
              result: json(stored),
              followUps: json(d.followUps),
              importKey: d.key,
              diagnosedAt: d.at,
            },
            select: { id: true },
          });
          if (d.confirmedFix) {
            await tx.confirmedFix.create({
              data: {
                userId,
                vehicleId: vehicle.id,
                diagnosisId: row.id,
                description: d.confirmedFix.fix || d.confirmedFix.title,
                matchedCauseRank: d.confirmedFix.causeIndex === null ? null : d.confirmedFix.causeIndex + 1,
                matchedCauseTitle: d.confirmedFix.causeIndex === null ? null : d.confirmedFix.title,
                fixedOn: new Date(Date.UTC(d.at.getUTCFullYear(), d.at.getUTCMonth(), d.at.getUTCDate())),
              },
            });
          }
          diagnoses += 1;
        }
        return { vehicle, diagnoses, maintenance };
      });

      if (created) account.push(result.vehicle);
      outcomes.push({
        clientId: entry.clientId,
        outcome: created ? "imported" : "attached",
        vehicleId: result.vehicle.id,
        maintenance: result.maintenance,
        diagnoses: result.diagnoses,
      });
    } catch (err) {
      console.error("[garage import]", err instanceof Error ? `${err.name}: ${err.message}` : err);
      outcomes.push({ clientId: entry.clientId, outcome: "failed", vehicleId: null, maintenance: 0, diagnoses: 0, error: "Could not import this vehicle." });
    }
  }
  return outcomes;
}
