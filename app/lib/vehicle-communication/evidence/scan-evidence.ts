/**
 * Scan evidence: one sealed ScanReport → preview evidence plus, separately,
 * the one input Guided Diagnostics could accept (carcode-scanner-architecture.md,
 * "One-way evidence mapping"; scan-flow.md, "DTC status mapping",
 * "Completeness and coverage", "Partial-scan provenance"; capability-gap-analysis.md,
 * "Guided Diagnostics mapping gaps").
 *
 * RESEARCH PROTOTYPE. Pure and deterministic: no clock, no randomness, no
 * session, no service call; the same report and scan id always give the same
 * result. It imports nothing from GD, not even types, and calls nothing in
 * GD: it builds local copies of GD's scan-input shapes (`gd-shapes.ts`),
 * which the tests prove GD's own types and `normalizeScan` accept.
 *
 * Two outputs, never mixed:
 * - preview evidence (`diagnosticUse: "display_only"`): vehicle identity,
 *   per-module code status, freeze frames, current data, readiness and
 *   capabilities, each with its opaque module label, raw lines, payload bytes,
 *   read time and outcome. Decoded PID and readiness values keep their
 *   `Unverified` wrapper (primary-source check pending) and an eligibility
 *   verdict that says why they cannot enter GD;
 * - `gd`: a `DiagnosticScanInput`, built only from what GD may accept. It is
 *   always `partial` with `coverage`, lists only `reportsStatus` flags whose
 *   service answered `ok` for every module, and never carries a VIN,
 *   readiness, current data, or any value whose table is unverified. A
 *   freeze-frame snapshot is emitted only with at least one eligible
 *   parameter, so no empty snapshot ever reaches GD; with today's tables
 *   (primary-source check pending) none is eligible and every drop is listed.
 *
 * Module labels (`obd-can11-7e8`) are opaque provenance: copied, never parsed.
 * A partial scan never establishes that a code is absent: a successful read
 * that did not list a code is `not_listed`, never "absent". Conflicting
 * observations from different modules are kept side by side; none is picked.
 */
import type { DiagnosticScanInput, DtcObservationInput, DtcStatusFlag, SnapshotInput, Unit } from "./gd-shapes";
import { DTC_SERVICE_KIND, type DtcKind, type DtcService, type EcuReadOutcome } from "../obd/dtc";
import type { ProtocolInfo } from "../obd/frames";
import type { FreezeFrameDtc, FreezeFrameValue, LiveValue } from "../obd/pids";
import type { DtcCountCheck, Readiness } from "../obd/readiness";
import type { EcuIdentity } from "../obd/response";
import type { SupportStatus } from "../obd/support";
import type { VinComparison } from "../obd/vin";
import { sealed, type EcuCapabilities, type EcuRead, type Phase, type ReportedText, type ScanReport, type ScanSectionState, type StepRecord, type Unverified, type Verification } from "../scanner/report";
import type { ScanEndReason } from "../types";

export const EVIDENCE_MAPPER_VERSION = "s10-preview";

const DTC_SERVICES: readonly DtcService[] = ["03", "07", "0A"];

/** scan-flow.md, "DTC status mapping". `active` and `history` are never produced. */
export const GD_FLAG_FOR_SERVICE: Readonly<Record<DtcService, DtcStatusFlag>> = Object.freeze({ "03": "confirmed", "07": "pending", "0A": "permanent" });

/**
 * Scanner unit → GD unit (capability-gap-analysis.md, G1). A unit with no GD
 * counterpart (km/h, g/s, s, crank-angle degrees) maps to nothing; no value is
 * converted.
 */
export const GD_UNIT_FOR: Readonly<Record<string, Unit>> = Object.freeze({ "%": "percent", degC: "degC", kPa: "kPa", rpm: "rpm", V: "V" });

/** GD's id patterns (OBSERVED in GD's `dtc.ts`), checked here so an input GD would refuse is never built. */
const GD_GENERIC_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const GD_SCAN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Which module answered, as an opaque label; `discovered` is false for a module that answered a scan request but not discovery. */
export type Provenance = EcuIdentity & { discovered: boolean };

/** The raw evidence of one module's part of one command. */
export type RawEvidence = { seq: number; command: string; startedAt: string; endedAt: string; rawLines: string[]; payloads: number[][] };

