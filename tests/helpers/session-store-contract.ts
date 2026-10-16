/**
 * The behaviour every DiagnosticSessionRepository must give the session store
 * (V2G). Run against the in-memory repository in the normal test run, and
 * against the Prisma adapter in the database tests.
 *
 * Everything here is SYNTHETIC / TEST ONLY / NOT OEM DATA.
 */
import { describe, expect, it } from "vitest";
import { nextBestTests, recheckPlan, type DiagnosticSession } from "../../app/lib/diagnostic-workflow";
import { canonicalJson, createInMemoryWorkflowResolver, createSessionStore, ownerFromAuthenticatedUser, type DiagnosticSessionRepository, type SessionStore } from "../../app/lib/diagnostic-workflow-persistence";
import { CONFLICT_FACTS, CONFLICT_ROUTE, FUEL_FACTS, FUEL_ROUTE, FUEL_VERIFIED, REGION_FACTS, REGION_ROUTE, REGION_VERIFIED, W, direct, persistThrough, started, step } from "./persisted-sessions";

export type ContractSetup = {
  /** A fresh, empty repository whose garage has vehicle "car-ann" owned by "ann" and "car-bob" owned by "bob". */
  repository: () => Promise<DiagnosticSessionRepository>;
};

export const ANN = ownerFromAuthenticatedUser("ann")!;
export const BOB = ownerFromAuthenticatedUser("bob")!;

const same = (a: unknown, b: unknown) => expect(canonicalJson(a)).toBe(canonicalJson(b));

