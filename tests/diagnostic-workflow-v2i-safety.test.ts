/**
 * Guided Diagnostics V2I: service-boundary safety regressions.
 *
 * What the service itself must guarantee, through its public API only:
 * - a session keeps the specifications it pinned, whatever specification
 *   source a later service instance is given (none, changed, unverified,
 *   failing), and that source is never asked again;
 * - with no verified source (the service default) a reading never drives
 *   pass/fail or a cause;
 * - the revision guard runs first: a malformed or stale expectedRevision is
 *   answered before the engine, the bridge or completion, and records nothing;
 * - evidence time is the server's clock, never the caller's.
 *
 * Everything here is SYNTHETIC / TEST ONLY / NOT OEM DATA.
 */
import { describe, expect, it } from "vitest";
import { startSession, submitStep, type DiagnosticSpecification, type EngineOptions, type SpecificationProvider, type StepInput } from "../app/lib/diagnostic-workflow";
import { createInMemorySpecificationProvider } from "../app/lib/diagnostic-workflow/examples/in-memory-specification-provider";
import { SYNTHETIC_SPECIFICATIONS } from "../app/lib/diagnostic-workflow/examples/synthetic-specifications";
import { parseStepInput } from "../app/lib/diagnostic-workflow-bridge";
import { createKeywordParser } from "../app/lib/diagnostic-workflow-bridge/examples/fake-adapters";
import { canonicalJson, createInMemorySessionRepository } from "../app/lib/diagnostic-workflow-persistence";
import { createGuidedDiagnosticsService, createInMemoryVehicleDirectory, type GuidedDiagnosticsService, type GuidedDiagnosticsServiceOptions } from "../app/lib/diagnostic-workflow-service";
import { ANN, CATALOG, GARAGE_CAR, SYNTHETIC_FOR_TESTS, fuelStart, reference } from "./helpers/guided-service-contract";
import { FUEL_ROUTE, FUEL_VERIFIED, SPECS, W, at } from "./helpers/persisted-sessions";

const GARAGE = { "car-ann": { ownerId: "ann", context: GARAGE_CAR } };
const FUEL_SPEC = "synthetic.fuel_supply_pressure_idle";
/** Up to and including the pump test: entering fuel_pressure pins its specification. */
const TO_FUEL_PRESSURE = FUEL_ROUTE.slice(0, 4);
const READING = FUEL_ROUTE[4];

/** A clock that starts at minute `from`: a later service instance carries on where the first stopped. */
const clockFrom = (from: number) => {
  let minute = from;
  return () => at(minute++);
};

function serviceOn(repository: ReturnType<typeof createInMemorySessionRepository>, over: Partial<GuidedDiagnosticsServiceOptions> = {}): GuidedDiagnosticsService {
  let ids = 0;
  return createGuidedDiagnosticsService({
    catalog: CATALOG,
    repository,
    vehicles: createInMemoryVehicleDirectory(GARAGE),
    contentPolicy: SYNTHETIC_FOR_TESTS,
    clock: clockFrom(0),
    newId: () => `v2i-safety-${++ids}`,
    ...over,
  });
}

/** Start and submit each input at the current revision; fail the test on anything but saved. */
async function drive(svc: GuidedDiagnosticsService, inputs: StepInput[], sessionId?: string) {
  let id = sessionId;
  if (!id) {
    const started = await svc.startGuidedSession(ANN, fuelStart());
    if (started.status !== "started") throw new Error(`start: ${JSON.stringify(started)}`);
    id = started.meta.id;
  }
  for (const input of inputs) {
    const loaded = await svc.loadGuidedSession(ANN, id);
    if (loaded.status !== "loaded") throw new Error(`load: ${JSON.stringify(loaded)}`);
    const saved = await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: loaded.meta.revision, input });
    if (saved.status !== "saved") throw new Error(`${input.nodeId}: ${JSON.stringify(saved)}`);
  }
  const final = await svc.loadGuidedSession(ANN, id);
  if (final.status !== "loaded") throw new Error(`final: ${JSON.stringify(final)}`);
  return { id, final };
}

