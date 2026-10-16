/**
 * Guided Diagnostics V2B: specifications live outside workflows and are
 * resolved through a SpecificationProvider.
 *
 * Research prototype. No network, no database, no AI. Every specification
 * here is SYNTHETIC / TEST ONLY: not data for any vehicle or manufacturer.
 */
import { describe, expect, it } from "vitest";
import { withCodes, type TypedCodes } from "./helpers/workflow-scans";
import {
  replaySession,
  resolveSpecification,
  resumeSession,
  sessionOutcome,
  specificationDrift,
  startSession,
  submitStep,
  validateWorkflow,
  type DiagnosticCapabilityContext,
  type DiagnosticSession,
  type DiagnosticSpecification,
  type EngineOptions,
  type SessionStartFacts,
  type SpecificationProvider,
  type StepInput,
  type WorkflowDefinition,
} from "../app/lib/diagnostic-workflow";
import { SYNTHETIC_MISFIRE_WORKFLOW as W } from "../app/lib/diagnostic-workflow/examples/synthetic-misfire";
import { SYNTHETIC_SPECIFICATIONS } from "../app/lib/diagnostic-workflow/examples/synthetic-specifications";
import { createInMemorySpecificationProvider as provider } from "../app/lib/diagnostic-workflow/examples/in-memory-specification-provider";

/** Explicit capabilities (V2C). Live data but no bidirectional control, so actuator tests are skipped. */
const PRO: DiagnosticCapabilityContext = { skill: "professional", scanAccess: "live_data", instruments: ["hand_tools", "compression_tester", "pressure_gauge"], facilities: [] };
/** A synthetic vehicle the synthetic misfire workflow applies to. Not a real vehicle. */
const SYNTHETIC_VEHICLE = { fuel: "gasoline" as const, cylinders: 4 };
const facts = (over: Partial<SessionStartFacts> & TypedCodes = {}): SessionStartFacts => withCodes({ capabilities: PRO, vehicle: SYNTHETIC_VEHICLE, ...over });
const FUEL = SYNTHETIC_SPECIFICATIONS.find((r) => r.id === "synthetic.fuel_supply_pressure_idle")!;
const COMPRESSION = SYNTHETIC_SPECIFICATIONS.find((r) => r.id === "synthetic.cylinder_compression_min")!;
const SYNTHETIC: EngineOptions = { specifications: provider(SYNTHETIC_SPECIFICATIONS) };
const withFuel = (...records: DiagnosticSpecification[]): EngineOptions => ({ specifications: provider([COMPRESSION, ...records]) });

function ok(r: ReturnType<typeof startSession>): DiagnosticSession {
  if (!r.ok) throw new Error(r.error);
  return r.session;
}
function run(f: SessionStartFacts, inputs: StepInput[], options: EngineOptions = SYNTHETIC, workflow: WorkflowDefinition = W): DiagnosticSession {
  return ok(replaySession(workflow, f, inputs, "2026-10-15T10:00:00Z", options));
}
const yes = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "yes" });
const no = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "no" });
const TO_FUEL: StepInput[] = [yes("confirm_symptom"), no("flashing_light"), { nodeId: "multi_vacuum", kind: "observation", choice: "nothing_found" }];
const fuel = (value: number, unit: "kPa" | "bar" | "psi" = "kPa"): StepInput => ({ nodeId: "fuel_pressure", kind: "measurement", value, unit });
const reading = (s: DiagnosticSession, nodeId = "fuel_pressure") => s.evidence.find((e) => e.nodeId === nodeId && e.kind === "measurement");
const resolution = (s: DiagnosticSession, nodeId = "fuel_pressure") => s.evidence.find((e) => e.nodeId === nodeId && e.kind === "specification");

/* ───────────────────────── the provider contract ───────────────────────── */

