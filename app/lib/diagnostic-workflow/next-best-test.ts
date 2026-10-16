/**
 * Next best test (V2E) and the limited post-repair recheck plan.
 *
 * RESEARCH PROTOTYPE. Deterministic and explainable:
 * - ranking happens only inside an EXPLICIT reorderable region
 *   (a test_selection step); everywhere else the workflow order stands;
 * - only eligible candidates are ranked (definitely reachable, capable, their
 *   conditions established, not done, able to change the remaining causes);
 * - the order is lexicographic over reviewed, categorical facts. No
 *   probabilities, confidence, money, time or scores, and nothing from AI;
 * - the recheck plan lists what would verify a repair; it runs nothing and
 *   verifies nothing.
 */
import { holds, unknownVehicleFacts } from "./conditions";
import { capabilityShortfall } from "./context";
import {
  INVASIVENESS,
  SCAN_ORDER,
  SETUP,
  SKILL_ORDER,
  TEST_RISK,
  type CauseEffect,
  type CauseId,
  type DiagnosticSession,
  type Evidence,
  type NodeId,
  type RepairVerificationNode,
  type StepRequirements,
  type TestProfile,
  type TestSelectionNode,
  type VerificationCriterion,
  type WorkflowNode,
} from "./types";

/* ───────────────────────── what a test can tell us ───────────────────────── */

/** One possible result of a test and its declared effect on the causes still in play. */
export type ResultEffect = { result: string; rulesOut: CauseId[]; supports: CauseId[]; changesCauses: boolean };

/**
 * Every possible result of a test step, from the reviewed workflow only.
 * "Unable" and "inconclusive" are not results: they never change causes and
 * are left out, so declaring them does not penalize a test.
 */
function resultsOf(node: WorkflowNode): Array<{ result: string; to: NodeId } & CauseEffect> {
  switch (node.type) {
    case "check":
    case "actuator_test":
      return node.outcomes.map((o) => ({ result: o.when, to: o.to, rulesOut: o.rulesOut, supports: o.supports }));
    case "observation":
      return node.options.map((opt) => {
        const o = node.outcomes.find((x) => x.when === opt.id);
        return o ? { result: opt.id, to: o.to, rulesOut: o.rulesOut, supports: o.supports } : { result: opt.id, to: node.otherwise! };
      });
    case "measurement":
      return [...node.outcomes.map((o) => ({ result: o.id, to: o.to, rulesOut: o.rulesOut, supports: o.supports })), { result: "otherwise", to: node.otherwise }];
    default:
      return [];
  }
}

/**
 * Whether some result of the test leads straight to a conclusion about a
 * cause the evidence has already ruled out. Under the single-primary-fault
 * assumption that result would contradict the evidence, so the test is not
 * offered (conservative), rather than risk a dead end.
 */
function couldContradict(node: WorkflowNode, byId: ReadonlyMap<NodeId, WorkflowNode>, remaining: readonly CauseId[]): boolean {
  return resultsOf(node).some((r) => {
    const target = byId.get(r.to);
    return target?.type === "conclusion" && !!target.cause && !remaining.includes(target.cause);
  });
}

/** What a test can do to the remaining causes. Single primary fault: ruling out removes a cause; supporting marks one. */
export function separation(node: WorkflowNode, remaining: readonly CauseId[]) {
  const live = new Set(remaining);
  const effects: ResultEffect[] = resultsOf(node).map((r) => {
    const rulesOut = (r.rulesOut ?? []).filter((c) => live.has(c));
    const supports = (r.supports ?? []).filter((c) => live.has(c));
    return { result: r.result, rulesOut, supports, changesCauses: rulesOut.length > 0 || supports.length > 0 };
  });
  const causes = [...new Set(effects.flatMap((e) => [...e.rulesOut, ...e.supports]))].sort((a, b) => remaining.indexOf(a) - remaining.indexOf(b));
  // Minimax: the number of causes still in play after the LEAST helpful result.
  const worstCaseRemaining = effects.length ? Math.max(...effects.map((e) => remaining.length - e.rulesOut.length)) : remaining.length;
  const changing = effects.filter((e) => e.changesCauses).length;
  const decisiveness: Decisiveness = changing === 0 ? "context_only" : changing === effects.length ? "decisive" : "partial";
  return { causes, worstCaseRemaining, decisiveness, results: effects };
}

/**
 * - decisive: every possible result changes the remaining causes;
 * - partial: some results do, others leave the diagnosis where it is;
 * - context_only: no result changes the remaining causes (never ranked).
 */
export type Decisiveness = "decisive" | "partial" | "context_only";
const DECISIVENESS_ORDER: Record<Decisiveness, number> = { decisive: 0, partial: 1, context_only: 2 };

/* ───────────────────────── region analysis ───────────────────────── */

