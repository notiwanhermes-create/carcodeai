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
 *   refused, not judged; every judgement records the specifications it used
 *   and how far they are trusted; evidence says whether it was gathered
 *   before or after the repair, and who produced it.
 */
import {
  INCONCLUSIVE_REASONS,
  SKILL_ORDER,
  SPEC_TRUST,
  type Bound,
  type Capabilities,
  type CauseEffect,
  type Condition,
  type ConditionId,
  type DiagnosticSession,
  type Evidence,
  type EvidenceSource,
  type InputSource,
  type MeasurementNode,
  type MeasurementOutcome,
  type NodeId,
  type NumericRange,
  type RepairVerificationNode,
  type SessionStartFacts,
  type SpecTrust,
  type SpecificationUse,
  type StepInput,
  type StepResult,
  type Unit,
  type VerificationEntry,
  type WorkflowDefinition,
  type WorkflowNode,
} from "./types";
import { convert, isUnit } from "./units";
import { successors, validateWorkflow } from "./validate";

/** A guard on top of the no-loops check: no run may take more automatic steps than this. */
export const MAX_AUTOMATIC_STEPS = 500;

const fail = (error: string): StepResult => ({ ok: false, error });

/* ───────────────────────── workflow lookup ───────────────────────── */

type Prepared = { workflow: WorkflowDefinition; byId: Map<NodeId, WorkflowNode>; start: WorkflowNode };
const prepared = new WeakMap<WorkflowDefinition, Prepared | { error: string }>();

/** The workflow, checked once and indexed. A workflow that fails the check can never be run. */
function prepare(workflow: WorkflowDefinition): Prepared | { error: string } {
  const known = prepared.get(workflow);
  if (known) return known;
  const check = validateWorkflow(workflow);
  const result = check.ok
    ? (() => {
        const byId = new Map(workflow.nodes.map((n) => [n.id, n] as const));
        return { workflow, byId, start: workflow.nodes.find((n) => n.type === "start")! };
      })()
    : { error: `invalid_workflow: ${check.problems.map((p) => p.code).join(", ")}` };
  prepared.set(workflow, result);
  return result;
}

/* ───────────────────────── specifications ───────────────────────── */

type SpecEntry = { value: number; trust: SpecTrust | "unspecified"; source?: string };

/** The session's specifications, each with its trust. Bare numbers are "unspecified". */
function specTable(facts: SessionStartFacts): Map<string, SpecEntry> {
  const table = new Map<string, SpecEntry>();
  for (const [name, raw] of Object.entries(facts.specs ?? {})) {
    if (typeof raw === "number") {
      if (Number.isFinite(raw)) table.set(name, { value: raw, trust: "unspecified" });
    } else if (raw && Number.isFinite(raw.value)) {
      table.set(name, { value: raw.value, trust: raw.trust, ...(raw.source ? { source: raw.source } : {}) });
    }
  }
  return table;
}

function validSpecs(specs: SessionStartFacts["specs"]): boolean {
  if (specs === undefined) return true;
  if (!specs || typeof specs !== "object") return false;
  return Object.values(specs).every(
    (v) =>
      (typeof v === "number" && Number.isFinite(v)) ||
      (!!v && typeof v === "object" && Number.isFinite(v.value) && (SPEC_TRUST as readonly string[]).includes(v.trust) && (v.source === undefined || typeof v.source === "string")),
  );
}

function resolveBound(bound: Bound | undefined, specs: Map<string, SpecEntry>): number | undefined | null {
  if (bound === undefined) return undefined;
  if (typeof bound === "number") return bound;
  return specs.get(bound.spec)?.value ?? null;
}

function specsIn(range: NumericRange, specs: Map<string, SpecEntry>): SpecificationUse[] {
  const out: SpecificationUse[] = [];
  for (const b of [range.min, range.max]) {
    if (typeof b !== "object" || !b) continue;
    const entry = specs.get(b.spec);
    if (entry && !out.some((u) => u.name === b.spec)) out.push({ name: b.spec, value: entry.value, trust: entry.trust, ...(entry.source ? { source: entry.source } : {}) });
  }
  return out;
}

/** Whether every specification a measurement step refers to is available. */
function specsAvailable(node: WorkflowNode, specs: Map<string, SpecEntry>): boolean {
  if (node.type !== "measurement") return true;
  return node.outcomes.every((o) => resolveBound(o.when.min, specs) !== null && resolveBound(o.when.max, specs) !== null);
}