/** Revision and history length: what "recorded nothing" is checked against. */
async function footprint(svc: GuidedDiagnosticsService, id: string) {
  const loaded = await svc.loadGuidedSession(ANN, id);
  const history = await svc.guidedSessionHistory(ANN, id);
  if (loaded.status !== "loaded" || history.status !== "found") throw new Error("footprint");
  return { revision: loaded.meta.revision, revisions: history.history.revisions.length, session: canonicalJson(loaded.session) };
}

/** A provider that counts every lookup, answering from `records`. */
function countingProvider(records: readonly DiagnosticSpecification[], simulate: Parameters<typeof createInMemorySpecificationProvider>[1] = {}) {
  const inner = createInMemorySpecificationProvider(records, simulate);
  const calls: string[] = [];
  const provider: SpecificationProvider = {
    resolve(query) {
      calls.push(query.id);
      return inner.resolve(query);
    },
  };
  return { provider, calls };
}

const withFuelSpec = (change: (s: DiagnosticSpecification) => DiagnosticSpecification) => SYNTHETIC_SPECIFICATIONS.map((s) => (s.id === FUEL_SPEC ? change(structuredClone(s)) : s));

/* ───────────────────────── pinned specifications ───────────────────────── */

describe("V2I service: a session keeps the specification it pinned", () => {
  const LATER_SOURCES: Array<[string, () => { provider?: SpecificationProvider; calls: string[] }]> = [
    ["no specification source (the service default)", () => ({ calls: [] })],
    // Today's verified value would put 200 kPa WITHIN range and rule fuel supply out.
    ["a verified source whose values have changed", () => countingProvider(withFuelSpec((s) => ({ ...s, revision: "SYNTHETIC-TEST-ONLY-r2", expected: { min: 100, max: 250 } })))],
    ["a source that now has it only unverified", () => countingProvider(withFuelSpec((s) => ({ ...s, trust: "reference" })))],
    ["a source that no longer has it", () => countingProvider(SYNTHETIC_SPECIFICATIONS.filter((s) => s.id !== FUEL_SPEC))],
    ["a source that fails on every lookup", () => countingProvider(SYNTHETIC_SPECIFICATIONS, { throwFor: SYNTHETIC_SPECIFICATIONS.map((s) => s.id) })],
  ];

  it.each(LATER_SOURCES)("judges the reading and the repair re-test against the pinned value when reopened with %s", async (_, later) => {
    const repository = createInMemorySessionRepository({ vehicles: { "car-ann": "ann" } });
    const first = serviceOn(repository, { specifications: SPECS.specifications });
    const { id, final: pinned } = await drive(first, TO_FUEL_PRESSURE);
    // Pinned by the first instance, from the verified synthetic source.
    expect(pinned.session.currentNodeId).toBe("fuel_pressure");
    expect(pinned.session.specifications[FUEL_SPEC]).toMatchObject({ status: "verified", specification: { revision: "SYNTHETIC-TEST-ONLY-r1", expected: { min: 300, max: 450 } } });

    // A new service instance (another request, another deploy) with a different specification source.
    const { provider, calls } = later();
    const second = serviceOn(repository, { clock: clockFrom(TO_FUEL_PRESSURE.length + 1), ...(provider && { specifications: provider }) });
    const { final } = await drive(second, [READING, FUEL_VERIFIED], id);

    // Exactly what the engine reaches on its own with the original source: 200 kPa is LOW, fuel supply found, repair verified.
    const ref = reference(fuelStart(), [...FUEL_ROUTE, FUEL_VERIFIED]);
    expect(canonicalJson(final.session)).toBe(canonicalJson(ref));
    const reading = final.session.evidence.find((e) => e.nodeId === "fuel_pressure" && e.kind === "measurement");
    expect(reading).toMatchObject({
      to: "concl_fuel_supply",
      judgement: { evaluated: true, range: "below_min", relation: "below", specification: { revision: "SYNTHETIC-TEST-ONLY-r1", status: "verified", expected: { min: 300, max: 450 } } },
    });
    expect(final.session.supportedCauses).toContain("fuel_supply");
    expect(final.session.endResult).toBe(ref.endResult);
    expect(final.meta.lifecycle).toBe("completed");
    // Pinned once, at the start of the step: one specification record, and today's source is never consulted.
    expect(final.session.evidence.filter((e) => e.kind === "specification")).toHaveLength(1);
    expect(calls).toEqual([]);
  });
});

