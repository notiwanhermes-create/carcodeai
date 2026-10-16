/**
 * The Prisma (PostgreSQL) DiagnosticSessionRepository (V2G).
 *
 * RESEARCH PROTOTYPE. NOTHING IN THE APP USES IT YET. A narrow adapter that
 * implements the storage contract in ./repository.ts over the
 * `guided_diagnostic_sessions` and `guided_diagnostic_session_revisions`
 * tables, and nothing else. The Prisma client is passed in (it does not import
 * the app's connection), so the engine, the codec and the store stay free of
 * Prisma, and their tests run without a database.
 *
 * - Every query is filtered by the authenticated owner's id; someone else's
 *   session reads exactly like a missing one.
 * - A new session's vehicle must be the owner's, checked in the same
 *   transaction as the insert.
 * - An update is a compare-and-set on (id, owner, revision, lifecycle =
 *   'active'), and appends its revision row in the same transaction. The
 *   (session_id, revision) primary key makes a second write of one revision
 *   impossible even under concurrency.
 */
import { Prisma, type PrismaClient } from "@/app/generated/prisma/client";
import type { SessionOwner } from "./owner";
import type { CreateOutcome, DiagnosticSessionRepository, GetOutcome, HistoryOutcome, NewRevision, NewSession, SessionChange, UpdateOutcome } from "./repository";

type Db = PrismaClient | Prisma.TransactionClient;

const SESSION_COLUMNS = {
  id: true,
  userId: true,
  vehicleId: true,
  workflowId: true,
  workflowVersion: true,
  workflowFingerprint: true,
  persistenceVersion: true,
  sessionFormatVersion: true,
  revision: true,
  lifecycle: true,
  currentStep: true,
  payload: true,
  integrityAlgorithm: true,
  payloadDigest: true,
  createKey: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
} as const;

type SessionRow = Prisma.GuidedDiagnosticSessionGetPayload<{ select: typeof SESSION_COLUMNS }>;

/** A row in the store's record shape. Values are passed through as read; the store validates them. */
function toRecord(row: SessionRow): Record<string, unknown> {
  const { userId, createdAt, updatedAt, completedAt, ...rest } = row;
  return { ...rest, ownerId: userId, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(), completedAt: completedAt ? completedAt.toISOString() : null };
}

const json = (value: unknown) => value as Prisma.InputJsonValue;
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** Thrown inside a transaction to roll it back when the compare-and-set lost. */
class LostRace extends Error {}

export function createPrismaSessionRepository(prisma: PrismaClient): DiagnosticSessionRepository {
  const findOwned = (db: Db, owner: SessionOwner, id: string) => db.guidedDiagnosticSession.findFirst({ where: { id, userId: owner.userId }, select: SESSION_COLUMNS });

  async function existingByKey(owner: SessionOwner, createKey: string | null): Promise<CreateOutcome | null> {
    if (createKey === null) return null;
    const row = await prisma.guidedDiagnosticSession.findFirst({ where: { userId: owner.userId, createKey }, select: SESSION_COLUMNS });
    return row ? { status: "exists", record: toRecord(row) } : null;
  }

  return {
    async create(owner: SessionOwner, session: NewSession, revision: NewRevision): Promise<CreateOutcome> {
      const existing = await existingByKey(owner, session.createKey);
      if (existing) return existing;
      try {
        return await prisma.$transaction(async (tx) => {
          const vehicle = await tx.vehicle.findFirst({ where: { id: session.vehicleId, userId: owner.userId }, select: { id: true } });
          if (!vehicle) return { status: "vehicle_not_found" } as const;
          const now = new Date();
          const row = await tx.guidedDiagnosticSession.create({
            data: {
              id: session.id,
              userId: owner.userId,
              vehicleId: session.vehicleId,
              workflowId: session.workflowId,
              workflowVersion: session.workflowVersion,
              workflowFingerprint: session.workflowFingerprint,
              persistenceVersion: session.persistenceVersion,
              sessionFormatVersion: session.sessionFormatVersion,
              revision: session.revision,
              lifecycle: session.lifecycle,
              currentStep: session.currentStep,
              payload: json(session.payload),
              integrityAlgorithm: session.integrityAlgorithm,
              payloadDigest: session.payloadDigest,
              createKey: session.createKey,
              createdAt: now,
              updatedAt: now,
              completedAt: session.lifecycle === "completed" ? now : null,
            },
            select: SESSION_COLUMNS,
          });
          await tx.guidedDiagnosticSessionRevision.create({ data: { ...revision, sessionId: row.id, createdAt: now } });
          return { status: "created", record: toRecord(row) } as const;
        });
      } catch (e) {
        // Two starts with the same key at the same moment: the one that lost finds the winner's session.
        if (isUniqueViolation(e)) {
          const winner = await existingByKey(owner, session.createKey);
          if (winner) return winner;
        }
        throw e;
      }
    },

    async update(owner: SessionOwner, sessionId: string, expectedRevision: number, change: SessionChange, revision: NewRevision): Promise<UpdateOutcome> {
      if (change.revision !== expectedRevision + 1 || revision.revision !== change.revision) throw new Error("an update must advance the revision by exactly one");
      try {
        return await prisma.$transaction(async (tx) => {
          const now = new Date();
          // Compare-and-set: only a writer that saw the current revision of an ACTIVE session moves it on.
          const moved = await tx.guidedDiagnosticSession.updateMany({
            where: { id: sessionId, userId: owner.userId, revision: expectedRevision, lifecycle: "active" },
            data: {
              revision: change.revision,
              lifecycle: change.lifecycle,
              currentStep: change.currentStep,
              payload: json(change.payload),
              integrityAlgorithm: change.integrityAlgorithm,
              payloadDigest: change.payloadDigest,
              updatedAt: now,
              completedAt: change.lifecycle === "completed" ? now : null,
            },
          });
          if (moved.count !== 1) {
            const row = await findOwned(tx, owner, sessionId);
            if (!row) return { status: "not_found" } as const;
            if (row.lifecycle !== "active") return { status: "immutable" } as const;
            return { status: "conflict", currentRevision: row.revision } as const;
          }
          await tx.guidedDiagnosticSessionRevision.create({ data: { ...revision, sessionId, createdAt: now } });
          const row = await findOwned(tx, owner, sessionId);
          if (!row) throw new LostRace();
          return { status: "updated", record: toRecord(row) } as const;
        });
      } catch (e) {
        if (e instanceof LostRace || isUniqueViolation(e)) {
          const row = await findOwned(prisma, owner, sessionId);
          if (!row) return { status: "not_found" };
          return row.lifecycle !== "active" && row.revision === expectedRevision ? { status: "immutable" } : { status: "conflict", currentRevision: row.revision };
        }
        throw e;
      }
    },

    async get(owner: SessionOwner, sessionId: string): Promise<GetOutcome> {
      const row = await findOwned(prisma, owner, sessionId);
      return row ? { status: "found", record: toRecord(row) } : { status: "not_found" };
    },

    async history(owner: SessionOwner, sessionId: string): Promise<HistoryOutcome> {
      const owned = await prisma.guidedDiagnosticSession.findFirst({ where: { id: sessionId, userId: owner.userId }, select: { id: true } });
      if (!owned) return { status: "not_found" };
      const rows = await prisma.guidedDiagnosticSessionRevision.findMany({ where: { sessionId }, orderBy: { revision: "asc" } });
      return { status: "found", revisions: rows.map(({ createdAt, ...r }) => ({ ...r, createdAt: createdAt.toISOString() })) };
    },
  };
}