describe("V2B: resolving specifications", () => {
  it("resolves one verified match to a frozen copy", () => {
    const r = resolveSpecification(provider([FUEL]), FUEL.id);
    expect(r).toMatchObject({ status: "verified", specification: { id: FUEL.id, revision: "SYNTHETIC-TEST-ONLY-r1", expected: { min: 300, max: 450 } } });
    expect(Object.isFrozen(r.status === "verified" && r.specification.expected)).toBe(true);
  });

  it("resolves an unverified match as informational", () => {
    expect(resolveSpecification(provider([{ ...FUEL, trust: "unverified" }]), FUEL.id)).toMatchObject({ status: "informational", specification: { trust: "unverified" } });
    expect(resolveSpecification(provider([{ ...FUEL, trust: "reference" }]), FUEL.id)).toMatchObject({ status: "informational" });
  });

  it("reports a missing specification as not found", () => {
    expect(resolveSpecification(provider([]), FUEL.id)).toEqual({ status: "not_found" });
  });

  it("reports several candidates as ambiguous and never picks one", () => {
    const r = resolveSpecification(provider([FUEL, { ...FUEL, revision: "SYNTHETIC-TEST-ONLY-r2", expected: { min: 250, max: 400 } }]), FUEL.id);
    expect(r.status).toBe("ambiguous");
    expect(r.status === "ambiguous" && r.candidates.map((c) => c.revision)).toEqual(["SYNTHETIC-TEST-ONLY-r1", "SYNTHETIC-TEST-ONLY-r2"]);
  });

  it("turns a failing, absent or misbehaving provider into an honest 'unavailable'", () => {
    expect(resolveSpecification(provider([FUEL], { throwFor: [FUEL.id] }), FUEL.id)).toEqual({ status: "unavailable", reason: "provider_error" });
    expect(resolveSpecification(provider([FUEL], { unavailable: { [FUEL.id]: "offline" } }), FUEL.id)).toEqual({ status: "unavailable", reason: "offline" });
    expect(resolveSpecification(undefined, FUEL.id)).toEqual({ status: "unavailable", reason: "no_provider" });
    const answering = (answer: unknown): SpecificationProvider => ({ resolve: () => answer as never });
    expect(resolveSpecification(answering(42), FUEL.id)).toMatchObject({ status: "unavailable", reason: "invalid_resolution" });
    expect(resolveSpecification(answering({ status: "verified", specification: { ...FUEL, id: "other" } }), FUEL.id)).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/^invalid_specification/) });
    expect(resolveSpecification(answering({ status: "verified", specification: { ...FUEL, expected: {} } }), FUEL.id)).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/^invalid_specification/) });
  });

  it("never upgrades trust: 'verified' for an unverified record is refused", () => {
    const lying: SpecificationProvider = { resolve: () => ({ status: "verified", specification: { ...FUEL, trust: "unverified" } }) };
    expect(resolveSpecification(lying, FUEL.id)).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/^inconsistent_trust/) });
    const s = run(facts({ dtcs: ["P0300"] }), TO_FUEL, { specifications: { resolve: (r) => (r.id === FUEL.id ? lying.resolve(r) : provider([COMPRESSION]).resolve(r)) } });
    expect(s).toMatchObject({ conclusionNodeId: "concl_professional", endResult: "referred" });
    expect(s.remainingCauses).toContain("fuel_supply");
  });
});

/* ───────────────────────── interpretation ───────────────────────── */

