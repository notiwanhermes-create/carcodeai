/**
 * Structured trouble-code and snapshot evidence (V2D).
 *
 * RESEARCH PROTOTYPE. Deterministic and offline: no code definitions, no
 * manufacturer meanings, no vehicle communication. Codes are normalized only
 * where the transformation is unambiguous, invalid input is refused rather
 * than repaired, and the raw text is always kept.
 */
import {
  COMPLETENESS,
  DTC_STATUS_FLAGS,
  UNITS,
  type Completeness,
  type DiagnosticScanInput,
  type DtcFormat,
  type DtcMatcher,
  type DtcObservation,
  type DtcStatusFlag,
  type Evidence,
  type ModuleOrigin,
  type ObdSystem,
  type ScanRecord,
  type SnapshotParameter,
  type SnapshotRecord,
} from "./types";
import { normalizeText } from "./context";

/** The standard five-character form: system letter, then 0-3, then three hex digits. */
const OBD_FORM = /^[PBCU][0-3][0-9A-F]{3}$/;
/** An opaque or unclassified identifier: one token, no spaces or control characters. */
const OPAQUE_FORM = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,31}$/;
const GENERIC_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const SCAN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SYSTEMS: Record<string, ObdSystem> = { P: "powertrain", B: "body", C: "chassis", U: "network" };

export type NormalizedCode = { raw: string; code: string; format: DtcFormat; system?: ObdSystem };

/**
 * A code in its canonical form, or why it is refused.
 * - declared "obd": must be in the OBD form once trimmed and upper-cased.
 * - declared "opaque": kept exactly (trimmed); must be one token.
 * - not declared: the OBD form is recognized (case-insensitively); anything
 *   else that is one token is kept as unclassified.
 */
export function normalizeCode(raw: unknown, declared?: "obd" | "opaque"): { ok: true; value: NormalizedCode } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "a code must be text" };
  const trimmed = raw.trim();
  if (declared !== undefined && declared !== "obd" && declared !== "opaque") return { ok: false, error: `unknown code format "${String(declared)}"` };
  const upper = trimmed.toUpperCase();
  if (declared === "obd" || (declared === undefined && OBD_FORM.test(upper))) {
    if (!OBD_FORM.test(upper)) return { ok: false, error: `"${raw}" is not a standard P/B/C/U code` };
    return { ok: true, value: { raw, code: upper, format: "obd", system: SYSTEMS[upper[0]] } };
  }
  if (!OPAQUE_FORM.test(trimmed)) return { ok: false, error: `"${raw}" is not a usable code identifier` };
  return { ok: true, value: { raw, code: trimmed, format: declared === "opaque" ? "opaque" : "unclassified" } };
}

/** How a workflow's code (in a matcher or a criterion) is compared: OBD-form codes match only OBD observations. */
export function workflowCodeKey(code: string): { format: "obd" | "other"; code: string } | null {
  const n = normalizeCode(code);
  if (!n.ok) return null;
  return n.value.format === "obd" ? { format: "obd", code: n.value.code } : { format: "other", code: n.value.code };
}

function normalizeModule(m: unknown): { ok: true; value?: ModuleOrigin } | { ok: false; error: string } {
  if (m === undefined) return { ok: true };
  const x = m as ModuleOrigin;
  if (!x || typeof x !== "object" || typeof x.id !== "string") return { ok: false, error: "a module needs an id" };
  const id = normalizeText(x.id);
  if (!GENERIC_ID.test(id)) return { ok: false, error: `module id "${x.id}" must be a generic identifier` };
  if (x.name !== undefined && (typeof x.name !== "string" || !x.name.trim() || x.name.length > 64)) return { ok: false, error: "a module name must be short text" };
  const extra = Object.keys(x).filter((k) => k !== "id" && k !== "name");
  if (extra.length) return { ok: false, error: `module has unsupported fields: ${extra.join(", ")}` };
  return { ok: true, value: { id, ...(x.name !== undefined ? { name: x.name.trim() } : {}) } };
}

function flags(value: unknown, what: string): { ok: true; value: DtcStatusFlag[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: `${what} must be a non-empty list` };
  if (value.some((f) => !(DTC_STATUS_FLAGS as readonly string[]).includes(f))) return { ok: false, error: `${what} has an unknown flag (known: ${DTC_STATUS_FLAGS.join(", ")})` };
  if (new Set(value).size !== value.length) return { ok: false, error: `${what} repeats a flag` };
  return { ok: true, value: [...value] as DtcStatusFlag[] };
}