export type RankedCandidate = {
  step: NodeId;
  title: string;
  /** Position in the author's list: the final tie-break. */
  declared: number;
  profile: TestProfile;
  requires: { level: StepRequirements["level"]; scan?: StepRequirements["scan"]; instruments: string[]; facilities: string[] };
  hazards: string[];
  separation: ReturnType<typeof separation>;
};

export type RegionAnalysis = {
  group: string;
  selection: NodeId;
  /** Eligible, useful candidates, best first. */
  ranked: RankedCandidate[];
  /** Useful candidates the person cannot do now (capability or unestablished conditions). Missing capability is not evidence. */
  blocked: Array<{ step: NodeId; title: string; reason: "capability" | "conditions"; missing: string[]; separates: CauseId[] }>;
  /** Useful candidates that depend on context this session does not have (never ranked, never treated as "no"). */
  potential: Array<{ step: NodeId; title: string; missingContext: string[]; separates: CauseId[] }>;
  /** Not offered: already done, definitely not applicable here, or unable to change the remaining causes. */
  excluded: Array<{ step: NodeId; reason: "already_done" | "not_applicable" | "cannot_change_remaining_causes" | "could_conclude_a_ruled_out_cause" }>;
};

/** Steps the session already has evidence for (done, skipped, unable or inconclusive). Each candidate runs at most once. */
function doneSteps(evidence: readonly Evidence[]): Set<NodeId> {
  return new Set(evidence.filter((e) => e.kind !== "specification" && e.kind !== "test_selection").map((e) => e.nodeId));
}

const index = <T extends string>(list: readonly T[], value: T) => list.indexOf(value);

/** The ranking keys, in priority order. Lower is better on every key. */
function keys(c: RankedCandidate): number[] {
  return [
    index(TEST_RISK, c.profile.risk),
    c.separation.worstCaseRemaining,
    DECISIVENESS_ORDER[c.separation.decisiveness],
    index(INVASIVENESS, c.profile.invasiveness),
    index(SETUP, c.profile.setup),
    c.requires.instruments.length + c.requires.facilities.length,
    SKILL_ORDER[c.requires.level],
    SCAN_ORDER[c.requires.scan ?? "none"],
    c.declared,
  ];
}

/** Why `a` ranks above `b`, in words: the first key that decides. */
export function preferenceReason(a: RankedCandidate, b: RankedCandidate): string {
  const ka = keys(a);
  const kb = keys(b);
  const i = ka.findIndex((v, j) => v !== kb[j]);
  switch (i) {
    case 0:
      return `lower risk (${a.profile.risk} vs ${b.profile.risk})`;
    case 1:
      return `separates more: at most ${a.separation.worstCaseRemaining} causes remain whatever the result, vs ${b.separation.worstCaseRemaining}`;
    case 2:
      return a.separation.decisiveness === "decisive" ? "every possible result changes the remaining causes" : "more of its results change the remaining causes";
    case 3:
      return `less invasive (${a.profile.invasiveness} vs ${b.profile.invasiveness})`;
    case 4:
      return `less setup (${a.profile.setup} vs ${b.profile.setup})`;
    case 5:
      return "needs fewer additional instruments or facilities";
    case 6:
      return `needs less skill (${a.requires.level} vs ${b.requires.level})`;
    case 7:
      return `needs less scan access (${a.requires.scan ?? "none"} vs ${b.requires.scan ?? "none"})`;
    default:
      return "listed earlier by the workflow author (otherwise equivalent)";
  }
}

/**
 * Analyze a reorderable region for the session standing at its selection.
 * Pure and deterministic: same workflow, same pinned session, same result.
 */
