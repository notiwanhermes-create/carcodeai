/**
 * Running a guided diagnostic workflow.
 *
 * RESEARCH PROTOTYPE: not used by any route or page.
 *
 * - Deterministic: no clock, no randomness, no network, no AI. Timestamps are
 *   whatever the caller passes in.
 * - Immutable: every call returns a new session. Recorded evidence is frozen
 *   and never changed or removed.
 * - Safe by construction: a step above the person's skill level, or needing a
 *   tool they do not have, is never presented to them. The workflow goes to
 *   that step's "cannot be done" route instead (usually: have a professional
 *   check it).
 * - Honest (V2A): a result that does not decide anything is recorded as
 *   inconclusive and rules nothing in or out; an implausible reading is
 *   refused, not judged; only VERIFIED specifications may decide pass or
 *   fail, causes or routes (anything else is shown, never used); every
 *   judgement records the specifications involved and their trust; evidence
 *   says whether it was gathered before or after the repair, and who
 *   produced it.
 */
import {
  INCONCLUSIVE_REASONS,
  SKILL_ORDER,
  type DiagnosticCapabilityContext,
  type CauseEffect,
  type CauseId,
  type Condition,
  type ConditionId,
  type DiagnosticSession,
  type DiagnosticSpecification,
  type EvidenceConflict,
  type EngineOptions,
  type Evidence,
  type EvidenceSource,
  type InputSource,
  type MeasurementNode,
  type MeasurementOutcome,
  type NodeId,
  type NumericRange,
  type RepairVerificationNode,
  type SnapshotCheckNode,
  type SessionStartFacts,
  type SpecRelation,
  type SpecTrust,
  type SpecificationReference,
  type SpecificationResolution,
  type StepInput,
  type StepResult,
  type Unit,
  type VerificationEntry,
  type WorkflowDefinition,
  type WorkflowNode,
} from "./types";
import { convert, isUnit } from "./units";
import { forwardSuccessors, regionReturns, validateWorkflow } from "./validate";
import { describeResolution, pinnedSpecificationProvider, resolveSpecification } from "./specifications";
import { capabilityProblem, capabilityShortfall, checkApplicability, normalizeText, normalizeVehicleContext } from "./context";
import { codeEvidence, codesAbsentVerdict, normalizeScan, workflowCodeKey, type NormalizedScan } from "./dtc";
import { holds, unknownVehicleFacts } from "./conditions";
import { analyzeRegion, buildRecheckPlan, toRecommendations, type NextBestTests, type RecheckPlan } from "./next-best-test";

/** A guard on top of the no-loops check: no run may take more automatic steps than this. */
export const MAX_AUTOMATIC_STEPS = 500;

const fail = (error: string): StepResult => ({ ok: false, error });

/** Plain data, deep-copied and frozen. */
function frozen<T>(value: T): T {
  const freeze = (v: unknown): unknown => {
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) freeze((v as Record<string, unknown>)[k]);
      Object.freeze(v);
    }
    return v;
  };
  return freeze(JSON.parse(JSON.stringify(value))) as T;
}

/* ───────────────────────── workflow lookup ───────────────────────── */

type Prepared = { workflow: WorkflowDefinition; byId: Map<NodeId, WorkflowNode>; start: WorkflowNode; returns: Map<NodeId, NodeId> };
const prepared = new WeakMap<WorkflowDefinition, Prepared | { error: string }>();

/** The workflow, checked once and indexed. A workflow that fails the check can never be run. */
function prepare(workflow: WorkflowDefinition): Prepared | { error: string } {
  const known = prepared.get(workflow);
  if (known) return known;
  const check = validateWorkflow(workflow);
  const result = check.ok
    ? (() => {
        const byId = new Map(workflow.nodes.map((n) => [n.id, n] as const));
        return { workflow, byId, start: workflow.nodes.find((n) => n.type === "start")!, returns: regionReturns(workflow.nodes) };
      })()
    : { error: `invalid_workflow: ${check.problems.map((p) => p.code).join(", ")}` };
  prepared.set(workflow, result);
  return result;
}

/* ───────────────────────── specifications ───────────────────────── */

/** Only a verified specification may drive the engine. Everything else is informational. */
export const isTrustedSpec = (trust: SpecTrust) => trust === "verified";

function inRange(value: number, range: NumericRange): boolean {
  if (range.min !== undefined && (range.minInclusive === false ? value <= range.min : value < range.min)) return false;
  if (range.max !== undefined && (range.maxInclusive === false ? value >= range.max : value > range.max)) return false;
  return true;
}

function conditionState(session: DiagnosticSession, id: ConditionId): "met" | "not_met" | "unknown" {
  if (session.establishedConditions.includes(id)) return "met";
  if (session.refutedConditions.includes(id)) return "not_met";
  return "unknown";
}

type UnsupportedSpecReason = "spec_not_found" | "spec_ambiguous" | "spec_unavailable" | "spec_incompatible_unit";

type Usable =
  | { ok: true; status: "verified" | "informational"; spec: DiagnosticSpecification; expected: { min?: number; max?: number }; plausible?: { min: number; max: number } }
  | { ok: false; reason: UnsupportedSpecReason };

/**
 * Whether a step can use its pinned specification at all, with the values
 * converted into the step's unit. Only the same kind of quantity converts.
 */
/** Steps that judge a value like a measurement: a live reading, or one snapshot parameter. */
type JudgedNode = MeasurementNode | SnapshotCheckNode;

function usable(node: JudgedNode, r: SpecificationResolution | undefined): Usable {
  if (!r || r.status === "unavailable") return { ok: false, reason: "spec_unavailable" };
  if (r.status === "not_found") return { ok: false, reason: "spec_not_found" };
  if (r.status === "ambiguous") return { ok: false, reason: "spec_ambiguous" };
  const spec = r.specification;
  const to = node.measurement.unit;
  const conv = (n: number | undefined) => (n === undefined ? undefined : convert(n, spec.unit, to));
  const min = conv(spec.expected.min);
  const max = conv(spec.expected.max);
  if (min === null || max === null) return { ok: false, reason: "spec_incompatible_unit" };
  let plausible: { min: number; max: number } | undefined;
  if (spec.plausible) {
    const pmin = convert(spec.plausible.min, spec.unit, to);
    const pmax = convert(spec.plausible.max, spec.unit, to);
    if (pmin === null || pmax === null) return { ok: false, reason: "spec_incompatible_unit" };
    plausible = { min: pmin, max: pmax };
  }
  return { ok: true, status: r.status, spec, expected: { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) }, ...(plausible ? { plausible } : {}) };
}

type Judged =
  | { ok: false; error: string }
  | { ok: true; status: "unusable"; reason: UnsupportedSpecReason }
  | { ok: true; status: "unjudged"; value: number; reason: "untrusted_spec" | "condition_not_met" | "condition_unknown"; specification: SpecificationReference }
  | { ok: true; status: "evaluated"; value: number; outcome: MeasurementOutcome | null; range: string; relation?: SpecRelation; specification?: SpecificationReference };

/**
 * A reading checked against the step: right kind of unit and physically
 * plausible (generic limits, plus a verified specification's own plausible
 * range), then judged. With a specification, the reading is judged ONLY when
 * the specification is verified and every condition it requires is
 * established; otherwise it is recorded but left unjudged, with the reason.
 */