function snapshotParameter(p: unknown, at: string): { ok: true; value: SnapshotParameter } | { ok: false; error: string } {
  const x = p as SnapshotParameter;
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !GENERIC_ID.test(x.id)) return { ok: false, error: `${at}: a parameter needs a generic lower-case id` };
  if (x.value !== undefined) {
    if (typeof x.value === "number" && !Number.isFinite(x.value)) return { ok: false, error: `${at}: "${x.id}" is not a finite number` };
    if (typeof x.value === "string" && (!x.value.trim() || x.value.length > 64)) return { ok: false, error: `${at}: "${x.id}" text must be short and not blank` };
    if (typeof x.value !== "number" && typeof x.value !== "string") return { ok: false, error: `${at}: "${x.id}" must be a number or text` };
  }
  if (x.unit !== undefined) {
    if (!(UNITS as readonly string[]).includes(x.unit)) return { ok: false, error: `${at}: "${x.id}" has an unknown unit` };
    if (typeof x.value !== "number") return { ok: false, error: `${at}: "${x.id}" has a unit but no number` };
  }
  return { ok: true, value: { id: x.id, ...(x.value !== undefined ? { value: x.value } : {}), ...(x.unit !== undefined ? { unit: x.unit } : {}) } };
}

export type NormalizedScan = { record: ScanRecord; source: "scan_tool" | "person"; codes: DtcObservation[]; snapshots: SnapshotRecord[] };

/**
 * Check one scan and put it in recorded form. `usedIds` holds the scan and
 * snapshot ids the session already has; a repeat is refused, so a later scan
 * can never replace an earlier one.
 */
