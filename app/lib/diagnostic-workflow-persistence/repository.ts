/**
 * The storage contract for persisted diagnostic sessions (V2G).
 *
 * RESEARCH PROTOTYPE. A repository only STORES: it knows nothing about the
 * diagnostic engine, never advances a session and never judges evidence. Its
 * guarantees, which both implementations (in-memory and Prisma) provide:
 *
 * - OWNERSHIP: every call takes the authenticated owner and only ever sees
 *   that owner's rows. Someone else's session answers exactly like a missing
 *   one ("not_found"), so existence is never leaked.
 * - OPTIMISTIC CONCURRENCY: an update names the revision it was based on and
 *   succeeds only if that is still the current revision (compare-and-set).
 *   A stale writer gets "conflict". There is no last-write-wins.
 * - IMMUTABILITY: a completed session is never updated ("immutable").
 * - APPEND-ONLY HISTORY: every successful create or update appends exactly
 *   one revision record in the same transaction; none is ever changed.
 * - IDEMPOTENT START: a create with a createKey the owner already used
 *   returns the existing row ("exists") instead of making a second one.
 *
 * What comes back is untrusted: callers validate it (see session-store.ts).
 */
import type { SessionOwner } from "./owner";
import type { StoredRevision, StoredSession } from "./envelope";

/** What the store hands a repository to create. Timestamps are the repository's. */
export type NewSession = Omit<StoredSession, "createdAt" | "updatedAt" | "completedAt" | "ownerId">;
/** The fields an update replaces. Identity, workflow, versions and createKey never change. */
export type SessionChange = Pick<StoredSession, "revision" | "lifecycle" | "currentStep" | "payload" | "payloadDigest" | "integrityAlgorithm">;
export type NewRevision = Omit<StoredRevision, "createdAt" | "sessionId">;

export type CreateOutcome =
  | { status: "created"; record: unknown }
  /** This owner already started a session with the same createKey. The existing row, unvalidated. */
  | { status: "exists"; record: unknown }
  /** The vehicle does not exist or is not this owner's. */
  | { status: "vehicle_not_found" };

export type UpdateOutcome =
  | { status: "updated"; record: unknown }
  | { status: "not_found" }
  | { status: "conflict"; currentRevision: number }
  | { status: "immutable" };

export type GetOutcome = { status: "found"; record: unknown } | { status: "not_found" };
export type HistoryOutcome = { status: "found"; revisions: unknown[] } | { status: "not_found" };

export interface DiagnosticSessionRepository {
  create(owner: SessionOwner, session: NewSession, revision: NewRevision): Promise<CreateOutcome>;
  update(owner: SessionOwner, sessionId: string, expectedRevision: number, change: SessionChange, revision: NewRevision): Promise<UpdateOutcome>;
  get(owner: SessionOwner, sessionId: string): Promise<GetOutcome>;
  /** The session's revisions, oldest first. */
  history(owner: SessionOwner, sessionId: string): Promise<HistoryOutcome>;
}