function inRange(value: number, range: NumericRange, specs: Map<string, SpecEntry>): boolean {
  const min = resolveBound(range.min, specs);
  const max = resolveBound(range.max, specs);
  if (min === null || max === null) return false;
  if (min !== undefined && (range.minInclusive === false ? value <= min : value < min)) return false;
  if (max !== undefined && (range.maxInclusive === false ? value >= max : value > max)) return false;
  return true;
}

type Judged =
  | { ok: false; error: string }
  | { ok: true; missingSpec: true }
  | { ok: true; missingSpec: false; value: number; outcome: MeasurementOutcome | null; range: string; specs: SpecificationUse[] };

/** A reading checked against the step: right kind of unit, plausible, then judged against the first matching range. */
function judge(node: MeasurementNode, raw: number, unit: Unit, specs: Map<string, SpecEntry>): Judged {
  if (!isUnit(unit) || typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false, error: "invalid_measurement" };
  const value = convert(raw, unit, node.measurement.unit);
  if (value === null) return { ok: false, error: `wrong_unit: this step measures in ${node.measurement.unit}` };
  const { min, max } = node.measurement.plausible;
  if (value < min || value > max) return { ok: false, error: `implausible_measurement: ${value} ${node.measurement.unit} is outside ${min}–${max} ${node.measurement.unit}; check the reading` };
  if (!specsAvailable(node, specs)) return { ok: true, missingSpec: true };
  const outcome = node.outcomes.find((o) => inRange(value, o.when, specs)) ?? null;
  const used = node.outcomes.flatMap((o) => specsIn(o.when, specs)).filter((u, i, all) => all.findIndex((x) => x.name === u.name) === i);
  return { ok: true, missingSpec: false, value, outcome, range: outcome?.id ?? "otherwise", specs: used };
}

/* ───────────────────────── helpers ───────────────────────── */

function canDo(node: WorkflowNode, capabilities: Capabilities): { ok: true } | { ok: false; reason: "level" | "tools" } {
  const needs = node.requires;
  if (!needs) return { ok: true };
  if (SKILL_ORDER[needs.level] > SKILL_ORDER[capabilities.maxLevel]) return { ok: false, reason: "level" };
  if ((needs.tools ?? []).some((tool) => !capabilities.tools.includes(tool))) return { ok: false, reason: "tools" };
  return { ok: true };
}

function holds(condition: Condition, session: DiagnosticSession): boolean {
  if ("dtcAny" in condition) return (session.facts.dtcs ?? []).some((code) => condition.dtcAny.includes(code));
  if ("symptomAny" in condition) return (session.facts.symptoms ?? []).some((s) => condition.symptomAny.includes(s));
  if ("vehicle" in condition) return session.facts.vehicle?.[condition.vehicle] === condition.equals;
  if ("established" in condition) return session.establishedConditions.includes(condition.established);
  if ("answered" in condition) {
    const last = [...session.evidence].reverse().find((e) => e.nodeId === condition.answered && e.kind !== "start_fact");
    return last?.value === condition.is;
  }
  if ("all" in condition) return condition.all.every((c) => holds(c, session));
  if ("any" in condition) return condition.any.some((c) => holds(c, session));
  return !holds(condition.not, session);
}

/** Who may have produced the input for a step of this type, and the default when the caller does not say. */
function sourcesFor(node: WorkflowNode, input: StepInput): { allowed: InputSource[]; fallback: InputSource } {
  if (input.kind === "unable") return { allowed: ["person"], fallback: "person" };
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
    remainingCauses: Object.freeze([...session.remainingCauses]),
    supportedCauses: Object.freeze([...session.supportedCauses]),
  });
}

type NewEvidence = Omit<Evidence, "seq" | "phase">;

/** A new session with one more piece of evidence and its effect on the candidate causes and conditions. */
function record(session: DiagnosticSession, entry: NewEvidence, effect: CauseEffect = {}): DiagnosticSession {
  const evidence = Object.freeze({
    ...entry,
    ...(entry.measured ? { measured: Object.freeze({ ...entry.measured }) } : {}),
    ...(entry.judgement ? { judgement: Object.freeze({ range: entry.judgement.range, specs: Object.freeze(entry.judgement.specs.map((s) => Object.freeze({ ...s }))) }) } : {}),
    ...(entry.established ? { established: Object.freeze([...entry.established]) } : {}),
    phase: session.phase,
    seq: session.evidence.length + 1,
  }) as Evidence;
  const ruledOut = new Set(effect.rulesOut ?? []);
  const remainingCauses = session.remainingCauses.filter((id) => !ruledOut.has(id));
  const supportedCauses = [...session.supportedCauses];
  for (const id of effect.supports ?? []) if (remainingCauses.includes(id) && !supportedCauses.includes(id)) supportedCauses.push(id);
  const establishedConditions = [...session.establishedConditions];
  for (const c of entry.established ?? []) if (!establishedConditions.includes(c)) establishedConditions.push(c);
  return {
    ...session,
    evidence: [...session.evidence, evidence],
    establishedConditions,
    remainingCauses,
    supportedCauses: supportedCauses.filter((id) => remainingCauses.includes(id)),
  };
}

