/**
 * Guided-diagnostics service (V2I). RESEARCH PROTOTYPE, server-side only:
 * nothing in the app imports this yet. See
 * docs/research/guided-diagnostics/v2i-service.md.
 *
 * Orchestration around the deterministic engine, the reviewed content catalog
 * and the V2G session store. The engine never imports it. The Prisma garage
 * directory is a separate module (./prisma-vehicles).
 */
export { PRODUCTION_CONTENT_POLICY, isRecognizedPolicy, startableWorkflow, startableWorkflows, testOnlyContentPolicy, type ContentPolicy } from "./policy";
export { createInMemoryVehicleDirectory, type OwnedVehicle, type VehicleDirectory } from "./vehicles";
export {
  UnrecognizedContentPolicyError,
  createGuidedDiagnosticsService,
  type GuidedDiagnosticsService,
  type GuidedDiagnosticsServiceOptions,
  type StartOutcome,
  type StartRequest,
  type SubmitOutcome,
  type SubmitRequest,
  type VehicleDetails,
} from "./service";
