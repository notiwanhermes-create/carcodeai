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
 */
import {
  SKILL_ORDER,
  type Bound,
  type Capabilities,
  type CauseEffect,
  type Condition,
  type DiagnosticSession,
  type Evidence,
  type NodeId,
  type NumericRange,
  type SessionStartFacts,
  type StepInput,
  type StepResult,
  type WorkflowDefinition,
  type WorkflowNode,
} from "./types";
import { convert, isUnit } from "./units";
import { validateWorkflow } from "./validate";

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

/* ───────────────────────── helpers ───────────────────────── */

function canDo(node: WorkflowNode, capabilities: Capabilities): { ok: true } | { ok: false; reason: "level" | "tools" } {
  const needs = node.requires;
  if (!needs) return { ok: true };
  if (SKILL_ORDER[needs.level] > SKILL_ORDER[capabilities.maxLevel]) return { ok: false, reason: "level" };
  if ((needs.tools ?? []).some((tool) => !capabilities.tools.includes(tool))) return { ok: false, reason: "tools" };
  return { ok: true };
}

function resolveBound(bound: Bound | undefined, specs: Record<string, number>): number | undefined | null {
  if (bound === undefined) return undefined;
  if (typeof bound === "number") return bound;
  const value = specs[bound.spec];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Whether every specification a measurement step refers to is available. */
function specsAvailable(node: WorkflowNode, specs: Record<string, number>): boolean {
  if (node.type !== "measurement") return true;
  return node.outcomes.every((o) => resolveBound(o.when.min, specs) !== null && resolveBound(o.when.max, specs) !== null);
}

function inRange(value: number, range: NumericRange, specs: Record<string, number>): boolean {
  const min = resolveBound(range.min, specs);
  const max = resolveBound(range.max, specs);
  if (min === null || max === null) return false;
  if (min !== undefined && (range.minInclusive === false ? value <= min : value < min)) return false;
  if (max !== undefined && (range.maxInclusive === false ? value >= max : value > max)) return false;
  return true;
}

function holds(condition: Condition, session: DiagnosticSession): boolean {
  if ("dtcAny" in condition) return (session.facts.dtcs ?? []).some((code) => condition.dtcAny.includes(code));
  if ("symptomAny" in condition) return (session.facts.symptoms ?? []).some((s) => condition.symptomAny.includes(s));
  if ("vehicle" in condition) return session.facts.vehicle?.[condition.vehicle] === condition.equals;
  if ("answered" in condition) {
    const last = [...session.evidence].reverse().find((e) => e.nodeId === condition.answered && e.kind !== "start_fact");
    return last?.value === condition.is;
  }
  if ("all" in condition) return condition.all.every((c) => holds(c, session));
  if ("any" in condition) return condition.any.some((c) => holds(c, session));
  return !holds(condition.not, session);
}

function freezeSession(session: DiagnosticSession): DiagnosticSession {
  return Object.freeze({
    ...session,
    evidence: Object.freeze([...session.evidence]),
    inputs: Object.freeze([...session.inputs]),
    remainingCauses: Object.freeze([...session.remainingCauses]),
    supportedCauses: Object.freeze([...session.supportedCauses]),
  });
}

/** A new session with one more piece of evidence and its effect on the candidate causes. */
function record(
  session: DiagnosticSession,
  entry: Omit<Evidence, "seq">,
  effect: CauseEffect = {},
): DiagnosticSession {
  const evidence = Object.freeze({ ...entry, ...(entry.measured ? { measured: Object.freeze({ ...entry.measured }) } : {}), seq: session.evidence.length + 1 }) as Evidence;
  const ruledOut = new Set(effect.rulesOut ?? []);
  const remainingCauses = session.remainingCauses.filter((id) => !ruledOut.has(id));
  const supportedCauses = [...session.supportedCauses];
  for (const id of effect.supports ?? []) if (remainingCauses.includes(id) && !supportedCauses.includes(id)) supportedCauses.push(id);
  return { ...session, evidence: [...session.evidence, evidence], remainingCauses, supportedCauses: supportedCauses.filter((id) => remainingCauses.includes(id)) };
}

/**
 * Move from `nodeId` through every step that needs no input (branches,
 * conclusions, steps the person cannot do), stopping at the next step that
 * needs input, or at the end.
 */
function advance(p: Prepared, from: DiagnosticSession, nodeId: NodeId, at?: string): StepResult {
  let session = from;
  let id = nodeId;
  const specs = session.facts.specs ?? {};
  for (let step = 0; step < MAX_AUTOMATIC_STEPS; step++) {
    const node = p.byId.get(id);
    if (!node) return fail(`broken_transition: ${id}`);

    // Steps the person cannot safely or practically do are never presented.
    const able = canDo(node, session.facts.capabilities);
    if (!able.ok && node.ifUnsupported) {
      session = record(session, { nodeId: node.id, kind: "unsupported", value: able.reason, unsupportedReason: able.reason, to: node.ifUnsupported, ...(at ? { at } : {}) });
      id = node.ifUnsupported;
      continue;
    }
    if (!specsAvailable(node, specs) && node.ifUnsupported) {
      session = record(session, { nodeId: node.id, kind: "unsupported", value: "missing_spec", unsupportedReason: "missing_spec", to: node.ifUnsupported, ...(at ? { at } : {}) });
      id = node.ifUnsupported;
      continue;
    }

    switch (node.type) {
      case "start":
        id = node.next;
        continue;
      case "branch": {
        const index = node.rules.findIndex((rule) => holds(rule.if, session));
        const rule = index >= 0 ? node.rules[index] : null;
        const to = rule ? rule.to : node.otherwise;
        session = record(session, { nodeId: node.id, kind: "branch", value: rule ? `rule:${index + 1}` : "otherwise", to, ...(at ? { at } : {}) }, rule ?? {});
        id = to;
        continue;
      }
      case "conclusion":
        session = { ...session, conclusionNodeId: node.id };
        id = node.next;
        continue;
      case "end":
        return { ok: true, session: freezeSession({ ...session, status: "completed", currentNodeId: null, endResult: node.result }) };
      default:
        return { ok: true, session: freezeSession({ ...session, currentNodeId: node.id }) };
    }
  }
  return fail("step_limit: the workflow did not reach a step needing input or an end");
}

/* ───────────────────────── public API ───────────────────────── */

/** Start a session. Start facts (codes, symptoms) are recorded as the first evidence. */
export function startSession(workflow: WorkflowDefinition, facts: SessionStartFacts, at?: string): StepResult {
  const p = prepare(workflow);
  if ("error" in p) return fail(p.error);
  if (!facts?.capabilities || !(facts.capabilities.maxLevel in SKILL_ORDER) || !Array.isArray(facts.capabilities.tools)) return fail("invalid_facts: capabilities are required");
  const normalized: SessionStartFacts = {
    ...facts,
    dtcs: (facts.dtcs ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean),
    symptoms: [...(facts.symptoms ?? [])],
    specs: { ...(facts.specs ?? {}) },
  };
  let session: DiagnosticSession = {
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    facts: Object.freeze(normalized),
    status: "in_progress",
    currentNodeId: null,
    evidence: [],
    inputs: [],
    remainingCauses: workflow.causes.map((c) => c.id),
    supportedCauses: [],
    conclusionNodeId: null,
    endResult: null,
    repairVerified: null,
  };
  const start = p.start as Extract<WorkflowNode, { type: "start" }>;
  for (const code of normalized.dtcs ?? []) session = record(session, { nodeId: start.id, kind: "start_fact", value: `dtc:${code}`, to: start.next, ...(at ? { at } : {}) });
  for (const symptom of normalized.symptoms ?? []) session = record(session, { nodeId: start.id, kind: "start_fact", value: `symptom:${symptom}`, to: start.next, ...(at ? { at } : {}) });
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
 * an option the step does not offer, a reading in the wrong kind of unit) is
 * refused and the session is unchanged.
 */
export function submitStep(workflow: WorkflowDefinition, session: DiagnosticSession, input: StepInput, at?: string): StepResult {
  const p = prepare(workflow);
  if ("error" in p) return fail(p.error);
  if (session.workflowId !== workflow.id || session.workflowVersion !== workflow.version) return fail("wrong_workflow");
  if (session.status !== "in_progress" || session.currentNodeId === null) return fail("session_complete");
  if (!input || input.nodeId !== session.currentNodeId) return fail("not_current_step");
  const node = p.byId.get(session.currentNodeId);
  if (!node) return fail("broken_session");

  const base = { nodeId: node.id, ...(at ? { at } : {}) };
  const logged: DiagnosticSession = { ...session, inputs: [...session.inputs, Object.freeze({ ...input, ...(at ? { at } : {}) })] };
  const go = (next: DiagnosticSession, to: NodeId) => advance(p, next, to, at);

  if (input.kind === "unable") {
    if (!node.ifUnsupported) return fail("no_alternative: this step has no route for when it cannot be done");
    return go(record(logged, { ...base, kind: "unsupported", value: input.reason, unsupportedReason: input.reason, to: node.ifUnsupported }), node.ifUnsupported);
  }

  switch (node.type) {
    case "prerequisite": {
      if (input.kind !== "prerequisite") return fail("wrong_input_kind");
      const to = input.met ? node.ifMet : node.ifNotMet;
      return go(record(logged, { ...base, kind: "prerequisite", value: input.met ? "met" : "not_met", to }), to);
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
      if (!isUnit(input.unit) || typeof input.value !== "number" || !Number.isFinite(input.value)) return fail("invalid_measurement");
      const value = convert(input.value, input.unit, node.measurement.unit);
      if (value === null) return fail(`wrong_unit: this step measures in ${node.measurement.unit}`);
      const specs = session.facts.specs ?? {};
      const outcome = node.outcomes.find((o) => inRange(value, o.when, specs));
      const to = outcome?.to ?? node.otherwise;
      return go(
        record(logged, { ...base, kind: "measurement", value: `${input.value} ${input.unit}`, measured: { value, unit: node.measurement.unit }, to }, outcome ?? {}),
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
      return go(record(logged, { ...base, kind: "action", value: "done", to: node.next }), node.next);
    }
    case "repair_verification": {
      if (input.kind !== "verification") return fail("wrong_input_kind");
      const to = input.verified ? node.ifVerified : node.ifNotVerified;
      return go({ ...record(logged, { ...base, kind: "verification", value: input.verified ? "verified" : "not_verified", to }), repairVerified: input.verified }, to);
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
 * Continue a saved session. It is rebuilt from its facts and inputs and must
 * match what was saved exactly, so a session that was edited, or saved
 * against another version of the workflow, is refused rather than trusted.
 */
export function resumeSession(workflow: WorkflowDefinition, saved: unknown): StepResult {
  const s = saved as Partial<DiagnosticSession> | null;
  if (!s || typeof s !== "object" || !s.facts || !Array.isArray(s.inputs) || !Array.isArray(s.evidence)) return fail("invalid_session");
  if (s.workflowId !== workflow.id || s.workflowVersion !== workflow.version) return fail("wrong_workflow");
  const startedAt = s.evidence.find((e) => e.kind === "start_fact")?.at;
  const rebuilt = replaySession(workflow, s.facts, s.inputs, startedAt);
  if (!rebuilt.ok) return fail(`invalid_session: ${rebuilt.error}`);
  if (JSON.stringify(rebuilt.session) !== JSON.stringify(s)) return fail("invalid_session: it does not match its own inputs");
  return rebuilt;
}

/**
 * Steps that could separate the causes still in play, cheapest first.
 *
 * A step "separates" when at least one of its outcomes rules out a remaining
 * cause while leaving another. Order: steps the person can do first; then the
 * lowest skill level; then the step whose most telling outcome rules out the
 * most remaining causes; then the fewest tools. No probabilities are involved.
 */
export function separatingSteps(workflow: WorkflowDefinition, session: DiagnosticSession) {
  const p = prepare(workflow);
  if ("error" in p) return [];
  const remaining = new Set(session.remainingCauses);
  const answered = new Set(session.evidence.map((e) => e.nodeId));
  const out: Array<{ nodeId: NodeId; title: string; canDo: boolean; level: string; tools: string[]; rulesOutUpTo: number }> = [];
  for (const node of p.workflow.nodes) {
    if (answered.has(node.id) || !("outcomes" in node)) continue;
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
