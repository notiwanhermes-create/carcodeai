/**
 * Checking a workflow before anyone runs it.
 *
 * A workflow is accepted only if every run must end: one start, unique ids,
 * every transition pointing at a real step, every step reachable, no loops,
 * every possible answer to a step going somewhere, and every step that needs
 * skill or tools having somewhere to go when the person cannot do it.
 *
 * V2A adds: a declared fault model; named conditions that every route
 * establishes before the steps needing them; inconclusive routes only where
 * they make sense; plausible ranges on measurements, with fixed pass bounds
 * inside them; and repair verifications that name real criteria.
 * Problems are reported all at once, each with a stable code.
 */
import {
  FACILITIES,
  FAULT_MODELS,
  INSTRUMENTS,
  SCAN_ACCESS,
  INCONCLUSIVE_TYPES,
  SKILL_ORDER,
  SPEC_RELATIONS,
  type Condition,
  type ConditionId,
  type MeasurementNode,
  type NodeId,
  type NumericRange,
  type WorkflowDefinition,
  type WorkflowNode,
} from "./types";
import { isUnit } from "./units";
import { applicabilityProblems } from "./context";

export type WorkflowProblem = { code: string; nodeId?: NodeId; message: string };
export type ValidationResult = { ok: true } | { ok: false; problems: WorkflowProblem[] };

/** Every step a node can lead to, in a fixed order. */
export function successors(node: WorkflowNode): NodeId[] {
  const out: NodeId[] = [];
  switch (node.type) {
    case "start":
    case "action":
      out.push(node.next);
      break;
    case "prerequisite":
      out.push(node.ifMet, node.ifNotMet);
      break;
    case "question":
    case "observation":
      out.push(...node.outcomes.map((o) => o.to));
      if (node.otherwise) out.push(node.otherwise);
      break;
    case "measurement":
      out.push(...node.outcomes.map((o) => o.to), node.otherwise);
      break;
    case "check":
    case "actuator_test":
    case "service_function":
      out.push(...node.outcomes.map((o) => o.to));
      break;
    case "branch":
      out.push(...node.rules.map((r) => r.to), node.otherwise);
      break;
    case "conclusion":
      out.push(node.next);
      break;
    case "repair_verification":
      out.push(node.ifVerified, node.ifNotVerified);
      break;
    case "end":
      break;
  }
  if (node.ifUnsupported) out.push(node.ifUnsupported);
  if (node.ifInconclusive) out.push(node.ifInconclusive);
  return out;
}

/** Every transition out of a node, with the named conditions taking it establishes. */
function edges(node: WorkflowNode): Array<{ to: NodeId; establishes: ConditionId[] }> {
  const plain = (to: NodeId) => ({ to, establishes: [] as ConditionId[] });
  if (node.type === "prerequisite") {
    return [{ to: node.ifMet, establishes: node.establishes ?? [] }, plain(node.ifNotMet), ...[node.ifUnsupported, node.ifInconclusive].filter((x): x is NodeId => !!x).map(plain)];
  }
  if (node.type === "action") {
    return [{ to: node.next, establishes: node.establishes ?? [] }, ...[node.ifUnsupported, node.ifInconclusive].filter((x): x is NodeId => !!x).map(plain)];
  }
  return successors(node).map(plain);
}

/** The keys a step's results can take, for checking a re-test's passWhen. */
function resultKeys(node: WorkflowNode): string[] | null {
  if (node.type === "check") return ["pass", "fail"];
  if (node.type === "observation") return node.options.map((o) => o.id);
  if (node.type === "measurement") return node.outcomes.map((o) => o.id);
  return null;
}

function conditionNames(c: Condition): ConditionId[] {
  if ("established" in c) return [c.established];
  if ("all" in c) return c.all.flatMap(conditionNames);
  if ("any" in c) return c.any.flatMap(conditionNames);
  if ("not" in c) return conditionNames(c.not);
  return [];
}

