/**
 * Guided Diagnostics V2I: retried and duplicate submissions, through the
 * service's public API only.
 *
 * The documented outcomes (v2i-service.md, the V2G session store and the
 * repository contract), asserted as they are, with no new retry policy:
 * - a retried start with the same createKey, the same vehicle and the same
 *   evidence time is the same start (duplicate, one session); anything else
 *   with that key fails closed as create_key_conflict, never a second session;
 * - a createKey belongs to its owner;
 * - a submit whose expectedRevision is no longer current is a conflict, even
 *   when it repeats a submit that already went through;
 * - a submit that loses the compare-and-set race to exactly the same save is
 *   that save (duplicate, written once); to anything else, a conflict that
 *   keeps the winner's evidence.
 *
 * Everything here is SYNTHETIC / TEST ONLY / NOT OEM DATA.
 */
import { describe, expect, it } from "vitest";
import type { StepInput } from "../app/lib/diagnostic-workflow";
import { parseStepInput } from "../app/lib/diagnostic-workflow-bridge";
import { createKeywordParser } from "../app/lib/diagnostic-workflow-bridge/examples/fake-adapters";
import { canonicalJson, createInMemorySessionRepository, type DiagnosticSessionRepository } from "../app/lib/diagnostic-workflow-persistence";
import { createGuidedDiagnosticsService, createInMemoryVehicleDirectory, type GuidedDiagnosticsService, type SubmitRequest } from "../app/lib/diagnostic-workflow-service";
import { ANN, BOB, CATALOG, GARAGE_CAR, SYNTHETIC_FOR_TESTS, fuelStart, regionStart } from "./helpers/guided-service-contract";
import { FUEL_ROUTE, SPECS, TO_REGION, W, at } from "./helpers/persisted-sessions";

const GARAGE = {
  "car-ann": { ownerId: "ann", context: GARAGE_CAR },
  "car-ann-2": { ownerId: "ann", context: GARAGE_CAR },
  "car-bob": { ownerId: "bob", context: GARAGE_CAR },
};

/**
 * The in-memory repository, counting every create and update by outcome. `beforeNextUpdate` runs a
 * competing request just before the next update reaches the repository: a deterministic lost race.
 */
function instrumented(inner: DiagnosticSessionRepository) {
  const creates: string[] = [];
  const updates: string[] = [];
  let competitor: (() => Promise<unknown>) | null = null;
  const repository: DiagnosticSessionRepository = {
    async create(owner, session, revision) {
      const out = await inner.create(owner, session, revision);
      creates.push(out.status);
      return out;
    },
    async update(owner, sessionId, expectedRevision, change, revision) {
      const race = competitor;
      competitor = null;
      if (race) await race();
      const out = await inner.update(owner, sessionId, expectedRevision, change, revision);
      updates.push(out.status);
      return out;
    },
    get: (owner, sessionId) => inner.get(owner, sessionId),
    history: (owner, sessionId) => inner.history(owner, sessionId),
  };
  /** Resolves with the competing request's own outcome once it has run. */
  function beforeNextUpdate<T>(race: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      competitor = () => race().then(resolve, reject);
    });
  }
  return { repository, creates, updates, beforeNextUpdate };
}

/** One repository and garage; `service(clock)` is another request handled by another service instance. */
function setup() {
  const store = instrumented(createInMemorySessionRepository({ vehicles: { "car-ann": "ann", "car-ann-2": "ann", "car-bob": "bob" } }));
  let ids = 0;
  const service = (clock: () => string): GuidedDiagnosticsService =>
    createGuidedDiagnosticsService({
      catalog: CATALOG,
      repository: store.repository,
      vehicles: createInMemoryVehicleDirectory(GARAGE),
      contentPolicy: SYNTHETIC_FOR_TESTS,
      specifications: SPECS.specifications,
      clock,
      newId: () => `v2i-retry-${++ids}`,
    });
  return { ...store, service };
}

