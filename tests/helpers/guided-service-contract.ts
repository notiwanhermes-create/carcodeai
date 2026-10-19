/**
 * The behaviour the V2I guided-diagnostics service must have over any session
 * repository and garage directory. Run against the in-memory ones in the
 * normal test run, and against PostgreSQL (Prisma repository and garage) in
 * the database tests.
 *
 * Everything here is SYNTHETIC / TEST ONLY / NOT OEM DATA.
 */
import { describe, expect, it } from "vitest";
import { nextBestTests, startSession, submitStep, type DiagnosticSession, type SessionStartFacts, type StepInput, type VehicleContext } from "../../app/lib/diagnostic-workflow";
import { parseStepInput } from "../../app/lib/diagnostic-workflow-bridge";
import { createKeywordParser } from "../../app/lib/diagnostic-workflow-bridge/examples/fake-adapters";
import { GENERIC_GASOLINE_MISFIRE, SYNTHETIC_MISFIRE, createContentCatalog } from "../../app/lib/diagnostic-workflow-content";
import { canonicalJson, ownerFromAuthenticatedUser, type DiagnosticSessionRepository, type SessionOwner } from "../../app/lib/diagnostic-workflow-persistence";
import { createGuidedDiagnosticsService, testOnlyContentPolicy, type GuidedDiagnosticsServiceOptions, type StartRequest, type VehicleDirectory } from "../../app/lib/diagnostic-workflow-service";
import { CONFLICT_ROUTE, FUEL_ROUTE, FUEL_VERIFIED, SPECS, START_SCAN, TO_REGION, W, WORKSHOP, at } from "./persisted-sessions";

export type ServiceContractSetup = {
  /**
   * A fresh, empty session store and garage: "car-ann" (ann; 2015 Synthetic Test Car, engine
   * synthetic-i4-a), "car-bob" (bob) and "car-ann-old" (ann, archived).
   */
  fresh: () => Promise<{ repository: DiagnosticSessionRepository; vehicles: VehicleDirectory }>;
  /** Edit a stored session's current step behind the service's back, as a corrupted database row would be. */
  corruptCurrentStep: (sessionId: string) => Promise<void>;
};

export const ANN = ownerFromAuthenticatedUser("ann")!;
export const BOB = ownerFromAuthenticatedUser("bob")!;

/** The garage as both setups hold it. */
export const GARAGE_CAR: VehicleContext = { year: 2015, make: "Synthetic", model: "Test Car", engine: "synthetic-i4-a" };
/** What the person tells us that the garage does not record. */
export const DETAILS = { fuel: "gasoline", cylinders: 4 } as const;

/** TEST ONLY: the synthetic fixture is startable here only because this policy says so explicitly. */
export const SYNTHETIC_FOR_TESTS = testOnlyContentPolicy({ minReview: "draft", classes: ["synthetic_test"] });
export const CATALOG = createContentCatalog([SYNTHETIC_MISFIRE, GENERIC_GASOLINE_MISFIRE]);

/** A deterministic clock: at(0), at(1), ... one tick per start or submit. */
export function tickingClock() {
  let minute = 0;
  return () => at(minute++);
}

export const fuelStart = (over: Partial<StartRequest> = {}): StartRequest => ({
  vehicleId: "car-ann",
  workflow: { id: W.id, version: W.version },
  capabilities: WORKSHOP,
  vehicleDetails: DETAILS,
  scans: [START_SCAN],
  symptoms: [],
  ...over,
});
export const regionStart = (over: Partial<StartRequest> = {}): StartRequest => ({ vehicleId: "car-ann", workflow: { id: W.id, version: W.version }, capabilities: WORKSHOP, vehicleDetails: DETAILS, ...over });

/** The engine alone, with the same pinned vehicle and the same times: the reference result. */
export function reference(request: StartRequest, inputs: StepInput[]): DiagnosticSession {
  const facts: SessionStartFacts = { vehicle: { ...GARAGE_CAR, ...request.vehicleDetails }, capabilities: request.capabilities, scans: request.scans, symptoms: request.symptoms };
  if (request.scans === undefined) delete facts.scans;
  if (request.symptoms === undefined) delete facts.symptoms;
  const s = startSession(W, facts, at(0), SPECS);
  if (!s.ok) throw new Error(s.error);
  return inputs.reduce((session, input, i) => {
    const r = submitStep(W, session, input, at(i + 1), SPECS);
    if (!r.ok) throw new Error(`${input.nodeId}: ${r.error}`);
    return r.session;
  }, s.session);
}