function measurementProblems(node: MeasurementNode): string[] {
  const out: string[] = [];
  const p = node.measurement?.plausible;
  if (!p || !Number.isFinite(p.min) || !Number.isFinite(p.max) || p.min >= p.max) {
    out.push("needs a plausible range with a finite minimum below a finite maximum");
    return out;
  }
  for (const o of node.outcomes) {
    if ("relativeToSpec" in o.when) continue;
    for (const b of [o.when.min, o.when.max]) {
      if (typeof b === "number" && (b < p.min || b > p.max)) out.push(`range "${o.id}" has a fixed bound outside the plausible range`);
    }
  }
  return out;
}

function conditionNodes(c: Condition): NodeId[] {
  if ("answered" in c) return [c.answered];
  if ("all" in c) return c.all.flatMap(conditionNodes);
  if ("any" in c) return c.any.flatMap(conditionNodes);
  if ("not" in c) return conditionNodes(c.not);
  return [];
}

function rangeProblems(range: NumericRange): string | null {
  const bounds = [range.min, range.max].filter((b) => b !== undefined);
  for (const b of bounds) {
    // Vehicle values never live in a workflow: they come from the step's specification.
    if (typeof b !== "number") return "a range bound must be a fixed number; a vehicle value belongs in the step's specification";
    if (!Number.isFinite(b)) return "a range bound is not a finite number";
  }
  if (bounds.length === 0) return "a range has neither a minimum nor a maximum";
  if (typeof range.min === "number" && typeof range.max === "number" && range.min > range.max) return "a range's minimum is above its maximum";
  return null;
}