export function analyzeRegion(byId: ReadonlyMap<NodeId, WorkflowNode>, selection: TestSelectionNode, session: DiagnosticSession): RegionAnalysis {
  const out: RegionAnalysis = { group: selection.group, selection: selection.id, ranked: [], blocked: [], potential: [], excluded: [] };
  const done = doneSteps(session.evidence);
  const remaining = session.remainingCauses;
  selection.candidates.forEach((entry, declared) => {
    const node = byId.get(entry.step)!;
    if (done.has(node.id)) return out.excluded.push({ step: node.id, reason: "already_done" });
    const sep = separation(node, remaining);
    const useful = sep.decisiveness !== "context_only" && remaining.length > 1;
    if (entry.when !== undefined) {
      const applies = holds(entry.when, session);
      if (applies === false) return out.excluded.push({ step: node.id, reason: "not_applicable" });
      if (applies === null) {
        // Unknown is not "no": the test stays visible as potentially available, but it does not compete.
        if (!useful) return out.excluded.push({ step: node.id, reason: "cannot_change_remaining_causes" });
        const vehicle = unknownVehicleFacts(entry.when, session);
        return out.potential.push({ step: node.id, title: node.title, missingContext: vehicle.length ? vehicle.map((f) => `vehicle:${f}`) : ["scan_evidence"], separates: sep.causes });
      }
    }
    if (!useful) return out.excluded.push({ step: node.id, reason: "cannot_change_remaining_causes" });
    if (couldContradict(node, byId, remaining)) return out.excluded.push({ step: node.id, reason: "could_conclude_a_ruled_out_cause" });
    const able = capabilityShortfall(node.requires, session.facts.capabilities);
    if (!able.ok) return out.blocked.push({ step: node.id, title: node.title, reason: "capability", missing: able.missing, separates: sep.causes });
    const unmet = (node.needsConditions ?? []).filter((c) => !session.establishedConditions.includes(c));
    if (unmet.length) return out.blocked.push({ step: node.id, title: node.title, reason: "conditions", missing: unmet.map((c) => `condition:${c}`), separates: sep.causes });
    out.ranked.push({
      step: node.id,
      title: node.title,
      declared,
      profile: node.testProfile!,
      requires: {
        level: node.requires?.level ?? "owner",
        ...(node.requires?.scan ? { scan: node.requires.scan } : {}),
        instruments: [...(node.requires?.instruments ?? [])],
        facilities: [...(node.requires?.facilities ?? [])],
      },
      hazards: [...(node.requires?.hazards ?? [])],
      separation: sep,
    });
  });
  out.ranked.sort((a, b) => {
    const ka = keys(a);
    const kb = keys(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
  return out;
}

/* ───────────────────────── public recommendation shape ───────────────────────── */

export type Recommendation = {
  step: NodeId;
  title: string;
  /** Why it may be offered now, in words. */
  eligibleBecause: string[];
  /** What it can tell apart among the causes still in play. */
  separates: { causes: CauseId[]; remainingNow: number; worstCaseRemaining: number; results: ResultEffect[] };
  decisiveness: Exclude<Decisiveness, "context_only">;
  profile: TestProfile;
  requires: RankedCandidate["requires"];
  /** Shown with the test, always. */
  hazards: string[];
  /** Each lower-ranked alternative and the first reason this test was preferred. */
  preferredOver: Array<{ step: NodeId; because: string }>;
};

export type NextBestTests =
  | { status: "follow_workflow"; currentStep: NodeId | null; reason: string }
  | {
      status: "region";
      group: string;
      selection: NodeId;
      recommended: Recommendation | null;
      /** The other eligible tests, in order. Inside this region only. */
      alternatives: Recommendation[];
      blocked: RegionAnalysis["blocked"];
      potential: RegionAnalysis["potential"];
      excluded: RegionAnalysis["excluded"];
    };

export function toRecommendations(a: RegionAnalysis, remainingNow: number): Recommendation[] {
  return a.ranked.map((c, i) => ({
    step: c.step,
    title: c.title,
    eligibleBecause: [
      `part of the reorderable region "${a.group}"`,
      "reachable now",
      "your capabilities cover it",
      "its required conditions are established",
      "not done yet in this session",
      "can change the causes still in play",
    ],
    separates: { causes: c.separation.causes, remainingNow, worstCaseRemaining: c.separation.worstCaseRemaining, results: c.separation.results },
    decisiveness: c.separation.decisiveness as Exclude<Decisiveness, "context_only">,
    profile: { ...c.profile },
    requires: { ...c.requires, instruments: [...c.requires.instruments], facilities: [...c.requires.facilities] },
    hazards: [...c.hazards],
    preferredOver: a.ranked.slice(i + 1).map((other) => ({ step: other.step, because: preferenceReason(c, other) })),
  }));
}

/* ───────────────────────── limited recheck after repair ───────────────────────── */

export type RecheckItem =
  | {
      kind: "detecting_test";
      step: NodeId;
      title: string;
      /** The before-repair evidence that supported the concluded cause. */
      evidenceSeq: number;
      result: string;
      repeatable: true;
      /** The verification criterion that repeats it, when the workflow has one. Otherwise it is advisory only. */
      coveredBy?: string;
      requires: StepRequirements | undefined;
      hazards: string[];
    }
  | {
      kind: "detecting_test";
      step: NodeId;
      title: string;
      evidenceSeq: number;
      result: string;
      repeatable: false;
      reason: "historical_snapshot" | "workflow_marks_not_repeatable" | "capability_missing";
      missing?: string[];
    }
  | { kind: "criterion"; criterion: string; criterionKind: VerificationCriterion["kind"]; step?: NodeId; note: string };

export type RecheckPlan =
  | { status: "not_at_verification" }
  | { status: "plan"; verificationStep: NodeId; conclusion: NodeId | null; cause: CauseId | null; items: RecheckItem[]; note: string };

/** The result key an evidence record represents for its step, or null. */
function resultKey(e: Evidence): string | null {
  if (e.kind === "measurement" || e.kind === "snapshot_check") return e.judgement?.evaluated ? e.judgement.range : null;
  if (["check", "observation", "answer", "actuator_test"].includes(e.kind)) return e.value;
  return null;
}

/** Before-repair evidence whose declared result supported `cause`: what actually detected the fault. */
export function detectingEvidence(byId: ReadonlyMap<NodeId, WorkflowNode>, session: DiagnosticSession, cause: CauseId) {
  const out: Array<{ evidence: Evidence; node: WorkflowNode; result: string }> = [];
  for (const e of session.evidence) {
    if (e.phase !== "before_repair") continue;
    const key = resultKey(e);
    const node = byId.get(e.nodeId);
    if (key === null || !node) continue;
    let effect: CauseEffect | undefined;
    if (node.type === "measurement" || node.type === "snapshot_check") effect = node.outcomes.find((o) => o.id === key);
    else if ("outcomes" in node) effect = (node.outcomes as Array<{ when: unknown } & CauseEffect>).find((o) => o.when === key);
    if (effect?.supports?.includes(cause)) out.push({ evidence: e, node, result: key });
  }
  return out;
}

/**
 * The bounded recheck plan at a repair verification, in priority order:
 * 1. the test(s) that actually detected the concluded cause, repeated where
 *    safe and meaningful (or recorded as not repeatable, with why);
 * 2. the workflow's explicit re-test criteria;
 * 3. the code re-scan, when the workflow requires it;
 * 4. symptom confirmation, when the workflow requires it.
 * Nothing else: no unrelated tests, no restart. It runs nothing and verifies nothing.
 */
export function buildRecheckPlan(byId: ReadonlyMap<NodeId, WorkflowNode>, session: DiagnosticSession, verification: RepairVerificationNode): RecheckPlan {
  const conclusion = session.conclusionNodeId ? byId.get(session.conclusionNodeId) : undefined;
  const cause = conclusion?.type === "conclusion" ? conclusion.cause ?? null : null;
  const items: RecheckItem[] = [];
  const covered = new Set<string>();
  if (cause) {
    for (const d of detectingEvidence(byId, session, cause)) {
      const base = { kind: "detecting_test" as const, step: d.node.id, title: d.node.title, evidenceSeq: d.evidence.seq, result: d.result };
      if (d.node.type === "snapshot_check") {
        items.push({ ...base, repeatable: false, reason: "historical_snapshot" });
        continue;
      }
      if (d.node.repeatableAfterRepair === false) {
        items.push({ ...base, repeatable: false, reason: "workflow_marks_not_repeatable" });
        continue;
      }
      const able = capabilityShortfall(d.node.requires, session.facts.capabilities);
      if (!able.ok) {
        items.push({ ...base, repeatable: false, reason: "capability_missing", missing: able.missing });
        continue;
      }
      const criterion = verification.criteria.find((c) => c.kind === "retest" && c.step === d.node.id);
      if (criterion) covered.add(criterion.id);
      items.push({ ...base, repeatable: true, ...(criterion ? { coveredBy: criterion.id } : {}), requires: d.node.requires, hazards: [...(d.node.requires?.hazards ?? [])] });
    }
  }
  const order: VerificationCriterion["kind"][] = ["retest", "codes_absent", "symptom_absent"];
  for (const kind of order) {
    for (const c of verification.criteria) {
      if (c.kind !== kind || covered.has(c.id)) continue;
      if (c.kind === "retest") {
        const pinned = (() => {
          const n = byId.get(c.step);
          const id = n?.type === "measurement" ? n.specification : undefined;
          const r = id ? session.specifications[id] : undefined;
          return r && (r.status === "verified" || r.status === "informational") ? ` against the pinned specification ${id}@${r.specification.revision} (only a verified one can decide)` : "";
        })();
        items.push({ kind: "criterion", criterion: c.id, criterionKind: "retest", step: c.step, note: `repeat "${c.step}"${pinned}; must give ${c.passWhen.join(" or ")}` });
      } else if (c.kind === "codes_absent") {
        items.push({
          kind: "criterion",
          criterion: c.id,
          criterionKind: "codes_absent",
          note: "a COMPLETE post-repair scan is needed; a partial or unknown scan is inconclusive, and a code still listed only as permanent or history is inconclusive, not a failure",
        });
      } else {
        items.push({ kind: "criterion", criterion: c.id, criterionKind: "symptom_absent", note: c.prompt });
      }
    }
  }
  return {
    status: "plan",
    verificationStep: verification.id,
    conclusion: session.conclusionNodeId,
    cause,
    items,
    note: "A plan only: the repair is verified solely by the after-repair evidence entered at the verification step.",
  };
}