/* ───────────────────────── no verified source ───────────────────────── */

describe("V2I service: without a verified specification a reading decides nothing", () => {
  it("by default (no source) skips the judged step to a professional and accepts no reading for it afterwards", async () => {
    const svc = serviceOn(createInMemorySessionRepository({ vehicles: { "car-ann": "ann" } }));
    const { id, final } = await drive(svc, TO_FUEL_PRESSURE);
    expect(final.session.specifications[FUEL_SPEC]).toEqual({ status: "unavailable", reason: "no_provider" });
    expect(final.session.evidence).toContainEqual(expect.objectContaining({ nodeId: "fuel_pressure", kind: "unsupported", unsupportedReason: "spec_unavailable" }));
    expect(final.session.evidence.some((e) => e.nodeId === "fuel_pressure" && e.kind === "measurement")).toBe(false);
    expect(final.session.supportedCauses).not.toContain("fuel_supply");
    expect(final.session.currentNodeId).not.toBe("fuel_pressure");
    // The same as the engine alone with no source.
    const facts = { vehicle: { ...GARAGE_CAR, ...fuelStart().vehicleDetails }, capabilities: fuelStart().capabilities, scans: fuelStart().scans, symptoms: [] };
    const none: EngineOptions = {};
    const engineOnly = TO_FUEL_PRESSURE.reduce((s, input, i) => {
      const r = submitStep(W, s, input, at(i + 1), none);
      if (!r.ok) throw new Error(r.error);
      return r.session;
    }, (startSession(W, facts, at(0), none) as Extract<ReturnType<typeof startSession>, { ok: true }>).session);
    expect(canonicalJson(final.session)).toBe(canonicalJson(engineOnly));

    // Referred to a professional, not to fuel supply; a reading for the skipped step cannot be slipped in afterwards.
    expect(final.meta.lifecycle).toBe("completed");
    expect(final.session.evidence.some((e) => e.nodeId === "concl_fuel_supply")).toBe(false);
    const before = await footprint(svc, id);
    expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: before.revision, input: READING })).toEqual({ status: "immutable" });
    expect(await footprint(svc, id)).toEqual(before);
  });

  it("with only an unverified source records the reading unjudged: no outcome, no cause", async () => {
    const referenceOnly = createInMemorySpecificationProvider(withFuelSpec((s) => ({ ...s, trust: "reference" })));
    const svc = serviceOn(createInMemorySessionRepository({ vehicles: { "car-ann": "ann" } }), { specifications: referenceOnly });
    const { final } = await drive(svc, [...TO_FUEL_PRESSURE, READING]);
    expect(final.session.specifications[FUEL_SPEC]).toMatchObject({ status: "informational" });
    const reading = final.session.evidence.find((e) => e.nodeId === "fuel_pressure" && e.kind === "measurement");
    expect(reading).toMatchObject({ measured: { value: 200, unit: "kPa" }, judgement: { evaluated: false, reason: "untrusted_spec", specification: { status: "informational" } } });
    expect(final.session.supportedCauses).not.toContain("fuel_supply");
    expect(final.session.remainingCauses).toContain("fuel_supply");
    expect(final.session.currentNodeId).not.toBe("verify_fuel_repair");
  });
});

/* ───────────────────────── revision guard ───────────────────────── */

