/**
 * The versioned envelope a persisted diagnostic session is stored in (V2G).
 *
 * RESEARCH PROTOTYPE. Two layers:
 * - the ENVELOPE: identity, ownership, lookup, lifecycle and concurrency
 *   (these are the relational columns in the database);
 * - the PAYLOAD: the engine's DiagnosticSession, exactly as the engine
 *   produced it, in canonical plain-data form.
 *
 * Both are validated on the way in and on the way out. The database is never
 * the diagnostic authority: a loaded payload is only used after the engine has
 * replayed it and produced exactly the same session.
 */
import { z } from "zod";
import { FAULT_MODELS } from "../diagnostic-workflow";

/** Version of this envelope's layout. A record with a higher one is refused, never guessed at. */
export const PERSISTENCE_VERSION = 1;
/**
 * Version of the stored DiagnosticSession layout: the engine's session as of
 * V2F (evidence kinds through `conflict` and `test_selection`, structured
 * scans, pinned specifications and conditions). Bumped when that layout
 * changes in a way an older reader cannot replay.
 */
export const SESSION_FORMAT_VERSION = 1;
/** Every session format this code can read. */
export const SUPPORTED_SESSION_FORMATS: readonly number[] = [1];

export const LIFECYCLES = ["active", "completed"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export const TRANSITIONS = ["start", "input"] as const;
export const INPUT_ORIGINS = ["direct", "ai_parser"] as const;
export type InputOrigin = (typeof INPUT_ORIGINS)[number];

const id = z.string().min(1).max(200);
const iso = z.iso.datetime({ offset: true });
const digest = z.string().regex(/^(sha256|hmac-sha256):[0-9a-f]{64}$/);
const positiveInt = z.number().int().min(1);

/**
 * The stored DiagnosticSession. Strict at the top level (an unknown field is
 * corruption, not something to carry along); entries inside are checked for
 * their identifying fields here and in full by the engine's replay, which must
 * reproduce every one of them exactly.
 */
const plainObject = z.record(z.string(), z.unknown());
export const SessionPayloadSchema = z.strictObject({
  workflowId: id,
  workflowVersion: z.number().int().min(0),
  faultModel: z.enum(FAULT_MODELS),
  facts: plainObject,
  startedAt: z.string().optional(),
  status: z.enum(["in_progress", "completed"]),
  currentNodeId: id.nullable(),
  phase: z.enum(["before_repair", "after_repair"]),
  evidence: z.array(z.looseObject({ seq: z.number().int().min(1), nodeId: id, kind: z.string().min(1), value: z.string() })),
  inputs: z.array(z.looseObject({ nodeId: id, kind: z.string().min(1) })),
  establishedConditions: z.array(id),
  refutedConditions: z.array(id),
  specifications: z.record(z.string(), plainObject),
  remainingCauses: z.array(id),
  supportedCauses: z.array(id),
  conclusionNodeId: id.nullable(),
  endResult: z.enum(["resolved", "concluded", "referred", "not_reproducible", "inconclusive"]).nullable(),
  verification: z.enum(["verified", "not_verified", "inconclusive"]).nullable(),
  repairVerified: z.boolean().nullable(),
});

/** One persisted session: the envelope with its payload. This is what a repository stores and returns. */
export const StoredSessionSchema = z.strictObject({
  id,
  ownerId: id,
  vehicleId: id,
  workflowId: id,
  workflowVersion: z.number().int().min(0),
  /** Content fingerprint of the exact workflow definition the session was run against. */
  workflowFingerprint: digest,
  persistenceVersion: positiveInt,
  sessionFormatVersion: positiveInt,
  revision: positiveInt,
  lifecycle: z.enum(LIFECYCLES),
  currentStep: id.nullable(),
  payload: SessionPayloadSchema,
  integrityAlgorithm: z.enum(["sha256", "hmac-sha256"]),
  /** Digest over the identity fields, the revision and the canonical payload (see sealedContent). */
  payloadDigest: digest,
  /** Caller's key for an idempotent start (a retried start finds the session it already made). */
  createKey: id.nullable(),
  createdAt: iso,
  updatedAt: iso,
  completedAt: iso.nullable(),
});
export type StoredSession = z.infer<typeof StoredSessionSchema>;

/**
 * One entry of a session's append-only history. Metadata only: the state at
 * any revision is the replay of its first `inputCount` inputs, so the
 * payload is not copied per revision. Rejected AI proposals never appear here.
 */
export const StoredRevisionSchema = z.strictObject({
  sessionId: id,
  revision: positiveInt,
  /** "start": the session was created; "input": one accepted input moved it on. */
  transition: z.enum(TRANSITIONS),
  /** How many inputs the session held after this revision. */
  inputCount: z.number().int().min(0),
  /** The step the accepted input answered (null for the start). */
  stepId: id.nullable(),
  lifecycle: z.enum(LIFECYCLES),
  currentStep: id.nullable(),
  endResult: z.string().nullable(),
  payloadDigest: digest,
  /** Where the accepted input came from. The payload is identical either way. */
  inputOrigin: z.enum(INPUT_ORIGINS),
  /** For an accepted AI-parsed input only: a reference (hash) to the user's text, never the text. */
  aiTextRef: z.string().regex(/^fnv1a32:[0-9a-f]{8}$/).nullable(),
  createdAt: iso,
});
export type StoredRevision = z.infer<typeof StoredRevisionSchema>;

/**
 * The exact content the digest seals: identity, versions, revision and the
 * payload. Swapping a payload between sessions or revisions, or editing any of
 * these, breaks the digest. Timestamps are repository metadata, checked for
 * consistency separately.
 */
export function sealedContent(r: Pick<StoredSession, "id" | "ownerId" | "vehicleId" | "workflowId" | "workflowVersion" | "workflowFingerprint" | "persistenceVersion" | "sessionFormatVersion" | "revision" | "lifecycle" | "currentStep"> & { payload: unknown }) {
  return {
    seal: "carcode.guided-diagnostic-session",
    id: r.id,
    ownerId: r.ownerId,
    vehicleId: r.vehicleId,
    workflowId: r.workflowId,
    workflowVersion: r.workflowVersion,
    workflowFingerprint: r.workflowFingerprint,
    persistenceVersion: r.persistenceVersion,
    sessionFormatVersion: r.sessionFormatVersion,
    revision: r.revision,
    lifecycle: r.lifecycle,
    currentStep: r.currentStep,
    payload: r.payload,
  };
}