export function validateWorkflow(workflow: WorkflowDefinition): ValidationResult {
  const problems: WorkflowProblem[] = [];
  const add = (code: string, message: string, nodeId?: NodeId) => problems.push({ code, message, ...(nodeId ? { nodeId } : {}) });

  if (!workflow || typeof workflow !== "object" || !Array.isArray(workflow.nodes)) {
    return { ok: false, problems: [{ code: "malformed", message: "A workflow needs a list of nodes." }] };
  }
  if (!workflow.id || !Number.isInteger(workflow.version) || workflow.version < 1) add("malformed", "A workflow needs an id and a whole-number version from 1.");
  if (!workflow.provenance?.trim()) add("no_provenance", "A workflow must say where its content came from.");
  if (workflow.applicability !== undefined) {
    const problems = workflow.applicability && typeof workflow.applicability === "object" ? applicabilityProblems(workflow.applicability) : ["must be an object"];
    for (const problem of problems) add("invalid_applicability", `Applicability: ${problem}.`);
  }
  if (!(FAULT_MODELS as readonly string[]).includes(workflow.faultModel)) {
    add("unsupported_fault_model", `A workflow must state its fault model, and only ${FAULT_MODELS.join(", ")} is supported.`);
  }

  // Ids.
  const byId = new Map<NodeId, WorkflowNode>();
  for (const node of workflow.nodes) {
    if (!node?.id) {
      add("malformed", "A node has no id.");
      continue;
    }
    if (byId.has(node.id)) add("duplicate_id", `Two nodes share the id "${node.id}".`, node.id);
    else byId.set(node.id, node);
  }
  const causeIds = new Set<string>();
  for (const cause of workflow.causes ?? []) {
    if (causeIds.has(cause.id)) add("duplicate_cause", `Two causes share the id "${cause.id}".`);
    causeIds.add(cause.id);
  }
  const conditionIds = new Set<ConditionId>();
  for (const condition of workflow.conditions ?? []) {
    if (!condition?.id || conditionIds.has(condition.id)) add("duplicate_condition", `A named condition is missing its id or shares the id "${condition?.id}".`);
    conditionIds.add(condition?.id);
  }

  // Exactly one start.
  const starts = workflow.nodes.filter((n) => n?.type === "start");
  if (starts.length === 0) add("no_start", "The workflow has no start node.");
  if (starts.length > 1) add("multiple_starts", "The workflow has more than one start node.");

  for (const node of byId.values()) {
    // Every transition goes to a real step.
    for (const to of successors(node)) {
      if (!byId.has(to)) add("broken_transition", `"${node.id}" leads to "${to}", which does not exist.`, node.id);
    }

    // Every possible answer goes somewhere.
    if (node.type === "question" && node.answer === "yes_no") {
      const covered = new Set(node.outcomes.map((o) => o.when));
      if (!node.otherwise && (!covered.has("yes") || !covered.has("no"))) add("incomplete_outcomes", `"${node.id}" does not say where both "yes" and "no" lead.`, node.id);
    }
    if ((node.type === "question" && node.answer === "choice") || node.type === "observation") {
      const options = new Set(node.options.map((o) => o.id));
      if (options.size === 0) add("incomplete_outcomes", `"${node.id}" offers no options.`, node.id);
      for (const o of node.outcomes) if (!options.has(o.when)) add("unknown_option", `"${node.id}" has an outcome for "${o.when}", which is not one of its options.`, node.id);
      const covered = new Set(node.outcomes.map((o) => o.when));
      if (!node.otherwise && [...options].some((id) => !covered.has(id))) add("incomplete_outcomes", `"${node.id}" does not say where every option leads.`, node.id);
    }
    if (node.type === "check") {
      const covered = new Set(node.outcomes.map((o) => o.when));
      if (!covered.has("pass") || !covered.has("fail")) add("incomplete_outcomes", `"${node.id}" does not say where both "pass" and "fail" lead.`, node.id);
    }
    if (node.type === "measurement") {
      if (!isUnit(node.measurement?.unit)) add("unknown_unit", `"${node.id}" measures in a unit the engine does not know.`, node.id);
      if (node.outcomes.length === 0) add("incomplete_outcomes", `"${node.id}" has no ranges.`, node.id);
      if (node.specification !== undefined) {
        // Judged against a specification: every outcome says where the reading sits against it, each place once.
        if (typeof node.specification !== "string" || !node.specification.trim()) add("invalid_specification_ref", `"${node.id}" names no specification.`, node.id);
        const relations = node.outcomes.map((o) => ("relativeToSpec" in o.when ? o.when.relativeToSpec : null));
        if (relations.some((r) => r === null || !(SPEC_RELATIONS as readonly string[]).includes(r))) {
          add("invalid_range", `"${node.id}": with a specification, every range must be relativeToSpec below, within or above.`, node.id);
        } else if (new Set(relations).size !== relations.length) {
          add("invalid_range", `"${node.id}": each of below, within and above may appear only once.`, node.id);
        }
        if (!node.ifUnsupported) add("no_unsupported_route", `"${node.id}" uses a specification but has no route for when it cannot be resolved.`, node.id);
      } else {
        for (const o of node.outcomes) {
          if ("relativeToSpec" in o.when) {
            add("invalid_range", `"${node.id}": a range relative to a specification needs the step to name one.`, node.id);
            continue;
          }
          const problem = rangeProblems(o.when);
          if (problem) add("invalid_range", `"${node.id}": ${problem}.`, node.id);
        }
      }
    }

    if (node.type === "measurement") {
      for (const problem of measurementProblems(node)) add("invalid_plausible_range", `"${node.id}": ${problem}.`, node.id);
      const ids = node.outcomes.map((o) => o.id);
      if (ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length || ids.includes("otherwise")) {
        add("invalid_range_id", `"${node.id}": every range needs its own id (and not "otherwise").`, node.id);
      }
    }

    // Inconclusive routes only where a result can fail to decide; a repair verification must have one.
    if (node.ifInconclusive && !INCONCLUSIVE_TYPES.has(node.type)) add("inconclusive_not_allowed", `"${node.id}" is a ${node.type} step, which cannot be inconclusive.`, node.id);
    if (node.type === "repair_verification") {
      if (!node.ifInconclusive) add("no_inconclusive_route", `"${node.id}" must say where an inconclusive verification leads.`, node.id);
      const criteria = Array.isArray(node.criteria) ? node.criteria : [];
      if (criteria.length === 0) add("no_verification_criteria", `"${node.id}" must name what has to hold after the repair.`, node.id);
      const seen = new Set<string>();
      for (const c of criteria) {
        if (!c?.id || seen.has(c.id)) add("invalid_criterion", `"${node.id}": every criterion needs its own id.`, node.id);
        seen.add(c?.id);
        if (c?.kind === "codes_absent" && c.codes !== "reported" && !(Array.isArray(c.codes) && c.codes.length > 0)) {
          add("invalid_criterion", `"${node.id}": criterion "${c.id}" names no codes.`, node.id);
        }
        if (c?.kind === "retest") {
          const target = byId.get(c.step);
          const keys = target ? resultKeys(target) : null;
          if (!keys) add("invalid_retest", `"${node.id}": criterion "${c.id}" re-tests "${c.step}", which is not a check, observation or measurement.`, node.id);
          else if (!Array.isArray(c.passWhen) || c.passWhen.length === 0 || c.passWhen.some((k) => !keys.includes(k))) {
            add("invalid_retest", `"${node.id}": criterion "${c.id}" must pass on results "${c.step}" can give (${keys.join(", ")}).`, node.id);
          }
        }
        if (!c || !["symptom_absent", "codes_absent", "retest"].includes(c.kind)) add("invalid_criterion", `"${node.id}": a criterion has an unknown kind.`, node.id);
      }
    }

    // Named conditions are declared.
    const named = [
      ...(node.needsConditions ?? []),
      ...((node.type === "prerequisite" || node.type === "action") ? node.establishes ?? [] : []),
      ...(node.type === "branch" ? node.rules.flatMap((r) => conditionNames(r.if)) : []),
    ];
    for (const name of named) if (!conditionIds.has(name)) add("unknown_condition", `"${node.id}" refers to an undeclared condition "${name}".`, node.id);

    // A step needing more than an owner with nothing says where to go when it cannot be done.
    const needs = node.requires;
    const demanding = !!needs && (SKILL_ORDER[needs.level] > 0 || (needs.scan !== undefined && needs.scan !== "none") || (needs.instruments?.length ?? 0) > 0 || (needs.facilities?.length ?? 0) > 0);
    if (demanding && !node.ifUnsupported) {
      add("no_unsupported_route", `"${node.id}" needs skill, scan access, instruments or facilities but has no route for when it cannot be done.`, node.id);
    }
    if (needs && !(needs.level in SKILL_ORDER)) add("malformed", `"${node.id}" names an unknown skill level.`, node.id);
    if (needs?.scan !== undefined && !(SCAN_ACCESS as readonly string[]).includes(needs.scan)) add("malformed", `"${node.id}" names an unknown scan access level.`, node.id);
    if ((needs?.instruments ?? []).some((i) => !(INSTRUMENTS as readonly string[]).includes(i))) add("malformed", `"${node.id}" names an unknown instrument.`, node.id);
    if ((needs?.facilities ?? []).some((f) => !(FACILITIES as readonly string[]).includes(f))) add("malformed", `"${node.id}" names an unknown facility.`, node.id);

    // Actuator tests and service functions are modelling of work an external tool does: they need
    // bidirectional scan access and hazard notes, and use generic ids only.
    if (node.type === "actuator_test" || node.type === "service_function") {
      if (needs?.scan !== "bidirectional") add("needs_bidirectional", `"${node.id}" commands the vehicle through an external tool, so it must require bidirectional scan access.`, node.id);
      if (!(needs?.hazards?.length)) add("no_hazards", `"${node.id}" must state its hazards.`, node.id);
      const genericId = node.type === "actuator_test" ? node.actuator : node.serviceFunction;
      if (typeof genericId !== "string" || !/^[a-z0-9_.-]+$/.test(genericId)) add("invalid_generic_id", `"${node.id}" needs a generic lower-case id (no manufacturer commands).`, node.id);
    }
    if (node.type === "actuator_test") {
      const ids = (node.results ?? []).map((r) => r.id);
      if (ids.length < 2 || new Set(ids).size !== ids.length) add("incomplete_outcomes", `"${node.id}" needs two or more distinct results.`, node.id);
      const covered = node.outcomes.map((o) => o.when);
      if (covered.some((w) => !ids.includes(w))) add("unknown_option", `"${node.id}" has an outcome for a result it does not offer.`, node.id);
      if (ids.some((id) => covered.filter((w) => w === id).length !== 1)) add("incomplete_outcomes", `"${node.id}" must route each result exactly once.`, node.id);
    }
    if (node.type === "service_function") {
      const covered = node.outcomes.map((o) => o.when);
      if (covered.length !== 2 || !covered.includes("completed") || !covered.includes("failed")) add("incomplete_outcomes", `"${node.id}" must route "completed" and "failed" (not_supported takes its cannot-be-done route).`, node.id);
    }

    // Cause references are real.
    const effects = [
      ...("outcomes" in node ? node.outcomes : []),
      ...(node.type === "branch" ? node.rules : []),
    ] as Array<{ rulesOut?: string[]; supports?: string[] }>;
    for (const e of effects) {
      for (const id of [...(e.rulesOut ?? []), ...(e.supports ?? [])]) if (!causeIds.has(id)) add("unknown_cause", `"${node.id}" refers to an unknown cause "${id}".`, node.id);
    }
    if (node.type === "conclusion" && node.cause && !causeIds.has(node.cause)) add("unknown_cause", `"${node.id}" concludes an unknown cause "${node.cause}".`, node.id);
    if (node.type === "branch") {
      for (const rule of node.rules) for (const ref of conditionNodes(rule.if)) if (!byId.has(ref)) add("broken_condition", `"${node.id}" depends on "${ref}", which does not exist.`, node.id);
    }
    if (node.type === "conclusion" && byId.get(node.next) && !["repair_verification", "end"].includes(byId.get(node.next)!.type)) {
      add("bad_conclusion_next", `"${node.id}" must lead to a repair verification step or an end node.`, node.id);
    }
  }

  // Every step reachable from the start, and no loops: every run must end.
  if (starts.length === 1 && problems.every((p) => p.code !== "duplicate_id")) {
    const reached = new Set<NodeId>();
    const stack = [starts[0].id];
    while (stack.length) {
      const id = stack.pop()!;
      if (reached.has(id) || !byId.has(id)) continue;
      reached.add(id);
      stack.push(...successors(byId.get(id)!));
    }
    for (const id of byId.keys()) if (!reached.has(id)) add("unreachable", `"${id}" cannot be reached from the start.`, id);

    const state = new Map<NodeId, "visiting" | "done">();
    const visit = (id: NodeId, path: NodeId[]): void => {
      if (state.get(id) === "done" || !byId.has(id)) return;
      if (state.get(id) === "visiting") {
        add("cycle", `The workflow loops: ${[...path.slice(path.indexOf(id)), id].join(" → ")}.`, id);
        return;
      }
      state.set(id, "visiting");
      for (const next of successors(byId.get(id)!)) visit(next, [...path, id]);
      state.set(id, "done");
    };
    visit(starts[0].id, []);

    // Every route to a step establishes the named conditions it needs. With no
    // loops, walk the steps in order and keep, for each, the conditions that
    // hold on EVERY route reaching it.
    if (!problems.some((p) => p.code === "cycle" || p.code === "broken_transition")) {
      const order: NodeId[] = [];
      const seen = new Set<NodeId>();
      const post = (id: NodeId): void => {
        if (seen.has(id) || !byId.has(id)) return;
        seen.add(id);
        for (const next of successors(byId.get(id)!)) post(next);
        order.push(id);
      };
      post(starts[0].id);
      order.reverse();
      const guaranteed = new Map<NodeId, Set<ConditionId>>([[starts[0].id, new Set()]]);
      for (const id of order) {
        const here = guaranteed.get(id) ?? new Set<ConditionId>();
        for (const edge of edges(byId.get(id)!)) {
          const arriving = new Set([...here, ...edge.establishes]);
          const known = guaranteed.get(edge.to);
          guaranteed.set(edge.to, known ? new Set([...known].filter((c) => arriving.has(c))) : arriving);
        }
      }
      for (const id of order) {
        const node = byId.get(id)!;
        const missing = (node.needsConditions ?? []).filter((c) => !guaranteed.get(id)?.has(c));
        if (missing.length) add("condition_not_guaranteed", `"${id}" needs ${missing.join(", ")}, which not every route to it establishes.`, id);
      }
    }
  }

  // With no loops and every answer routed, every run finishes at an end node, as long as one exists.
  if (![...byId.values()].some((n) => n.type === "end")) add("no_end", "The workflow has no end node.");

  return problems.length ? { ok: false, problems } : { ok: true };
}