/**
 * The command-log entry an item came from: its `seq` in this scan's own log
 * (`log.scan`) or in the discovery's (`log.discovery`: the VIN is read before
 * the scan), and when that request ended. Null when no request was made for it.
 */
export type StepRef = { log: "discovery" | "scan"; seq: number; command: string; endedAt: string };

/** Why a value cannot enter GD. Every reason that applies is listed. */
export type IneligibleReason =
  | "unverified"
  | "primary_source_check_pending"
  | "not_read"
  | "not_decoded"
  | "no_gd_unit"
  | "current_data_not_mapped"
  | "freeze_frame_not_stored";

export type GdEligibility = { eligible: true } | { eligible: false; reasons: IneligibleReason[] };

/** A read value as shown: never a blank or a zero when it was not read; its outcome says why. */
export type PreviewMeasurement = Provenance & {
  source: "current_data" | "freeze_frame";
  pid: number;
  outcome: EcuRead<unknown>["outcome"];
  detail: string | null;
  code?: number;
  /** When CarCode's request for it ended; null when it was not read. For a freeze frame this is not when the ECU captured it. */
  readAt: string | null;
  step: StepRef | null;
  rawLines: string[];
  payloads: number[][];
  reading:
    | null
    | { status: "decoded"; id: string; value: number; unit: string; gdUnit: Unit | null; formula: string; data: number[]; undecoded: number[] }
    | { status: "not_decoded"; reason: string; data: number[] };
  verification: Verification | null;
  diagnosticUse: "display_only";
  gd: GdEligibility;
};

export type VinReport = Provenance & {
  outcome: EcuRead<unknown>["outcome"];
  detail: string | null;
  text: string | null;
  charset: "iso3779" | "nonstandard" | null;
  raw: number[];
  /** When the discovery's `0902` request ended; null when it was not made for this module. */
  readAt: string | null;
  step: StepRef | null;
  rawLines: string[];
  payloads: number[][];
};

export type VehicleIdentityEvidence = {
  diagnosticUse: "display_only";
  /** Reported by the adapter; never proof of what it is. */
  adapter: { identity: string[]; ati: ReportedText; description: ReportedText };
  protocol: ProtocolInfo | null;
  /** What each module reported; never verified, never written anywhere, never merged. */
  vin: { comparison: VinComparison; reports: VinReport[] };
};

/**
 * One kind of one code at one module:
 * - `reported`: that module's read listed it;
 * - `not_listed`: the read answered `ok` for that module without it. In a
 *   partial scan this never shows the code is absent;
 * - `unknown`: the read did not answer `ok` for that module (its outcome kept).
 */
export type KindState = { state: "reported" } | { state: "not_listed" } | { state: "unknown"; outcome: EcuReadOutcome };

export type CodeEvidence = Provenance & { code: string; kinds: Record<DtcKind, KindState> };

export type ServiceEvidence = { service: DtcService; kind: DtcKind; outcome: EcuReadOutcome; raw: RawEvidence | null };

export type ModuleDtcEvidence = Provenance & { services: ServiceEvidence[]; codes: CodeEvidence[] };

export type DtcEvidence = {
  completeness: "partial";
  /** Generic OBD can never show a code is absent; this is never anything else in the preview. */
  absence: "not_established";
  servicesOkForEveryModule: DtcService[];
  modules: ModuleDtcEvidence[];
  countChecks: DtcCountCheck[];
};

export type ReadinessEvidence = Provenance & {
  outcome: EcuRead<unknown>["outcome"];
  detail: string | null;
  code?: number;
  readAt: string | null;
  step: StepRef | null;
  rawLines: string[];
  payloads: number[][];
  readiness: Unverified<Readiness> | null;
  diagnosticUse: "display_only";
  /** GD has no readiness field (capability-gap-analysis.md, G13). */
  gd: { eligible: false; reasons: ["not_mapped"] };
};

