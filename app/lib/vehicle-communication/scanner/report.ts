/**
 * Scanner reports: what one discovery, scan or live-polling run read, and how
 * (scan-flow.md, "Partial-scan provenance"; module-discovery.md, "Discovery
 * output"; live-data.md, "Rules for every value").
 *
 * RESEARCH PROTOTYPE. Pure types and helpers; nothing here judges a value.
 * Every per-ECU entry keeps its response identifier, opaque module label, raw
 * lines and reassembled payload bytes. A read that produced no data says why
 * (its outcome), never a blank or a zero. Every decoded PID value and every
 * readiness decode is wrapped as `Unverified`: its table's primary-source
 * check is pending, so it is display-only and may not feed Guided Diagnostics
 * or any pass/fail, cause, safety or next-best-test decision. Reports are
 * deep-frozen when their run ends and never rewritten.
 */
import type { CommandResult } from "../elm/executor";
import type { DtcService, EcuDtcs, EcuReadOutcome } from "../obd/dtc";
import type { ProtocolInfo } from "../obd/frames";
import { PID_TABLE_REVIEW, type FreezeFrameDtc, type FreezeFrameValue, type LiveValue } from "../obd/pids";
import { READINESS_TABLE_REVIEW, type DtcCountCheck, type Readiness } from "../obd/readiness";
import type { EcuIdentity } from "../obd/response";
import type { SupportedPidBitmap, SupportStatus } from "../obd/support";
import type { ReportedVin, VinComparison } from "../obd/vin";
import type { CommandOutcome, ScanEndReason } from "../types";

export const SCANNER_VERSION = "s7-preview";

/** What every decoded PID value and readiness decode carries until a licensed SAE J1979 check is recorded. */
export type Verification = {
  status: "unverified";
  primarySourceCheck: "pending";
  /** The only permitted use. Never pass/fail, cause selection, safety, verification or next-best-test. */
  diagnosticUse: "display_only";
  standard: string;
  secondaryCrossCheck: string;
};

export type Unverified<T> = { decoded: T; verification: Verification };

function verification(table: typeof PID_TABLE_REVIEW | typeof READINESS_TABLE_REVIEW): Verification {
  return {
    status: "unverified",
    primarySourceCheck: table.primarySourceCheck,
    diagnosticUse: "display_only",
    standard: table.standard,
    secondaryCrossCheck: table.secondaryCrossCheck,
  };
}

export function unverifiedPid<T extends LiveValue | FreezeFrameValue>(decoded: T): Unverified<T> {
  return { decoded, verification: verification(PID_TABLE_REVIEW) };
}

export function unverifiedReadiness(decoded: Readiness): Unverified<Readiness> {
  return { decoded, verification: verification(READINESS_TABLE_REVIEW) };
}

/** Which run a step or report belongs to. */
export type ActivityKind = "discovery" | "scan" | "live";

export type Phase =
  | "open"
  | "initialise"
  | "identify"
  | "protocol"
  | "current_data_support"
  | "vin"
  | "readiness"
  | "dtcs"
  | "freeze_frame"
  | "current_data"
  | "live";

/** One ECU's part of one command's reply. */
export type StepEcu = EcuIdentity & { outcome: "ok" | "negative_response" | "malformed"; detail: string | null; rawLines: string[]; payloads: number[][] };

/** One command as sent and answered: the raw log entry. */
export type StepRecord = {
  /** 1, 2, 3 … in the order sent on this controller (all runs). */
  seq: number;
  activity: ActivityKind;
  phase: Phase;
  /** The allowlisted text requested. */
  command: string;
  startedAt: string;
  endedAt: string;
  written: boolean;
  outcome: CommandOutcome;
  token: string | null;
  detail: string | null;
  /** Empty for adapter commands and for replies without attributable data. */
  perEcu: StepEcu[];
  raw: CommandResult["raw"];
};

/** An adapter answer as REPORTED (ATI, AT@1): never proof of what the adapter is. */
export type ReportedText = { outcome: CommandOutcome | "not_read"; lines: string[] };

/** A per-ECU read: data only when `outcome` is `ok`; otherwise the reason there is none. */
export type EcuRead<T> = EcuIdentity & {
  outcome: EcuReadOutcome | Exclude<SupportStatus, "supported">;
  detail: string | null;
  /** A negative response code, as sent. */
  code?: number;
  rawLines: string[];
  payloads: number[][];
  value?: T;
};

export type BitmapProblem = { command: string; outcome: EcuReadOutcome; detail: string | null };

export type DiscoveredEcu = EcuIdentity & {
  currentData: {
    bitmaps: SupportedPidBitmap[];
    supportedPids: number[];
    /** The last bitmap range read; null when not even `00` was read; 0xFF when the chain ended. Later ranges are `support_unknown`. */
    supportKnownUpTo: number | null;
    problems: BitmapProblem[];
  };
  /** $09 infotypes (from `0900`). */
  infoTypes: EcuRead<SupportedPidBitmap>;
  vin: EcuRead<ReportedVin>;
};