/** Revision, history length and the exact stored session: what "nothing changed" is checked against. */
async function footprint(svc: GuidedDiagnosticsService, id: string) {
  const loaded = await svc.loadGuidedSession(ANN, id);
  const history = await svc.guidedSessionHistory(ANN, id);
  if (loaded.status !== "loaded" || history.status !== "found") throw new Error(`footprint: ${JSON.stringify([loaded.status, history.status])}`);
  return { revision: loaded.meta.revision, revisions: history.history.revisions.length, session: canonicalJson(loaded.session) };
}

/** Start at the given clock and answer the first step: the session is at revision 2, on flashing_light. */
async function atRevisionTwo(svc: GuidedDiagnosticsService) {
  const started = await svc.startGuidedSession(ANN, fuelStart());
  if (started.status !== "started") throw new Error(`start: ${JSON.stringify(started)}`);
  const saved = await svc.submitGuidedStep(ANN, { sessionId: started.meta.id, expectedRevision: 1, input: FUEL_ROUTE[0] });
  if (saved.status !== "saved") throw new Error(`submit: ${JSON.stringify(saved)}`);
  const loaded = await svc.loadGuidedSession(ANN, started.meta.id);
  if (loaded.status !== "loaded") throw new Error(`load: ${JSON.stringify(loaded)}`);
  expect(loaded.meta.revision).toBe(2);
  expect(loaded.session.currentNodeId).toBe("flashing_light");
  return { id: started.meta.id, loaded };
}

/* ───────────────────────── retried start ───────────────────────── */