export type FreezeFrameEvidence = Provenance & {
  diagnosticUse: "display_only";
  /** The `020000` read; `readAt` / `step` null when it was not made. */
  support: { outcome: EcuRead<unknown>["outcome"]; detail: string | null; code?: number; readAt: string | null; step: StepRef | null; rawLines: string[]; payloads: number[][] };
  supportProblems: Array<{ command: string; outcome: EcuReadOutcome; detail: string | null; step: StepRef | null }>;
  frame: "stored" | "none_stored" | "unknown";
  /** The `020200` read; `readAt` / `step` null when it was not made. */
  storedDtc: {
    outcome: EcuRead<unknown>["outcome"];
    detail: string | null;
    value: FreezeFrameDtc | null;
    readAt: string | null;
    step: StepRef | null;
    rawLines: string[];
    payloads: number[][];
  };
  values: PreviewMeasurement[];
  /** The snapshot id in `gd.input`, or null with the reason no snapshot was emitted. */
  snapshot: { id: string; linkedCode: string | null } | { id: null; reason: string };
};

export type EvidenceConflict =
  | { kind: "vin_differs"; reports: Array<EcuIdentity & { text: string }> }
  | { kind: "dtc_count_mismatch"; module: string; responseId: string; readinessCount: number; storedCount: number }
  | { kind: "mil_status_differs"; reports: Array<EcuIdentity & { milOn: boolean }> }
  | { kind: "current_value_differs"; pid: number; id: string; readings: Array<EcuIdentity & { value: number; unit: string; readAt: string | null }> }
  | { kind: "freeze_frame_code_not_stored"; module: string; responseId: string; code: string };

export type DroppedForMapping = { what: string; module?: string; why: string };

export type NotMappedReason = "no_vehicle" | "no_code_read" | "invalid_scan_id" | "invalid_module_id";

export type GdMapping =
  | { status: "mapped"; input: DiagnosticScanInput }
  | { status: "not_mapped"; reason: NotMappedReason; detail: string };

export type ScanEvidence = {
  kind: "scan_evidence";
  mapperVersion: string;
  scannerVersion: string;
  scanNumber: number;
  startedAt: string;
  endedAt: string;
  ended: ScanEndReason;
  endDetail: string | null;
  completeness: "partial";
  sections: Record<"readiness" | "dtcs" | "freeze_frame" | "current_data", ScanSectionState>;
  /** Every module that answered discovery or a code read, in report order. */
  modules: Provenance[];
  /** Module labels of the ECUs that answered discovery. */
  coverage: string[];
  vehicle: VehicleIdentityEvidence;
  readiness: ReadinessEvidence[];
  dtcs: DtcEvidence;
  freezeFrames: FreezeFrameEvidence[];
  currentData: PreviewMeasurement[];
  capabilities: EcuCapabilities[];
  conflicts: EvidenceConflict[];
  gd: GdMapping;
  droppedForMapping: DroppedForMapping[];
  /** Every command of the discovery in effect and of this scan, as recorded (raw adapter text kept); `StepRef`s point here. */
  log: { discovery: StepRecord[]; scan: StepRecord[] };
};

export type MapOptions = {
  /** The GD scan id, chosen by the caller and unique per scan; never derived or reused here. */
  scanId: string;
};

/* ───────────────────────── helpers ───────────────────────── */

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

function lastStep(report: ScanReport, phase: Phase, command: string): StepRecord | undefined {
  const matches = report.steps.filter((step) => step.activity === "scan" && step.phase === phase && step.command === command);
  return matches[matches.length - 1];
}

function rawFor(step: StepRecord | undefined, module: string): RawEvidence | null {
  if (!step) return null;
  const ecu = step.perEcu.find((entry) => entry.module === module);
  return { seq: step.seq, command: step.command, startedAt: step.startedAt, endedAt: step.endedAt, rawLines: ecu ? [...ecu.rawLines] : [], payloads: ecu ? ecu.payloads.map((p) => [...p]) : [] };
}

const NOT_ATTEMPTED: ReadonlySet<string> = new Set<string>(["unsupported", "support_unknown", "not_read"] satisfies Array<Exclude<SupportStatus, "supported"> | "not_read">);

/** The log reference and read time of a read with `outcome`; both null when no request was made for it. */
function acquired(log: StepRef["log"], step: StepRecord | undefined, outcome: string): { readAt: string | null; step: StepRef | null } {
  if (!step || NOT_ATTEMPTED.has(outcome)) return { readAt: null, step: null };
  return { readAt: step.endedAt, step: { log, seq: step.seq, command: step.command, endedAt: step.endedAt } };
}

