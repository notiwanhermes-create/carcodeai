/**
 * The guided-diagnostics service (V2I): orchestration only.
 *
 * RESEARCH PROTOTYPE, server-side only. Nothing in the app calls it yet; a
 * future route would construct it with the signed-in user's SessionOwner.
 *
 *   start:  owner → policy-checked content (exact id + version) → owner's garage
 *           vehicle → pinned vehicle context → engine startSession → V2G store
 *   submit: owner → V2G load (exact workflow, replayed) → engine submitStep
 *           (or the V2F bridge's acceptProposal, which calls it) → V2G
 *           compare-and-set save with the caller's expected revision
 *   load / history: owner → V2G store, unchanged
 *
 * It holds no diagnostic logic of its own. The deterministic engine decides
 * every transition, cause, judgement, ranking and verdict; the content catalog
 * decides what may start; the store decides what may be saved and fails closed
 * on anything it cannot replay exactly. Nothing here calls a model.
 */
import {
  startSession,
  submitStep,
  type DiagnosticCapabilityContext,
  type DiagnosticScanInput,
  type DiagnosticSession,
  type EngineOptions,
  type SpecificationProvider,
  type StepInput,
  type VehicleContext,
  type WorkflowDefinition,
} from "../diagnostic-workflow";
import { acceptProposal, type ParseResult } from "../diagnostic-workflow-bridge";
import type { ContentCatalog } from "../diagnostic-workflow-content";
import {
  createSessionStore,
  isSessionOwner,
  type DiagnosticSessionRepository,
  type HistoryOutcome,
  type InputProvenance,
  type IntegrityConfig,
  type LoadOutcome,
  type SaveOutcome,
  type SessionMeta,
  type SessionOwner,
} from "../diagnostic-workflow-persistence";
import { PRODUCTION_CONTENT_POLICY, isRecognizedPolicy, startableWorkflow, startableWorkflows, type ContentPolicy } from "./policy";
import type { VehicleDirectory } from "./vehicles";

export type GuidedDiagnosticsServiceOptions = {
  catalog: ContentCatalog;
  repository: DiagnosticSessionRepository;
  vehicles: VehicleDirectory;
  /** Which content a new session may start from. Defaults to the production policy (approved only). */
  contentPolicy?: ContentPolicy;
  /** Where specifications come from when a step first needs one. None by default: no verified source exists yet. */
  specifications?: SpecificationProvider;
  /** The time recorded on evidence (ISO 8601). Defaults to the server clock. */
  clock?: () => string;
  integrity?: IntegrityConfig;
  newId?: () => string;
};

/** Vehicle facts the garage does not record. Anything the garage does record comes from the garage only. */
export type VehicleDetails = Pick<VehicleContext, "fuel" | "cylinders" | "market">;
const DETAIL_FIELDS: ReadonlySet<string> = new Set(["fuel", "cylinders", "market"]);

export type StartRequest = {
  vehicleId: string;
  workflow: { id: string; version: number };
  capabilities: DiagnosticCapabilityContext;
  vehicleDetails?: VehicleDetails;
  scans?: DiagnosticScanInput[];
  symptoms?: string[];
  /** The caller's key for an idempotent start (see the V2G store). */
  createKey?: string;
};

export type StartOutcome =
  | { status: "started"; session: DiagnosticSession; workflow: WorkflowDefinition; meta: SessionMeta; duplicate: boolean }
  /** No such workflow version, or the content policy does not offer it. */
  | { status: "workflow_not_offered"; workflowId: string; workflowVersion: number }
  /** The request itself is malformed. */
  | { status: "invalid_request"; reason: string }
  /** The engine would not start (not applicable, insufficient context, invalid facts, ...). */
  | { status: "not_started"; reason: string }
  | Exclude<SaveOutcome, { status: "saved" }>;

export type SubmitRequest =
  | { sessionId: string; expectedRevision: number; input: StepInput }
  /** A proposal the V2F bridge parsed against this session's current step. */
  | { sessionId: string; expectedRevision: number; proposal: ParseResult };

export type SubmitOutcome =
  | { status: "saved"; session: DiagnosticSession; meta: SessionMeta; duplicate: boolean }
  /** The engine refused the input. Nothing was recorded. */
  | { status: "rejected"; reason: string }
  /** The proposal was not a valid candidate, or the session moved on since it was parsed. Nothing was recorded. */
  | { status: "proposal_not_accepted"; reason: string }
  | Exclude<SaveOutcome, { status: "saved" }>;