function judge(node: JudgedNode, raw: number, unit: Unit, session: DiagnosticSession): Judged {
  if (!isUnit(unit) || typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false, error: "invalid_measurement" };
  const value = convert(raw, unit, node.measurement.unit);
  if (value === null) return { ok: false, error: `wrong_unit: this step measures in ${node.measurement.unit}` };
  const { min, max } = node.measurement.plausible;
  if (value < min || value > max) return { ok: false, error: `implausible_measurement: ${value} ${node.measurement.unit} is outside ${min}–${max} ${node.measurement.unit}; check the reading` };

  if (!node.specification) {
    const outcome = node.outcomes.find((o) => !("relativeToSpec" in o.when) && inRange(value, o.when as NumericRange)) ?? null;
    return { ok: true, status: "evaluated", value, outcome, range: outcome?.id ?? "otherwise" };
  }

  const u = usable(node, session.specifications[node.specification]);
  if (!u.ok) return { ok: true, status: "unusable", reason: u.reason };
  const trusted = u.status === "verified";
  if (trusted && u.plausible && (value < u.plausible.min || value > u.plausible.max)) {
    return { ok: false, error: `implausible_measurement: ${value} ${node.measurement.unit} is outside this specification's plausible ${u.plausible.min}–${u.plausible.max} ${node.measurement.unit}; check the reading` };
  }
  const specification: SpecificationReference = {
    id: u.spec.id,
    revision: u.spec.revision,
    status: u.status,
    trust: u.spec.trust,
    source: { ...u.spec.source },
    sourceUnit: u.spec.unit,
    expected: u.expected,
    conditions: (u.spec.conditions ?? []).map((id) => ({ id, state: conditionState(session, id) })),
  };
  if (!trusted) return { ok: true, status: "unjudged", value, reason: "untrusted_spec", specification };
  if (specification.conditions.some((c) => c.state === "not_met")) return { ok: true, status: "unjudged", value, reason: "condition_not_met", specification };
  if (specification.conditions.some((c) => c.state === "unknown")) return { ok: true, status: "unjudged", value, reason: "condition_unknown", specification };
  const relation: SpecRelation = u.expected.min !== undefined && value < u.expected.min ? "below" : u.expected.max !== undefined && value > u.expected.max ? "above" : "within";
  const outcome = node.outcomes.find((o) => "relativeToSpec" in o.when && o.when.relativeToSpec === relation) ?? null;
  return { ok: true, status: "evaluated", value, outcome, range: outcome?.id ?? "otherwise", relation, specification };
}

/* ───────────────────────── helpers ───────────────────────── */

/** Whether the person's declared capabilities cover a step (skill, scan access, instruments, facilities). */
const canDo = (node: WorkflowNode, capabilities: DiagnosticCapabilityContext) => capabilityShortfall(node.requires, capabilities);

/**
 * Which way an automatic branch goes. The first rule that is definitely true
 * wins. A rule that cannot be evaluated because a vehicle fact is unknown
 * stops the search: going on to a later rule, or to `otherwise`, would treat
 * "unknown" as "no". The branch then takes its inconclusive route. (A rule
 * left unknown by incomplete scan evidence is passed over, as before: its
 * absence is never concluded.)
 */
function chooseRoute(node: Extract<WorkflowNode, { type: "branch" }>, session: DiagnosticSession): { index: number } | { otherwise: true } | { unknown: string[] } {
  for (let i = 0; i < node.rules.length; i++) {
    const result = holds(node.rules[i].if, session);
    if (result === true) return { index: i };
    if (result === null) {
      const missing = unknownVehicleFacts(node.rules[i].if, session);
      if (missing.length) return { unknown: [...new Set(missing)] };
    }
  }
  return { otherwise: true };
}

/* ───────────────────────── reachability ───────────────────────── */

export type Reachability = "reachable" | "potential" | "unreachable";

/**
 * A condition judged now, without future answers: true / false, "open" (it
 * depends on answers not given yet), or unknown because of missing context
 * (a vehicle fact, or scan evidence too incomplete to show absence). The
 * pinned vehicle and start scans do not change during a session, so missing
 * context stays missing until a new session supplies it.
 */
type StaticValue = true | false | "open" | "unknown_dtc" | "unknown_vehicle";

function staticValue(c: Condition, session: DiagnosticSession): StaticValue {
  if ("answered" in c || "established" in c) return "open";
  if ("vehicle" in c) {
    const v = holds(c, session);
    return v === null ? "unknown_vehicle" : v;
  }
  if ("dtc" in c || "noDtc" in c || "symptomAny" in c) {
    const v = holds(c, session);
    return v === null ? "unknown_dtc" : v;
  }
  if ("not" in c) {
    const v = staticValue(c.not, session);
    return v === true ? false : v === false ? true : v;
  }
  const parts = ("all" in c ? c.all : c.any).map((x) => staticValue(x, session));
  const decisive = "all" in c ? false : true;
  if (parts.includes(decisive)) return decisive;
  for (const v of ["unknown_vehicle", "unknown_dtc", "open"] as const) if (parts.includes(v)) return v;
  return !decisive;
}

/** Each way out of a branch, and whether this session can take it. */
function branchEdges(node: Extract<WorkflowNode, { type: "branch" }>, session: DiagnosticSession): Array<{ to: NodeId; status: Reachability }> {
  const out: Array<{ to: NodeId; status: Reachability }> = [];
  let blocked = false; // an earlier rule is definitely true
  let pending = false; // an earlier rule stops on a missing vehicle fact
  for (const rule of node.rules) {
    if (blocked) {
      out.push({ to: rule.to, status: "unreachable" });
      continue;
    }
    const v = staticValue(rule.if, session);
    if (v === true) {
      out.push({ to: rule.to, status: pending ? "potential" : "reachable" });
      blocked = true;
    } else if (v === false) out.push({ to: rule.to, status: "unreachable" });
    else if (v === "open") out.push({ to: rule.to, status: pending ? "potential" : "reachable" });
    else {
      // Missing context: this rule cannot fire in this session, but would be possible with that context.
      out.push({ to: rule.to, status: "potential" });
      if (v === "unknown_vehicle") pending = true;
    }
  }
  out.push({ to: node.otherwise, status: blocked ? "unreachable" : pending ? "potential" : "reachable" });
  if (node.ifInconclusive) out.push({ to: node.ifInconclusive, status: pending ? "reachable" : "unreachable" });
  return out;
}

const RANK: Record<Reachability, number> = { unreachable: 0, potential: 1, reachable: 2 };

/**
 * From where the session stands, whether each step can still be reached:
 * "reachable" (some route this session can take leads there), "potential"
 * (only if missing context, such as an unknown vehicle fact or an incomplete
 * scan, were known) or "unreachable" (no route leads there). Only branches on
 * fixed facts prune; answers not given yet keep every route open.
 */
export function stepReachability(workflow: WorkflowDefinition, session: DiagnosticSession): Map<NodeId, Reachability> {
  const p = prepare(workflow);
  const out = new Map<NodeId, Reachability>();
  if ("error" in p || session.currentNodeId === null) return out;
  for (const node of p.workflow.nodes) out.set(node.id, "unreachable");
  // Workflows have no loops, so a depth-first post-order gives a topological order.
  const order: NodeId[] = [];
  const seen = new Set<NodeId>();
  const visit = (id: NodeId): void => {
    if (seen.has(id) || !p.byId.has(id)) return;
    seen.add(id);
    for (const next of forwardSuccessors(p.byId.get(id)!, p.returns)) visit(next);
    order.push(id);
  };
  visit(session.currentNodeId);
  out.set(session.currentNodeId, "reachable");
  for (const id of order.reverse()) {
    const here = out.get(id)!;
    if (here === "unreachable") continue;
    const node = p.byId.get(id)!;
    const edges =
      node.type === "branch"
        ? branchEdges(node, session)
        : node.type === "test_selection"
          ? [
              // A candidate is reachable when its guard holds, potential when the guard is unknown (missing context), unreachable when it fails.
              ...node.candidates.map((c) => {
                const v = c.when === undefined ? true : holds(c.when, session);
                return { to: c.step, status: (v === true ? "reachable" : v === null ? "potential" : "unreachable") as Reachability };
              }),
              { to: node.next, status: "reachable" as Reachability },
            ]
          : forwardSuccessors(node, p.returns).map((to) => ({ to, status: "reachable" as Reachability }));
    for (const edge of edges) {
      const via: Reachability = RANK[edge.status] < RANK[here] ? edge.status : here;
      if (RANK[via] > RANK[out.get(edge.to)!]) out.set(edge.to, via);
    }
  }
  return out;
}