function verificationReasons(verification: Verification | null): IneligibleReason[] {
  if (!verification) return ["not_read"];
  const reasons: IneligibleReason[] = [];
  if (verification.status === "unverified") reasons.push("unverified");
  if (verification.primarySourceCheck === "pending") reasons.push("primary_source_check_pending");
  return reasons;
}

function measurement(
  provenance: Provenance,
  entry: EcuRead<Unverified<LiveValue | FreezeFrameValue>> & { pid: number },
  source: "current_data" | "freeze_frame",
  readAt: string | null,
  step: StepRecord | undefined,
  extra: IneligibleReason[],
): PreviewMeasurement {
  const wrapped = entry.value ?? null;
  const decoded = wrapped?.decoded;
  const reading: PreviewMeasurement["reading"] = !decoded
    ? null
    : decoded.status === "decoded"
      ? {
          status: "decoded",
          id: decoded.id,
          value: decoded.value,
          unit: decoded.unit,
          gdUnit: GD_UNIT_FOR[decoded.unit] ?? null,
          formula: decoded.formula,
          data: [...decoded.data],
          undecoded: [...decoded.undecoded],
        }
      : { status: "not_decoded", reason: decoded.reason, data: [...decoded.data] };
  const reasons = [...verificationReasons(wrapped?.verification ?? null)];
  if (reading?.status === "not_decoded") reasons.push("not_decoded");
  if (reading?.status === "decoded" && reading.gdUnit === null) reasons.push("no_gd_unit");
  for (const reason of extra) if (!reasons.includes(reason)) reasons.push(reason);
  return {
    ...provenance,
    source,
    pid: entry.pid,
    outcome: entry.outcome,
    detail: entry.detail,
    ...(entry.code !== undefined ? { code: entry.code } : {}),
    readAt: NOT_ATTEMPTED.has(entry.outcome) ? null : readAt,
    step: acquired("scan", step, entry.outcome).step,
    rawLines: [...entry.rawLines],
    payloads: entry.payloads.map((p) => [...p]),
    reading,
    verification: wrapped?.verification ?? null,
    diagnosticUse: "display_only",
    gd: reasons.length === 0 ? { eligible: true } : { eligible: false, reasons },
  };
}

/**
 * A GD snapshot from eligible parameters only, or null when there are none:
 * GD never receives an empty snapshot. Always `partial`; no capture time (the
 * ECU's capture time is unknown; CarCode's read time is not it).
 */
export function toSnapshotInput(id: string, parameters: ReadonlyArray<{ id: string; value: number; unit: Unit }>): SnapshotInput | null {
  if (parameters.length === 0 || !GD_SCAN_ID.test(id)) return null;
  return { id, parameters: parameters.map((p) => ({ id: p.id, value: p.value, unit: p.unit })), completeness: "partial" };
}

/* ───────────────────────── mapping ───────────────────────── */