export class UnrecognizedContentPolicyError extends Error {
  constructor() {
    super("unrecognized content policy: use PRODUCTION_CONTENT_POLICY, or testOnlyContentPolicy in tests");
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function createGuidedDiagnosticsService(options: GuidedDiagnosticsServiceOptions) {
  const policy = options.contentPolicy ?? PRODUCTION_CONTENT_POLICY;
  if (!isRecognizedPolicy(policy)) throw new UnrecognizedContentPolicyError();
  const { catalog, vehicles } = options;
  const clock = options.clock ?? (() => new Date().toISOString());
  const engine: EngineOptions = options.specifications ? { specifications: options.specifications } : {};
  // History resolves every class and review status: reopening a session never depends on today's policy.
  const store = createSessionStore({ repository: options.repository, workflows: catalog.workflowResolver(), integrity: options.integrity, newId: options.newId });

  /** What a new session may start from, under this service's policy. */
  function listStartable(): Array<{ id: string; version: number; title: string }> {
    return startableWorkflows(catalog, policy).map((w) => ({ id: w.id, version: w.version, title: w.title }));
  }

  async function startGuidedSession(owner: SessionOwner, request: StartRequest): Promise<StartOutcome> {
    if (!isSessionOwner(owner)) return { status: "forbidden" };
    if (!isRecord(request) || !isRecord(request.workflow)) return { status: "invalid_request", reason: "a vehicle and a workflow are required" };
    const { id: workflowId, version: workflowVersion } = request.workflow;
    if (typeof workflowId !== "string" || !Number.isInteger(workflowVersion)) return { status: "invalid_request", reason: "the workflow is named by id and integer version" };
    if (request.vehicleDetails !== undefined) {
      if (!isRecord(request.vehicleDetails)) return { status: "invalid_request", reason: "vehicleDetails must be an object" };
      const extra = Object.keys(request.vehicleDetails).filter((k) => !DETAIL_FIELDS.has(k));
      if (extra.length) return { status: "invalid_request", reason: `vehicle details the garage records come from the garage: ${extra.join(", ")}` };
    }

    const workflow = startableWorkflow(catalog, policy, workflowId, workflowVersion);
    if (!workflow) return { status: "workflow_not_offered", workflowId, workflowVersion };

    if (typeof request.vehicleId !== "string" || !request.vehicleId) return { status: "vehicle_not_found" };
    const vehicle = await vehicles.find(owner, request.vehicleId);
    if (!vehicle || vehicle.archived) return { status: "vehicle_not_found" };

    const started = startSession(
      workflow,
      {
        vehicle: { ...vehicle.context, ...request.vehicleDetails },
        capabilities: request.capabilities,
        ...(request.scans !== undefined && { scans: request.scans }),
        ...(request.symptoms !== undefined && { symptoms: request.symptoms }),
      },
      clock(),
      engine,
    );
    if (!started.ok) return { status: "not_started", reason: started.error };

    const saved = await store.start(owner, { vehicleId: vehicle.id, session: started.session, createKey: request.createKey });
    if (saved.status !== "saved") return saved;
    return { status: "started", session: started.session, workflow, meta: saved.meta, duplicate: saved.duplicate };
  }

  async function submitGuidedStep(owner: SessionOwner, request: SubmitRequest): Promise<SubmitOutcome> {
    if (!isSessionOwner(owner)) return { status: "forbidden" };
    if (!isRecord(request) || typeof request.sessionId !== "string") return { status: "not_found" };
    if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 1) return { status: "invalid_transition", reason: "expectedRevision is required" };

    const loaded = await store.load(owner, request.sessionId);
    if (loaded.status !== "loaded") return loaded;
    // The caller decided on a revision that is no longer current: say so, never apply the input to a different state.
    if (loaded.meta.revision !== request.expectedRevision) return { status: "conflict", currentRevision: loaded.meta.revision };
    if (loaded.meta.lifecycle === "completed") return { status: "immutable" };

    const at = clock();
    let next: DiagnosticSession;
    let provenance: InputProvenance;
    if ("proposal" in request) {
      const result = acceptProposal(loaded.workflow, loaded.session, request.proposal, at, engine);
      if (!result.ok) {
        // acceptProposal refuses non-valid and stale proposals itself; anything else is the engine's refusal.
        const notAccepted = result.error.startsWith("not_acceptable") || result.error.startsWith("stale_proposal");
        return notAccepted ? { status: "proposal_not_accepted", reason: result.error } : { status: "rejected", reason: result.error };
      }
      next = result.session;
      provenance = { origin: "ai_parser", textRef: (request.proposal as Extract<ParseResult, { status: "valid" }>).audit.textRef.hash };
    } else {
      const result = submitStep(loaded.workflow, loaded.session, request.input, at, engine);
      if (!result.ok) return { status: "rejected", reason: result.error };
      next = result.session;
      provenance = { origin: "direct" };
    }

    const saved = await store.advance(owner, { sessionId: request.sessionId, expectedRevision: request.expectedRevision, session: next, provenance });
    if (saved.status !== "saved") return saved;
    return { status: "saved", session: next, meta: saved.meta, duplicate: saved.duplicate };
  }

  /** Reopen a session: owner-filtered, exact workflow, replayed by the engine; fails closed. */
  async function loadGuidedSession(owner: SessionOwner, sessionId: string): Promise<LoadOutcome> {
    return store.load(owner, sessionId);
  }

  /** Revision metadata only (V2G). It records what happened; it never decides anything. */
  async function guidedSessionHistory(owner: SessionOwner, sessionId: string): Promise<HistoryOutcome> {
    return store.history(owner, sessionId);
  }

  return { listStartable, startGuidedSession, submitGuidedStep, loadGuidedSession, guidedSessionHistory };
}

export type GuidedDiagnosticsService = ReturnType<typeof createGuidedDiagnosticsService>;