/** Record one normalized scan: the scan, then its codes, then its snapshots, all in the current phase. */
function recordScan(session: DiagnosticSession, nodeId: NodeId, scan: NormalizedScan, to: NodeId, at?: string): DiagnosticSession {
  const stamp = at ? { at } : {};
  let next = record(session, { nodeId, kind: "scan", value: scan.record.id, scanInfo: scan.record, source: scan.source, to, ...stamp });
  for (const dtc of scan.codes) next = record(next, { nodeId, kind: "code", value: dtc.code, dtc, source: scan.source, to, ...stamp });
  for (const snapshot of scan.snapshots) next = record(next, { nodeId, kind: "snapshot", value: snapshot.id, snapshot, source: scan.source, to, ...stamp });
  return next;
}

/** Scan and snapshot ids already in the session. */
function usedIds(session: DiagnosticSession) {
  return {
    scans: new Set(session.evidence.filter((e) => e.kind === "scan").map((e) => e.value)),
    snapshots: new Set(session.evidence.filter((e) => e.kind === "snapshot").map((e) => e.value)),
  };
}

type SnapshotRead = { ok: true; snapshot: string; parameter: string; value: number; unit: Unit } | { ok: false; reason: string; snapshot?: string; value?: number | string; unit?: Unit };

/** The parameter a snapshot_check reads, from the before-repair snapshots only. Never guessed. */
function readSnapshot(session: DiagnosticSession, node: SnapshotCheckNode): SnapshotRead {
  const snaps = session.evidence.filter((e) => e.kind === "snapshot" && e.phase === "before_repair" && e.snapshot).map((e) => e.snapshot!);
  let snapshotId: string | undefined;
  if (node.from === "any") snapshotId = snaps[0]?.id;
  else {
    // The snapshot captured with the first matching code (in recorded order) that has one.
    const matcher = node.from.dtc;
    snapshotId = codeEvidence(session.evidence, "before_repair").codes.find((c) => c.dtc.snapshot && codeFits(matcher, c.dtc))?.dtc.snapshot;
  }
  const snap = snaps.find((x) => x.id === snapshotId);
  if (!snap) return { ok: false, reason: "no_snapshot" };
  const param = snap.parameters.find((x) => x.id === node.parameter);
  if (!param) return { ok: false, reason: "parameter_missing", snapshot: snap.id };
  if (param.value === undefined) return { ok: false, reason: "parameter_not_available", snapshot: snap.id };
  if (typeof param.value !== "number") return { ok: false, reason: "not_numeric", snapshot: snap.id, value: param.value };
  if (!param.unit) return { ok: false, reason: "no_unit", snapshot: snap.id, value: param.value };
  return { ok: true, snapshot: snap.id, parameter: param.id, value: param.value, unit: param.unit };
}

type DtcMatcherLike = { code?: string | string[]; status?: string; module?: string };

/** Whether one recorded code fits a matcher (code list, module, and reported status when asked). */
function codeFits(m: DtcMatcherLike, d: NonNullable<Evidence["dtc"]>): boolean {
  if (m.code !== undefined) {
    const targets = Array.isArray(m.code) ? m.code : [m.code];
    const hit = targets.some((t) => {
      const key = workflowCodeKey(t);
      return !!key && (key.format === "obd" ? d.format === "obd" : d.format !== "obd") && d.code === key.code;
    });
    if (!hit) return false;
  }
  if (m.module !== undefined && d.module?.id !== normalizeText(m.module)) return false;
  if (m.status !== undefined && (d.status === "unknown" || !d.status.includes(m.status as never))) return false;
  return true;
}

/** Who may have produced the input for a step of this type, and the default when the caller does not say. */
function sourcesFor(node: WorkflowNode, input: StepInput): { allowed: InputSource[]; fallback: InputSource } {
  if (input.kind === "unable") return { allowed: ["person"], fallback: "person" };
  // Actuator tests and service functions are run by an external tool; the result is the tool's report or the person's observation of it.
  if (node.type === "actuator_test" || node.type === "service_function") return { allowed: ["scan_tool", "person"], fallback: "scan_tool" };
  if (node.type === "measurement") return { allowed: ["instrument", "scan_tool"], fallback: "instrument" };
  if (node.type === "check" || node.type === "repair_verification") return { allowed: ["person", "instrument", "scan_tool"], fallback: "person" };
  return { allowed: ["person"], fallback: "person" };
}

function freezeSession(session: DiagnosticSession): DiagnosticSession {
  return Object.freeze({
    ...session,
    evidence: Object.freeze([...session.evidence]),
    inputs: Object.freeze([...session.inputs]),
    establishedConditions: Object.freeze([...session.establishedConditions]),
    refutedConditions: Object.freeze([...session.refutedConditions]),
    specifications: Object.freeze({ ...session.specifications }),
    remainingCauses: Object.freeze([...session.remainingCauses]),
    supportedCauses: Object.freeze([...session.supportedCauses]),
  });
}

type NewEvidence = Omit<Evidence, "seq" | "phase">;

/** A new session with one more piece of evidence and its effect on the candidate causes and conditions. */
/** The cause effect an evidence record's result declares in the workflow (for explaining a conflict). */
function declaredEffect(byId: ReadonlyMap<NodeId, WorkflowNode>, e: Evidence): CauseEffect | undefined {
  const node = byId.get(e.nodeId);
  if (!node) return undefined;
  if (e.kind === "branch" && node.type === "branch") {
    const m = /^rule:(\d+)$/.exec(e.value);
    return m ? node.rules[Number(m[1]) - 1] : undefined;
  }
  if ((e.kind === "measurement" || e.kind === "snapshot_check") && (node.type === "measurement" || node.type === "snapshot_check")) {
    const j = e.judgement;
    return j?.evaluated ? node.outcomes.find((o) => o.id === j.range) : undefined;
  }
  if (["answer", "observation", "check", "actuator_test", "service_function"].includes(e.kind) && "outcomes" in node) {
    return (node.outcomes as Array<{ when: unknown } & CauseEffect>).find((o) => o.when === e.value);
  }
  return undefined;
}

const CONFLICT_EXPLANATION = "The evidence cannot be reconciled under this workflow's single-primary-fault assumption.";

/**
 * End the session as inconclusive because of conflicting evidence. The
 * conflicting evidence is already in the log; its effect is not applied, the
 * earlier cause state is kept as it was, and a conflict record says what
 * clashed with what. No cause wins, nothing is overwritten, no second fault
 * is assumed.
 */
function endInConflict(
  session: DiagnosticSession,
  nodeId: NodeId,
  evidenceSeq: number,
  items: Array<{ cause: CauseId; earlierState: "ruled_out" | "supported"; newEvidenceWould: "support" | "rule_out" | "conclude" }>,
  byId: ReadonlyMap<NodeId, WorkflowNode> | undefined,
  at?: string,
): DiagnosticSession {
  const causes = items.map((item) => ({
    ...item,
    earlierEvidence: byId
      ? session.evidence
          .filter((e) => e.seq < evidenceSeq || (item.newEvidenceWould === "conclude" && e.seq <= evidenceSeq))
          .filter((e) => {
            const eff = declaredEffect(byId, e);
            return item.earlierState === "ruled_out" ? eff?.rulesOut?.includes(item.cause) : eff?.supports?.includes(item.cause);
          })
          .map((e) => e.seq)
      : [],
  }));
  const conflict: EvidenceConflict = { evidenceSeq, nodeId, causes, assumption: "single_primary_fault", explanation: CONFLICT_EXPLANATION };
  const entry = frozen({
    nodeId,
    kind: "conflict",
    value: `conflict:${causes.map((c) => c.cause).join(",")}`,
    conflict,
    source: "engine",
    to: nodeId,
    ...(at ? { at } : {}),
    phase: session.phase,
    seq: session.evidence.length + 1,
  }) as Evidence;
  return { ...session, evidence: [...session.evidence, entry], status: "completed", currentNodeId: null, endResult: "inconclusive" };
}