/** Maps one scan report. The report is not changed; the result is sealed. */
export function mapScanEvidence(report: ScanReport, options: MapOptions): ScanEvidence {
  const discovery = report.discovery;
  const discovered = new Set(discovery.ecus.map((ecu) => ecu.module));
  const modules: Provenance[] = [];
  const addModule = (ecu: EcuIdentity) => {
    if (!modules.some((m) => m.module === ecu.module)) modules.push({ responseId: ecu.responseId, module: ecu.module, discovered: discovered.has(ecu.module) });
  };
  discovery.ecus.forEach(addModule);
  report.dtcs.ecus.forEach(addModule);
  const provenance = (ecu: EcuIdentity): Provenance => ({ responseId: ecu.responseId, module: ecu.module, discovered: discovered.has(ecu.module) });
  const coverage = discovery.ecus.map((ecu) => ecu.module);
  const dropped: DroppedForMapping[] = [];
  const conflicts: EvidenceConflict[] = [];

  // Vehicle identity: shown only. The VIN was read by the discovery, before this scan.
  const vinStep = discovery.steps.filter((step) => step.phase === "vin" && step.command === "0902").at(-1);
  const vinReports: VinReport[] = discovery.ecus.map((ecu) => ({
    ...provenance(ecu),
    outcome: ecu.vin.outcome,
    detail: ecu.vin.detail,
    text: ecu.vin.value?.text ?? null,
    charset: ecu.vin.value?.charset ?? null,
    raw: ecu.vin.value ? [...ecu.vin.value.raw] : [],
    ...acquired("discovery", vinStep, ecu.vin.outcome),
    rawLines: [...ecu.vin.rawLines],
    payloads: ecu.vin.payloads.map((p) => [...p]),
  }));
  if (discovery.vinComparison.status === "conflicting") conflicts.push({ kind: "vin_differs", reports: discovery.vinComparison.reports.map((r) => ({ ...r })) });
  if (vinReports.some((r) => r.text !== null)) dropped.push({ what: "VIN", why: "GD vehicle context has no VIN; reported text is shown only" });
  const vehicle: VehicleIdentityEvidence = {
    diagnosticUse: "display_only",
    adapter: structuredClone(discovery.adapter),
    protocol: discovery.protocol ? { ...discovery.protocol } : null,
    vin: { comparison: structuredClone(discovery.vinComparison), reports: vinReports },
  };

  // Readiness: shown only.
  const readinessStep = lastStep(report, "readiness", "0101");
  const readiness: ReadinessEvidence[] = report.readiness.map((entry) => ({
    ...provenance(entry),
    outcome: entry.outcome,
    detail: entry.detail,
    ...(entry.code !== undefined ? { code: entry.code } : {}),
    ...acquired("scan", readinessStep, entry.outcome),
    rawLines: [...entry.rawLines],
    payloads: entry.payloads.map((p) => [...p]),
    readiness: entry.value ? structuredClone(entry.value) : null,
    diagnosticUse: "display_only",
    gd: { eligible: false, reasons: ["not_mapped"] },
  }));
  const milReports = readiness.flatMap((r) => (r.readiness ? [{ responseId: r.responseId, module: r.module, milOn: r.readiness.decoded.milOn }] : []));
  if (milReports.length > 1 && milReports.some((r) => r.milOn !== milReports[0].milOn)) conflicts.push({ kind: "mil_status_differs", reports: milReports });
  if (readiness.some((r) => r.readiness)) dropped.push({ what: "readiness (PID 01)", why: "GD has no readiness field; primary-source check pending; shown only" });

  // Codes: per module, per kind.
  const dtcModules: ModuleDtcEvidence[] = report.dtcs.ecus.map((ecu) => {
    const services: ServiceEvidence[] = DTC_SERVICES.map((service) => ({
      service,
      kind: DTC_SERVICE_KIND[service],
      outcome: ecu.outcomes[service],
      raw: ecu.outcomes[service] === "not_read" ? null : rawFor(lastStep(report, "dtcs", service), ecu.module),
    }));
    const codes: CodeEvidence[] = ecu.codes.map((merged) => {
      const kinds = {} as Record<DtcKind, KindState>;
      for (const service of DTC_SERVICES) {
        const kind = DTC_SERVICE_KIND[service];
        const outcome = ecu.outcomes[service];
        kinds[kind] = merged.kinds.includes(kind) ? { state: "reported" } : outcome === "ok" ? { state: "not_listed" } : { state: "unknown", outcome };
      }
      return { ...provenance(ecu), code: merged.code, kinds };
    });
    return { ...provenance(ecu), services, codes };
  });
  for (const check of report.dtcs.countChecks) {
    if (check.status === "dtc_count_mismatch") {
      conflicts.push({ kind: "dtc_count_mismatch", module: check.module, responseId: check.responseId, readinessCount: check.readinessCount, storedCount: check.storedCount });
    }
  }
  const dtcs: DtcEvidence = {
    completeness: "partial",
    absence: "not_established",
    servicesOkForEveryModule: [...report.dtcs.servicesOkForEveryEcu],
    modules: dtcModules,
    countChecks: structuredClone(report.dtcs.countChecks),
  };

  // Current data: shown only (GD has no live-data field).
  const currentData = report.currentData.map((entry) =>
    measurement(provenance(entry), entry, "current_data", entry.at, lastStep(report, "current_data", `01${hex(entry.pid)}`), ["current_data_not_mapped"]),
  );
  const byPid = new Map<number, PreviewMeasurement[]>();
  for (const m of currentData) if (m.reading?.status === "decoded") byPid.set(m.pid, [...(byPid.get(m.pid) ?? []), m]);
  for (const [pid, readings] of byPid) {
    const values = readings.map((m) => (m.reading as { value: number }).value);
    if (readings.length > 1 && values.some((v) => v !== values[0])) {
      const first = readings[0].reading as { id: string };
      conflicts.push({
        kind: "current_value_differs",
        pid,
        id: first.id,
        readings: readings.map((m) => {
          const r = m.reading as { value: number; unit: string };
          return { responseId: m.responseId, module: m.module, value: r.value, unit: r.unit, readAt: m.readAt };
        }),
      });
    }
  }
  if (currentData.some((m) => m.reading)) dropped.push({ what: "current data", why: "GD has no live-data field; primary-source check pending; shown only" });

  // Freeze frames: preview always; a GD snapshot only from eligible parameters.
  const scanIdValid = GD_SCAN_ID.test(options.scanId);
  const storedCodes = (module: string) => dtcModules.find((m) => m.module === module)?.codes.filter((c) => c.kinds.stored.state === "reported").map((c) => c.code) ?? [];
  const snapshots: SnapshotInput[] = [];
  const snapshotLinks = new Map<string, string>(); // module + code → snapshot id
  const freezeFrames: FreezeFrameEvidence[] = report.freezeFrames.map((entry) => {
    const values = entry.values.map((value) =>
      measurement(
        provenance(entry),
        value,
        "freeze_frame",
        value.readAt,
        lastStep(report, "freeze_frame", `02${hex(value.pid)}00`),
        entry.frame === "none_stored" ? ["freeze_frame_not_stored"] : [],
      ),
    );
    const storedDtc = entry.storedDtc.value ?? null;
    const storedRead = dtcModules.find((m) => m.module === entry.module)?.services.find((s) => s.service === "03");
    if (storedDtc?.status === "stored" && storedRead?.outcome === "ok" && !storedCodes(entry.module).includes(storedDtc.code)) {
      conflicts.push({ kind: "freeze_frame_code_not_stored", module: entry.module, responseId: entry.responseId, code: storedDtc.code });
    }
    const eligible = values.flatMap((m) => (m.gd.eligible && m.reading?.status === "decoded" && m.reading.gdUnit ? [{ id: m.reading.id, value: m.reading.value, unit: m.reading.gdUnit }] : []));
    let snapshot: FreezeFrameEvidence["snapshot"];
    if (entry.frame === "none_stored") snapshot = { id: null, reason: "the module reports no stored freeze frame" };
    else if (entry.support.outcome !== "ok") snapshot = { id: null, reason: `freeze-frame support ${entry.support.outcome}` };
    else if (eligible.length === 0) {
      const read = values.filter((m) => m.reading);
      snapshot = {
        id: null,
        reason: read.length === 0 ? "no freeze-frame value was read" : "no freeze-frame value is eligible (unverified decoding, primary-source check pending, or no GD unit)",
      };
      if (read.length > 0 || entry.frame === "stored") dropped.push({ what: "freeze frame 0", module: entry.module, why: snapshot.reason });
    } else {
      const built = scanIdValid ? toSnapshotInput(`${options.scanId}.ff0.${entry.module}`, eligible) : null;
      if (!built) {
        snapshot = { id: null, reason: "no valid snapshot id fits this scan id" };
        dropped.push({ what: "freeze frame 0", module: entry.module, why: snapshot.reason });
      } else {
        snapshots.push(built);
        const linked = storedDtc?.status === "stored" && storedCodes(entry.module).includes(storedDtc.code) ? storedDtc.code : null;
        if (linked) snapshotLinks.set(`${entry.module}\u0000${linked}`, built.id);
        snapshot = { id: built.id, linkedCode: linked };
      }
    }
    for (const m of values) {
      if (m.reading && !m.gd.eligible) dropped.push({ what: `freeze-frame PID ${hex(m.pid)}`, module: entry.module, why: m.gd.reasons.join(", ") });
    }
    return {
      ...provenance(entry),
      diagnosticUse: "display_only",
      support: {
        outcome: entry.support.outcome,
        detail: entry.support.detail,
        ...(entry.support.code !== undefined ? { code: entry.support.code } : {}),
        ...acquired("scan", lastStep(report, "freeze_frame", "020000"), entry.support.outcome),
        rawLines: [...entry.support.rawLines],
        payloads: entry.support.payloads.map((p) => [...p]),
      },
      supportProblems: entry.supportProblems.map((p) => ({ ...p, step: acquired("scan", lastStep(report, "freeze_frame", p.command), p.outcome).step })),
      frame: entry.frame,
      storedDtc: {
        outcome: entry.storedDtc.outcome,
        detail: entry.storedDtc.detail,
        value: storedDtc ? structuredClone(storedDtc) : null,
        ...acquired("scan", lastStep(report, "freeze_frame", "020200"), entry.storedDtc.outcome),
        rawLines: [...entry.storedDtc.rawLines],
        payloads: entry.storedDtc.payloads.map((p) => [...p]),
      },
      values,
      snapshot,
    };
  });

  const gd = gdInput(report, options, { coverage, dtcModules, snapshots, snapshotLinks, dropped });

  return sealed({
    kind: "scan_evidence",
    mapperVersion: EVIDENCE_MAPPER_VERSION,
    scannerVersion: report.scannerVersion,
    scanNumber: report.scanNumber,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    ended: report.ended,
    endDetail: report.endDetail,
    completeness: "partial",
    sections: { ...report.sections },
    modules,
    coverage,
    vehicle,
    readiness,
    dtcs,
    freezeFrames,
    currentData,
    capabilities: structuredClone(report.capabilities),
    conflicts,
    gd,
    droppedForMapping: dropped,
    log: { discovery: structuredClone(discovery.steps), scan: structuredClone(report.steps) },
  });
}

