/**
 * The explanation bridge (V2F): deterministic state → facts → optional AI wording.
 *
 * RESEARCH PROTOTYPE. The model receives ONLY deterministic facts and is
 * never asked to diagnose. Its output is presentation text, schema-checked,
 * then constrained deterministically:
 * - every deterministic safety warning is shown, verbatim, first;
 * - text that softens a warning, claims a cause, a repair success, a second
 *   fault or a safe-to-drive verdict, invents numbers or money, reorders the
 *   recommendation or proposes an unavailable test is REJECTED;
 * - on any rejection or failure a deterministic fallback explanation is used.
 * Explaining never changes the session.
 */
import {
  currentStep,
  nextBestTests,
  recheckPlan,
  type DiagnosticSession,
  type EvidenceConflict,
  type NextBestTests,
  type RecheckPlan,
  type WorkflowDefinition,
} from "../diagnostic-workflow";
import { ExplanationOutputSchema, issuePaths, type ExplanationText } from "./schemas";

type Named = { id: string; title: string };

/** Only deterministic facts the explanation needs. Same state, same context. */
export type ExplanationContext = {
  workflow: { id: string; version: number; title: string };
  status: DiagnosticSession["status"];
  endResult: DiagnosticSession["endResult"];
  phase: DiagnosticSession["phase"];
  currentStep: { id: string; type: string; title: string; prompt?: string } | null;
  causes: { unresolved: Named[]; supported: Named[]; ruledOut: Named[] };
  conclusion: { id: string; title: string; cause?: string; recommendation: string } | null;
  evidence: Array<{ seq: number; step: string; kind: string; value: string; phase: string; source: string }>;
  nextBestTests: NextBestTests;
  safety: {
    /** Must appear in every explanation, verbatim. */
    warnings: string[];
    /** Tests that cannot be done now, and why (capability, conditions, missing context). */
    unavailable: Array<{ step: string; title: string; reason: string; missing: string[] }>;
  };
  conflict: EvidenceConflict | null;
  verification: { status: DiagnosticSession["verification"]; repairVerified: boolean | null; recheckPlan: RecheckPlan };
};

/** Build the facts-only context. Pure. */
export function explanationContext(workflow: WorkflowDefinition, session: DiagnosticSession): ExplanationContext {
  const causeTitle = (id: string): Named => ({ id, title: workflow.causes.find((c) => c.id === id)?.title ?? id });
  const step = currentStep(workflow, session);
  const nbt = nextBestTests(workflow, session);
  const conclusionNode = session.conclusionNodeId ? workflow.nodes.find((n) => n.id === session.conclusionNodeId) : undefined;
  const warnings = [...(step?.requires?.hazards ?? [])];
  if (nbt.status === "region" && nbt.recommended) for (const h of nbt.recommended.hazards) if (!warnings.includes(h)) warnings.push(h);
  const unavailable =
    nbt.status === "region"
      ? [
          ...nbt.blocked.map((b) => ({ step: b.step, title: b.title, reason: b.reason, missing: [...b.missing] })),
          ...nbt.potential.map((p) => ({ step: p.step, title: p.title, reason: "missing_context", missing: [...p.missingContext] })),
        ]
      : [];
  const conflict = session.evidence.find((e) => e.kind === "conflict")?.conflict ?? null;
  return {
    workflow: { id: workflow.id, version: workflow.version, title: workflow.title },
    status: session.status,
    endResult: session.endResult,
    phase: session.phase,
    currentStep: step ? { id: step.id, type: step.type, title: step.title, ...(step.prompt ? { prompt: step.prompt } : {}) } : null,
    causes: {
      unresolved: session.remainingCauses.filter((c) => !session.supportedCauses.includes(c)).map(causeTitle),
      supported: session.supportedCauses.map(causeTitle),
      ruledOut: workflow.causes.filter((c) => !session.remainingCauses.includes(c.id)).map((c) => ({ id: c.id, title: c.title })),
    },
    conclusion:
      conclusionNode?.type === "conclusion"
        ? { id: conclusionNode.id, title: conclusionNode.title, ...(conclusionNode.cause ? { cause: conclusionNode.cause } : {}), recommendation: conclusionNode.recommendation }
        : null,
    evidence: session.evidence.map((e) => ({ seq: e.seq, step: e.nodeId, kind: e.kind, value: e.value, phase: e.phase, source: e.source })),
    nextBestTests: nbt,
    safety: { warnings, unavailable },
    conflict,
    verification: { status: session.verification, repairVerified: session.repairVerified, recheckPlan: recheckPlan(workflow, session) },
  };
}