describe("V2I service: the revision guard runs first and records nothing", () => {
  const MALFORMED: unknown[] = [undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2", [2], { revision: 2 }];

  it.each(MALFORMED.map((v) => [String(JSON.stringify(v) ?? v), v]))("refuses expectedRevision %s for typed and AI-parsed input alike", async (_, bad) => {
    const svc = serviceOn(createInMemorySessionRepository({ vehicles: { "car-ann": "ann" } }), { specifications: SPECS.specifications });
    const { id, final } = await drive(svc, FUEL_ROUTE.slice(0, 1));
    const proposal = await parseStepInput(createKeywordParser(), final.workflow, final.session, "no, the light was not flashing", SPECS);
    expect(proposal.status).toBe("valid");
    const before = await footprint(svc, id);
    const refused = { status: "invalid_transition", reason: "expectedRevision is required" };
    expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: bad as number, input: FUEL_ROUTE[1] })).toEqual(refused);
    expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: bad as number, proposal })).toEqual(refused);
    expect(await footprint(svc, id)).toEqual(before);
  });

  it("answers a stale or future revision with conflict before the bridge, the engine or completion see it", async () => {
    const svc = serviceOn(createInMemorySessionRepository({ vehicles: { "car-ann": "ann" } }), { specifications: SPECS.specifications });
    const { id, final } = await drive(svc, FUEL_ROUTE.slice(0, 2));
    expect(final.meta.revision).toBe(3);
    const before = await footprint(svc, id);

    // A proposal that is valid for the CURRENT state is still not applied under a revision the caller did not see.
    const proposal = await parseStepInput(createKeywordParser(), final.workflow, final.session, "nothing found", SPECS);
    expect(proposal.status).toBe("valid");
    for (const expectedRevision of [1, 2, 4, 99]) {
      expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision, proposal })).toEqual({ status: "conflict", currentRevision: 3 });
      expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision, input: FUEL_ROUTE[2] })).toEqual({ status: "conflict", currentRevision: 3 });
      // An input the engine would refuse is a conflict too: the engine is never asked about a state the caller did not see.
      expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision, input: FUEL_ROUTE[0] })).toEqual({ status: "conflict", currentRevision: 3 });
    }
    expect(await footprint(svc, id)).toEqual(before);
    // The same proposal at the current revision is accepted: it was refused only for the revision.
    expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: 3, proposal })).toMatchObject({ status: "saved", meta: { revision: 4 } });
  });

  it("keeps a completed session immutable: stale revisions conflict, current ones are refused, typed or AI-parsed", async () => {
    const svc = serviceOn(createInMemorySessionRepository({ vehicles: { "car-ann": "ann" } }), { specifications: SPECS.specifications });
    const { id, final } = await drive(svc, [...FUEL_ROUTE, FUEL_VERIFIED]);
    expect(final.meta.lifecycle).toBe("completed");
    const current = final.meta.revision;
    const before = await footprint(svc, id);
    // A proposal parsed while the session was still open, for a step it has long left.
    const early = await drive(serviceOn(createInMemorySessionRepository({ vehicles: { "car-ann": "ann" } }), { specifications: SPECS.specifications }), []);
    const proposal = await parseStepInput(createKeywordParser(), early.final.workflow, early.final.session, "yes it was shaking", SPECS);
    expect(proposal.status).toBe("valid");

    expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: current - 1, input: FUEL_VERIFIED })).toEqual({ status: "conflict", currentRevision: current });
    expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: current, input: FUEL_VERIFIED })).toEqual({ status: "immutable" });
    expect(await svc.submitGuidedStep(ANN, { sessionId: id, expectedRevision: current, proposal })).toEqual({ status: "immutable" });
    expect(await footprint(svc, id)).toEqual(before);
  });
});

/* ───────────────────────── evidence time ───────────────────────── */

describe("V2I service: evidence carries the server's time", () => {
  it("stamps start and every input with the service clock, even when the caller supplies a time", async () => {
    const svc = serviceOn(createInMemorySessionRepository({ vehicles: { "car-ann": "ann" } }), { specifications: SPECS.specifications });
    // StepInput has no `at`; a caller can still send one at runtime. Model that extra field
    // explicitly so it reaches the service unchanged.
    const forged: StepInput & { at: string } = { ...FUEL_ROUTE[0], at: "1999-01-01T00:00:00Z" };
    expect(forged.at).toBe("1999-01-01T00:00:00Z");
    const { final } = await drive(svc, [forged]);
    expect(final.session.inputs).toHaveLength(1);
    expect(final.session.inputs[0]).toMatchObject({ nodeId: "confirm_symptom", at: at(1) });
    const stamps = final.session.evidence.map((e) => e.at);
    expect(stamps.every((t) => t === at(0) || t === at(1))).toBe(true);
    expect(JSON.stringify(final.session)).not.toContain("1999-01-01");
    // Identical to the engine given the plain input at the server's times.
    expect(canonicalJson(final.session)).toBe(canonicalJson(reference(fuelStart(), FUEL_ROUTE.slice(0, 1))));
  });
});
