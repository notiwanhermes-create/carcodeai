/**
 * Shapes shared by the garage API and the pages that use it. Types and pure
 * helpers only: safe to import from both server and browser code.
 */
import type { Diagnosis } from "./diagnosis-schema";
import type { DtcResult } from "./dtc";
import type { OdometerUnit } from "./odometer";

export const DIAGNOSIS_STATUSES = ["open", "resolved", "dismissed"] as const;
export type DiagnosisStatus = (typeof DIAGNOSIS_STATUSES)[number];

export function isDiagnosisStatus(value: unknown): value is DiagnosisStatus {
  return typeof value === "string" && (DIAGNOSIS_STATUSES as readonly string[]).includes(value);
}

/** The vehicle exactly as it was described when the diagnosis ran. */
export type VehicleSnapshot = { year: string; make: string; model: string; engine: string; trim: string };

/** One cause in a diagnosis copied from a device, which kept only a short summary. */
export type LegacyCause = { title: string; why: string[]; checks: string[]; fix: string[] };

/**
 * The stored answer.
 *  - "structured": the full diagnosis this app produced for a signed-in user.
 *  - "legacy": a diagnosis copied from a device, where only a summary was kept.
 */
export type StoredResult =
  | { kind: "structured"; diagnosis: Diagnosis }
  | { kind: "legacy"; issueText: string; causes: LegacyCause[] };

export type FollowUpAnswer = { question: string; answer: string };

/** Whether a reported repair still stands, or the problem came back after it. */
export const FIX_OUTCOMES = ["fixed", "did_not_hold"] as const;
export type FixOutcome = (typeof FIX_OUTCOMES)[number];

export function isFixOutcome(value: unknown): value is FixOutcome {
  return typeof value === "string" && (FIX_OUTCOMES as readonly string[]).includes(value);
}

/** A repair the user reported for a diagnosis. */
export type ConfirmedFixDto = {
  id: string;
  /** 1 for the first repair reported for the diagnosis, 2 for the next, and so on. */
  attempt: number;
  outcome: FixOutcome;
  /** When the user said the problem came back. Null while the repair stands. */
  returnedAt: string | null;
  description: string;
  /** Set only when the user said the repair was one of the listed causes. */
  matchedCauseRank: number | null;
  matchedCauseTitle: string | null;
  /** YYYY-MM-DD */
  fixedOn: string;
  odometerValue: number | null;
  odometerUnit: OdometerUnit | null;
  notes: string | null;
};

/** A diagnosis as lists show it. */
export type DiagnosisSummaryDto = {
  id: string;
  vehicleId: string;
  status: DiagnosisStatus;
  /** A short label made from what the user entered: symptoms, else the codes. */
  title: string;
  /** The codes the user submitted, as typed, one per entry. */
  codes: string[];
  diagnosedAt: string;
  updatedAt: string;
  fix: { description: string; fixedOn: string } | null;
};

/** A diagnosis as its own page shows it. Everything comes from stored data. */
export type DiagnosisDetailDto = DiagnosisSummaryDto & {
  source: "app" | "device_import";
  language: string;
  vehicle: VehicleSnapshot;
  codeInput: string;
  symptoms: string;
  codeDetails: DtcResult[];
  result: StoredResult;
  followUps: FollowUpAnswer[];
  updateCount: number;
  odometerValue: number | null;
  odometerUnit: OdometerUnit | null;
  statusChangedAt: string | null;
  /** The repair that currently stands as the resolution, if there is one. */
  confirmedFix: ConfirmedFixDto | null;
  /** Repairs reported earlier that did not hold, oldest first. They are history and are never removed. */
  previousFixes: ConfirmedFixDto[];
};

export type MaintenanceDto = {
  id: string;
  vehicleId: string;
  serviceType: string;
  /** As the user entered it. */
  date: string;
  /** YYYY-MM-DD when `date` is a real calendar day, else null. */
  serviceDate: string | null;
  /** As the user entered it (older records may hold free text). */
  odometer?: string;
  odometerValue: number | null;
  odometerUnit: OdometerUnit | null;
  cost?: string;
  notes?: string;
  createdAt: string;
};

/** What the user must type to delete an archived vehicle for good. The server checks for exactly this word. */
export const PERMANENT_DELETE_CONFIRMATION = "DELETE";

export type VehicleStats = {
  openIssues: number;
  diagnoses: number;
  lastDiagnosisAt: string | null;
  maintenanceRecords: number;
  lastMaintenance: { serviceType: string; date: string } | null;
  /** Repairs the user reported, whether or not they held. */
  repairs: number;
};

export type VehicleDto = {
  id: string;
  year: string;
  make: string;
  model: string;
  engine?: string;
  vin?: string;
  nickname?: string;
  trim?: string;
  odometerValue: number | null;
  odometerUnit: OdometerUnit | null;
  odometerUpdatedAt: string | null;
  archivedAt: string | null;
  stats?: VehicleStats;
};