describe("V2B: only a usable, verified specification interprets a reading", () => {
  it("a trusted specification drives a pass", () => {
    const s = run(facts({ dtcs: ["P0300"] }), [...TO_FUEL, fuel(380)]);
    expect(reading(s)).toMatchObject({ judgement: { evaluated: true, range: "within", relation: "within" }, to: "concl_professional" });
    expect(s.remainingCauses).not.toContain("fuel_supply");
  });

  it("a trusted specification drives a fail", () => {
    const s = run(facts({ dtcs: ["P0300"] }), [...TO_FUEL, fuel(200)]);
    expect(reading(s)).toMatchObject({ judgement: { evaluated: true, range: "below_min", relation: "below" }, to: "concl_fuel_supply" });
    expect(s.supportedCauses).toEqual(["fuel_supply"]);
  });

  it("an untrusted specification cannot branch", () => {
    const options = withFuel({ ...FUEL, trust: "unverified" });
    const before = run(facts({ dtcs: ["P0300"] }), TO_FUEL, options);
    for (const value of [200, 380]) {
      const s = ok(submitStep(W, before, fuel(value), undefined, options));
      expect(reading(s)).toMatchObject({ judgement: { evaluated: false, reason: "untrusted_spec" }, to: "concl_professional" });
      expect(s.remainingCauses).toEqual(before.remainingCauses);
      expect(s.supportedCauses).toEqual(before.supportedCauses);
    }
  });

  const cannotBranch: Array<[string, EngineOptions, string, RegExp]> = [
    ["a missing specification", withFuel(), "spec_not_found", /^not_found synthetic\.fuel/],
    ["an ambiguous specification", withFuel(FUEL, { ...FUEL, revision: "SYNTHETIC-TEST-ONLY-r2" }), "spec_ambiguous", /^ambiguous synthetic\.fuel.*\(2 candidates\)/],
    ["an unavailable provider", { specifications: provider(SYNTHETIC_SPECIFICATIONS, { throwFor: [FUEL.id] }) }, "spec_unavailable", /^unavailable .*provider_error/],
    ["no provider at all", {}, "spec_unavailable", /no_provider/],
  ];
  for (const [label, options, reason, described] of cannotBranch) {
    it(`${label} cannot branch: the step is not presented and nothing is interpreted`, () => {
      const s = run(facts({ dtcs: ["P0300"] }), TO_FUEL, options);
      expect(resolution(s)).toMatchObject({ kind: "specification", source: "specification_provider", value: expect.stringMatching(described) });
      expect(s.evidence.find((e) => e.nodeId === "fuel_pressure" && e.kind === "unsupported")).toMatchObject({ unsupportedReason: reason, to: "concl_professional" });
      expect(reading(s)).toBeUndefined();
      expect(s).toMatchObject({ conclusionNodeId: "concl_professional", endResult: "referred" });
      expect(s.remainingCauses).toContain("fuel_supply");
      expect(s.supportedCauses).toEqual([]);
    });
  }

  it("keeps ambiguous candidates for display, unpicked", () => {
    const s = run(facts({ dtcs: ["P0300"] }), TO_FUEL, withFuel(FUEL, { ...FUEL, revision: "SYNTHETIC-TEST-ONLY-r2" }));
    expect(s.specifications[FUEL.id]).toMatchObject({ status: "ambiguous", candidates: [{ revision: "SYNTHETIC-TEST-ONLY-r1" }, { revision: "SYNTHETIC-TEST-ONLY-r2" }] });
  });
});

/* ───────────────────────── conditions ───────────────────────── */