function record(session: DiagnosticSession, entry: NewEvidence, effect: CauseEffect = {}, byId?: ReadonlyMap<NodeId, WorkflowNode>): DiagnosticSession {
  const evidence = frozen({ ...entry, phase: session.phase, seq: session.evidence.length + 1 }) as Evidence;
  // Single primary fault: a result that would support a ruled-out cause, or rule out a supported one, cannot be reconciled.
  const conflicts = [
    ...(effect.supports ?? []).filter((c) => !session.remainingCauses.includes(c)).map((cause) => ({ cause, earlierState: "ruled_out" as const, newEvidenceWould: "support" as const })),
    ...(effect.rulesOut ?? []).filter((c) => session.supportedCauses.includes(c)).map((cause) => ({ cause, earlierState: "supported" as const, newEvidenceWould: "rule_out" as const })),
  ];
  if (conflicts.length) return endInConflict({ ...session, evidence: [...session.evidence, evidence] }, entry.nodeId, evidence.seq, conflicts, byId, entry.at);
  const ruledOut = new Set(effect.rulesOut ?? []);
  const remainingCauses = session.remainingCauses.filter((id) => !ruledOut.has(id));
  const supportedCauses = [...session.supportedCauses];
  for (const id of effect.supports ?? []) if (remainingCauses.includes(id) && !supportedCauses.includes(id)) supportedCauses.push(id);
  // A condition is established, refuted (known not to hold) or unknown; the latest evidence about it wins.
  let establishedConditions = [...session.establishedConditions];
  let refutedConditions = [...session.refutedConditions];
  for (const c of entry.refuted ?? []) {
    establishedConditions = establishedConditions.filter((x) => x !== c);
    if (!refutedConditions.includes(c)) refutedConditions.push(c);
  }
  for (const c of entry.established ?? []) {
    refutedConditions = refutedConditions.filter((x) => x !== c);
    if (!establishedConditions.includes(c)) establishedConditions.push(c);
  }
  return {
    ...session,
    evidence: [...session.evidence, evidence],
    establishedConditions,
    refutedConditions,
    remainingCauses,
    supportedCauses: supportedCauses.filter((id) => remainingCauses.includes(id)),
  };
}

/**
 * Move from `nodeId` through every step that needs no input (branches,
 * conclusions, steps the person cannot do), stopping at the next step that
 * needs input, or at the end.
 */
/**
 * The session with `node`'s specification pinned: resolved once through the
 * provider and recorded as evidence. Already pinned means no new lookup.
 */
function pinSpecification(session: DiagnosticSession, node: JudgedNode, options: EngineOptions, at?: string): DiagnosticSession {
  const id = node.specification!;
  if (Object.prototype.hasOwnProperty.call(session.specifications, id)) return session;
  // The provider receives the session's PINNED vehicle context, never the currently selected vehicle.
  const resolution = resolveSpecification(options.specifications, id, session.facts.vehicle);
  const next = record(session, { nodeId: node.id, kind: "specification", specification: id, value: describeResolution(id, resolution), source: "specification_provider", to: node.id, ...(at ? { at } : {}) });
  return { ...next, specifications: { ...session.specifications, [id]: resolution } };
}

function advance(p: Prepared, from: DiagnosticSession, nodeId: NodeId, at: string | undefined, options: EngineOptions): StepResult {
  let session = from;
  let id = nodeId;
  const stamp = at ? { at } : {};
  for (let step = 0; step < MAX_AUTOMATIC_STEPS; step++) {
    // Ended (for example by conflicting evidence): nothing further is evaluated.
    if (session.status === "completed") return { ok: true, session: freezeSession(session) };
    const node = p.byId.get(id);
    if (!node) return fail(`broken_transition: ${id}`);

    // Steps the person cannot safely or practically do are never presented. Why is kept; it is never evidence about a cause.
    const able = canDo(node, session.facts.capabilities);
    if (!able.ok && node.ifUnsupported) {
      session = record(session, {
        nodeId: node.id,
        kind: "unsupported",
        value: able.reason,
        unsupportedReason: able.reason,
        missingCapabilities: able.missing,
        source: "engine",
        to: node.ifUnsupported,
        ...stamp,
      });
      id = node.ifUnsupported;
      continue;
    }
    // A step that judges against a specification resolves it now. One that is not found, ambiguous,
    // unavailable or in another kind of unit cannot be judged at all, so the step is not presented.
    if (node.type === "measurement" && node.specification) {
      session = pinSpecification(session, node, options, at);
      const u = usable(node, session.specifications[node.specification]);
      if (!u.ok && node.ifUnsupported) {
        session = record(session, { nodeId: node.id, kind: "unsupported", value: u.reason, unsupportedReason: u.reason, source: "engine", to: node.ifUnsupported, ...stamp });
        id = node.ifUnsupported;
        continue;
      }
    }

    // The checker proves every route establishes what a step needs; this is the run-time guard.
    const missing = (node.needsConditions ?? []).filter((c) => !session.establishedConditions.includes(c));
    if (missing.length) return fail(`condition_not_established: "${node.id}" needs ${missing.join(", ")}`);

    switch (node.type) {
      case "start":
        id = node.next;
        continue;
      case "branch": {
        const route = chooseRoute(node, session);
        if ("unknown" in route) {
          // Cannot evaluate: a vehicle fact is unknown. Neither the positive nor the "no" route; no effect on causes.
          if (!node.ifInconclusive) return fail(`cannot_evaluate: "${node.id}" needs ${route.unknown.join(", ")} and has no inconclusive route`);
          session = record(session, { nodeId: node.id, kind: "branch", value: `unknown:${route.unknown.join(",")}`, source: "engine", to: node.ifInconclusive, ...stamp });
          id = node.ifInconclusive;
          continue;
        }
        const rule = "index" in route ? node.rules[route.index] : null;
        const to = rule ? rule.to : node.otherwise;
        session = record(session, { nodeId: node.id, kind: "branch", value: rule ? `rule:${(route as { index: number }).index + 1}` : "otherwise", source: "engine", to, ...stamp }, rule ?? {}, p.byId);
        id = to;
        continue;
      }
      case "test_selection": {
        // An explicit reorderable region. Stay for the person's choice while a useful eligible test exists; otherwise leave it.
        const analysis = analyzeRegion(p.byId, node, session);
        if (analysis.ranked.length) return { ok: true, session: freezeSession({ ...session, currentNodeId: node.id }) };
        const why = session.remainingCauses.length <= 1 ? "one_cause_left" : "no_eligible_test_can_change_the_causes";
        session = record(session, { nodeId: node.id, kind: "test_selection", value: `exhausted:${why}`, source: "engine", to: node.next, ...stamp });
        id = node.next;
        continue;
      }
      case "snapshot_check": {
        // Explicit interpretation of one snapshot parameter. Never a live measurement, never automatic for every snapshot.
        if (node.specification) session = pinSpecification(session, node, options, at);
        const read = readSnapshot(session, node);
        const base = { nodeId: node.id, kind: "snapshot_check" as const, source: "engine" as const, ...stamp };
        const unavailable = (reason: string, ref?: NewEvidence["snapshotRef"]) => {
          session = record(session, { ...base, value: `unavailable: ${reason}`, ...(ref ? { snapshotRef: ref } : {}), to: node.ifUnavailable });
          id = node.ifUnavailable;
        };
        if (!read.ok) {
          unavailable(read.reason, read.snapshot ? { snapshot: read.snapshot, parameter: node.parameter, ...(read.value !== undefined ? { value: read.value } : {}) } : undefined);
          continue;
        }
        const ref = { snapshot: read.snapshot, parameter: read.parameter, value: read.value, unit: read.unit };
        const judged = judge(node, read.value, read.unit, session);
        if (!judged.ok) {
          unavailable(judged.error.startsWith("wrong_unit") ? "incompatible_unit" : judged.error.startsWith("implausible") ? "implausible_value" : "invalid_value", ref);
          continue;
        }
        if (judged.status === "unusable") {
          unavailable(judged.reason, ref);
          continue;
        }
        if (judged.status === "unjudged") {
          // An untrusted specification or an unconfirmed condition: shown, never used to judge.
          const to = node.ifInconclusive!;
          session = record(session, { ...base, value: `${read.value} ${read.unit}`, snapshotRef: ref, measured: { value: judged.value, unit: node.measurement.unit }, judgement: { evaluated: false, reason: judged.reason, specification: judged.specification }, to });
          id = to;
          continue;
        }
        const to = judged.outcome?.to ?? node.otherwise;
        const judgement = { evaluated: true as const, range: judged.range, ...(judged.relation ? { relation: judged.relation } : {}), ...(judged.specification ? { specification: judged.specification } : {}) };
        session = record(session, { ...base, value: `${read.value} ${read.unit}`, snapshotRef: ref, measured: { value: judged.value, unit: node.measurement.unit }, judgement, to }, judged.outcome ?? {}, p.byId);
        id = to;
        continue;
      }
      case "conclusion":
        // Single primary fault: reaching a conclusion about a ruled-out cause cannot be reconciled. An explicit inconclusive end, not an error.
        if (node.cause && !session.remainingCauses.includes(node.cause)) {
          session = endInConflict(session, node.id, session.evidence.length, [{ cause: node.cause, earlierState: "ruled_out", newEvidenceWould: "conclude" }], p.byId, at);
          continue;
        }
        session = { ...session, conclusionNodeId: node.id };
        id = node.next;
        continue;
      case "end":
        return { ok: true, session: freezeSession({ ...session, status: "completed", currentNodeId: null, endResult: node.result }) };
      case "repair_verification":
        // From here on, everything recorded is about the repair.
        return { ok: true, session: freezeSession({ ...session, phase: "after_repair", currentNodeId: node.id }) };
      default:
        return { ok: true, session: freezeSession({ ...session, currentNodeId: node.id }) };
    }
  }
  return fail("step_limit: the workflow did not reach a step needing input or an end");
}