function gdInput(
  report: ScanReport,
  options: MapOptions,
  parts: { coverage: string[]; dtcModules: ModuleDtcEvidence[]; snapshots: SnapshotInput[]; snapshotLinks: Map<string, string>; dropped: DroppedForMapping[] },
): GdMapping {
  if (report.discovery.result.status !== "vehicle_found" || parts.coverage.length === 0) {
    return { status: "not_mapped", reason: "no_vehicle", detail: "no module answered discovery" };
  }
  if (!parts.dtcModules.some((m) => m.services.some((s) => s.outcome === "ok"))) {
    return { status: "not_mapped", reason: "no_code_read", detail: "no code service answered ok for any module; there is no GD scan with nothing read" };
  }
  if (!GD_SCAN_ID.test(options.scanId)) return { status: "not_mapped", reason: "invalid_scan_id", detail: "the scan id does not fit GD's scan id pattern" };
  const badModule = [...parts.coverage, ...parts.dtcModules.map((m) => m.module)].find((id) => !GD_GENERIC_ID.test(id));
  if (badModule !== undefined) return { status: "not_mapped", reason: "invalid_module_id", detail: `module label "${badModule}" does not fit GD's module id pattern` };

  const reportsStatus = DTC_SERVICES.filter((service) => report.dtcs.servicesOkForEveryEcu.includes(service)).map((service) => GD_FLAG_FOR_SERVICE[service]);
  const codes: DtcObservationInput[] = [];
  for (const ecu of parts.dtcModules) {
    for (const code of ecu.codes) {
      const flags: DtcStatusFlag[] = [];
      for (const service of DTC_SERVICES) {
        const kind = DTC_SERVICE_KIND[service];
        if (code.kinds[kind].state !== "reported") continue;
        const flag = GD_FLAG_FOR_SERVICE[service];
        if (reportsStatus.length > 0 && !reportsStatus.includes(flag)) {
          parts.dropped.push({ what: `${code.code} status ${flag}`, module: ecu.module, why: `service ${service} did not answer ok for every module, so GD may not receive this flag` });
          continue;
        }
        flags.push(flag);
      }
      const snapshot = parts.snapshotLinks.get(`${ecu.module}\u0000${code.code}`);
      codes.push({
        code: code.code,
        format: "obd",
        ...(flags.length > 0 ? { status: flags } : {}),
        module: { id: ecu.module },
        ...(snapshot !== undefined ? { snapshot } : {}),
      });
    }
  }
  const input: DiagnosticScanInput = {
    id: options.scanId,
    source: "scan_tool",
    completeness: "partial",
    coverage: { modules: [...parts.coverage] },
    ...(reportsStatus.length > 0 ? { reportsStatus } : {}),
    codes,
    ...(parts.snapshots.length > 0 ? { snapshots: parts.snapshots } : {}),
  };
  return { status: "mapped", input };
}