export type TimelineItem =
  | { kind: "diagnosis"; id: string; at: string; title: string; codes: string[]; status: DiagnosisStatus }
  | { kind: "fix"; id: string; at: string; diagnosisId: string; description: string; outcome: FixOutcome; odometerValue: number | null; odometerUnit: OdometerUnit | null }
  | {
      kind: "maintenance";
      id: string;
      at: string;
      serviceType: string;
      dateText: string;
      odometer?: string;
      odometerValue: number | null;
      odometerUnit: OdometerUnit | null;
      cost?: string;
      notes?: string;
    };

export type VehicleDetailDto = {
  vehicle: VehicleDto;
  openIssues: DiagnosisSummaryDto[];
  timeline: TimelineItem[];
  maintenance: MaintenanceDto[];
};

/* ───────────────────────── pure helpers ───────────────────────── */

const TITLE_MAX = 90;

/**
 * A short label for a diagnosis, made only from what the user entered: the
 * symptoms if there are any, otherwise the codes. Never from the AI's answer.
 */
export function issueTitle(symptoms: string, codeInput: string): string {
  const text = symptoms.replace(/\s+/g, " ").trim();
  if (text) return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1).trimEnd()}…` : text;
  const codes = splitCodes(codeInput);
  return codes.length ? codes.join(", ") : "Diagnosis";
}

/** The submitted codes, one per entry, upper-cased, in the order typed. */
export function splitCodes(codeInput: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of codeInput.split(/[\s,;]+/)) {
    const code = part.trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out.slice(0, 12);
}

type TimelineSource = {
  diagnoses: Array<{ id: string; diagnosedAt: Date; symptoms: string; codeInput: string; status: string }>;
  fixes: Array<{ id: string; diagnosisId: string; fixedOn: Date; createdAt: Date; description: string; outcome: string; odometerValue: number | null; odometerUnit: string | null }>;
  maintenance: Array<{
    id: string;
    serviceType: string;
    date: string;
    serviceDate: Date | null;
    createdAt: Date;
    odometer: string | null;
    odometerValue: number | null;
    odometerUnit: string | null;
    cost: string | null;
    notes: string | null;
  }>;
};

const unitOrNull = (u: string | null): OdometerUnit | null => (u === "km" || u === "mi" ? u : null);

/**
 * One vehicle's history, newest first, built from the records themselves:
 * diagnoses, reported repairs (those that held and those that did not) and
 * service records. Nothing is copied or stored
 * for the timeline; it is a view over the three tables.
 *
 * Ordering: by calendar day first (a service record or repair dated today
 * sorts with today), then by the exact time the record was made.
 */
export function buildTimeline(source: TimelineSource): TimelineItem[] {
  type Sortable = { item: TimelineItem; day: string; exact: number };
  const rows: Sortable[] = [];
  const dayOf = (d: Date) => d.toISOString().slice(0, 10);

  for (const d of source.diagnoses) {
    rows.push({
      day: dayOf(d.diagnosedAt),
      exact: d.diagnosedAt.getTime(),
      item: {
        kind: "diagnosis",
        id: d.id,
        at: d.diagnosedAt.toISOString(),
        title: issueTitle(d.symptoms, d.codeInput),
        codes: splitCodes(d.codeInput),
        status: isDiagnosisStatus(d.status) ? d.status : "open",
      },
    });
  }
  for (const f of source.fixes) {
    rows.push({
      day: dayOf(f.fixedOn),
      exact: f.createdAt.getTime(),
      item: {
        kind: "fix",
        id: f.id,
        at: f.fixedOn.toISOString(),
        diagnosisId: f.diagnosisId,
        description: f.description,
        // Anything unreadable is shown as a standing repair: the row is still the user's report.
        outcome: isFixOutcome(f.outcome) ? f.outcome : "fixed",
        odometerValue: f.odometerValue,
        odometerUnit: unitOrNull(f.odometerUnit),
      },
    });
  }
  for (const m of source.maintenance) {
    // A record whose date text is not a real calendar day is placed by when it was entered.
    const when = m.serviceDate ?? m.createdAt;
    rows.push({
      day: dayOf(when),
      exact: m.createdAt.getTime(),
      item: {
        kind: "maintenance",
        id: m.id,
        at: when.toISOString(),
        serviceType: m.serviceType,
        dateText: m.date,
        odometer: m.odometer || undefined,
        odometerValue: m.odometerValue,
        odometerUnit: unitOrNull(m.odometerUnit),
        cost: m.cost || undefined,
        notes: m.notes || undefined,
      },
    });
  }

  rows.sort((a, b) => (a.day === b.day ? b.exact - a.exact : a.day < b.day ? 1 : -1));
  return rows.map((r) => r.item);
}