/* ───────────────────────── repair verification ───────────────────────── */

type CriterionResult = "met" | "not_met" | "inconclusive";

/** Judge every criterion of a verification step. Refuses the whole input if any entry does not fit. */
function verify(
  p: Prepared,
  session: DiagnosticSession,
  node: RepairVerificationNode,
  results: VerificationEntry[],
  source: InputSource | undefined,
  at: string | undefined,
  options: EngineOptions,
): { ok: false; error: string } | { ok: true; session: DiagnosticSession; verdict: "verified" | "not_verified" | "inconclusive" } {
  if (!Array.isArray(results)) return { ok: false, error: "invalid_verification: results are required" };
  const ids = node.criteria.map((c) => c.id);
  const given = results.map((r) => r?.criterion);
  if (given.length !== ids.length || new Set(given).size !== given.length || given.some((g) => !ids.includes(g))) {
    return { ok: false, error: `invalid_verification: answer each of ${ids.join(", ")} exactly once` };
  }
  const stamp = at ? { at } : {};
  let next = session;
  const outcomes: CriterionResult[] = [];
  for (const criterion of node.criteria) {
    const entry = results.find((r) => r.criterion === criterion.id)!;
    let result: CriterionResult;
    let value: string;
    let extra: Partial<NewEvidence> = {};
    let entrySource: InputSource = source ?? "person";

    if (criterion.kind === "codes_absent") {
      // "reported" means every code reported before the repair.
      const targets =
        criterion.codes === "reported"
          ? codeEvidence(session.evidence, "before_repair")
              .codes.map((c) => ({ format: c.dtc.format === "obd" ? ("obd" as const) : ("other" as const), code: c.dtc.code, ...(c.dtc.module ? { module: c.dtc.module.id } : {}) }))
              .filter((t, i, all) => all.findIndex((x) => x.format === t.format && x.code === t.code && x.module === t.module) === i)
          : criterion.codes.map((c) => workflowCodeKey(c)!);
      if ("scan" in entry) {
        const scan = normalizeScan(entry.scan, usedIds(next));
        if (!scan.ok) return { ok: false, error: `invalid_verification: "${criterion.id}": ${scan.error}` };
        // The post-repair scan is its own after-repair evidence; earlier scans are never replaced.
        next = recordScan(next, node.id, scan.value, node.id, at);
        entrySource = scan.value.source;
        if (targets.length === 0) {
          result = "met";
          value = "met (no codes were reported before the repair)";
        } else {
          const verdict = codesAbsentVerdict(targets, scan.value);
          result = verdict.result;
          value = `${verdict.result} (${verdict.detail})`;
        }
      } else if ("result" in entry && (entry.result === "not_met" || entry.result === "inconclusive")) {
        // A person can report the codes came back, or that they could not check; only a scan can show they are gone.
        result = entry.result;
        value = entry.result;
      } else if ("result" in entry && entry.result === "met" && targets.length === 0) {
        result = "met";
        value = "met (no codes were reported before the repair)";
      } else {
        return { ok: false, error: `invalid_verification: "${criterion.id}" needs a post-repair scan to be met (or not_met / inconclusive)` };
      }
    } else if ("result" in entry && entry.result === "inconclusive") {
      result = "inconclusive";
      value = "inconclusive";
    } else if (criterion.kind === "symptom_absent") {
      if (!("result" in entry) || (entry.result !== "met" && entry.result !== "not_met")) return { ok: false, error: `invalid_verification: "${criterion.id}" needs met, not_met or inconclusive` };
      result = entry.result;
      value = result;
    } else {
      const target = p.byId.get(criterion.step)!;
      const before = [...session.evidence].reverse().find((e) => e.nodeId === target.id && e.phase === "before_repair" && ["check", "observation", "measurement"].includes(e.kind));
      if (before) extra = { comparesTo: before.seq };
      if (target.type === "measurement") {
        if (!("value" in entry)) return { ok: false, error: `invalid_verification: "${criterion.id}" needs a new reading` };
        entrySource = source ?? "instrument";
        // The re-test uses the specification pinned when the fault was found (resolved now only if it never was).
        if (target.specification) next = pinSpecification(next, target, options, at);
        const judged = judge(target, entry.value, entry.unit, next);
        if (!judged.ok) return { ok: false, error: `invalid_verification: "${criterion.id}": ${judged.error}` };
        if (judged.status === "unusable") {
          result = "inconclusive";
          value = `inconclusive (${entry.value} ${entry.unit}, ${judged.reason})`;
        } else if (judged.status === "unjudged") {
          // An unverified specification, or a condition not confirmed, never decides whether the repair worked.
          result = "inconclusive";
          value = `inconclusive (${entry.value} ${entry.unit}, ${judged.reason})`;
          extra = { ...extra, measured: { value: judged.value, unit: target.measurement.unit }, judgement: { evaluated: false, reason: judged.reason, specification: judged.specification } };
        } else {
          result = criterion.passWhen.includes(judged.range) ? "met" : "not_met";
          value = `${result} (${entry.value} ${entry.unit})`;
          extra = {
            ...extra,
            measured: { value: judged.value, unit: target.measurement.unit },
            judgement: { evaluated: true, range: judged.range, ...(judged.relation ? { relation: judged.relation } : {}), ...(judged.specification ? { specification: judged.specification } : {}) },
          };
        }
      } else {
        if (!("observed" in entry)) return { ok: false, error: `invalid_verification: "${criterion.id}" needs the new result` };
        const allowed = target.type === "check" ? ["pass", "fail"] : target.type === "observation" ? target.options.map((o) => o.id) : [];
        if (!allowed.includes(entry.observed)) return { ok: false, error: `invalid_verification: "${criterion.id}": "${entry.observed}" is not a result of "${target.id}"` };
        result = criterion.passWhen.includes(entry.observed) ? "met" : "not_met";
        value = `${result} (${entry.observed})`;
      }
    }
    outcomes.push(result);
    next = record(next, { nodeId: node.id, kind: "verification_criterion", criterion: criterion.id, value, source: entrySource, to: node.id, ...extra, ...stamp });
  }
  const verdict = outcomes.includes("not_met") ? "not_verified" : outcomes.includes("inconclusive") ? "inconclusive" : "verified";
  return { ok: true, session: next, verdict };
}

