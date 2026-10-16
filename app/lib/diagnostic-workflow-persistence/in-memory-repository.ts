/**
 * An in-memory DiagnosticSessionRepository (V2G).
 *
 * RESEARCH PROTOTYPE, FOR TESTS. Not the production design. It has the same
 * semantics as the Prisma adapter (ownership filter, compare-and-set on the
 * revision, immutability of completed sessions, append-only history,
 * idempotent start) and is deterministic: its clock is injected, and every
 * record is kept as canonical JSON TEXT, so what is read back went through a
 * real serialize / parse boundary, exactly as it would through a database.
 *
 * `tamper` and `rawRecord` exist only so tests can simulate corruption.
 */
import { canonicalJson } from "./canonical";
import type { SessionOwner } from "./owner";
import type { CreateOutcome, DiagnosticSessionRepository, GetOutcome, HistoryOutcome, NewRevision, NewSession, SessionChange, UpdateOutcome } from "./repository";

type Row = { ownerId: string; text: string };

/** A deterministic clock: a fixed start, one second later on every call. */
export function steppingClock(start = "2026-10-16T09:00:00.000Z"): () => string {
  let t = Date.parse(start);
  return () => {
    const now = new Date(t).toISOString();
    t += 1000;
    return now;
  };
}

export type InMemoryRepositoryOptions = {
  /** vehicleId → owning user id: the garage this repository checks ownership against. */
  vehicles?: Record<string, string>;
  now?: () => string;
};

export function createInMemorySessionRepository(options: InMemoryRepositoryOptions = {}) {
  const vehicles = new Map(Object.entries(options.vehicles ?? {}));
  const now = options.now ?? steppingClock();
  const sessions = new Map<string, Row>();
  const revisions = new Map<string, string[]>();
  /** A row that does not even parse comes back as its text, for the store to reject. */
  const read = (row: Row): Record<string, unknown> => {
    try {
      return JSON.parse(row.text) as Record<string, unknown>;
    } catch {
      return row.text as unknown as Record<string, unknown>;
    }
  };
  const owned = (owner: SessionOwner, id: string): Row | null => {
    const row = sessions.get(id);
    return row && row.ownerId === owner.userId ? row : null;
  };

  const repo: DiagnosticSessionRepository = {
    async create(owner: SessionOwner, session: NewSession, revision: NewRevision): Promise<CreateOutcome> {
      if (session.createKey !== null) {
        for (const row of sessions.values()) {
          const r = read(row);
          if (row.ownerId === owner.userId && r.createKey === session.createKey) return { status: "exists", record: r };
        }
      }
      if (vehicles.get(session.vehicleId) !== owner.userId) return { status: "vehicle_not_found" };
      if (sessions.has(session.id)) throw new Error("duplicate session id");
      const at = now();
      const record = { ...session, ownerId: owner.userId, createdAt: at, updatedAt: at, completedAt: session.lifecycle === "completed" ? at : null };
      sessions.set(session.id, { ownerId: owner.userId, text: canonicalJson(record) });
      revisions.set(session.id, [canonicalJson({ ...revision, sessionId: session.id, createdAt: at })]);
      return { status: "created", record: JSON.parse(canonicalJson(record)) };
    },

    async update(owner: SessionOwner, sessionId: string, expectedRevision: number, change: SessionChange, revision: NewRevision): Promise<UpdateOutcome> {
      const row = owned(owner, sessionId);
      if (!row) return { status: "not_found" };
      const current = read(row);
      if (current.lifecycle !== "active") return { status: "immutable" };
      // Compare-and-set: only the writer that saw the current revision may move it on.
      if (current.revision !== expectedRevision) return { status: "conflict", currentRevision: current.revision as number };
      if (change.revision !== expectedRevision + 1 || revision.revision !== change.revision) throw new Error("an update must advance the revision by exactly one");
      const at = now();
      const record = { ...current, ...change, updatedAt: at, completedAt: change.lifecycle === "completed" ? at : null };
      row.text = canonicalJson(record);
      revisions.get(sessionId)!.push(canonicalJson({ ...revision, sessionId, createdAt: at }));
      return { status: "updated", record: JSON.parse(row.text) };
    },

    async get(owner: SessionOwner, sessionId: string): Promise<GetOutcome> {
      const row = owned(owner, sessionId);
      return row ? { status: "found", record: read(row) } : { status: "not_found" };
    },

    async history(owner: SessionOwner, sessionId: string): Promise<HistoryOutcome> {
      if (!owned(owner, sessionId)) return { status: "not_found" };
      return { status: "found", revisions: (revisions.get(sessionId) ?? []).map((t) => JSON.parse(t)) };
    },
  };

  return Object.assign(repo, {
    /** TEST ONLY: the stored record, as stored. */
    rawRecord(sessionId: string): Record<string, unknown> | null {
      const row = sessions.get(sessionId);
      return row ? read(row) : null;
    },
    /** TEST ONLY: edit a stored record behind the store's back, as a corrupted or hand-edited database row would be. */
    tamper(sessionId: string, edit: (record: Record<string, unknown>) => unknown) {
      const row = sessions.get(sessionId);
      if (!row) throw new Error("no such session");
      const record = read(row);
      const replaced = edit(record);
      row.text = typeof replaced === "string" ? replaced : canonicalJson(replaced ?? record);
    },
    /** TEST ONLY: edit the stored history. */
    tamperHistory(sessionId: string, edit: (revisions: Record<string, unknown>[]) => void) {
      const list = (revisions.get(sessionId) ?? []).map((t) => JSON.parse(t));
      edit(list);
      revisions.set(sessionId, list.map((r) => canonicalJson(r)));
    },
    /** TEST ONLY: the garage, for vehicle ownership. */
    setVehicle(vehicleId: string, ownerId: string) {
      vehicles.set(vehicleId, ownerId);
    },
    sessionCount: () => sessions.size,
  });
}

export type InMemorySessionRepository = ReturnType<typeof createInMemorySessionRepository>;