describe("V2B: a specification's conditions must be confirmed before a reading is interpreted", () => {
  const TO_COMPRESSION: StepInput[] = [
    yes("confirm_symptom"),
    no("flashing_light"),
    { nodeId: "single_prereq", kind: "prerequisite", met: true },
    no("coil_swap"),
    { nodeId: "plug_inspection", kind: "observation", choice: "normal" },
    { nodeId: "injector_check", kind: "check", result: "pass" },
    { nodeId: "compression_test", kind: "measurement", value: 600, unit: "kPa" },
  ];

  it("preserves the required conditions, with their state, in the judgement", () => {
    const s = run(facts({ dtcs: ["P0301"] }), TO_COMPRESSION);
    expect(reading(s, "compression_test")).toMatchObject({
      judgement: { evaluated: true, range: "below_min", specification: { id: COMPRESSION.id, conditions: [{ id: "engine_off_cool", state: "met" }] } },
    });
  });

  /** A tiny workflow: a prerequisite that establishes "engine_idling", then a reading judged against "test.idle_v". */
  const idle: WorkflowDefinition = {
    id: "test.conditions",
    version: 1,
    title: "Conditions",
    provenance: "SYNTHETIC: test only",
    faultModel: "single_primary_fault",
    conditions: [{ id: "engine_idling", title: "Engine idling" }],
    causes: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
    nodes: [
      { id: "s", type: "start", title: "Start", next: "p" },
      { id: "p", type: "prerequisite", title: "Idling?", ifMet: "m", ifNotMet: "m", establishes: ["engine_idling"] },
      {
        id: "m",
        type: "measurement",
        title: "M",
        measurement: { quantity: "Q", unit: "V", plausible: { min: 0, max: 20 } },
        specification: "test.idle_v",
        outcomes: [
          { id: "low", when: { relativeToSpec: "below" }, to: "e", supports: ["a"], rulesOut: ["b"] },
          { id: "ok", when: { relativeToSpec: "within" }, to: "e", rulesOut: ["a"] },
        ],
        otherwise: "e",
        ifUnsupported: "e",
        ifInconclusive: "e_inc",
      },
      { id: "e", type: "end", title: "End", result: "concluded" },
      { id: "e_inc", type: "end", title: "Inconclusive", result: "inconclusive" },
    ],
  };
  const idleSpec = (conditions: string[]): EngineOptions => ({
    specifications: provider([{ id: "test.idle_v", revision: "SYNTHETIC-r1", unit: "V", expected: { min: 12 }, conditions, source: { name: "SYNTHETIC / TEST ONLY" }, trust: "verified" }]),
  });
  const measure = (met: boolean, conditions: string[]) => run(facts(), [{ nodeId: "p", kind: "prerequisite", met }, { nodeId: "m", kind: "measurement", value: 9, unit: "V" }], idleSpec(conditions), idle);

  it("a confirmed condition lets a trusted specification interpret the reading", () => {
    expect(validateWorkflow(idle)).toEqual({ ok: true });
    expect(measure(true, ["engine_idling"])).toMatchObject({ endResult: "concluded", supportedCauses: ["a"], remainingCauses: ["a"] });
  });

  it("a condition known to be false blocks interpretation", () => {
    const s = measure(false, ["engine_idling"]);
    expect(s.refutedConditions).toEqual(["engine_idling"]);
    expect(reading(s, "m")).toMatchObject({ judgement: { evaluated: false, reason: "condition_not_met", specification: { conditions: [{ id: "engine_idling", state: "not_met" }] } }, to: "e_inc" });
    expect(s).toMatchObject({ endResult: "inconclusive", remainingCauses: ["a", "b"], supportedCauses: [] });
  });

  it("a condition never confirmed (unknown) blocks interpretation", () => {
    const s = measure(true, ["engine_idling", "engine_at_operating_temperature"]);
    expect(reading(s, "m")).toMatchObject({
      judgement: { evaluated: false, reason: "condition_unknown", specification: { conditions: [{ id: "engine_idling", state: "met" }, { id: "engine_at_operating_temperature", state: "unknown" }] } },
    });
    expect(s).toMatchObject({ endResult: "inconclusive", remainingCauses: ["a", "b"] });
  });
});

/* ───────────────────────── units and plausibility ───────────────────────── */