/* ───────────────────────── adapter contract ───────────────────────── */

export const EXPLAIN_INSTRUCTIONS =
  "Explain the diagnostic state in `context` in plain words. Use only these facts. Do not diagnose, rank, change causes, " +
  "verify repairs, judge readings or give probabilities, costs or driving advice. Keep every safety warning. Answer with the JSON schema only.";

export interface ExplanationAdapter {
  explain(request: { instructions: string; context: ExplanationContext }): Promise<unknown>;
}

/* ───────────────────────── deterministic constraints ───────────────────────── */

const RULES: Array<{ code: string; test: (text: string, c: ExplanationContext) => boolean }> = [
  { code: "invented_numbers", test: (t) => /\d\s*%|\bpercent|\bprobab|\bconfiden|\bchances?\b|\bodds\b/i.test(t) },
  { code: "money", test: (t) => /\$|€|£|\bcost|\bprice|\bdollars?\b|\bcheap|\bexpensive/i.test(t) },
  { code: "driving_verdict", test: (t) => /\b(safe|ok|okay|fine|alright)\s+to\s+drive\b/i.test(t) },
  {
    code: "softens_safety",
    test: (t) => /\b(no need|don'?t need|do not need|not necessary|unnecessary|ignore|skip|optional)\b[^.]{0,50}\b(warning|precaution|safety|hazard|prerequisite|parking brake|protect)/i.test(t),
  },
  {
    code: "claims_repair_verified",
    test: (t, c) =>
      c.verification.status !== "verified" &&
      /\b(repair|fix)\w*\b[^.]{0,40}\b(worked|successful|succeeded|verified|confirmed|complete)\b|\b(problem|fault|issue|misfire)\s+(is|was|has been)\s+(fixed|solved|resolved|gone)\b|\bcodes?\s+(are|is|have been|has been)\s+(gone|cleared|absent)\b/i.test(t),
  },
  {
    code: "overrides_conflict",
    test: (t, c) => c.conflict !== null && /\b(second|two|multiple|another|both)\s+(faults?|causes?|problems?)\b|\bprobably\s+(right|correct|wrong)\b|\bmore\s+(reliable|trustworthy|believable)\b|\breal\s+cause\b/i.test(t),
  },
  { code: "claims_a_cause", test: (t, c) => c.conclusion === null && /\b(the|your)\s+(cause|culprit|problem|fault)\s+is\b|\bis\s+(definitely|certainly)\s+(the|a|your)\b/i.test(t) },
];

const mentions = (text: string, title: string) => text.toLowerCase().includes(title.toLowerCase());

/** Every reason the explanation must be rejected. Empty: acceptable. */
export function explanationViolations(out: ExplanationText, c: ExplanationContext): string[] {
  const all = [out.summary, ...out.why, ...out.whatToDoNext, ...out.warnings].join("\n");
  const found = RULES.filter((r) => r.test(all, c)).map((r) => r.code);
  // Never propose a test the engine says cannot be done now.
  if (c.safety.unavailable.some((u) => out.whatToDoNext.some((line) => mentions(line, u.title)))) found.push("recommends_unavailable_test");
  // Never reorder the deterministic recommendation: the first ranked test mentioned must be the recommended one.
  const nbt = c.nextBestTests;
  if (nbt.status === "region" && nbt.recommended) {
    const ranked = [nbt.recommended, ...nbt.alternatives];
    const first = out.whatToDoNext.find((line) => ranked.some((r) => mentions(line, r.title)));
    if (first && !mentions(first, nbt.recommended.title)) found.push("reorders_recommendation");
  }
  return found;
}

/** A plain explanation built only from the facts. Used when there is no model, or its text fails a check. */
export function deterministicExplanation(c: ExplanationContext): ExplanationText {
  const names = (xs: Named[]) => xs.map((x) => x.title).join(", ") || "none";
  const why: string[] = [];
  const next: string[] = [];
  let summary: string;
  if (c.conflict) {
    summary = c.conflict.explanation;
    for (const x of c.conflict.causes) why.push(`New evidence would ${x.newEvidenceWould.replace("_", " ")} "${x.cause}", which earlier evidence (${x.earlierEvidence.join(", ") || "none"}) had ${x.earlierState.replace("_", " ")}.`);
    next.push("Share the recorded evidence with a professional; this workflow cannot settle it.");
  } else if (c.status === "completed") {
    summary = c.conclusion ? `${c.conclusion.title}: ${c.conclusion.recommendation}` : `The workflow ended (${c.endResult ?? "unknown"}).`;
    if (c.verification.status) why.push(`Repair verification: ${c.verification.status}.`);
  } else if (c.nextBestTests.status === "region" && c.nextBestTests.recommended) {
    const r = c.nextBestTests.recommended;
    summary = `Recommended next test: ${r.title}.`;
    why.push(...r.preferredOver.map((p) => `Preferred over ${p.step}: ${p.because}.`));
    why.push(`It can separate: ${r.separates.causes.join(", ")}.`);
    next.push(r.title);
  } else if (c.verification.recheckPlan.status === "plan") {
    summary = "The repair is not verified yet. Recheck:";
    for (const item of c.verification.recheckPlan.items) next.push(item.kind === "detecting_test" ? `${item.title}${item.repeatable ? "" : ` (not repeated: ${item.reason})`}` : `${item.criterion}: ${item.note}`);
  } else {
    summary = c.currentStep ? `Next step: ${c.currentStep.title}.` : "No step is waiting.";
    if (c.currentStep) next.push(c.currentStep.title);
  }
  why.push(`Still unresolved: ${names(c.causes.unresolved)}. Supported: ${names(c.causes.supported)}. Ruled out: ${names(c.causes.ruledOut)}.`);
  for (const u of c.safety.unavailable) why.push(`${u.title} is not available now (${u.reason}: ${u.missing.join(", ")}).`);
  return { summary, why: why.slice(0, 8), whatToDoNext: next.slice(0, 5), warnings: [...c.safety.warnings] };
}

export type ExplanationResult =
  | { status: "ok"; explanation: ExplanationText; context: ExplanationContext }
  | { status: "rejected"; violations: string[]; explanation: ExplanationText; context: ExplanationContext }
  | { status: "invalid"; reason: "adapter_error" | "malformed_output"; detail?: string[]; explanation: ExplanationText; context: ExplanationContext };

/**
 * Explain the session. The model's text is used only if it is schema-valid
 * and passes every deterministic check; its warnings are kept after the
 * deterministic ones, never instead of them. Otherwise the deterministic
 * explanation is returned. The session is never changed.
 */
export async function explain(adapter: ExplanationAdapter | null, workflow: WorkflowDefinition, session: DiagnosticSession): Promise<ExplanationResult> {
  const context = explanationContext(workflow, session);
  const fallback = deterministicExplanation(context);
  if (!adapter) return { status: "ok", explanation: fallback, context };
  let raw: unknown;
  try {
    raw = await adapter.explain({ instructions: EXPLAIN_INSTRUCTIONS, context });
  } catch {
    return { status: "invalid", reason: "adapter_error", explanation: fallback, context };
  }
  const parsed = ExplanationOutputSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid", reason: "malformed_output", detail: issuePaths(parsed.error), explanation: fallback, context };
  const violations = explanationViolations(parsed.data, context);
  if (violations.length) return { status: "rejected", violations, explanation: fallback, context };
  // Deterministic warnings first, verbatim; the model may only add to them.
  const extra = parsed.data.warnings.filter((w) => !context.safety.warnings.includes(w));
  return { status: "ok", explanation: { ...parsed.data, warnings: [...context.safety.warnings, ...extra] }, context };
}