export function normalizeScan(input: unknown, usedIds: { scans: Set<string>; snapshots: Set<string> }): { ok: true; value: NormalizedScan } | { ok: false; error: string } {
  const s = input as DiagnosticScanInput;
  if (!s || typeof s !== "object") return { ok: false, error: "a scan must be an object" };
  if (typeof s.id !== "string" || !SCAN_ID.test(s.id)) return { ok: false, error: "a scan needs an id" };
  const at = `scan "${s.id}"`;
  if (usedIds.scans.has(s.id)) return { ok: false, error: `${at} is already in this session; new evidence needs a new scan id` };
  if (s.source !== "scan_tool" && s.source !== "person") return { ok: false, error: `${at}: source must be scan_tool or person` };
  if (!(COMPLETENESS as readonly string[]).includes(s.completeness)) return { ok: false, error: `${at}: completeness must be ${COMPLETENESS.join(", ")}` };
  let coverage: { modules: string[] } | undefined;
  if (s.coverage !== undefined) {
    const mods = s.coverage?.modules;
    if (!Array.isArray(mods) || mods.length === 0 || mods.some((m) => typeof m !== "string" || !GENERIC_ID.test(normalizeText(m)))) return { ok: false, error: `${at}: coverage needs generic module ids` };
    coverage = { modules: mods.map(normalizeText) };
  }
  let reports: DtcStatusFlag[] | undefined;
  if (s.reportsStatus !== undefined) {
    const f = flags(s.reportsStatus, `${at}: reportsStatus`);
    if (!f.ok) return f;
    reports = f.value;
  }
  if (!Array.isArray(s.codes)) return { ok: false, error: `${at}: codes must be a list (empty for a scan with no codes)` };
  const extra = Object.keys(s).filter((k) => !["id", "source", "completeness", "coverage", "reportsStatus", "codes", "snapshots"].includes(k));
  if (extra.length) return { ok: false, error: `${at}: unsupported fields: ${extra.join(", ")}` };

  // Snapshots first, so codes can reference them.
  const snapshots: SnapshotRecord[] = [];
  for (const raw of s.snapshots ?? []) {
    const snap = raw as SnapshotRecord;
    if (!snap || typeof snap.id !== "string" || !SCAN_ID.test(snap.id)) return { ok: false, error: `${at}: a snapshot needs an id` };
    if (usedIds.snapshots.has(snap.id) || snapshots.some((x) => x.id === snap.id)) return { ok: false, error: `${at}: snapshot "${snap.id}" is already in this session` };
    if (!Array.isArray(snap.parameters) || snap.parameters.length === 0) return { ok: false, error: `${at}: snapshot "${snap.id}" has no parameters` };
    const params: SnapshotParameter[] = [];
    for (const p of snap.parameters) {
      const r = snapshotParameter(p, `${at} snapshot "${snap.id}"`);
      if (!r.ok) return r;
      if (params.some((x) => x.id === r.value.id)) return { ok: false, error: `${at}: snapshot "${snap.id}" repeats "${r.value.id}"` };
      params.push(r.value);
    }
    const completeness = snap.completeness ?? "unknown";
    if (!(COMPLETENESS as readonly string[]).includes(completeness)) return { ok: false, error: `${at}: snapshot "${snap.id}" has an unknown completeness` };
    let captured: SnapshotRecord["captured"];
    if (snap.captured !== undefined) {
      const c = snap.captured;
      if (!c || typeof c !== "object" || (c.at !== undefined && typeof c.at !== "string") || (c.order !== undefined && (!Number.isInteger(c.order) || c.order < 0))) {
        return { ok: false, error: `${at}: snapshot "${snap.id}" capture time must be text and order a whole number` };
      }
      captured = { ...(c.at !== undefined ? { at: c.at } : {}), ...(c.order !== undefined ? { order: c.order } : {}) };
    }
    snapshots.push({ id: snap.id, scan: s.id, ...(captured ? { captured } : {}), completeness, parameters: params });
  }

  const codes: DtcObservation[] = [];
  for (const raw of s.codes) {
    const c = raw as DiagnosticScanInput["codes"][number];
    if (!c || typeof c !== "object") return { ok: false, error: `${at}: a code entry must be an object` };
    const n = normalizeCode(c.code, c.format);
    if (!n.ok) return { ok: false, error: `${at}: ${n.error}` };
    let status: DtcStatusFlag[] | "unknown" = "unknown";
    if (c.status !== undefined) {
      const f = flags(c.status, `${at}: ${n.value.code} status`);
      if (!f.ok) return f;
      // A source cannot report a flag it does not support; "active" needs the source to say it supports it.
      const outside = f.value.filter((flag) => (reports ? !reports.includes(flag) : flag === "active"));
      if (outside.length) return { ok: false, error: `${at}: ${n.value.code} reports ${outside.join(", ")}, which this source does not declare it reports` };
      status = f.value;
    }
    const mod = normalizeModule(c.module);
    if (!mod.ok) return { ok: false, error: `${at}: ${mod.error}` };
    if (c.snapshot !== undefined && !snapshots.some((x) => x.id === c.snapshot)) return { ok: false, error: `${at}: ${n.value.code} refers to snapshot "${String(c.snapshot)}", which this scan does not include` };
    if (codes.some((o) => o.code === n.value.code && o.format === n.value.format && o.module?.id === mod.value?.id)) return { ok: false, error: `${at}: ${n.value.code} is listed twice` };
    codes.push({ ...n.value, status, ...(mod.value ? { module: mod.value } : {}), ...(c.snapshot !== undefined ? { snapshot: c.snapshot } : {}), scan: s.id });
  }
  for (const snap of snapshots) {
    const owners = codes.filter((c) => c.snapshot === snap.id);
    if (owners.length > 1) return { ok: false, error: `${at}: snapshot "${snap.id}" is referenced by more than one code` };
    if (owners.length === 1) snap.forCode = owners[0].code;
  }
  return {
    ok: true,
    value: {
      record: { id: s.id, completeness: s.completeness, ...(coverage ? { coverage } : {}), ...(reports ? { reportsStatus: reports } : {}), codeCount: codes.length },
      source: s.source,
      codes,
      snapshots,
    },
  };
}

/* ───────────────────────── matching (three-valued) ───────────────────────── */

export type Tri = true | false | null;

type CodeEvidence = { dtc: DtcObservation; scan: ScanRecord };

/** The code evidence and scans of one phase, in recorded order. */
export function codeEvidence(evidence: readonly Evidence[], phase: Evidence["phase"]): { codes: CodeEvidence[]; scans: ScanRecord[] } {
  const scans = evidence.filter((e) => e.kind === "scan" && e.phase === phase && e.scanInfo).map((e) => e.scanInfo!);
  const byId = new Map(scans.map((s) => [s.id, s]));
  const codes = evidence.filter((e) => e.kind === "code" && e.phase === phase && e.dtc && byId.has(e.dtc.scan)).map((e) => ({ dtc: e.dtc!, scan: byId.get(e.dtc!.scan)! }));
  return { codes, scans };
}