describe("V2B: units and plausible ranges", () => {
  it("converts a specification given in a compatible unit, and keeps the source unit", () => {
    const options = withFuel({ ...FUEL, unit: "bar", expected: { min: 3, max: 4.5 } });
    const s = run(facts({ dtcs: ["P0300"] }), [...TO_FUEL, fuel(200)], options);
    expect(reading(s)).toMatchObject({ judgement: { evaluated: true, relation: "below", specification: { sourceUnit: "bar", expected: { min: 300, max: 450 } } }, to: "concl_fuel_supply" });
    // A reading in psi is converted too: 50 psi is about 345 kPa, within.
    expect(reading(run(facts({ dtcs: ["P0300"] }), [...TO_FUEL, fuel(50, "psi")], options))).toMatchObject({ judgement: { relation: "within" } });
  });

  it("rejects a specification in another kind of unit: it cannot be used at all", () => {
    const s = run(facts({ dtcs: ["P0300"] }), TO_FUEL, withFuel({ ...FUEL, unit: "V", expected: { min: 3 } }));
    expect(s.evidence.find((e) => e.kind === "unsupported" && e.nodeId === "fuel_pressure")).toMatchObject({ unsupportedReason: "spec_incompatible_unit" });
    expect(s).toMatchObject({ conclusionNodeId: "concl_professional" });
    expect(s.remainingCauses).toContain("fuel_supply");
  });

  it("keeps plausibility (refusing a typo) distinct from the expected range (judging a reading)", () => {
    const options = withFuel({ ...FUEL, plausible: { min: 0, max: 700 } });
    const at = run(facts({ dtcs: ["P0300"] }), TO_FUEL, options);
    // Outside the verified specification's plausible range: refused as a reading error, nothing recorded.
    expect(submitStep(W, at, fuel(800), undefined, options)).toEqual({ ok: false, error: expect.stringMatching(/^implausible_measurement: .*this specification's plausible/) });
    // Plausible but above the expected range: a valid reading, judged "above" (no range for it, so "otherwise").
    const above = ok(submitStep(W, at, fuel(600), undefined, options));
    expect(reading(above)).toMatchObject({ judgement: { evaluated: true, relation: "above", range: "otherwise" } });
    // An unverified specification's plausible range is information only: it refuses nothing.
    const informational = withFuel({ ...FUEL, trust: "unverified", plausible: { min: 0, max: 700 } });
    const atInfo = run(facts({ dtcs: ["P0300"] }), TO_FUEL, informational);
    expect(reading(ok(submitStep(W, atInfo, fuel(800), undefined, informational)))).toMatchObject({ judgement: { evaluated: false, reason: "untrusted_spec" } });
  });
});

/* ───────────────────────── replay and history ───────────────────────── */

describe("V2B: replay and history", () => {
  const f = facts({ dtcs: ["P0300"] });
  const completed = () => {
    const s = run(f, [...TO_FUEL, fuel(280)]);
    return ok(submitStep(W, s, { nodeId: "verify_fuel_repair", kind: "verification", results: [{ criterion: "pressure_ok", value: 380, unit: "kPa" }, { criterion: "smooth", result: "met" }] }, undefined, SYNTHETIC));
  };
  const LATER = withFuel({ ...FUEL, revision: "SYNTHETIC-TEST-ONLY-r2", expected: { min: 250, max: 450 } });

  it("replays deterministically", () => {
    const live = run(f, [...TO_FUEL, fuel(280)]);
    expect(JSON.stringify(run(f, live.inputs as StepInput[]))).toBe(JSON.stringify(live));
    expect(JSON.stringify(run(f, live.inputs as StepInput[]))).toBe(JSON.stringify(live));
  });

  it("records the exact specification revision a judgement used", () => {
    const s = completed();
    expect(resolution(s)).toMatchObject({ value: "verified synthetic.fuel_supply_pressure_idle@SYNTHETIC-TEST-ONLY-r1" });
    expect(reading(s)).toMatchObject({ judgement: { specification: { revision: "SYNTHETIC-TEST-ONLY-r1" } } });
  });

  it("does not let a later provider change rewrite a completed judgement, and reports the change explicitly", () => {
    const saved = JSON.parse(JSON.stringify(completed()));
    expect(saved).toMatchObject({ conclusionNodeId: "concl_fuel_supply", endResult: "resolved" });
    // Resume replays against what the session pinned, not the provider's new data: same history.
    const resumed = resumeSession(W, saved);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(sessionOutcome(resumed.session)).toEqual(sessionOutcome(saved));
    // The change is surfaced, never applied.
    expect(specificationDrift(saved, LATER.specifications)).toMatchObject([
      { id: FUEL.id, recorded: { specification: { revision: "SYNTHETIC-TEST-ONLY-r1" } }, current: { specification: { revision: "SYNTHETIC-TEST-ONLY-r2" } } },
    ]);
    expect(specificationDrift(saved, SYNTHETIC.specifications)).toEqual([]);
    // Only an explicit new run uses the new data (280 kPa is now within).
    expect(reading(run(f, [...TO_FUEL, fuel(280)], LATER))).toMatchObject({ judgement: { relation: "within" } });
  });

  it("refuses a saved session whose pinned specification was edited", () => {
    const saved = JSON.parse(JSON.stringify(completed()));
    saved.specifications[FUEL.id].specification.expected.min = 250;
    expect(resumeSession(W, saved)).toMatchObject({ ok: false, error: expect.stringMatching(/^invalid_session/) });
  });

  it("an in-progress session keeps judging against its pinned specification after the provider changes", () => {
    const halfway = JSON.parse(JSON.stringify(run(f, [...TO_FUEL, fuel(280)])));
    const resumed = resumeSession(W, halfway);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    // The re-test uses r1 (min 300), not the provider's later r2 (min 250): 280 kPa is still low.
    const s = ok(submitStep(W, resumed.session, { nodeId: "verify_fuel_repair", kind: "verification", results: [{ criterion: "pressure_ok", value: 280, unit: "kPa" }, { criterion: "smooth", result: "met" }] }, undefined, LATER));
    expect(s.evidence.find((e) => e.criterion === "pressure_ok")).toMatchObject({ value: "not_met (280 kPa)", judgement: { specification: { revision: "SYNTHETIC-TEST-ONLY-r1" } } });
    expect(s.verification).toBe("not_verified");
  });
});

/* ───────────────────────── the synthetic misfire workflow ───────────────────────── */

describe("V2B: the synthetic misfire workflow uses the provider", () => {
  it("carries no vehicle values: its measurements name specifications", () => {
    const measurements = W.nodes.filter((n) => n.type === "measurement");
    expect(measurements.map((n) => n.type === "measurement" && n.specification)).toEqual(["synthetic.cylinder_compression_min", "synthetic.fuel_supply_pressure_idle"]);
    for (const n of measurements) if (n.type === "measurement") for (const o of n.outcomes) expect(o.when).toHaveProperty("relativeToSpec");
    expect(SYNTHETIC_SPECIFICATIONS.every((r) => /SYNTHETIC \/ TEST ONLY/.test(r.source.name) && /SYNTHETIC/.test(r.revision))).toBe(true);
  });

  it("routes correctly through both measurement branches", () => {
    const single: StepInput[] = [
      yes("confirm_symptom"),
      no("flashing_light"),
      { nodeId: "single_prereq", kind: "prerequisite", met: true },
      no("coil_swap"),
      { nodeId: "plug_inspection", kind: "observation", choice: "normal" },
      { nodeId: "injector_check", kind: "check", result: "pass" },
    ];
    expect(run(facts({ dtcs: ["P0301"] }), [...single, { nodeId: "compression_test", kind: "measurement", value: 600, unit: "kPa" }]).conclusionNodeId).toBe("concl_mechanical");
    expect(run(facts({ dtcs: ["P0301"] }), [...single, { nodeId: "compression_test", kind: "measurement", value: 1100, unit: "kPa" }]).conclusionNodeId).toBe("concl_wiring");
    expect(run(facts({ dtcs: ["P0300"] }), [...TO_FUEL, fuel(200)])).toMatchObject({ conclusionNodeId: "concl_fuel_supply", currentNodeId: "verify_fuel_repair" });
    expect(run(facts({ dtcs: ["P0300"] }), [...TO_FUEL, fuel(400)])).toMatchObject({ conclusionNodeId: "concl_professional", endResult: "referred" });
  });
});