/* ───────────────────────── public API ───────────────────────── */

/** Start a session. Start facts (codes, symptoms) are recorded as the first evidence. */
export function startSession(workflow: WorkflowDefinition, facts: SessionStartFacts, at?: string, options: EngineOptions = {}): StepResult {
  const p = prepare(workflow);
  if ("error" in p) return fail(p.error);
  const capabilityIssue = capabilityProblem(facts?.capabilities);
  if (capabilityIssue) return fail(`invalid_facts: ${capabilityIssue}`);
  const vehicle = normalizeVehicleContext(facts.vehicle);
  if (!vehicle.ok) return fail(`invalid_facts: ${vehicle.error}`);
  // An inapplicable workflow never starts, and unknown vehicle facts are never guessed.
  const applies = checkApplicability(workflow.applicability, vehicle.vehicle);
  if (applies.status === "not_applicable") return fail(`not_applicable: the vehicle does not match ${applies.mismatched.join(", ")}`);
  if (applies.status === "insufficient_context") return fail(`insufficient_context: the vehicle's ${applies.missing.join(", ")} must be known`);
  if ("dtcs" in (facts as object) || "dtcSource" in (facts as object)) return fail("invalid_facts: trouble codes are supplied as structured scans (facts.scans)");
  if (facts.scans !== undefined && !Array.isArray(facts.scans)) return fail("invalid_facts: scans must be a list");
  const ids = { scans: new Set<string>(), snapshots: new Set<string>() };
  const scans: NormalizedScan[] = [];
  for (const raw of facts.scans ?? []) {
    const scan = normalizeScan(raw, ids);
    if (!scan.ok) return fail(`invalid_facts: ${scan.error}`);
    ids.scans.add(scan.value.record.id);
    for (const snap of scan.value.snapshots) ids.snapshots.add(snap.id);
    scans.push(scan.value);
  }
  if ("specs" in (facts as object)) return fail("invalid_facts: specifications come from a SpecificationProvider, not the session facts");
  const normalized: SessionStartFacts = {
    ...facts,
    // Pinned: this normalized, frozen copy is the vehicle for the whole session, its replays and resumes.
    ...(facts.vehicle !== undefined ? { vehicle: vehicle.vehicle } : {}),
    capabilities: Object.freeze({ ...facts.capabilities, instruments: [...facts.capabilities.instruments], facilities: [...facts.capabilities.facilities] }),
    // Pinned exactly as supplied (deep-frozen copy): a later scan or a change at the source never reaches this session.
    ...(facts.scans !== undefined ? { scans: frozen(facts.scans) } : {}),
    symptoms: [...(facts.symptoms ?? [])],
  };
  let session: DiagnosticSession = {
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    faultModel: workflow.faultModel,
    facts: Object.freeze(normalized),
    ...(at ? { startedAt: at } : {}),
    status: "in_progress",
    currentNodeId: null,
    phase: "before_repair",
    evidence: [],
    inputs: [],
    establishedConditions: [],
    refutedConditions: [],
    specifications: {},
    remainingCauses: workflow.causes.map((c) => c.id),
    supportedCauses: [],
    conclusionNodeId: null,
    endResult: null,
    verification: null,
    repairVerified: null,
  };
  const start = p.start as Extract<WorkflowNode, { type: "start" }>;
  const stamp = at ? { at } : {};
  for (const scan of scans) session = recordScan(session, start.id, scan, start.next, at);
  for (const symptom of normalized.symptoms ?? []) session = record(session, { nodeId: start.id, kind: "symptom", value: symptom, source: "person", to: start.next, ...stamp });
  return advance(p, session, start.next, at, options);
}

/** The step waiting for input, or null when the session is complete. */
export function currentStep(workflow: WorkflowDefinition, session: DiagnosticSession): WorkflowNode | null {
  const p = prepare(workflow);
  if ("error" in p || session.currentNodeId === null) return null;
  return p.byId.get(session.currentNodeId) ?? null;
}

/**
 * Record the person's input for the current step and move on. Anything that
 * does not fit the current step (another step's id, the wrong kind of answer,
 * an option the step does not offer, a reading in the wrong kind of unit or
 * outside what is physically plausible, a source that cannot have produced
 * it) is refused and the session is unchanged.
 */
