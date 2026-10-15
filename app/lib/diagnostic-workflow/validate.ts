/**
 * Checking a workflow before anyone runs it.
 *
 * A workflow is accepted only if every run must end: one start, unique ids,
 * every transition pointing at a real step, every step reachable, no loops,
 * every possible answer to a step going somewhere, and every step that needs
 * skill or tools having somewhere to go when the person cannot do it.
 * Problems are reported all at once, each with a stable code.
 */
import { SKILL_ORDER, type Condition, type NodeId, type NumericRange, type WorkflowDefinition, type WorkflowNode } from "./types";
import { isUnit } from "./units";

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
    if (typeof b === "number" && !Number.isFinite(b)) return "a range bound is not a finite number";
    if (typeof b === "object" && (!b || typeof b.spec !== "string" || !b.spec.trim())) return "a range bound names no specification";
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
      for (const o of node.outcomes) {
        const problem = rangeProblems(o.when);
        if (problem) add("invalid_range", `"${node.id}": ${problem}.`, node.id);
      }
    }

    // A step above owner level, or needing tools, says where to go when it cannot be done.
    const needs = node.requires;
    if (needs && (SKILL_ORDER[needs.level] > 0 || (needs.tools?.length ?? 0) > 0) && !node.ifUnsupported) {
      add("no_unsupported_route", `"${node.id}" needs skill or tools but has no route for when it cannot be done.`, node.id);
    }
    if (needs && !(needs.level in SKILL_ORDER)) add("malformed", `"${node.id}" names an unknown skill level.`, node.id);

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
    if (node.type === "measurement" && node.outcomes.some((o) => typeof o.when.min === "object" || typeof o.when.max === "object") && !node.ifUnsupported) {
      add("no_unsupported_route", `"${node.id}" uses a vehicle specification but has no route for when the specification is not available.`, node.id);
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
  }

  // With no loops and every answer routed, every run finishes at an end node, as long as one exists.
  if (![...byId.values()].some((n) => n.type === "end")) add("no_end", "The workflow has no end node.");

  return problems.length ? { ok: false, problems } : { ok: true };
}