/**
 * Move from `nodeId` through every step that needs no input (branches,
 * conclusions, steps the person cannot do), stopping at the next step that
 * needs input, or at the end.
 */
function advance(p: Prepared, from: DiagnosticSession, nodeId: NodeId, at?: string): StepResult {
  let session = from;
  let id = nodeId;
  const specs = specTable(session.facts);
  const stamp = at ? { at } : {};
  for (let step = 0; step < MAX_AUTOMATIC_STEPS; step++) {
    const node = p.byId.get(id);
    if (!node) return fail(`broken_transition: ${id}`);

    // Steps the person cannot safely or practically do are never presented.
    const able = canDo(node, session.facts.capabilities);
    if (!able.ok && node.ifUnsupported) {
      session = record(session, { nodeId: node.id, kind: "unsupported", value: able.reason, unsupportedReason: able.reason, source: "engine", to: node.ifUnsupported, ...stamp });
      id = node.ifUnsupported;
      continue;
    }
    if (!specsAvailable(node, specs) && node.ifUnsupported) {
      session = record(session, { nodeId: node.id, kind: "unsupported", value: "missing_spec", unsupportedReason: "missing_spec", source: "engine", to: node.ifUnsupported, ...stamp });
      id = node.ifUnsupported;
      continue;
    }

    // The checker proves every route establishes what a step needs; this is the run-time guard.
    const missing = (node.needsConditions ?? []).filter((c) => !session.establishedConditions.includes(c));
    if (missing.length) return fail(`condition_not_established: "${node.id}" needs ${missing.join(", ")}`);

    switch (node.type) {
      case "start":
        id = node.next;
        continue;
      case "branch": {
        const index = node.rules.findIndex((rule) => holds(rule.if, session));
        const rule = index >= 0 ? node.rules[index] : null;
        const to = rule ? rule.to : node.otherwise;
        session = record(session, { nodeId: node.id, kind: "branch", value: rule ? `rule:${index + 1}` : "otherwise", source: "engine", to, ...stamp }, rule ?? {});
        id = to;
        continue;
      }
      case "conclusion":
        // Single primary fault: concluding a cause the evidence already ruled out is a contradiction in the workflow, not a result.
        if (node.cause && !session.remainingCauses.includes(node.cause)) return fail(`contradiction: "${node.id}" concludes "${node.cause}", which the evidence ruled out`);
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
  at?: string,
): { ok: false; error: string } | { ok: true; session: DiagnosticSession; verdict: "verified" | "not_verified" | "inconclusive" } {
  if (!Array.isArray(results)) return { ok: false, error: "invalid_verification: results are required" };
  const ids = node.criteria.map((c) => c.id);
  const given = results.map((r) => r?.criterion);
  if (given.length !== ids.length || new Set(given).size !== given.length || given.some((g) => !ids.includes(g))) {
    return { ok: false, error: `invalid_verification: answer each of ${ids.join(", ")} exactly once` };
  }
  const specs = specTable(session.facts);
  const stamp = at ? { at } : {};
  let next = session;
  const outcomes: CriterionResult[] = [];
  for (const criterion of node.criteria) {
    const entry = results.find((r) => r.criterion === criterion.id)!;
    let result: CriterionResult;
    let value: string;
    let extra: Partial<NewEvidence> = {};
    let entrySource: InputSource = source ?? "person";

    if ("result" in entry && entry.result === "inconclusive") {
      result = "inconclusive";
      value = "inconclusive";
    } else if (criterion.kind === "symptom_absent" || criterion.kind === "codes_absent") {
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
        const judged = judge(target, entry.value, entry.unit, specs);
        if (!judged.ok) return { ok: false, error: `invalid_verification: "${criterion.id}": ${judged.error}` };
        if (judged.missingSpec) {
          result = "inconclusive";
          value = `inconclusive (${entry.value} ${entry.unit}, specification missing)`;
        } else {
          result = criterion.passWhen.includes(judged.range) ? "met" : "not_met";
          value = `${result} (${entry.value} ${entry.unit})`;
          extra = { ...extra, measured: { value: judged.value, unit: target.measurement.unit }, judgement: { range: judged.range, specs: judged.specs } };
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
export function startSession(workflow: WorkflowDefinition, facts: SessionStartFacts, at?: string): StepResult {
  const p = prepare(workflow);
  if ("error" in p) return fail(p.error);
  if (!facts?.capabilities || !(facts.capabilities.maxLevel in SKILL_ORDER) || !Array.isArray(facts.capabilities.tools)) return fail("invalid_facts: capabilities are required");
  if (facts.dtcSource !== undefined && facts.dtcSource !== "person" && facts.dtcSource !== "scan_tool") return fail("invalid_facts: dtcSource must be person or scan_tool");
  if (!validSpecs(facts.specs)) return fail("invalid_facts: a specification must be a number, or a value with a known trust level");
  const normalized: SessionStartFacts = {
    ...facts,
    dtcs: (facts.dtcs ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean),
    symptoms: [...(facts.symptoms ?? [])],
    specs: Object.fromEntries(Object.entries(facts.specs ?? {}).map(([k, v]) => [k, typeof v === "number" ? v : Object.freeze({ ...v })])),
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
    remainingCauses: workflow.causes.map((c) => c.id),
    supportedCauses: [],
    conclusionNodeId: null,
    endResult: null,
    verification: null,
    repairVerified: null,
  };
  const start = p.start as Extract<WorkflowNode, { type: "start" }>;
  const stamp = at ? { at } : {};
  for (const code of normalized.dtcs ?? []) session = record(session, { nodeId: start.id, kind: "start_fact", value: `dtc:${code}`, source: normalized.dtcSource ?? "person", to: start.next, ...stamp });
  for (const symptom of normalized.symptoms ?? []) session = record(session, { nodeId: start.id, kind: "start_fact", value: `symptom:${symptom}`, source: "person", to: start.next, ...stamp });
  return advance(p, session, start.next, at);
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
export function submitStep(workflow: WorkflowDefinition, session: DiagnosticSession, input: StepInput, at?: string): StepResult {
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
  const go = (next: DiagnosticSession, to: NodeId) => advance(p, next, to, at);

  if (input.kind === "unable") {
    if (!node.ifUnsupported) return fail("no_alternative: this step has no route for when it cannot be done");
    return go(record(logged, { ...base, kind: "unsupported", value: input.reason, unsupportedReason: input.reason, to: node.ifUnsupported }), node.ifUnsupported);
  }

  if (input.kind === "inconclusive") {
    if (node.type !== "check" && node.type !== "observation" && node.type !== "measurement") return fail("inconclusive_not_allowed: this step cannot be inconclusive");
    if (!node.ifInconclusive) return fail("no_inconclusive_route: this step has no route for an inconclusive result");
    if (!(INCONCLUSIVE_REASONS as readonly string[]).includes(input.reason)) return fail("invalid_reason");
    // Inconclusive evidence never rules a cause in or out.
    return go(record(logged, { ...base, kind: "inconclusive", value: input.reason, to: node.ifInconclusive }), node.ifInconclusive);
  }

  switch (node.type) {
    case "prerequisite": {
      if (input.kind !== "prerequisite") return fail("wrong_input_kind");
      const to = input.met ? node.ifMet : node.ifNotMet;
      const established: ConditionId[] = input.met ? [...(node.establishes ?? [])] : [];
      return go(record(logged, { ...base, kind: "prerequisite", value: input.met ? "met" : "not_met", to, ...(established.length ? { established } : {}) }), to);
    }
    case "question": {
      if (node.answer === "yes_no") {
        if (input.kind !== "yes_no" || (input.answer !== "yes" && input.answer !== "no")) return fail("wrong_input_kind");
        const outcome = node.outcomes.find((o) => o.when === input.answer);
        const to = outcome?.to ?? node.otherwise;
        if (!to) return fail("no_route");
        return go(record(logged, { ...base, kind: "answer", value: input.answer, to }, outcome ?? {}), to);
      }
      if (input.kind !== "choice") return fail("wrong_input_kind");
      if (!node.options.some((o) => o.id === input.choice)) return fail("unknown_option");
      const outcome = node.outcomes.find((o) => o.when === input.choice);
      const to = outcome?.to ?? node.otherwise;
      if (!to) return fail("no_route");
      return go(record(logged, { ...base, kind: "answer", value: input.choice, to }, outcome ?? {}), to);
    }
    case "observation": {
      if (input.kind !== "observation") return fail("wrong_input_kind");
      if (!node.options.some((o) => o.id === input.choice)) return fail("unknown_option");
      const outcome = node.outcomes.find((o) => o.when === input.choice);
      const to = outcome?.to ?? node.otherwise;
      if (!to) return fail("no_route");
      return go(record(logged, { ...base, kind: "observation", value: input.choice, to }, outcome ?? {}), to);
    }
    case "measurement": {
      if (input.kind !== "measurement") return fail("wrong_input_kind");
      const judged = judge(node, input.value, input.unit, specTable(session.facts));
      if (!judged.ok) return fail(judged.error);
      // Specifications missing were already routed away in advance(); this cannot happen for a presented step.
      if (judged.missingSpec) return fail("missing_spec");
      const to = judged.outcome?.to ?? node.otherwise;
      return go(
        record(
          logged,
          { ...base, kind: "measurement", value: `${input.value} ${input.unit}`, measured: { value: judged.value, unit: node.measurement.unit }, judgement: { range: judged.range, specs: judged.specs }, to },
          judged.outcome ?? {},
        ),
        to,
      );
    }
    case "check": {
      if (input.kind !== "check" || (input.result !== "pass" && input.result !== "fail")) return fail("wrong_input_kind");
      const outcome = node.outcomes.find((o) => o.when === input.result)!;
      return go(record(logged, { ...base, kind: "check", value: input.result, to: outcome.to }, outcome), outcome.to);
    }
    case "action": {
      if (input.kind !== "done") return fail("wrong_input_kind");
      const established = [...(node.establishes ?? [])];
      return go(record(logged, { ...base, kind: "action", value: "done", to: node.next, ...(established.length ? { established } : {}) }), node.next);
    }
    case "repair_verification": {
      if (input.kind !== "verification") return fail("wrong_input_kind");
      const checked = verify(p, logged, node, input.results, input.source, at);
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
export function replaySession(workflow: WorkflowDefinition, facts: SessionStartFacts, inputs: ReadonlyArray<StepInput & { at?: string }>, startedAt?: string): StepResult {
  let result = startSession(workflow, facts, startedAt);
  for (const input of inputs) {
    if (!result.ok) return result;
    const { at, ...step } = input;
    result = submitStep(workflow, result.session, step as StepInput, at);
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
    evidence: session.evidence.map((e) => [e.seq, e.nodeId, e.kind, e.value, e.to] as const),
  };
}

/** Outcome fields added in V2A. Compared when a saved session has them; an older save without them is still checked on everything else. */
const V2A_OUTCOME_FIELDS = ["phase", "verification", "establishedConditions", "faultModel"] as const;

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
  const startedAt = typeof s.startedAt === "string" ? s.startedAt : s.evidence.find((e) => e?.kind === "start_fact")?.at;
  const rebuilt = replaySession(workflow, s.facts, s.inputs, startedAt);
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
export function separatingSteps(workflow: WorkflowDefinition, session: DiagnosticSession) {
  const p = prepare(workflow);
  if ("error" in p || session.status !== "in_progress" || session.currentNodeId === null) return [];
  const ahead = new Set<NodeId>();
  const stack = [session.currentNodeId];
  while (stack.length) {
    const id = stack.pop()!;
    if (ahead.has(id) || !p.byId.has(id)) continue;
    ahead.add(id);
    stack.push(...successors(p.byId.get(id)!));
  }
  const remaining = new Set(session.remainingCauses);
  const out: Array<{ nodeId: NodeId; title: string; canDo: boolean; level: string; tools: string[]; rulesOutUpTo: number }> = [];
  for (const node of p.workflow.nodes) {
    if (!ahead.has(node.id) || !("outcomes" in node)) continue;
    const best = Math.max(0, ...(node.outcomes as CauseEffect[]).map((o) => (o.rulesOut ?? []).filter((id) => remaining.has(id)).length));
    if (best === 0 || best >= remaining.size) continue;
    out.push({
      nodeId: node.id,
      title: node.title,
      canDo: canDo(node, session.facts.capabilities).ok,
      level: node.requires?.level ?? "owner",
      tools: [...(node.requires?.tools ?? [])],
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
