/**
 * Guided diagnostic workflows. RESEARCH PROTOTYPE: nothing in the app imports
 * this yet. See docs/research/guided-diagnostics/design.md.
 */
export * from "./types";
export { convert, isUnit } from "./units";
export { codesAbsentVerdict, matchDtc, normalizeCode, normalizeScan, workflowCodeKey, type NormalizedCode, type NormalizedScan, type Tri } from "./dtc";
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
export { MAX_AUTOMATIC_STEPS, currentStep, nextBestTests, recheckPlan, stepReachability, type Reachability, isTrustedSpec, replaySession, resumeSession, separatingSteps, sessionOutcome, startSession, submitStep } from "./engine";
export { analyzeRegion, detectingEvidence, separation, type Decisiveness, type NextBestTests, type RecheckItem, type RecheckPlan, type Recommendation, type RegionAnalysis } from "./next-best-test";