const same = (a: unknown, b: unknown) => expect(canonicalJson(a)).toBe(canonicalJson(b));

export function guidedServiceContract(name: string, setup: ServiceContractSetup) {
  let ids = 0;
  async function service(over: Partial<GuidedDiagnosticsServiceOptions> = {}) {
    const { repository, vehicles } = await setup.fresh();
    const svc = createGuidedDiagnosticsService({
      catalog: CATALOG,
      repository,
      vehicles,
      contentPolicy: SYNTHETIC_FOR_TESTS,
      specifications: SPECS.specifications,
      clock: tickingClock(),
      newId: () => `${name}-v2i-${++ids}`,
      ...over,
    });
    return svc;
  }
  type Svc = Awaited<ReturnType<typeof service>>;

  /** Start, then submit every input against a freshly loaded session and its current revision. */
  async function runThrough(svc: Svc, owner: SessionOwner, request: StartRequest, inputs: StepInput[]) {
    const started = await svc.startGuidedSession(owner, request);
    if (started.status !== "started") throw new Error(`start: ${JSON.stringify(started)}`);
    for (const input of inputs) {
      const loaded = await svc.loadGuidedSession(owner, started.meta.id);
      if (loaded.status !== "loaded") throw new Error(`load: ${JSON.stringify(loaded)}`);
      const saved = await svc.submitGuidedStep(owner, { sessionId: started.meta.id, expectedRevision: loaded.meta.revision, input });
      if (saved.status !== "saved") throw new Error(`${input.nodeId}: ${JSON.stringify(saved)}`);
    }
    const final = await svc.loadGuidedSession(owner, started.meta.id);
    if (final.status !== "loaded") throw new Error(`final: ${JSON.stringify(final)}`);
    return { id: started.meta.id, final };
  }

  describe(`V2I service contract (${name}): start, submit, reload`, () => {
    it("starts from the owner's garage vehicle and reaches exactly what the engine reaches on its own", async () => {
      const svc = await service();
      const { id, final } = await runThrough(svc, ANN, fuelStart(), [...FUEL_ROUTE, FUEL_VERIFIED]);
      same(final.session, reference(fuelStart(), [...FUEL_ROUTE, FUEL_VERIFIED]));
      // The garage's facts plus only the details the garage does not record, pinned at the start.
      expect(final.session.facts.vehicle).toEqual({ year: 2015, make: "synthetic", model: "test car", engine: "synthetic-i4-a", fuel: "gasoline", cylinders: 4 });
      expect(final.meta).toMatchObject({ vehicleId: "car-ann", workflowId: W.id, workflowVersion: W.version, lifecycle: "completed", revision: FUEL_ROUTE.length + 2 });
      expect(final.session.endResult).toBe(reference(fuelStart(), [...FUEL_ROUTE, FUEL_VERIFIED]).endResult);
      const h = await svc.guidedSessionHistory(ANN, id);
      expect(h.status === "found" && h.history.revisions.map((r) => r.transition)).toEqual(["start", ...FUEL_ROUTE.map(() => "input"), "input"]);
      // Completed history is never changed.
      expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: final.meta.revision, input: FUEL_ROUTE[0] })).toEqual({ status: "immutable" });
    });

    it("keeps contradictory evidence inconclusive, exactly as the engine does", async () => {
      const svc = await service();
      const { final } = await runThrough(svc, ANN, regionStart(), CONFLICT_ROUTE);
      const ref = reference(regionStart(), CONFLICT_ROUTE);
      expect(final.session.endResult).toBe("inconclusive");
      same(final.session, ref);
    });

    it("leaves next-best-test ranking to the engine: the same recommendation as without the service", async () => {
      const svc = await service();
      const { final } = await runThrough(svc, ANN, regionStart(), TO_REGION);
      const ref = reference(regionStart(), TO_REGION);
      expect(nextBestTests(final.workflow, final.session)).toEqual(nextBestTests(W, ref));
      expect(nextBestTests(final.workflow, final.session).status).toBe("region");
    });

    it("never shows or changes another user's session, and answers exactly as for a missing one", async () => {
      const svc = await service();
      const { id, final } = await runThrough(svc, ANN, fuelStart(), FUEL_ROUTE.slice(0, 1));
      expect(await svc.loadGuidedSession(BOB, id)).toEqual({ status: "not_found" });
      expect(await svc.guidedSessionHistory(BOB, id)).toEqual({ status: "not_found" });
      expect(await svc.submitGuidedStep(BOB, { sessionId: id, expectedRevision: final.meta.revision, input: FUEL_ROUTE[1] })).toEqual({ status: "not_found" });
      expect(await svc.loadGuidedSession(BOB, "no-such-session")).toEqual({ status: "not_found" });
      // An owner that did not come from the authenticated-owner boundary is refused outright.
      const forged = { userId: "ann" } as unknown as SessionOwner;
      expect(await svc.loadGuidedSession(forged, id)).toEqual({ status: "forbidden" });
      expect(await svc.startGuidedSession(forged, fuelStart())).toEqual({ status: "forbidden" });
      expect(await svc.submitGuidedStep(forged, { sessionId: id, expectedRevision: final.meta.revision, input: FUEL_ROUTE[1] })).toEqual({ status: "forbidden" });
      const after = await svc.loadGuidedSession(ANN, id);
      expect(after.status === "loaded" && after.meta.revision).toBe(final.meta.revision);
    });

    it("starts only on a vehicle in the owner's garage, and takes garage facts from the garage", async () => {
      const svc = await service();
      expect(await svc.startGuidedSession(ANN, fuelStart({ vehicleId: "car-bob" }))).toEqual({ status: "vehicle_not_found" });
      expect(await svc.startGuidedSession(ANN, fuelStart({ vehicleId: "car-nobody" }))).toEqual({ status: "vehicle_not_found" });
      expect(await svc.startGuidedSession(ANN, fuelStart({ vehicleId: "car-ann-old" }))).toEqual({ status: "vehicle_not_found" });
      expect(await svc.startGuidedSession(ANN, fuelStart({ vehicleDetails: { ...DETAILS, make: "Other" } as never }))).toMatchObject({ status: "invalid_request" });
      // Unknown is not false: without the fuel the engine refuses to guess.
      expect(await svc.startGuidedSession(ANN, fuelStart({ vehicleDetails: { cylinders: 4 } }))).toMatchObject({ status: "not_started", reason: expect.stringMatching(/^insufficient_context/) });
    });

    it("refuses a stale revision instead of overwriting, and lets exactly one of two concurrent submissions win", async () => {
      const svc = await service();
      const { id } = await runThrough(svc, ANN, fuelStart(), FUEL_ROUTE.slice(0, 1));
      // Someone answered on revision 1, which is no longer current.
      expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: 1, input: FUEL_ROUTE[0] })).toEqual({ status: "conflict", currentRevision: 2 });
      const both = await Promise.all([
        svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: 2, input: FUEL_ROUTE[1] }),
        svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: 2, input: { nodeId: "flashing_light", kind: "yes_no", answer: "yes" } }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual(["conflict", "saved"]);
      const winner = both.find((r) => r.status === "saved");
      const now = await svc.loadGuidedSession(ANN, id);
      if (now.status !== "loaded" || winner?.status !== "saved") throw new Error("load");
      expect(now.meta.revision).toBe(3);
      same(now.session, winner.session);
      const h = await svc.guidedSessionHistory(ANN, id);
      expect(h.status === "found" && h.history.revisions.length).toBe(3);
    });

    it("refuses an input the engine refuses, and records nothing", async () => {
      const svc = await service();
      const { id, final } = await runThrough(svc, ANN, fuelStart(), []);
      expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: 1, input: FUEL_ROUTE[1] })).toMatchObject({ status: "rejected", reason: "not_current_step" });
      const after = await svc.loadGuidedSession(ANN, id);
      if (after.status !== "loaded") throw new Error("load");
      same(after.session, final.session);
      expect(after.meta.revision).toBe(1);
    });

    it("stores an accepted AI-parsed input exactly like a typed one, through the same engine path", async () => {
      const svc = await service({ clock: () => at(0) });
      const parser = createKeywordParser();
      const typed = await svc.startGuidedSession(ANN, fuelStart());
      const viaAi = await svc.startGuidedSession(ANN, fuelStart());
      if (typed.status !== "started" || viaAi.status !== "started") throw new Error("start");
      const loaded = await svc.loadGuidedSession(ANN, viaAi.meta.id);
      if (loaded.status !== "loaded") throw new Error("load");
      const proposal = await parseStepInput(parser, loaded.workflow, loaded.session, "yes it was definitely shaking and rough", SPECS);
      expect(proposal.status).toBe("valid");

      const a = await svc.submitGuidedStep(ANN, { sessionId: viaAi.meta.id, expectedRevision: 1, proposal });
      const b = await svc.submitGuidedStep(ANN, { sessionId: typed.meta.id, expectedRevision: 1, input: FUEL_ROUTE[0] });
      if (a.status !== "saved" || b.status !== "saved") throw new Error(JSON.stringify([a, b]));
      same(a.session, b.session);
      const ha = await svc.guidedSessionHistory(ANN, viaAi.meta.id);
      const hb = await svc.guidedSessionHistory(ANN, typed.meta.id);
      expect(ha.status === "found" && ha.history.revisions[1]).toMatchObject({ inputOrigin: "ai_parser", aiTextRef: expect.stringMatching(/^fnv1a32:/) });
      expect(hb.status === "found" && hb.history.revisions[1]).toMatchObject({ inputOrigin: "direct", aiTextRef: null });
      expect(JSON.stringify(ha)).not.toContain("shaking");
      // The same proposal cannot be applied twice: the session has moved on.
      expect(await svc.submitGuidedStep(ANN, { sessionId: viaAi.meta.id, expectedRevision: 2, proposal })).toMatchObject({ status: "proposal_not_accepted", reason: expect.stringMatching(/^stale_proposal/) });
    });

    it("records nothing for an ambiguous or invalid AI proposal", async () => {
      const svc = await service();
      const { id } = await runThrough(svc, ANN, fuelStart(), FUEL_ROUTE.slice(0, 1));
      const loaded = await svc.loadGuidedSession(ANN, id);
      if (loaded.status !== "loaded") throw new Error("load");
      const ambiguous = await parseStepInput(createKeywordParser(), loaded.workflow, loaded.session, "yes and no, not sure", SPECS);
      expect(ambiguous.status).toBe("ambiguous");
      expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: 2, proposal: ambiguous })).toMatchObject({ status: "proposal_not_accepted" });
      const after = await svc.loadGuidedSession(ANN, id);
      if (after.status !== "loaded") throw new Error("load");
      expect(after.meta.revision).toBe(2);
      same(after.session.evidence, loaded.session.evidence);
      const h = await svc.guidedSessionHistory(ANN, id);
      expect(h.status === "found" && h.history.revisions.length).toBe(2);
    });

    it("makes a retried start with the same key the same start, and refuses the key for a different one", async () => {
      const svc = await service({ clock: () => at(0) });
      const first = await svc.startGuidedSession(ANN, fuelStart({ createKey: "start-1" }));
      const retry = await svc.startGuidedSession(ANN, fuelStart({ createKey: "start-1" }));
      expect(first).toMatchObject({ status: "started", duplicate: false });
      expect(retry).toMatchObject({ status: "started", duplicate: true });
      expect(first.status === "started" && retry.status === "started" && retry.meta.id).toBe(first.status === "started" && first.meta.id);
      expect(await svc.startGuidedSession(ANN, regionStart({ createKey: "start-1" }))).toEqual({ status: "create_key_conflict" });
    });

    it("fails closed on a corrupted stored session, for load, submit and history", async () => {
      const svc = await service();
      const { id } = await runThrough(svc, ANN, fuelStart(), FUEL_ROUTE.slice(0, 2));
      await setup.corruptCurrentStep(id);
      expect(await svc.loadGuidedSession(ANN, id)).toMatchObject({ status: "corrupted" });
      expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: 3, input: FUEL_ROUTE[2] })).toMatchObject({ status: "corrupted" });
      expect(await svc.guidedSessionHistory(ANN, id)).toMatchObject({ status: "corrupted" });
    });
  });
}
