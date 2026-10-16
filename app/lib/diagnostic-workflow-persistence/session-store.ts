/**
 * Saving and loading guided-diagnostic sessions (V2G).
 *
 * RESEARCH PROTOTYPE. Sits between the deterministic engine and a storage
 * repository, and is never imported by the engine:
 *
 *   save: engine session → plain-data codec → checks → repository (compare-and-set)
 *   load: repository → envelope schema → versions → digest → EXACT workflow
 *         → engine replay (resumeSession) → full equality → usable session
 *
 * Persistence never advances a session: the caller runs the engine
 * (submitStep, or the V2F bridge's acceptProposal) and saves the result. The
 * database is never the diagnostic authority: a stored session is only used
 * once the engine has replayed its inputs, against its pinned facts and pinned
 * specifications, and arrived at exactly the stored state. Anything else
 * fails closed. Nothing is repaired, guessed or migrated to a newer workflow.
 * No AI, no specification provider and no live vehicle data are used.
 */
import { randomUUID } from "node:crypto";
import { resumeSession, type DiagnosticSession, type WorkflowDefinition } from "../diagnostic-workflow";
import { DEFAULT_INTEGRITY, NotPlainDataError, canonicalJson, digestOf, sameData, toPlainData, workflowFingerprint, type IntegrityConfig, type JsonValue } from "./canonical";
import {
  PERSISTENCE_VERSION,
  SESSION_FORMAT_VERSION,
  SUPPORTED_SESSION_FORMATS,
  SessionPayloadSchema,
  StoredRevisionSchema,
  StoredSessionSchema,
  sealedContent,
  type InputOrigin,
  type Lifecycle,
  type StoredRevision,
  type StoredSession,
} from "./envelope";
import { isSessionOwner, type SessionOwner } from "./owner";
import type { DiagnosticSessionRepository, NewRevision } from "./repository";
import type { WorkflowResolver } from "./workflow-resolver";

/** What a caller may know about a stored session besides the session itself. */
export type SessionMeta = {
  id: string;
  vehicleId: string;
  workflowId: string;
  workflowVersion: number;
  revision: number;
  lifecycle: Lifecycle;
  currentStep: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type LoadOutcome =
  | { status: "loaded"; session: DiagnosticSession; workflow: WorkflowDefinition; meta: SessionMeta }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "corrupted"; reason: string }
  | { status: "incompatible_workflow"; reason: "workflow_unavailable" | "workflow_changed"; workflowId: string; workflowVersion: number }
  | { status: "unsupported_version"; persistenceVersion: unknown; sessionFormatVersion: unknown };

type Failure = Exclude<LoadOutcome, { status: "loaded" }>;

export type SaveOutcome =
  /** Saved (or, with duplicate: true, this exact save had already been made: nothing was written twice). */
  | { status: "saved"; meta: SessionMeta; duplicate: boolean }
  | { status: "forbidden" }
  | { status: "not_found" }
  | { status: "vehicle_not_found" }
  /** The session is not one the engine can stand behind (not replayable, not plain data, wrong shape). */
  | { status: "invalid_session"; reason: string }
  /** Not a legal next revision of the stored session (history rewritten, more or fewer than one new input, ...). */
  | { status: "invalid_transition"; reason: string }
  /** Someone else moved the session on since `expectedRevision`. Reload and decide again. */
  | { status: "conflict"; currentRevision: number }
  /** The session is completed: it is history and is never changed. */
  | { status: "immutable" }
  /** This createKey already started a different session. */
  | { status: "create_key_conflict" }
  | Exclude<Failure, { status: "not_found" | "forbidden" }>;

export type SessionHistory = {
  sessionId: string;
  startedAt: string;
  currentRevision: number;
  lifecycle: Lifecycle;
  completedAt: string | null;
  /** The diagnostic outcome (the engine's endResult), separate from the lifecycle. */
  endResult: string | null;
  revisions: Array<Omit<StoredRevision, "payloadDigest" | "sessionId">>;
};
export type HistoryOutcome = { status: "found"; history: SessionHistory } | Failure;

/** Where an accepted input came from. Only a reference to AI-parsed text is kept, never the text. */
export type InputProvenance = { origin: "direct" } | { origin: "ai_parser"; textRef: string };