export function submitStep(workflow: WorkflowDefinition, session: DiagnosticSession, input: StepInput, at?: string, options: EngineOptions = {}): StepResult {
  const p = prepare(workflow);
  if ("error" in p) return fail(p.error);
  if (session.workflowId !== workflow.id || session.workflowVersion !== workflow.version) return fail("wrong_workflow");
  if (session.status !== "in_progress" || session.currentNodeId === null) return fail("session_complete");
  if (!input || input.nodeId !== session.currentNodeId) return fail("not_current_step");
  const node = p.byId.get(session.currentNodeId);
  if (!node) return fail("broken_session");

  const sources = sourcesFor(node, input);
  if (input.source !== undefined && !sources.allowed.includes(input.source)) return fail(`invalid_source: this step takes ${sources.allowed.join(" or ")}`);
  const source: EvidenceSource = input.source ?? sources.fallback;

  const stamp = at ? { at } : {};
  const base = { nodeId: node.id, source, ...stamp };
  const logged: DiagnosticSession = { ...session, inputs: [...session.inputs, Object.freeze({ ...input, ...stamp })] };
  const go = (next: DiagnosticSession, to: NodeId) => advance(p, next, to, at, options);

  if (input.kind === "unable") {
    if (!node.ifUnsupported) return fail("no_alternative: this step has no route for when it cannot be done");
    return go(record(logged, { ...base, kind: "unsupported", value: input.reason, unsupportedReason: input.reason, to: node.ifUnsupported }), node.ifUnsupported);
  }

  if (input.kind === "inconclusive") {
    if (!["check", "observation", "measurement", "actuator_test", "service_function"].includes(node.type)) return fail("inconclusive_not_allowed: this step cannot be inconclusive");
    if (!node.ifInconclusive) return fail("no_inconclusive_route: this step has no route for an inconclusive result");
    if (!(INCONCLUSIVE_REASONS as readonly string[]).includes(input.reason)) return fail("invalid_reason");
    // Inconclusive evidence never rules a cause in or out.
    return go(record(logged, { ...base, kind: "inconclusive", value: input.reason, to: node.ifInconclusive }), node.ifInconclusive);
  }

  switch (node.type) {
    case "prerequisite": {
      if (input.kind !== "prerequisite") return fail("wrong_input_kind");
      const to = input.met ? node.ifMet : node.ifNotMet;
      // Met establishes the prerequisite's conditions; not met shows they do not hold (until something establishes them).
      const named: ConditionId[] = [...(node.establishes ?? [])];
      const effect = named.length ? (input.met ? { established: named } : { refuted: named }) : {};
      return go(record(logged, { ...base, kind: "prerequisite", value: input.met ? "met" : "not_met", to, ...effect }), to);
    }
    case "question": {
      if (node.answer === "yes_no") {
        if (input.kind !== "yes_no" || (input.answer !== "yes" && input.answer !== "no")) return fail("wrong_input_kind");
        const outcome = node.outcomes.find((o) => o.when === input.answer);
        const to = outcome?.to ?? node.otherwise;
        if (!to) return fail("no_route");
        return go(record(logged, { ...base, kind: "answer", value: input.answer, to }, outcome ?? {}, p.byId), to);
      }
      if (input.kind !== "choice") return fail("wrong_input_kind");
      if (!node.options.some((o) => o.id === input.choice)) return fail("unknown_option");
      const outcome = node.outcomes.find((o) => o.when === input.choice);
      const to = outcome?.to ?? node.otherwise;
      if (!to) return fail("no_route");
      return go(record(logged, { ...base, kind: "answer", value: input.choice, to }, outcome ?? {}, p.byId), to);
    }
    case "observation": {
      if (input.kind !== "observation") return fail("wrong_input_kind");
      if (!node.options.some((o) => o.id === input.choice)) return fail("unknown_option");
      const outcome = node.outcomes.find((o) => o.when === input.choice);
      const to = outcome?.to ?? node.otherwise;
      if (!to) return fail("no_route");
      return go(record(logged, { ...base, kind: "observation", value: input.choice, to }, outcome ?? {}, p.byId), to);
    }
    case "measurement": {
      if (input.kind !== "measurement") return fail("wrong_input_kind");
      const judged = judge(node, input.value, input.unit, session);
      if (!judged.ok) return fail(judged.error);
      // An unusable specification was already routed away in advance(); this cannot happen for a presented step.
      if (judged.status === "unusable") return fail(judged.reason);
      const measured = { value: judged.value, unit: node.measurement.unit };
      if (judged.status === "unjudged") {
        // Recorded and shown, never judged: no range, no effect on causes, and the route is the step's
        // inconclusive route (or, without one, its cannot-be-done route), never a pass or fail route.
        const to = node.ifInconclusive ?? node.ifUnsupported!;
        return go(
          record(logged, { ...base, kind: "measurement", value: `${input.value} ${input.unit}`, measured, judgement: { evaluated: false, reason: judged.reason, specification: judged.specification }, to }),
          to,
        );
      }
      const to = judged.outcome?.to ?? node.otherwise;
      const judgement = { evaluated: true as const, range: judged.range, ...(judged.relation ? { relation: judged.relation } : {}), ...(judged.specification ? { specification: judged.specification } : {}) };
      return go(record(logged, { ...base, kind: "measurement", value: `${input.value} ${input.unit}`, measured, judgement, to }, judged.outcome ?? {}, p.byId), to);
    }
    case "test_selection": {
      // Only an eligible, useful test of this region may be chosen; the recommendation is recorded with the choice.
      if (input.kind !== "select_test") return fail("wrong_input_kind");
      const analysis = analyzeRegion(p.byId, node, session);
      if (!analysis.ranked.some((c) => c.step === input.test)) {
        const why =
          analysis.blocked.find((b) => b.step === input.test)?.reason ??
          (analysis.potential.some((x) => x.step === input.test) ? "missing_context" : analysis.excluded.find((x) => x.step === input.test)?.reason ?? "not_in_region");
        return fail(`not_eligible: "${input.test}" (${why})`);
      }
      return go(record(logged, { ...base, kind: "test_selection", value: input.test, recommendedTest: analysis.ranked[0].step, to: input.test }), input.test);
    }
    case "actuator_test": {
      // MODELLING ONLY: an external tool commanded the actuator; this records what was observed. Nothing is executed here.
      if (input.kind !== "actuator_result") return fail("wrong_input_kind");
      if (!node.results.some((r) => r.id === input.result)) return fail("unknown_result");
      const outcome = node.outcomes.find((o) => o.when === input.result)!;
      return go(record(logged, { ...base, kind: "actuator_test", actuator: node.actuator, performedBy: "external_tool", value: input.result, to: outcome.to }, outcome, p.byId), outcome.to);
    }
    case "service_function": {
      // MODELLING ONLY: an external tool ran the function and reported its status. Nothing is executed here.
      if (input.kind !== "service_result") return fail("wrong_input_kind");
      const common = { ...base, kind: "service_function" as const, serviceFunction: node.serviceFunction, performedBy: "external_tool" as const, value: input.result };
      if (input.result === "not_supported") {
        // Not supported is not a failure: no effect on causes, and the cannot-be-done route.
        if (!node.ifUnsupported) return fail("no_alternative: this step has no route for when it cannot be done");
        return go(record(logged, { ...common, unsupportedReason: "function_not_supported", to: node.ifUnsupported }), node.ifUnsupported);
      }
      if (input.result !== "completed" && input.result !== "failed") return fail("wrong_input_kind");
      const outcome = node.outcomes.find((o) => o.when === input.result)!;
      return go(record(logged, { ...common, to: outcome.to }, outcome, p.byId), outcome.to);
    }
    case "check": {
      if (input.kind !== "check" || (input.result !== "pass" && input.result !== "fail")) return fail("wrong_input_kind");
      const outcome = node.outcomes.find((o) => o.when === input.result)!;
      return go(record(logged, { ...base, kind: "check", value: input.result, to: outcome.to }, outcome, p.byId), outcome.to);
    }
    case "action": {
      if (input.kind !== "done") return fail("wrong_input_kind");
      const established = [...(node.establishes ?? [])];
      return go(record(logged, { ...base, kind: "action", value: "done", to: node.next, ...(established.length ? { established } : {}) }), node.next);
    }
    case "repair_verification": {
      if (input.kind !== "verification") return fail("wrong_input_kind");
      const checked = verify(p, logged, node, input.results, input.source, at, options);
      if (!checked.ok) return fail(checked.error);
      const to = checked.verdict === "verified" ? node.ifVerified : checked.verdict === "not_verified" ? node.ifNotVerified : node.ifInconclusive!;
      // The verdict is decided by the engine from the criteria just recorded.
      const recorded = record(checked.session, { ...base, source: "engine", kind: "verification", value: checked.verdict, to });
      return go({ ...recorded, verification: checked.verdict, repairVerified: checked.verdict === "inconclusive" ? null : checked.verdict === "verified" }, to);
    }
    default:
      return fail("not_an_input_step");
  }
}

/** Run a whole list of inputs from the start. The same workflow, facts and inputs always give the same session. */
/**
 * Run a whole list of inputs from the start. The same workflow, facts, inputs
 * and specification answers always give the same session. (A replay with a
 * provider whose data has since changed is a NEW run; to reproduce a saved
 * session use resumeSession, which replays against what that session pinned.)
 */
export function replaySession(
  workflow: WorkflowDefinition,
  facts: SessionStartFacts,
  inputs: ReadonlyArray<StepInput & { at?: string }>,
  startedAt?: string,
  options: EngineOptions = {},
): StepResult {
  let result = startSession(workflow, facts, startedAt, options);
  for (const input of inputs) {
    if (!result.ok) return result;
    const { at, ...step } = input;
    result = submitStep(workflow, result.session, step as StepInput, at, options);
  }
  return result;
}

/**
 * What a session's inputs led to: the evidence trail and where the session
 * stands. Two sessions with the same outcome reached the same results, however
 * their saved form is laid out. Used by resumeSession.
 */