function codeMatches(m: DtcMatcher, d: DtcObservation): boolean {
  if (m.code === undefined) return true;
  const targets = Array.isArray(m.code) ? m.code : [m.code];
  return targets.some((t) => {
    const key = workflowCodeKey(t);
    if (!key) return false;
    return key.format === "obd" ? d.format === "obd" && d.code === key.code : d.format !== "obd" && d.code === key.code;
  });
}

/** Whether a complete scan covers the question, so a code it does not list is really absent. */
function absenceProvable(scans: ScanRecord[], m: DtcMatcher): boolean {
  const wanted = m.module !== undefined ? normalizeText(m.module) : undefined;
  return scans.some((s) => s.completeness === "complete" && (!s.coverage || (wanted !== undefined && s.coverage.modules.includes(wanted))));
}

/**
 * Is a matching code present? true: reported. false: provably absent (or
 * provably without the asked status). null: cannot tell from the evidence.
 */
export function matchDtc(evidence: readonly Evidence[], m: DtcMatcher): Tri {
  const { codes, scans } = codeEvidence(evidence, "before_repair");
  const wanted = m.module !== undefined ? normalizeText(m.module) : undefined;
  const sameCode = codes.filter((c) => codeMatches(m, c.dtc));
  const hits = sameCode.filter((c) => wanted === undefined || c.dtc.module?.id === wanted);
  // A matching code whose module is unknown might be from the asked module: no definite answer from it.
  const unplaced = wanted !== undefined && sameCode.some((c) => c.dtc.module === undefined);

  if (m.status === undefined) {
    if (hits.length) return true;
    if (unplaced) return null;
    return absenceProvable(scans, m) ? false : null;
  }
  const status = m.status;
  if (hits.some((c) => c.dtc.status !== "unknown" && c.dtc.status.includes(status))) return true;
  if (unplaced) return null;
  // Every observation shows the flag is absent only if its status is known AND its source reports that flag.
  const allLackIt = hits.every((c) => c.dtc.status !== "unknown" && (c.scan.reportsStatus ?? []).includes(status));
  return allLackIt && absenceProvable(scans, m) ? false : null;
}

/* ───────────────────────── repair verification ───────────────────────── */

/** Flags that mean the fault is still being detected. permanent / history alone do not. */
const STILL_DETECTED: readonly DtcStatusFlag[] = ["pending", "confirmed", "active"];

/**
 * Judge "the codes do not come back" from a post-repair scan.
 * - any target still pending, confirmed or active: not_met;
 * - any target still listed only as permanent or history, or with unknown status: inconclusive
 *   (a permanent code can remain after a good repair until the vehicle clears it);
 * - none listed: met only if the scan is complete and covers them; otherwise inconclusive
 *   ("not observed in the supplied evidence" is not "absent").
 */
export function codesAbsentVerdict(
  targets: Array<{ format: "obd" | "other"; code: string; module?: string }>,
  scan: NormalizedScan,
): { result: "met" | "not_met" | "inconclusive"; detail: string } {
  const listed = (t: (typeof targets)[number]) =>
    scan.codes.filter((c) => (t.format === "obd" ? c.format === "obd" : c.format !== "obd") && c.code === t.code && (t.module === undefined || c.module?.id === t.module || c.module === undefined));
  const present = targets.flatMap((t) => listed(t));
  const detected = present.filter((c) => c.status !== "unknown" && c.status.some((f) => STILL_DETECTED.includes(f)));
  if (detected.length) return { result: "not_met", detail: `${detected.map((c) => `${c.code} ${(c.status as DtcStatusFlag[]).join("+")}`).join(", ")} still reported` };
  if (present.length) {
    return { result: "inconclusive", detail: `${present.map((c) => `${c.code} ${c.status === "unknown" ? "status unknown" : c.status.join("+")}`).join(", ")} still listed; not proof the repair failed` };
  }
  const covered =
    scan.record.completeness === "complete" && (!scan.record.coverage || targets.every((t) => t.module !== undefined && scan.record.coverage!.modules.includes(t.module)));
  if (covered) return { result: "met", detail: `complete scan "${scan.record.id}" does not report ${targets.map((t) => t.code).join(", ")}` };
  return { result: "inconclusive", detail: `${scan.record.completeness} scan "${scan.record.id}": not observed in the supplied evidence, which cannot show absence` };
}

export const isCompleteness = (x: unknown): x is Completeness => (COMPLETENESS as readonly string[]).includes(x as string);