describe("V2I service: a retried start", () => {
  it("with the same key, vehicle and evidence time is the same start: same session, written once", async () => {
    const t = setup();
    const svc = t.service(() => at(0));
    const first = await svc.startGuidedSession(ANN, fuelStart({ createKey: "start-1" }));
    // Another request, another service instance, handled at the same time.
    const retry = await t.service(() => at(0)).startGuidedSession(ANN, fuelStart({ createKey: "start-1" }));
    if (first.status !== "started" || retry.status !== "started") throw new Error(JSON.stringify([first, retry]));
    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(true);
    expect(retry.meta).toEqual(first.meta);
    expect(canonicalJson(retry.session)).toBe(canonicalJson(first.session));
    expect(retry.meta).toMatchObject({ workflowId: W.id, workflowVersion: W.version, revision: 1, vehicleId: "car-ann" });
    expect(retry.session).toMatchObject({ workflowId: W.id, workflowVersion: W.version });
    expect(retry.workflow).toBe(first.workflow);
    expect(t.creates).toEqual(["created", "exists"]);
    expect(await footprint(svc, first.meta.id)).toEqual({ revision: 1, revisions: 1, session: canonicalJson(first.session) });
  });

  it("sent twice at once with the same key makes one session", async () => {
    const t = setup();
    const both = await Promise.all([
      t.service(() => at(0)).startGuidedSession(ANN, fuelStart({ createKey: "start-1" })),
      t.service(() => at(0)).startGuidedSession(ANN, fuelStart({ createKey: "start-1" })),
    ]);
    if (both[0].status !== "started" || both[1].status !== "started") throw new Error(JSON.stringify(both));
    expect(both.map((r) => r.status === "started" && r.duplicate).sort()).toEqual([false, true]);
    expect(both[0].meta).toEqual(both[1].meta);
    expect(t.creates.filter((s) => s === "created")).toHaveLength(1);
    expect((await footprint(t.service(() => at(0)), both[0].meta.id)).revisions).toBe(1);
  });

  it("handled later (a new evidence time) fails closed as create_key_conflict: no second session, the first unchanged and usable", async () => {
    const t = setup();
    const first = await t.service(() => at(0)).startGuidedSession(ANN, fuelStart({ createKey: "start-1" }));
    if (first.status !== "started") throw new Error(JSON.stringify(first));
    const svc = t.service(() => at(1));
    expect(await svc.startGuidedSession(ANN, fuelStart({ createKey: "start-1" }))).toEqual({ status: "create_key_conflict" });
    expect(t.creates).toEqual(["created", "exists"]);
    expect(await footprint(svc, first.meta.id)).toEqual({ revision: 1, revisions: 1, session: canonicalJson(first.session) });
    expect(await svc.submitGuidedStep(ANN, { sessionId: first.meta.id, expectedRevision: 1, input: FUEL_ROUTE[0] })).toMatchObject({ status: "saved", duplicate: false, meta: { revision: 2 } });
  });

  it.each([
    ["another vehicle of the same owner", fuelStart({ vehicleId: "car-ann-2", createKey: "start-1" })],
    ["different starting evidence", regionStart({ createKey: "start-1" })],
  ])("with the same key for %s fails closed as create_key_conflict", async (_, request) => {
    const t = setup();
    const svc = t.service(() => at(0));
    const first = await svc.startGuidedSession(ANN, fuelStart({ createKey: "start-1" }));
    if (first.status !== "started") throw new Error(JSON.stringify(first));
    expect(await svc.startGuidedSession(ANN, request)).toEqual({ status: "create_key_conflict" });
    expect(t.creates).toEqual(["created", "exists"]);
    expect(await footprint(svc, first.meta.id)).toEqual({ revision: 1, revisions: 1, session: canonicalJson(first.session) });
  });

  it("after the session has moved on is a create_key_conflict, and the recorded evidence is kept", async () => {
    const t = setup();
    const svc = t.service(() => at(0));
    const first = await svc.startGuidedSession(ANN, fuelStart({ createKey: "start-1" }));
    if (first.status !== "started") throw new Error(JSON.stringify(first));
    expect(await svc.submitGuidedStep(ANN, { sessionId: first.meta.id, expectedRevision: 1, input: FUEL_ROUTE[0] })).toMatchObject({ status: "saved" });
    const before = await footprint(svc, first.meta.id);
    expect(await svc.startGuidedSession(ANN, fuelStart({ createKey: "start-1" }))).toEqual({ status: "create_key_conflict" });
    expect(await footprint(svc, first.meta.id)).toEqual(before);
    expect(before.revision).toBe(2);
    expect(t.creates).toEqual(["created", "exists"]);
  });

  it("uses a key that belongs to its owner: another owner's same key starts their own session and changes nothing of ann's", async () => {
    const t = setup();
    const svc = t.service(() => at(0));
    const ann = await svc.startGuidedSession(ANN, fuelStart({ createKey: "start-1" }));
    const bob = await svc.startGuidedSession(BOB, fuelStart({ vehicleId: "car-bob", createKey: "start-1" }));
    if (ann.status !== "started" || bob.status !== "started") throw new Error(JSON.stringify([ann, bob]));
    expect(bob.duplicate).toBe(false);
    expect(bob.meta.id).not.toBe(ann.meta.id);
    expect(bob.meta.vehicleId).toBe("car-bob");
    expect(t.creates).toEqual(["created", "created"]);
    expect(await svc.loadGuidedSession(BOB, ann.meta.id)).toEqual({ status: "not_found" });
    expect(await footprint(svc, ann.meta.id)).toEqual({ revision: 1, revisions: 1, session: canonicalJson(ann.session) });
  });
});

/* ───────────────────────── retried submit ───────────────────────── */