export type DiscoveryFailure =
  | "not_completed"
  | "adapter_initialisation_failed"
  | "no_ecu_answered"
  | "no_vehicle_protocol"
  | "unsupported_protocol"
  | "protocol_unknown"
  | "no_valid_answer"
  | "adapter_error";

export type DiscoveryReport = {
  kind: "discovery";
  scannerVersion: string;
  transport: string;
  startedAt: string;
  endedAt: string;
  ended: ScanEndReason;
  endDetail: string | null;
  result: { status: "vehicle_found" } | { status: "no_vehicle"; reason: DiscoveryFailure; outcome: CommandOutcome | null; detail: string };
  adapter: { identity: string[]; ati: ReportedText; description: ReportedText };
  protocol: ProtocolInfo | null;
  ecus: DiscoveredEcu[];
  /** `0100` answers that did not count as discovery (malformed, negative), kept with their identifiers. */
  rejectedAnswers: EcuRead<SupportedPidBitmap>[];
  vinComparison: VinComparison;
  steps: StepRecord[];
};

export type ReadinessEntry = EcuRead<Unverified<Readiness>>;

export type FreezeFrameEntry = EcuIdentity & {
  /** The ECU's own $02 bitmap answer; anything but `ok` leaves its $02 support unknown (never `unsupported`). */
  support: EcuRead<SupportedPidBitmap[]>;
  /** Continuation ranges (`022000` …) this ECU did not answer, or that the run stopped on; later ranges stay `support_unknown`. */
  supportProblems: BitmapProblem[];
  /** `020200`, read only when the ECU's $02 bitmap lists PID 02. */
  storedDtc: EcuRead<FreezeFrameDtc>;
  /** `stored` / `none_stored` from `020200`; `unknown` when it was not read or failed. */
  frame: "stored" | "none_stored" | "unknown";
  values: Array<
    EcuRead<Unverified<FreezeFrameValue>> & {
      pid: number;
      /** When CarCode read this value (its `02` request ended), not when the ECU captured the frame; null when it was not read. */
      readAt: string | null;
    }
  >;
};

export type CurrentReading = EcuRead<Unverified<LiveValue>> & { pid: number; at: string };

export type EcuCapabilities = EcuIdentity & {
  currentDataPids: number[];
  currentDataSupportKnownUpTo: number | null;
  readiness: SupportStatus;
  vin: SupportStatus;
  freezeFrame: "bitmap_read" | "declined" | "support_unknown" | "not_read";
  dtcServices: Record<DtcService, EcuReadOutcome>;
};

export type ScanSectionState = "done" | "not_run" | "interrupted";

export type ScanReport = {
  kind: "scan";
  scannerVersion: string;
  scanNumber: number;
  startedAt: string;
  endedAt: string;
  ended: ScanEndReason;
  endDetail: string | null;
  /** Generic OBD can never show every module answered. */
  completeness: "partial";
  diagnosticUse: "display_only";
  verification: { pidTable: typeof PID_TABLE_REVIEW; readinessTable: typeof READINESS_TABLE_REVIEW };
  /** The discovery this scan relied on (module coverage = its ECUs). */
  discovery: DiscoveryReport;
  sections: Record<"readiness" | "dtcs" | "freeze_frame" | "current_data", ScanSectionState>;
  readiness: ReadinessEntry[];
  dtcs: {
    ecus: EcuDtcs[];
    /** Services that answered `ok` for every discovered ECU. Only these could ever say "this status was reported". */
    servicesOkForEveryEcu: DtcService[];
    countChecks: DtcCountCheck[];
  };
  freezeFrames: FreezeFrameEntry[];
  currentData: CurrentReading[];
  capabilities: EcuCapabilities[];
  steps: StepRecord[];
};

/**
 * One polling cycle. `complete: false` when the run stopped part-way: the
 * readings already taken are kept, the stopping read shows its outcome with no
 * value, and PIDs after it have no entry.
 */
export type LiveCycle = { cycle: number; startedAt: string; complete: boolean; readings: CurrentReading[] };

export type LiveReport = {
  kind: "live";
  startedAt: string;
  endedAt: string;
  ended: ScanEndReason;
  endDetail: string | null;
  diagnosticUse: "display_only";
  verification: { pidTable: typeof PID_TABLE_REVIEW };
  selection: Array<EcuIdentity & { pid: number }>;
  cyclesRequested: number;
  cycles: LiveCycle[];
  steps: StepRecord[];
};

/** A copy that can never change (scan-flow.md: nothing in a report is rewritten after it ends). */
export function sealed<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown) => {
    if (item && typeof item === "object" && !Object.isFrozen(item)) {
      Object.freeze(item);
      for (const child of Object.values(item)) freeze(child);
    }
  };
  freeze(copy);
  return copy;
}
