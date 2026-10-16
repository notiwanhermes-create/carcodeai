/**
 * Persisted guided-diagnostic sessions (V2G). RESEARCH PROTOTYPE: nothing in
 * the app imports this yet. See docs/research/guided-diagnostics/v2g-persistence.md.
 *
 * Lives OUTSIDE the deterministic engine (app/lib/diagnostic-workflow), which
 * never imports it. The Prisma adapter is a separate module
 * (./prisma-repository) so that everything here runs without a database.
 */
export { DEFAULT_INTEGRITY, NotPlainDataError, canonicalJson, digestOf, sameData, toPlainData, workflowFingerprint, type IntegrityAlgorithm, type IntegrityConfig, type JsonValue } from "./canonical";
export {
  INPUT_ORIGINS,
  LIFECYCLES,
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
export { isSessionOwner, ownerFromAuthenticatedUser, type SessionOwner } from "./owner";
export type { CreateOutcome, DiagnosticSessionRepository, GetOutcome, HistoryOutcome as RepositoryHistoryOutcome, NewRevision, NewSession, SessionChange, UpdateOutcome } from "./repository";
export { createInMemorySessionRepository, steppingClock, type InMemoryRepositoryOptions, type InMemorySessionRepository } from "./in-memory-repository";
export { createInMemoryWorkflowResolver, type WorkflowResolver } from "./workflow-resolver";
export { createSessionStore, type HistoryOutcome, type InputProvenance, type LoadOutcome, type SaveOutcome, type SessionHistory, type SessionMeta, type SessionStore, type SessionStoreOptions } from "./session-store";