describe("V2I service: a retried submission", () => {
  it("repeated after it went through is a conflict on the revision it moved to, and writes nothing twice", async () => {
    const t = setup();
    // One fixed time: the retry would produce exactly the same session, and is still refused by the revision guard.
    const svc = t.service(() => at(0));
    const { id } = await atRevisionTwo(svc);
    const request: SubmitRequest = { sessionId: id, expectedRevision: 2, input: FUEL_ROUTE[1] };
    const first = await svc.submitGuidedStep(ANN, request);
    expect(first).toMatchObject({ status: "saved", duplicate: false, meta: { revision: 3, workflowId: W.id, workflowVersion: W.version } });
    const after = await footprint(svc, id);
    const writes = [...t.updates];

    for (const retry of [svc, t.service(() => at(0)), t.service(() => at(1))]) {
      expect(await retry.submitGuidedStep(ANN, request)).toEqual({ status: "conflict", currentRevision: 3 });
    }
    expect(t.updates).toEqual(writes);
    expect(await footprint(svc, id)).toEqual(after);
    expect(after).toMatchObject({ revision: 3, revisions: 3 });
  });

  it("repeated as the same AI proposal after it went through is a conflict too, and writes nothing twice", async () => {
    const t = setup();
    const svc = t.service(() => at(0));
    const { id, loaded } = await atRevisionTwo(svc);
    const proposal = await parseStepInput(createKeywordParser(), loaded.workflow, loaded.session, "no, the light was not flashing", SPECS);
    expect(proposal.status).toBe("valid");
    expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: 2, proposal })).toMatchObject({ status: "saved", duplicate: false, meta: { revision: 3 } });
    const after = await footprint(svc, id);
    const writes = [...t.updates];
    expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: 2, proposal })).toEqual({ status: "conflict", currentRevision: 3 });
    expect(t.updates).toEqual(writes);
    expect(await footprint(svc, id)).toEqual(after);
  });

  it.each([
    ["typed", "input"],
    ["AI-parsed", "proposal"],
  ] as const)("that loses the race to exactly the same %s save is that save: duplicate, one revision", async (_, kind) => {
    const t = setup();
    const { id, loaded } = await atRevisionTwo(t.service(() => at(0)));
    const proposal = await parseStepInput(createKeywordParser(), loaded.workflow, loaded.session, "no, the light was not flashing", SPECS);
    expect(proposal.status).toBe("valid");
    const request: SubmitRequest = kind === "input" ? { sessionId: id, expectedRevision: 2, input: FUEL_ROUTE[1] } : { sessionId: id, expectedRevision: 2, proposal };

    // Two requests for the same answer, handled at the same time; the other one reaches the database first.
    const won = t.beforeNextUpdate(() => t.service(() => at(5)).submitGuidedStep(ANN, request));
    const loser = await t.service(() => at(5)).submitGuidedStep(ANN, request);
    const winner = await won;

    if (winner.status !== "saved" || loser.status !== "saved") throw new Error(JSON.stringify([winner, loser]));
    expect(winner.duplicate).toBe(false);
    expect(loser.duplicate).toBe(true);
    expect(loser.meta).toEqual(winner.meta);
    expect(loser.meta).toMatchObject({ revision: 3, workflowId: W.id, workflowVersion: W.version });
    expect(canonicalJson(loser.session)).toBe(canonicalJson(winner.session));
    // The loser's update reached the repository and was refused: one write.
    expect(t.updates).toEqual(["updated", "updated", "conflict"]);
    const svc = t.service(() => at(9));
    expect(await footprint(svc, id)).toEqual({ revision: 3, revisions: 3, session: canonicalJson(winner.session) });
    const h = await svc.guidedSessionHistory(ANN, id);
    expect(h.status === "found" && h.history.revisions[2]).toMatchObject({ stepId: "flashing_light", inputOrigin: kind === "input" ? "direct" : "ai_parser" });
  });

  it("that loses the race to the same answer given at another time is a conflict, and the winner's evidence is kept", async () => {
    const t = setup();
    const { id } = await atRevisionTwo(t.service(() => at(0)));
    const won = t.beforeNextUpdate(() => t.service(() => at(6)).submitGuidedStep(ANN, { sessionId: id, expectedRevision: 2, input: FUEL_ROUTE[1] }));
    const loser = await t.service(() => at(5)).submitGuidedStep(ANN, { sessionId: id, expectedRevision: 2, input: FUEL_ROUTE[1] });
    const winner = await won;

    expect(loser).toEqual({ status: "conflict", currentRevision: 3 });
    if (winner.status !== "saved") throw new Error(JSON.stringify(winner));
    expect(t.updates).toEqual(["updated", "updated", "conflict"]);
    const svc = t.service(() => at(9));
    expect(await footprint(svc, id)).toEqual({ revision: 3, revisions: 3, session: canonicalJson(winner.session) });
    const now = await svc.loadGuidedSession(ANN, id);
    if (now.status !== "loaded") throw new Error(JSON.stringify(now));
    expect(now.session.inputs).toHaveLength(2);
    expect(now.session.inputs[1]).toMatchObject({ nodeId: "flashing_light", at: at(6) });
    expect(now.meta).toMatchObject({ workflowId: W.id, workflowVersion: W.version });
  });

  it("that loses the race to a different answer is a conflict, and the winner's evidence is kept", async () => {
    const t = setup();
    const svc = t.service(() => at(0));
    const started = await svc.startGuidedSession(ANN, regionStart());
    if (started.status !== "started") throw new Error(JSON.stringify(started));
    const id = started.meta.id;
    for (const [i, input] of TO_REGION.slice(0, 2).entries()) {
      expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: i + 1, input })).toMatchObject({ status: "saved" });
    }
    const asked = await svc.loadGuidedSession(ANN, id);
    expect(asked.status === "loaded" && asked.session.currentNodeId).toBe("ask_pattern");

    const helpMeTest: StepInput = TO_REGION[2];
    const several: StepInput = { nodeId: "ask_pattern", kind: "choice", choice: "several" };
    const won = t.beforeNextUpdate(() => t.service(() => at(5)).submitGuidedStep(ANN, { sessionId: id, expectedRevision: 3, input: helpMeTest }));
    const loser = await t.service(() => at(5)).submitGuidedStep(ANN, { sessionId: id, expectedRevision: 3, input: several });
    const winner = await won;

    expect(loser).toEqual({ status: "conflict", currentRevision: 4 });
    if (winner.status !== "saved") throw new Error(JSON.stringify(winner));
    expect(winner.meta.lifecycle).toBe("active");
    expect(t.updates).toEqual(["updated", "updated", "updated", "conflict"]);
    expect(await footprint(svc, id)).toEqual({ revision: 4, revisions: 4, session: canonicalJson(winner.session) });
    const now = await svc.loadGuidedSession(ANN, id);
    if (now.status !== "loaded") throw new Error(JSON.stringify(now));
    expect(now.session.inputs.map((i) => i.nodeId)).toEqual(["confirm_symptom", "flashing_light", "ask_pattern"]);
    expect(now.session.inputs[2]).toMatchObject({ choice: "help_me_test" });
    expect(now.session.currentNodeId).toBe("region_secure");
    expect(now.meta).toMatchObject({ workflowId: W.id, workflowVersion: W.version });
  });

  it("that loses the race to the same answer with a different provenance is a conflict, not a duplicate: only the winner's provenance is recorded", async () => {
    const t = setup();
    const { id, loaded } = await atRevisionTwo(t.service(() => at(0)));
    // The same flashing_light answer, one typed and one AI-parsed: identical session payload, different provenance.
    const proposal = await parseStepInput(createKeywordParser(), loaded.workflow, loaded.session, "no, the light was not flashing", SPECS);
    expect(proposal.status).toBe("valid");
    const typed: SubmitRequest = { sessionId: id, expectedRevision: 2, input: FUEL_ROUTE[1] };
    const parsed: SubmitRequest = { sessionId: id, expectedRevision: 2, proposal };

    // The typed save wins; the AI-parsed save reaches the repository just after and loses the race.
    const won = t.beforeNextUpdate(() => t.service(() => at(5)).submitGuidedStep(ANN, typed));
    const loser = await t.service(() => at(5)).submitGuidedStep(ANN, parsed);
    const winner = await won;

    if (winner.status !== "saved") throw new Error(JSON.stringify(winner));
    expect(winner.duplicate).toBe(false);
    // A different provenance is not "the same save": the loser is a conflict, never a duplicate.
    expect(loser).toEqual({ status: "conflict", currentRevision: 3 });
    expect(t.updates).toEqual(["updated", "updated", "conflict"]);
    const svc = t.service(() => at(9));
    expect(await footprint(svc, id)).toEqual({ revision: 3, revisions: 3, session: canonicalJson(winner.session) });
    // History keeps only the winner's origin; the losing AI attempt's text hash is never persisted.
    const h = await svc.guidedSessionHistory(ANN, id);
    expect(h.status === "found" && h.history.revisions[2]).toMatchObject({ stepId: "flashing_light", inputOrigin: "direct", aiTextRef: null });
  });

  it("that loses the race to the same answer parsed from different AI text is a conflict, not a duplicate: only the winner's text hash is recorded", async () => {
    const t = setup();
    const { id, loaded } = await atRevisionTwo(t.service(() => at(0)));
    // Two AI proposals from different source texts that yield the SAME flashing_light answer: identical
    // session payload, different audit text-hashes. Text hash is part of the recorded save identity.
    const winnerProposal = await parseStepInput(createKeywordParser(), loaded.workflow, loaded.session, "no, the light was not flashing", SPECS);
    const loserProposal = await parseStepInput(createKeywordParser(), loaded.workflow, loaded.session, "nope, no flashing seen", SPECS);
    if (winnerProposal.status !== "valid" || loserProposal.status !== "valid") throw new Error("both proposals must be valid");
    expect(winnerProposal.audit.textRef.hash).not.toBe(loserProposal.audit.textRef.hash);

    const won = t.beforeNextUpdate(() => t.service(() => at(5)).submitGuidedStep(ANN, { sessionId: id, expectedRevision: 2, proposal: winnerProposal }));
    const loser = await t.service(() => at(5)).submitGuidedStep(ANN, { sessionId: id, expectedRevision: 2, proposal: loserProposal });
    const winner = await won;

    if (winner.status !== "saved") throw new Error(JSON.stringify(winner));
    expect(winner.duplicate).toBe(false);
    // Different AI text is not "the same save", even though the diagnostic payload is identical.
    expect(loser).toEqual({ status: "conflict", currentRevision: 3 });
    expect(t.updates).toEqual(["updated", "updated", "conflict"]);
    const svc = t.service(() => at(9));
    expect(await footprint(svc, id)).toEqual({ revision: 3, revisions: 3, session: canonicalJson(winner.session) });
    // History keeps the winner's exact text hash; the loser's is never persisted, and neither raw text ever is.
    const h = await svc.guidedSessionHistory(ANN, id);
    expect(h.status === "found" && h.history.revisions[2]).toMatchObject({ stepId: "flashing_light", inputOrigin: "ai_parser", aiTextRef: winnerProposal.audit.textRef.hash });
  });

  it("that loses the race to a winning save which completes the session is a conflict, not immutable", async () => {
    const t = setup();
    const { id } = await atRevisionTwo(t.service(() => at(0)));
    // The winner answers flashing_light = yes, which completes the session; the loser's different
    // answer reaches the repository just after. Its primary failure is stale revision, so: conflict.
    const completing: SubmitRequest = { sessionId: id, expectedRevision: 2, input: { nodeId: "flashing_light", kind: "yes_no", answer: "yes" } };
    const other: SubmitRequest = { sessionId: id, expectedRevision: 2, input: FUEL_ROUTE[1] };
    const won = t.beforeNextUpdate(() => t.service(() => at(5)).submitGuidedStep(ANN, completing));
    const loser = await t.service(() => at(5)).submitGuidedStep(ANN, other);
    const winner = await won;

    if (winner.status !== "saved") throw new Error(JSON.stringify(winner));
    expect(winner.meta.lifecycle).toBe("completed");
    expect(loser).toEqual({ status: "conflict", currentRevision: 3 });
    expect(t.updates).toEqual(["updated", "updated", "conflict"]);
    const svc = t.service(() => at(9));
    expect(await footprint(svc, id)).toEqual({ revision: 3, revisions: 3, session: canonicalJson(winner.session) });
  });
});