export function sessionOutcome(session: Pick<DiagnosticSession, "status" | "currentNodeId" | "conclusionNodeId" | "endResult" | "remainingCauses" | "supportedCauses" | "evidence">) {
  return {
    status: session.status,
    currentNodeId: session.currentNodeId,
    conclusionNodeId: session.conclusionNodeId,
    endResult: session.endResult,
    remainingCauses: [...session.remainingCauses],
    supportedCauses: [...session.supportedCauses],
    // Structured code and snapshot evidence is compared in full, so an edited code, status or snapshot is caught.
    evidence: session.evidence.map((e) => {
      const detail = e.dtc ?? e.scanInfo ?? e.snapshot ?? e.snapshotRef ?? e.conflict;
      return detail ? ([e.seq, e.nodeId, e.kind, e.value, e.to, JSON.stringify(detail)] as const) : ([e.seq, e.nodeId, e.kind, e.value, e.to] as const);
    }),
  };
}

/** Outcome fields added in V2A. Compared when a saved session has them; an older save without them is still checked on everything else. */
const V2A_OUTCOME_FIELDS = ["phase", "verification", "establishedConditions", "refutedConditions", "faultModel", "specifications"] as const;

/**
 * Continue a saved session. Its inputs are replayed against the workflow and
 * the RESULTS are compared with what was saved: the evidence trail (step,
 * kind, value, where it led), where the session stands, the conclusion and the
 * causes. A session whose inputs no longer lead to what it recorded (edited,
 * or saved against another version) is refused rather than trusted. Layout,
 * key order and fields the engine does not know are ignored, so a save outlives
 * harmless changes to the session's shape.
 */
export function resumeSession(workflow: WorkflowDefinition, saved: unknown): StepResult {
  const s = saved as Partial<DiagnosticSession> | null;
  if (!s || typeof s !== "object" || !s.facts || !Array.isArray(s.inputs) || !Array.isArray(s.evidence)) return fail("invalid_session");
  if (s.workflowId !== workflow.id || s.workflowVersion !== workflow.version) return fail("wrong_workflow");
  if (!Array.isArray(s.remainingCauses) || !Array.isArray(s.supportedCauses)) return fail("invalid_session");
  const startedAt = typeof s.startedAt === "string" ? s.startedAt : s.evidence.find((e) => e?.kind === "scan" || e?.kind === "symptom")?.at;
  // History is replayed against the specifications the session pinned, never the provider's current data,
  // so a later change in that data cannot rewrite a recorded judgement. (specificationDrift reports such changes.)
  const pinned = s.specifications && typeof s.specifications === "object" ? s.specifications : {};
  const rebuilt = replaySession(workflow, s.facts, s.inputs, startedAt, { specifications: pinnedSpecificationProvider(pinned) });
  if (!rebuilt.ok) return fail(`invalid_session: ${rebuilt.error}`);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const savedOutcome = sessionOutcome({
    status: s.status!,
    currentNodeId: s.currentNodeId ?? null,
    conclusionNodeId: s.conclusionNodeId ?? null,
    endResult: s.endResult ?? null,
    remainingCauses: s.remainingCauses,
    supportedCauses: s.supportedCauses,
    evidence: s.evidence,
  });
  if (!same(sessionOutcome(rebuilt.session), savedOutcome)) return fail("invalid_session: its inputs do not lead to what it recorded");
  for (const field of V2A_OUTCOME_FIELDS) {
    if (field in s && !same((s as Record<string, unknown>)[field], rebuilt.session[field])) return fail(`invalid_session: its ${field} does not match its inputs`);
  }
  return rebuilt;
}

/**
 * Steps still ahead that could separate the causes still in play, cheapest first.
 *
 * Only steps the session can still REACH from where it stands are listed: in a
 * fixed workflow a step on another branch is not an option. A step
 * "separates" when at least one of its outcomes rules out a remaining cause
 * while leaving another. Order: steps the person can do first; then the lowest
 * skill level; then the step whose most telling outcome rules out the most
 * remaining causes; then the fewest tools. No probabilities are involved. (A
 * full next-best-test ranking is later work.)
 */
/**
 * The next best test (V2E). Inside an explicit reorderable region (the
 * session stands at a test_selection step) it returns the recommended test,
 * the other eligible tests in order, and separately the useful tests that are
 * blocked (capability, conditions) or only potentially available (missing
 * context). Outside a region it says to follow the workflow: its order is
 * authoritative there. Pure: computing it changes nothing.
 */
export function nextBestTests(workflow: WorkflowDefinition, session: DiagnosticSession): NextBestTests {
  const p = prepare(workflow);
  if ("error" in p) return { status: "follow_workflow", currentStep: null, reason: p.error };
  const node = session.currentNodeId ? p.byId.get(session.currentNodeId) : undefined;
  if (session.status !== "in_progress" || !node) return { status: "follow_workflow", currentStep: null, reason: "session_complete" };
  if (node.type !== "test_selection") return { status: "follow_workflow", currentStep: node.id, reason: "not_in_a_reorderable_region" };
  const a = analyzeRegion(p.byId, node, session);
  const recs = toRecommendations(a, session.remainingCauses.length);
  return { status: "region", group: a.group, selection: a.selection, recommended: recs[0] ?? null, alternatives: recs.slice(1), blocked: a.blocked, potential: a.potential, excluded: a.excluded };
}

/**
 * The limited post-repair recheck plan, at a repair verification step. A
 * plan only: it changes nothing and verifies nothing.
 */
export function recheckPlan(workflow: WorkflowDefinition, session: DiagnosticSession): RecheckPlan {
  const p = prepare(workflow);
  const node = "error" in p || !session.currentNodeId ? undefined : p.byId.get(session.currentNodeId);
  if ("error" in p || session.status !== "in_progress" || node?.type !== "repair_verification") return { status: "not_at_verification" };
  return buildRecheckPlan(p.byId, session, node);
}

/**
 * @internal @deprecated Retired from the public API: nextBestTests is the one
 * canonical recommendation API. Kept only so the V1-V2D regression tests can
 * keep checking reachability behaviour. It lists every separating step still
 * reachable across the whole workflow and must never be used to recommend or
 * reorder tests.
 */
export function separatingSteps(workflow: WorkflowDefinition, session: DiagnosticSession) {
  const p = prepare(workflow);
  if ("error" in p || session.status !== "in_progress" || session.currentNodeId === null) return [];
  // Steps definitely unreachable are left out; steps reachable only with missing context are kept, and say so.
  const reach = stepReachability(workflow, session);
  const remaining = new Set(session.remainingCauses);
  const out: Array<{ nodeId: NodeId; title: string; reachability: "reachable" | "potential"; canDo: boolean; level: string; tools: string[]; rulesOutUpTo: number }> = [];
  for (const node of p.workflow.nodes) {
    const reachability = reach.get(node.id) ?? "unreachable";
    if (reachability === "unreachable" || !("outcomes" in node)) continue;
    const best = Math.max(0, ...(node.outcomes as CauseEffect[]).map((o) => (o.rulesOut ?? []).filter((id) => remaining.has(id)).length));
    if (best === 0 || best >= remaining.size) continue;
    out.push({
      nodeId: node.id,
      title: node.title,
      reachability,
      canDo: canDo(node, session.facts.capabilities).ok,
      level: node.requires?.level ?? "owner",
      // Everything the step needs beyond skill: scan access, instruments and facilities.
      tools: [
        ...(node.requires?.scan && node.requires.scan !== "none" ? [`scan_access:${node.requires.scan}`] : []),
        ...(node.requires?.instruments ?? []),
        ...(node.requires?.facilities ?? []),
      ],
      rulesOutUpTo: best,
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.canDo) - Number(a.canDo) ||
      SKILL_ORDER[a.level as keyof typeof SKILL_ORDER] - SKILL_ORDER[b.level as keyof typeof SKILL_ORDER] ||
      b.rulesOutUpTo - a.rulesOutUpTo ||
      a.tools.length - b.tools.length ||
      a.nodeId.localeCompare(b.nodeId),
  );
}
