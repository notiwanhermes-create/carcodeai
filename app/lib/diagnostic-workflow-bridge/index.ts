/**
 * Guided Diagnostics AI bridge (V2F). RESEARCH PROTOTYPE, not wired into the app.
 *
 * A narrow layer AROUND the deterministic engine (app/lib/diagnostic-workflow),
 * which never imports it. Any model, any vendor, plugs in through the adapter
 * interfaces; tests use fakes. The engine stays the only authority over steps,
 * causes, pass/fail, specifications, conditions, safety, capability, codes,
 * ranking, repair verification and outcomes.
 */
export { textReference, type BridgeOutcome, type ProposalAudit } from "./audit";
export { ExplanationOutputSchema, ParserOutputSchema, ProposalSchema, StartFactsOutputSchema, WorkflowSuggestionOutputSchema, type ExplanationText, type Proposal } from "./schemas";
export {
  PARSER_INSTRUCTIONS,
  SUGGEST_INSTRUCTIONS,
  acceptProposal,
  expectedInput,
  parseStartFacts,
  parseStepInput,
  suggestWorkflows,
  type ExpectedInput,
  type ParseRequest,
  type ParseResult,
  type ParserAdapter,
  type StartFactsResult,
  type WorkflowSuggestion,
  type WorkflowSuggestionAdapter,
} from "./parser";
export { EXPLAIN_INSTRUCTIONS, deterministicExplanation, explain, explanationContext, explanationViolations, type ExplanationAdapter, type ExplanationContext, type ExplanationResult } from "./explanation";
export { informationalNoteOnly } from "./spec-notes";
