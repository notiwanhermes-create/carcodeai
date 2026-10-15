/**
 * Guided diagnostic workflows. RESEARCH PROTOTYPE: nothing in the app imports
 * this yet. See docs/research/guided-diagnostics/design.md.
 */
export * from "./types";
export { convert, isUnit } from "./units";
export { applicabilityProblems, capabilityProblem, capabilityShortfall, checkApplicability, normalizeText, normalizeVehicleContext } from "./context";
export { validateWorkflow, successors, type ValidationResult, type WorkflowProblem } from "./validate";
export {
  describeResolution,
  isTrustedResolution,
  normalizeResolution,
  pinnedSpecificationProvider,
  resolveSpecification,
  specificationDrift,
  specificationProblem,
} from "./specifications";
export { MAX_AUTOMATIC_STEPS, currentStep, isTrustedSpec, replaySession, resumeSession, separatingSteps, sessionOutcome, startSession, submitStep } from "./engine";