export function sessionStoreContract(name: string, setup: ContractSetup) {
  let ids = 0;
  const storeOn = (repository: DiagnosticSessionRepository): SessionStore =>
    createSessionStore({ repository, workflows: createInMemoryWorkflowResolver([W]), newId: () => `${name.replace(/\W+/g, "-")}-session-${++ids}` });
  const fresh = async () => {
    const repository = await setup.repository();
    return { repository, store: storeOn(repository) };
  };

  describe(`V2G contract (${name}): save, reload and resume at the exact state`, () => {
    it("start → save → reload → advance → save → reload … reaches exactly what the engine reaches without storage", async () => {
      const { store } = await fresh();
      const { id, final } = await persistThrough(store, ANN, "car-ann", FUEL_FACTS, FUEL_ROUTE);
      const reference = direct(FUEL_FACTS, FUEL_ROUTE);
      same(final.session, reference);
      expect(final.meta).toMatchObject({ id, revision: FUEL_ROUTE.length + 1, lifecycle: "active", currentStep: "verify_fuel_repair", completedAt: null, vehicleId: "car-ann", workflowId: W.id, workflowVersion: W.version });
    });

    it("keeps the pinned vehicle, scans, completeness, snapshots, pinned specifications, causes, phase and conditions", async () => {
      const { store } = await fresh();
      const { final } = await persistThrough(store, ANN, "car-ann", FUEL_FACTS, FUEL_ROUTE);
      const s = final.session;
      const ref = direct(FUEL_FACTS, FUEL_ROUTE);
      same(s.facts.vehicle, ref.facts.vehicle);
      expect(s.facts.vehicle).toMatchObject({ make: "synthetic", model: "test car", engine: "synthetic-i4-a", fuel: "gasoline", cylinders: 4 });
      same(s.facts.scans, ref.facts.scans);
      expect(s.evidence.find((e) => e.kind === "scan")).toMatchObject({ scanInfo: { id: "start", completeness: "complete" }, phase: "before_repair" });
      expect(s.evidence.find((e) => e.kind === "snapshot")).toMatchObject({ value: "ff1", snapshot: { id: "ff1", forCode: "P0300" } });
      expect(Object.keys(s.specifications)).toEqual(["synthetic.fuel_supply_pressure_idle"]);
      same(s.specifications, ref.specifications);
      expect(s.evidence.find((e) => e.nodeId === "fuel_pressure" && e.kind === "measurement")).toMatchObject({ value: expect.stringMatching(/200/) });
      expect(s).toMatchObject({ supportedCauses: ["fuel_supply"], conclusionNodeId: "concl_fuel_supply", phase: "after_repair", faultModel: "single_primary_fault" });
      same([s.remainingCauses, s.establishedConditions, s.refutedConditions], [ref.remainingCauses, ref.establishedConditions, ref.refutedConditions]);
    });

    it("completes: before/after-repair evidence and the verification verdict survive, and the session becomes immutable history", async () => {
      const { store } = await fresh();
      const { id, final } = await persistThrough(store, ANN, "car-ann", FUEL_FACTS, [...FUEL_ROUTE, FUEL_VERIFIED]);
      same(final.session, direct(FUEL_FACTS, [...FUEL_ROUTE, FUEL_VERIFIED]));
      expect(final.session).toMatchObject({ status: "completed", endResult: "resolved", verification: "verified", repairVerified: true });
      expect(final.meta).toMatchObject({ lifecycle: "completed", currentStep: null, completedAt: expect.any(String) });
      expect(final.session.evidence.filter((e) => e.criterion === "pressure_ok").map((e) => e.phase)).toEqual(["after_repair"]);
      const beforeRepair = final.session.evidence.filter((e) => e.nodeId === "fuel_pressure");
      expect(beforeRepair.length).toBeGreaterThan(0);
      expect(beforeRepair.every((e) => e.phase === "before_repair")).toBe(true);
      // A completed session is history: no further revision is accepted, whatever it holds.
      const attempt = await store.advance(ANN, { sessionId: id, expectedRevision: final.meta.revision, session: final.session });
      expect(attempt).toEqual({ status: "immutable" });
      const again = await store.load(ANN, id);
      expect(again.status === "loaded" && again.meta.revision).toBe(final.meta.revision);
    });

    it("keeps a conflict and its inconclusive outcome exactly", async () => {
      const { store } = await fresh();
      const { final } = await persistThrough(store, ANN, "car-ann", CONFLICT_FACTS, CONFLICT_ROUTE);
      same(final.session, direct(CONFLICT_FACTS, CONFLICT_ROUTE));
      expect(final.session).toMatchObject({ status: "completed", endResult: "inconclusive", conclusionNodeId: null });
      expect(final.session.evidence.at(-1)).toMatchObject({ kind: "conflict", conflict: { nodeId: "injector_balance", assumption: "single_primary_fault" } });
      expect(final.meta.lifecycle).toBe("completed");
    });

    it("keeps V2E region progress: completed tests, next best tests and the recheck plan are identical after reload", async () => {
      const { store } = await fresh();
      for (let n = 4; n <= REGION_ROUTE.length; n += 2) {
        const inputs = REGION_ROUTE.slice(0, n);
        const { final } = await persistThrough(store, ANN, "car-ann", REGION_FACTS, inputs);
        const ref = direct(REGION_FACTS, inputs);
        same(nextBestTests(final.workflow, final.session), nextBestTests(W, ref));
        same(recheckPlan(final.workflow, final.session), recheckPlan(W, ref));
        same(final.session.evidence.filter((e) => e.kind === "test_selection"), ref.evidence.filter((e) => e.kind === "test_selection"));
      }
      const { final } = await persistThrough(store, ANN, "car-ann", REGION_FACTS, [...REGION_ROUTE, REGION_VERIFIED]);
      expect(final.session).toMatchObject({ endResult: "resolved", verification: "verified" });
    });
  });

  describe(`V2G contract (${name}): optimistic concurrency and idempotency`, () => {
    async function startedAt2(store: SessionStore) {
      const s1 = started(FUEL_FACTS);
      const r = await store.start(ANN, { vehicleId: "car-ann", session: s1 });
      if (r.status !== "saved") throw new Error(JSON.stringify(r));
      return { id: r.meta.id, s1 };
    }

    it("requires the expected revision, and refuses a stale writer instead of overwriting (no last-write-wins)", async () => {
      const { store } = await fresh();
      const { id, s1 } = await startedAt2(store);
      const a = step(s1, FUEL_ROUTE[0]);
      expect(await store.advance(ANN, { sessionId: id, expectedRevision: 0, session: a })).toMatchObject({ status: "invalid_transition" });
      expect(await store.advance(ANN, { sessionId: id, expectedRevision: 1, session: a })).toMatchObject({ status: "saved", meta: { revision: 2 } });
      // A second writer that also started from revision 1, with a DIFFERENT answer: conflict, nothing changed.
      const b = step(s1, { nodeId: "confirm_symptom", kind: "yes_no", answer: "no" });
      expect(await store.advance(ANN, { sessionId: id, expectedRevision: 1, session: b })).toEqual({ status: "conflict", currentRevision: 2 });
      const now = await store.load(ANN, id);
      if (now.status !== "loaded") throw new Error("load");
      same(now.session, a);
      expect(now.meta.revision).toBe(2);
    });

    it("lets exactly one of two concurrent writers win", async () => {
      const { store } = await fresh();
      const { id, s1 } = await startedAt2(store);
      const results = await Promise.all([
        store.advance(ANN, { sessionId: id, expectedRevision: 1, session: step(s1, FUEL_ROUTE[0]) }),
        store.advance(ANN, { sessionId: id, expectedRevision: 1, session: step(s1, { nodeId: "confirm_symptom", kind: "yes_no", answer: "no" }) }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["conflict", "saved"]);
      const h = await store.history(ANN, id);
      expect(h.status === "found" && h.history.revisions.map((r) => r.revision)).toEqual([1, 2]);
    });

    it("treats a retried save as the same save: no duplicated evidence, no double advance", async () => {
      const { store } = await fresh();
      const { id, s1 } = await startedAt2(store);
      const a = step(s1, FUEL_ROUTE[0]);
      const first = await store.advance(ANN, { sessionId: id, expectedRevision: 1, session: a });
      const retry = await store.advance(ANN, { sessionId: id, expectedRevision: 1, session: a });
      expect(first).toMatchObject({ status: "saved", duplicate: false, meta: { revision: 2 } });
      expect(retry).toMatchObject({ status: "saved", duplicate: true, meta: { revision: 2 } });
      // Concurrent identical retries: still exactly one revision.
      const b = step(a, FUEL_ROUTE[1]);
      const both = await Promise.all([store.advance(ANN, { sessionId: id, expectedRevision: 2, session: b }), store.advance(ANN, { sessionId: id, expectedRevision: 2, session: b })]);
      expect(both.map((r) => r.status)).toEqual(["saved", "saved"]);
      expect(both.map((r) => r.status === "saved" && r.duplicate).sort()).toEqual([false, true]);
      const now = await store.load(ANN, id);
      if (now.status !== "loaded") throw new Error("load");
      expect(now.meta.revision).toBe(3);
      expect(now.session.inputs).toHaveLength(2);
      same(now.session.evidence, b.evidence);
      const h = await store.history(ANN, id);
      expect(h.status === "found" && h.history.revisions.length).toBe(3);
    });

    it("makes a retried start with the same key find the session it already made", async () => {
      const { store } = await fresh();
      const s1 = started(FUEL_FACTS);
      const a = await store.start(ANN, { vehicleId: "car-ann", session: s1, createKey: "start-1" });
      const b = await store.start(ANN, { vehicleId: "car-ann", session: s1, createKey: "start-1" });
      expect(a).toMatchObject({ status: "saved", duplicate: false });
      expect(b).toMatchObject({ status: "saved", duplicate: true });
      expect(a.status === "saved" && b.status === "saved" && a.meta.id === b.meta.id).toBe(true);
      // The same key for a different session is refused, never merged.
      expect(await store.start(ANN, { vehicleId: "car-ann", session: started(REGION_FACTS), createKey: "start-1" })).toEqual({ status: "create_key_conflict" });
      // Keys are per owner.
      expect(await store.start(BOB, { vehicleId: "car-bob", session: s1, createKey: "start-1" })).toMatchObject({ status: "saved", duplicate: false });
    });

    it("refuses a save that is not one input past the stored revision, or that rewrites history", async () => {
      const { store } = await fresh();
      const { id, s1 } = await startedAt2(store);
      const two = step(step(s1, FUEL_ROUTE[0]), FUEL_ROUTE[1]);
      expect(await store.advance(ANN, { sessionId: id, expectedRevision: 1, session: two })).toEqual({ status: "invalid_transition", reason: "expected exactly one new input, found 2" });
      expect(await store.advance(ANN, { sessionId: id, expectedRevision: 1, session: s1 })).toMatchObject({ status: "invalid_transition" });
      const otherCar = step(started({ ...FUEL_FACTS, vehicle: { ...FUEL_FACTS.vehicle, cylinders: 6 } }), FUEL_ROUTE[0]);
      expect(await store.advance(ANN, { sessionId: id, expectedRevision: 1, session: otherCar })).toEqual({ status: "invalid_transition", reason: "pinned_facts_changed" });
      // A forged session (evidence edited after the engine produced it) is never stored.
      const forged = JSON.parse(JSON.stringify(step(s1, FUEL_ROUTE[0]))) as DiagnosticSession & { evidence: Array<{ value: string }> };
      forged.evidence[forged.evidence.length - 1].value = "no";
      expect(await store.advance(ANN, { sessionId: id, expectedRevision: 1, session: forged })).toMatchObject({ status: "invalid_session" });
      expect((await store.load(ANN, id)).status === "loaded").toBe(true);
    });
  });

  describe(`V2G contract (${name}): ownership`, () => {
    it("never shows or changes another user's session, and answers exactly as for a missing one", async () => {
      const { store } = await fresh();
      const r = await store.start(ANN, { vehicleId: "car-ann", session: started(FUEL_FACTS) });
      if (r.status !== "saved") throw new Error("start");
      const id = r.meta.id;
      expect(await store.load(BOB, id)).toEqual({ status: "not_found" });
      expect(await store.load(BOB, "no-such-session")).toEqual({ status: "not_found" });
      expect(await store.history(BOB, id)).toEqual({ status: "not_found" });
      expect(await store.advance(BOB, { sessionId: id, expectedRevision: 1, session: step(started(FUEL_FACTS), FUEL_ROUTE[0]) })).toEqual({ status: "not_found" });
      const still = await store.load(ANN, id);
      expect(still.status === "loaded" && still.meta.revision).toBe(1);
    });

    it("needs an authenticated owner, and a vehicle that owner has", async () => {
      const { store } = await fresh();
      expect(ownerFromAuthenticatedUser("")).toBeNull();
      expect(ownerFromAuthenticatedUser(undefined)).toBeNull();
      expect(ownerFromAuthenticatedUser(" ann")).toBeNull();
      const forgedOwner = { userId: "ann" } as never;
      expect(await store.load(forgedOwner, "x")).toEqual({ status: "forbidden" });
      expect(await store.start(null as never, { vehicleId: "car-ann", session: started(FUEL_FACTS) })).toEqual({ status: "forbidden" });
      expect(await store.start(ANN, { vehicleId: "car-bob", session: started(FUEL_FACTS) })).toEqual({ status: "vehicle_not_found" });
      expect(await store.start(ANN, { vehicleId: "no-such-car", session: started(FUEL_FACTS) })).toEqual({ status: "vehicle_not_found" });
    });
  });

  describe(`V2G contract (${name}): history`, () => {
    it("answers when it started, which transition changed it, the current revision, when it completed and how it ended", async () => {
      const { store } = await fresh();
      const { id, final } = await persistThrough(store, ANN, "car-ann", FUEL_FACTS, [...FUEL_ROUTE, FUEL_VERIFIED]);
      const h = await store.history(ANN, id);
      if (h.status !== "found") throw new Error(JSON.stringify(h));
      expect(h.history).toMatchObject({ sessionId: id, currentRevision: 7, lifecycle: "completed", completedAt: final.meta.completedAt, endResult: "resolved", startedAt: final.meta.createdAt });
      expect(h.history.revisions.map((r) => [r.revision, r.transition, r.stepId, r.inputCount])).toEqual([
        [1, "start", null, 0],
        [2, "input", "confirm_symptom", 1],
        [3, "input", "flashing_light", 2],
        [4, "input", "multi_vacuum", 3],
        [5, "input", "fuel_pump_actuator", 4],
        [6, "input", "fuel_pressure", 5],
        [7, "input", "verify_fuel_repair", 6],
      ]);
      expect(h.history.revisions.at(-1)).toMatchObject({ lifecycle: "completed", currentStep: null, endResult: "resolved", inputOrigin: "direct", aiTextRef: null });
      expect(h.history.revisions.slice(0, -1).every((r) => r.lifecycle === "active" && r.endResult === null)).toBe(true);
    });
  });
}