export type SessionStoreOptions = {
  repository: DiagnosticSessionRepository;
  workflows: WorkflowResolver;
  integrity?: IntegrityConfig;
  /** Makes new session ids. Defaults to random UUIDs. */
  newId?: () => string;
};

const lifecycleOf = (s: { status: string }): Lifecycle => (s.status === "completed" ? "completed" : "active");

function metaOf(r: StoredSession): SessionMeta {
  return {
    id: r.id,
    vehicleId: r.vehicleId,
    workflowId: r.workflowId,
    workflowVersion: r.workflowVersion,
    revision: r.revision,
    lifecycle: r.lifecycle,
    currentStep: r.currentStep,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    completedAt: r.completedAt,
  };
}

export function createSessionStore(options: SessionStoreOptions) {
  const { repository, workflows } = options;
  const integrity = options.integrity ?? DEFAULT_INTEGRITY;
  const newId = options.newId ?? (() => randomUUID());

  const seal = (r: Parameters<typeof sealedContent>[0]) => digestOf(canonicalJson(sealedContent(r)), integrity);

  /** The plain-data form of a session, or why it cannot be stored. */
  function plain(session: DiagnosticSession): { ok: true; payload: JsonValue } | { ok: false; reason: string } {
    try {
      const payload = toPlainData(session);
      const parsed = SessionPayloadSchema.safeParse(payload);
      if (!parsed.success) return { ok: false, reason: `not a session: ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}` };
      return { ok: true, payload };
    } catch (e) {
      return { ok: false, reason: e instanceof NotPlainDataError ? e.message : "not serializable" };
    }
  }

  /**
   * The engine replays the stored inputs against the exact workflow, the pinned
   * facts and the pinned specifications, and must arrive at EXACTLY the stored
   * session, field for field. Then, and only then, the session is usable.
   */
  function replayed(workflow: WorkflowDefinition, payload: unknown): { ok: true; session: DiagnosticSession } | { ok: false; reason: string } {
    const resumed = resumeSession(workflow, payload);
    if (!resumed.ok) return { ok: false, reason: resumed.error };
    if (!sameData(resumed.session, payload)) return { ok: false, reason: "replay_mismatch: the stored session is not what its inputs lead to" };
    return { ok: true, session: resumed.session };
  }

  /** Exact workflow, or why not. Never another version, never the newest. */
  function exactWorkflow(id: string, version: number, fingerprint?: string): { ok: true; workflow: WorkflowDefinition } | { ok: false; outcome: Failure } {
    const workflow = workflows.resolve(id, version);
    if (!workflow || workflow.id !== id || workflow.version !== version) {
      return { ok: false, outcome: { status: "incompatible_workflow", reason: "workflow_unavailable", workflowId: id, workflowVersion: version } };
    }
    if (fingerprint !== undefined && workflowFingerprint(workflow) !== fingerprint) {
      return { ok: false, outcome: { status: "incompatible_workflow", reason: "workflow_changed", workflowId: id, workflowVersion: version } };
    }
    return { ok: true, workflow };
  }

  /** Validate a record a repository returned. Fails closed on anything it cannot establish. */
  function validate(raw: unknown): { ok: true; record: StoredSession; workflow: WorkflowDefinition; session: DiagnosticSession } | { ok: false; outcome: Failure } {
    const corrupted = (reason: string) => ({ ok: false as const, outcome: { status: "corrupted" as const, reason } });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return corrupted("malformed_record");
    // 1. Versions first: a record from a newer writer is refused as such, not mistaken for corruption.
    const pv = (raw as Record<string, unknown>).persistenceVersion;
    const sv = (raw as Record<string, unknown>).sessionFormatVersion;
    if (typeof pv === "number" && typeof sv === "number" && (pv !== PERSISTENCE_VERSION || !SUPPORTED_SESSION_FORMATS.includes(sv))) {
      return { ok: false, outcome: { status: "unsupported_version", persistenceVersion: pv, sessionFormatVersion: sv } };
    }
    // 2. The envelope and payload schema.
    const parsed = StoredSessionSchema.safeParse(raw);
    if (!parsed.success) return corrupted(`malformed_record: ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").slice(0, 5).join(", ")}`);
    const r = parsed.data;
    // 3. Integrity: the digest seals identity, versions, revision, lifecycle and payload.
    if (r.integrityAlgorithm !== integrity.algorithm) return corrupted("integrity_algorithm_mismatch");
    if (seal(r) !== r.payloadDigest) return corrupted("digest_mismatch");
    // 4. Revision and lifecycle metadata must be possible.
    const p = r.payload;
    if (r.revision !== p.inputs.length + 1) return corrupted("impossible_revision: one revision per accepted input");
    if (r.lifecycle !== lifecycleOf(p)) return corrupted("lifecycle_mismatch");
    if (r.currentStep !== p.currentNodeId) return corrupted("current_step_mismatch");
    if ((r.completedAt === null) !== (r.lifecycle === "active")) return corrupted("impossible_timestamps: completedAt");
    if (Date.parse(r.updatedAt) < Date.parse(r.createdAt) || (r.completedAt && Date.parse(r.completedAt) < Date.parse(r.createdAt))) return corrupted("impossible_timestamps");
    if (p.workflowId !== r.workflowId || p.workflowVersion !== r.workflowVersion) return corrupted("workflow_identity_mismatch");
    // 5. The exact workflow, unchanged since the session was run.
    const w = exactWorkflow(r.workflowId, r.workflowVersion, r.workflowFingerprint);
    if (!w.ok) return w;
    // 6. Deterministic replay must reproduce the stored session exactly.
    const rebuilt = replayed(w.workflow, p);
    if (!rebuilt.ok) return corrupted(`replay_failed: ${rebuilt.reason}`);
    return { ok: true, record: r, workflow: w.workflow, session: rebuilt.session };
  }

  async function load(owner: SessionOwner, sessionId: string): Promise<LoadOutcome> {
    if (!isSessionOwner(owner)) return { status: "forbidden" };
    if (typeof sessionId !== "string" || !sessionId) return { status: "not_found" };
    const got = await repository.get(owner, sessionId);
    if (got.status !== "found") return { status: "not_found" };
    const v = validate(got.record);
    if (!v.ok) return v.outcome;
    if (v.record.id !== sessionId) return { status: "corrupted", reason: "session_id_mismatch" };
    if (v.record.ownerId !== owner.userId) return { status: "not_found" };
    return { status: "loaded", session: v.session, workflow: v.workflow, meta: metaOf(v.record) };
  }

  /** Persist a freshly started session as revision 1. */
  async function start(
    owner: SessionOwner,
    request: { vehicleId: string; session: DiagnosticSession; createKey?: string },
  ): Promise<SaveOutcome> {
    if (!isSessionOwner(owner)) return { status: "forbidden" };
    if (typeof request.vehicleId !== "string" || !request.vehicleId || request.vehicleId.length > 200) return { status: "vehicle_not_found" };
    if (request.createKey !== undefined && (typeof request.createKey !== "string" || !request.createKey || request.createKey.length > 200)) return { status: "invalid_session", reason: "invalid createKey" };
    const pl = plain(request.session);
    if (!pl.ok) return { status: "invalid_session", reason: pl.reason };
    const p = SessionPayloadSchema.parse(pl.payload);
    if (p.inputs.length !== 0) return { status: "invalid_session", reason: "a stored session starts at revision 1, before any input" };
    const w = exactWorkflow(p.workflowId, p.workflowVersion);
    if (!w.ok) return w.outcome;
    const check = replayed(w.workflow, pl.payload);
    if (!check.ok) return { status: "invalid_session", reason: check.reason };

    const base = {
      id: newId(),
      ownerId: owner.userId,
      vehicleId: request.vehicleId,
      workflowId: p.workflowId,
      workflowVersion: p.workflowVersion,
      workflowFingerprint: workflowFingerprint(w.workflow),
      persistenceVersion: PERSISTENCE_VERSION,
      sessionFormatVersion: SESSION_FORMAT_VERSION,
      revision: 1,
      lifecycle: lifecycleOf(p),
      currentStep: p.currentNodeId,
      payload: pl.payload,
    };
    const payloadDigest = seal(base);
    const { ownerId, ...rest } = base;
    if (ownerId !== owner.userId) throw new Error("unreachable");
    const created = await repository.create(
      owner,
      { ...rest, payload: pl.payload as typeof p, integrityAlgorithm: integrity.algorithm, payloadDigest, createKey: request.createKey ?? null },
      { revision: 1, transition: "start", inputCount: 0, stepId: null, lifecycle: base.lifecycle, currentStep: base.currentStep, endResult: p.endResult, payloadDigest, inputOrigin: "direct", aiTextRef: null },
    );
    if (created.status === "vehicle_not_found") return created;
    const v = validate(created.record);
    if (!v.ok) return v.outcome;
    if (created.status === "exists") {
      // A retried start: the same session for the same vehicle is the same start. Anything else is a misuse of the key.
      const same = v.record.vehicleId === request.vehicleId && v.record.revision === 1 && sameData(v.record.payload, pl.payload);
      return same ? { status: "saved", meta: metaOf(v.record), duplicate: true } : { status: "create_key_conflict" };
    }
    return { status: "saved", meta: metaOf(v.record), duplicate: false };
  }

  /**
   * Persist the session the engine produced from the stored one plus ONE new
   * input, as revision expectedRevision + 1. The previous revision is loaded and
   * fully validated first; the new one must extend it without changing any of
   * its history, and must itself replay exactly.
   */
  async function advance(
    owner: SessionOwner,
    request: { sessionId: string; expectedRevision: number; session: DiagnosticSession; provenance?: InputProvenance },
  ): Promise<SaveOutcome> {
    if (!isSessionOwner(owner)) return { status: "forbidden" };
    if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 1) return { status: "invalid_transition", reason: "expectedRevision is required" };
    const provenance = request.provenance ?? { origin: "direct" };
    if (provenance.origin === "ai_parser" && !/^fnv1a32:[0-9a-f]{8}$/.test(provenance.textRef)) return { status: "invalid_transition", reason: "an AI-parsed input is referenced by its text hash only" };

    const current = await load(owner, request.sessionId);
    if (current.status !== "loaded") return current;
    const pl = plain(request.session);
    if (!pl.ok) return { status: "invalid_session", reason: pl.reason };
    const next = SessionPayloadSchema.parse(pl.payload);
    const prev = current.session;
    const nextRevision = request.expectedRevision + 1;
    const sealedAt = (revision: number) =>
      seal({
        id: current.meta.id,
        ownerId: owner.userId,
        vehicleId: current.meta.vehicleId,
        workflowId: current.meta.workflowId,
        workflowVersion: current.meta.workflowVersion,
        workflowFingerprint: workflowFingerprint(current.workflow),
        persistenceVersion: PERSISTENCE_VERSION,
        sessionFormatVersion: SESSION_FORMAT_VERSION,
        revision,
        lifecycle: lifecycleOf(next),
        currentStep: next.currentNodeId,
        payload: pl.payload,
      });

    // A retry of a save that already went through: same result, nothing written twice.
    const alreadySaved = async () => {
      const got = await repository.get(owner, request.sessionId);
      if (got.status !== "found") return null;
      const r = StoredSessionSchema.safeParse(got.record);
      return r.success && r.data.revision === nextRevision && r.data.payloadDigest === sealedAt(nextRevision) ? r.data : null;
    };
    if (current.meta.revision !== request.expectedRevision) {
      const done = current.meta.revision === nextRevision ? await alreadySaved() : null;
      return done ? { status: "saved", meta: metaOf(done), duplicate: true } : { status: "conflict", currentRevision: current.meta.revision };
    }
    if (current.meta.lifecycle === "completed") return { status: "immutable" };

    // The new state must extend the stored one: same workflow, same pinned facts, one more input, history untouched.
    const bad = (reason: string): SaveOutcome => ({ status: "invalid_transition", reason });
    if (next.workflowId !== prev.workflowId || next.workflowVersion !== prev.workflowVersion) return bad("workflow_changed");
    if (!sameData(next.facts, prev.facts)) return bad("pinned_facts_changed");
    if (next.startedAt !== prev.startedAt) return bad("start_time_changed");
    if (next.faultModel !== prev.faultModel) return bad("fault_model_changed");
    if (next.inputs.length !== prev.inputs.length + 1) return bad(`expected exactly one new input, found ${next.inputs.length - prev.inputs.length}`);
    if (!sameData(next.inputs.slice(0, prev.inputs.length), prev.inputs)) return bad("earlier_inputs_changed");
    if (next.evidence.length < prev.evidence.length || !sameData(next.evidence.slice(0, prev.evidence.length), prev.evidence)) return bad("earlier_evidence_changed");
    for (const [specId, resolution] of Object.entries(prev.specifications)) {
      if (!sameData(next.specifications[specId], resolution)) return bad(`pinned_specification_changed: ${specId}`);
    }
    const answered = next.inputs[next.inputs.length - 1];
    if (answered.nodeId !== prev.currentNodeId) return bad("the new input does not answer the stored current step");
    const check = replayed(current.workflow, pl.payload);
    if (!check.ok) return { status: "invalid_session", reason: check.reason };

    const payloadDigest = sealedAt(nextRevision);
    const lifecycle = lifecycleOf(next);
    const revision: NewRevision = {
      revision: nextRevision,
      transition: "input",
      inputCount: next.inputs.length,
      stepId: answered.nodeId,
      lifecycle,
      currentStep: next.currentNodeId,
      endResult: next.endResult,
      payloadDigest,
      inputOrigin: provenance.origin as InputOrigin,
      aiTextRef: provenance.origin === "ai_parser" ? provenance.textRef : null,
    };
    const updated = await repository.update(
      owner,
      request.sessionId,
      request.expectedRevision,
      { revision: nextRevision, lifecycle, currentStep: next.currentNodeId, payload: pl.payload as typeof next, payloadDigest, integrityAlgorithm: integrity.algorithm },
      revision,
    );
    if (updated.status === "conflict") {
      // Lost a race. If the winner saved exactly this, it is the same save.
      const done = updated.currentRevision === nextRevision ? await alreadySaved() : null;
      return done ? { status: "saved", meta: metaOf(done), duplicate: true } : updated;
    }
    if (updated.status !== "updated") return updated;
    const v = validate(updated.record);
    if (!v.ok) return v.outcome;
    return { status: "saved", meta: metaOf(v.record), duplicate: false };
  }

  /** When it started, every transition, the current revision, when it completed and how it ended. */
  async function history(owner: SessionOwner, sessionId: string): Promise<HistoryOutcome> {
    const current = await load(owner, sessionId);
    if (current.status !== "loaded") return current;
    const got = await repository.history(owner, sessionId);
    if (got.status !== "found") return { status: "not_found" };
    const corrupted = (reason: string): HistoryOutcome => ({ status: "corrupted", reason: `history: ${reason}` });
    const revisions: StoredRevision[] = [];
    for (const raw of got.revisions) {
      const r = StoredRevisionSchema.safeParse(raw);
      if (!r.success) return corrupted("malformed_revision");
      revisions.push(r.data);
    }
    const { meta, session } = current;
    if (revisions.length !== meta.revision) return corrupted("revision_count_mismatch");
    for (const [i, r] of revisions.entries()) {
      if (r.sessionId !== meta.id || r.revision !== i + 1 || r.inputCount !== i) return corrupted(`impossible_revision ${i + 1}`);
      if (r.transition !== (i === 0 ? "start" : "input")) return corrupted(`impossible_transition ${i + 1}`);
      if (i > 0 && r.stepId !== session.inputs[i - 1].nodeId) return corrupted(`step_mismatch ${i + 1}`);
      if ((r.inputOrigin === "ai_parser") !== (r.aiTextRef !== null)) return corrupted(`provenance ${i + 1}`);
      if (i > 0 && Date.parse(r.createdAt) < Date.parse(revisions[i - 1].createdAt)) return corrupted(`time_order ${i + 1}`);
    }
    const last = revisions[revisions.length - 1];
    const stored = await repository.get(owner, sessionId);
    const digest = stored.status === "found" ? (stored.record as { payloadDigest?: unknown }).payloadDigest : null;
    if (last.payloadDigest !== digest || last.lifecycle !== meta.lifecycle || last.currentStep !== meta.currentStep) return corrupted("latest_revision_mismatch");
    return {
      status: "found",
      history: {
        sessionId: meta.id,
        startedAt: revisions[0].createdAt,
        currentRevision: meta.revision,
        lifecycle: meta.lifecycle,
        completedAt: meta.completedAt,
        endResult: session.endResult,
        revisions: revisions.map((r) => ({
          revision: r.revision,
          transition: r.transition,
          inputCount: r.inputCount,
          stepId: r.stepId,
          lifecycle: r.lifecycle,
          currentStep: r.currentStep,
          endResult: r.endResult,
          inputOrigin: r.inputOrigin,
          aiTextRef: r.aiTextRef,
          createdAt: r.createdAt,
        })),
      },
    };
  }

  return { start, advance, load, history };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
