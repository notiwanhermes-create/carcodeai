/**
 * Schemas for everything an AI model may hand to the bridge (V2F).
 *
 * RESEARCH PROTOTYPE. Every object is STRICT: an extra field (a cause, a
 * confidence, a step id, a trust level, a verdict) makes the whole output
 * invalid, and the bridge fails closed. Nothing here can express a cause
 * change, a specification, a transition or a repair verdict.
 */
import { z } from "zod";
import { INCONCLUSIVE_REASONS, SERVICE_RESULTS, UNITS } from "../diagnostic-workflow";

const shortId = z.string().min(1).max(64);
const text = (max: number) => z.string().max(max);

/** What the model proposes for the CURRENT step. No step id: the engine decides which step it is for. */
export const ProposalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("yes_no"), answer: z.enum(["yes", "no"]) }),
  z.strictObject({ kind: z.literal("choice"), choice: shortId }),
  z.strictObject({ kind: z.literal("observation"), choice: shortId }),
  z.strictObject({
    kind: z.literal("measurement"),
    value: z.number(),
    unit: z.enum(UNITS),
    /**
     * A value the model mentioned as "normal" or "expected". Kept ONLY in the
     * audit record, as unverified information. It never reaches the engine and
     * cannot carry a trust level.
     */
    mentionedSpecification: z.strictObject({ value: z.number(), unit: z.enum(UNITS), text: text(200).optional() }).optional(),
  }),
  z.strictObject({ kind: z.literal("check"), result: z.enum(["pass", "fail"]) }),
  z.strictObject({ kind: z.literal("prerequisite"), met: z.boolean() }),
  z.strictObject({ kind: z.literal("done") }),
  z.strictObject({ kind: z.literal("actuator_result"), result: shortId }),
  z.strictObject({ kind: z.literal("service_result"), result: z.enum(SERVICE_RESULTS) }),
  z.strictObject({ kind: z.literal("select_test"), test: shortId }),
  z.strictObject({ kind: z.literal("inconclusive"), reason: z.enum(INCONCLUSIVE_REASONS) }),
  z.strictObject({ kind: z.literal("unable"), reason: z.enum(["no_tool", "not_comfortable", "not_possible"]) }),
]);
export type Proposal = z.infer<typeof ProposalSchema>;

/** Not a guess: what was understood, what is unclear, and (optionally) the readings the text could mean. */
const Ambiguous = z.strictObject({
  status: z.literal("ambiguous"),
  understood: text(500),
  unclear: text(500),
  interpretations: z.array(ProposalSchema).max(5).optional(),
});
const Unsupported = z.strictObject({ status: z.literal("unsupported"), reason: text(300) });

export const ParserOutputSchema = z.discriminatedUnion("status", [z.strictObject({ status: z.literal("parsed"), proposal: ProposalSchema }), Ambiguous, Unsupported]);

/**
 * Codes and symptoms mentioned at the start. Only code TEXT: no status, no
 * completeness, no module, no snapshot. The bridge always records them as
 * typed by a person, completeness unknown.
 */
export const StartFactsOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("parsed"), codes: z.array(text(40)).max(20), symptoms: z.array(shortId).max(10) }),
  Ambiguous,
  Unsupported,
]);

/** Workflow ids only, from the supplied catalog. */
export const WorkflowSuggestionOutputSchema = z.strictObject({ workflowIds: z.array(shortId).max(5) });

/** Presentation only. No field can change causes, confidence, specifications, transitions or verification. */
export const ExplanationOutputSchema = z.strictObject({
  summary: text(600),
  why: z.array(text(300)).max(8),
  whatToDoNext: z.array(text(300)).max(5),
  warnings: z.array(text(300)).max(10),
});
export type ExplanationText = z.infer<typeof ExplanationOutputSchema>;

/** The paths of schema problems, for a clear structured failure (never the raw model text). */
export function issuePaths(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`).slice(0, 10);
}
