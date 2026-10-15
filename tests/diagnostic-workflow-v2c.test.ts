/**
 * Guided Diagnostics V2C: vehicle context and applicability, capability
 * context, and modelling-only actuator tests and service functions.
 *
 * Research prototype. No network, no database, no AI, no vehicle
 * communication. Every vehicle, specification and step here is SYNTHETIC /
 * TEST ONLY / NOT OEM DATA.
 */
import { describe, expect, it } from "vitest";
import {
  capabilityShortfall,
  checkApplicability,
  replaySession,
  resumeSession,
  sessionOutcome,
  specificationDrift,
  startSession,
  submitStep,
  validateWorkflow,
  type DiagnosticCapabilityContext,
  type DiagnosticSession,
  type EngineOptions,
  type SessionStartFacts,
  type SpecificationProvider,
  type SpecificationRequest,
  type StepInput,
  type VehicleContext,
  type WorkflowDefinition,
  type WorkflowNode,
} from "../app/lib/diagnostic-workflow";
import { SYNTHETIC_MISFIRE_WORKFLOW as W } from "../app/lib/diagnostic-workflow/examples/synthetic-misfire";
import { SYNTHETIC_SPECIFICATIONS } from "../app/lib/diagnostic-workflow/examples/synthetic-specifications";
import { createInMemorySpecificationProvider } from "../app/lib/diagnostic-workflow/examples/in-memory-specification-provider";
import { CAPABILITY_PRESETS, capabilityPreset } from "../app/lib/diagnostic-workflow/examples/capability-presets";

/** SYNTHETIC / TEST ONLY: not a real vehicle. */
const CAR: VehicleContext = { year: 2015, make: "  Synthetic   Motors ", model: "Test Car", engine: "SYN-I4-A", fuel: "gasoline", cylinders: 4 };
const SPECS: EngineOptions = { specifications: createInMemorySpecificationProvider(SYNTHETIC_SPECIFICATIONS) };
const facts = (capabilities: DiagnosticCapabilityContext = capabilityPreset("workshop"), over: Partial<SessionStartFacts> = {}): SessionStartFacts => ({ capabilities, vehicle: CAR, ...over });

function ok(r: ReturnType<typeof startSession>): DiagnosticSession {
  if (!r.ok) throw new Error(r.error);
  return r.session;
}
const run = (f: SessionStartFacts, inputs: StepInput[], options: EngineOptions = SPECS, workflow: WorkflowDefinition = W) => ok(replaySession(workflow, f, inputs, "2026-10-15T10:00:00Z", options));
const yes = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "yes" });
const no = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "no" });
const TO_PUMP: StepInput[] = [yes("confirm_symptom"), no("flashing_light"), { nodeId: "multi_vacuum", kind: "observation", choice: "nothing_found" }];
const P0300 = (capabilities?: DiagnosticCapabilityContext) => facts(capabilities, { dtcs: ["P0300"] });
const pump = (result: string): StepInput => ({ nodeId: "fuel_pump_actuator", kind: "actuator_result", result });
const skipped = (s: DiagnosticSession, nodeId: string) => s.evidence.find((e) => e.nodeId === nodeId && e.kind === "unsupported");

/* ───────────────────────── vehicle context and applicability ───────────────────────── */

describe("V2C: vehicle context and workflow applicability", () => {
  it("starts on an applicable vehicle and pins its normalized, frozen context", () => {
    const s = ok(startSession(W, facts(), "2026-10-15T10:00:00Z", SPECS));
    expect(s.facts.vehicle).toEqual({ year: 2015, make: "synthetic motors", model: "test car", engine: "syn-i4-a", fuel: "gasoline", cylinders: 4 });
    expect(Object.isFrozen(s.facts.vehicle)).toBe(true);
  });

  it("never starts on a vehicle the workflow does not apply to", () => {
    expect(startSession(W, facts(undefined, { vehicle: { ...CAR, fuel: "diesel" } }))).toEqual({ ok: false, error: expect.stringMatching(/^not_applicable: .*fuel/) });
    expect(startSession(W, facts(undefined, { vehicle: { ...CAR, cylinders: 12 } }))).toEqual({ ok: false, error: expect.stringMatching(/^not_applicable: .*cylinders/) });
    // A known mismatch is decisive even when other facts are unknown.
    expect(startSession(W, facts(undefined, { vehicle: { fuel: "electric" } }))).toEqual({ ok: false, error: expect.stringMatching(/^not_applicable/) });
  });

  it("does not guess when vehicle facts are missing, and says which", () => {
    expect(startSession(W, facts(undefined, { vehicle: undefined }))).toEqual({ ok: false, error: "insufficient_context: the vehicle's fuel, cylinders must be known" });
    expect(startSession(W, facts(undefined, { vehicle: { fuel: "hybrid" } }))).toEqual({ ok: false, error: "insufficient_context: the vehicle's cylinders must be known" });
    expect(checkApplicability(W.applicability, { fuel: "gasoline", make: "   " })).toEqual({ status: "insufficient_context", missing: ["cylinders"] });
  });

  it("evaluates every declarative field, case-insensitively, without scripting", () => {
    const rule = { make: ["Synthetic Motors"], engine: ["syn-i4-a", "syn-i4-b"], market: ["test-market"], years: { from: 2010, to: 2018 } };
    expect(checkApplicability(rule, { make: "synthetic motors", engine: "SYN-I4-B", market: "Test-Market", year: 2018 })).toEqual({ status: "applicable" });
    expect(checkApplicability(rule, { make: "synthetic motors", engine: "syn-i4-a", market: "test-market", year: 2019 })).toEqual({ status: "not_applicable", mismatched: ["years"] });
    expect(checkApplicability(rule, { make: "synthetic motors", engine: "syn-i4-a" })).toEqual({ status: "insufficient_context", missing: ["market", "years"] });
    expect(checkApplicability(undefined, undefined)).toEqual({ status: "applicable" });
  });

  it("refuses invalid vehicle facts and invalid applicability declarations", () => {
    expect(startSession(W, facts(undefined, { vehicle: { ...CAR, year: 2015.5 } }))).toEqual({ ok: false, error: expect.stringMatching(/^invalid_facts: vehicle year/) });
    expect(startSession(W, facts(undefined, { vehicle: { ...CAR, fuel: "steam" as "gasoline" } }))).toEqual({ ok: false, error: expect.stringMatching(/^invalid_facts: vehicle fuel/) });
    expect(startSession(W, facts(undefined, { vehicle: { ...CAR, vin: "X" } as VehicleContext }))).toEqual({ ok: false, error: expect.stringMatching(/unsupported fields: vin/) });
    const bad = (applicability: object) => (validateWorkflow({ ...W, applicability } as WorkflowDefinition).ok ? [] : (validateWorkflow({ ...W, applicability } as WorkflowDefinition) as { problems: { code: string }[] }).problems.map((p) => p.code));
    expect(bad({ fuel: [] })).toContain("invalid_applicability");
    expect(bad({ fuel: ["steam"] })).toContain("invalid_applicability");
    expect(bad({ years: { from: 2020, to: 2010 } })).toContain("invalid_applicability");
    expect(bad({ vin: ["x"] })).toContain("invalid_applicability");
  });

  it("keeps the pinned vehicle through a resume", () => {
    const saved = JSON.parse(JSON.stringify(run(P0300(), TO_PUMP)));
    const resumed = resumeSession(W, saved);
    expect(resumed.ok && resumed.session.facts.vehicle).toEqual(saved.facts.vehicle);
  });

  it("does not let a different current vehicle change an old session", () => {
    const current: VehicleContext = { ...CAR };
    const live = run(facts(undefined, { dtcs: ["P0300"], vehicle: current }), TO_PUMP);
    current.cylinders = 6; // the person later selects or edits another vehicle
    expect(live.facts.vehicle?.cylinders).toBe(4);
    const saved = JSON.parse(JSON.stringify(live));
    const resumed = resumeSession(W, saved);
    expect(resumed.ok && sessionOutcome(resumed.session)).toEqual(sessionOutcome(live));
    // An old session cannot be re-pointed at an inapplicable vehicle.
    expect(resumeSession(W, { ...saved, facts: { ...saved.facts, vehicle: { ...saved.facts.vehicle, fuel: "diesel" } } })).toEqual({ ok: false, error: expect.stringMatching(/^invalid_session: not_applicable/) });
  });
});

/* ───────────────────────── provider and vehicle context ───────────────────────── */

describe("V2C: specification requests carry the pinned vehicle context", () => {
  const recording = () => {
    const requests: SpecificationRequest[] = [];
    const inner = createInMemorySpecificationProvider(SYNTHETIC_SPECIFICATIONS);
    const provider: SpecificationProvider = { resolve: (r) => (requests.push(r), inner.resolve(r)) };
    return { requests, options: { specifications: provider } };
  };

  it("passes the pinned, frozen vehicle context to the provider", () => {
    const { requests, options } = recording();
    run(P0300(), [...TO_PUMP, pump("runs")], options);
    expect(requests).toEqual([{ id: "synthetic.fuel_supply_pressure_idle", vehicle: { year: 2015, make: "synthetic motors", model: "test car", engine: "syn-i4-a", fuel: "gasoline", cylinders: 4 } }]);
    expect(Object.isFrozen(requests[0].vehicle)).toBe(true);
  });

  it("keeps V2B pinning: resume never asks a provider, and drift checks use the pinned vehicle", () => {
    const options = { specifications: createInMemorySpecificationProvider(SYNTHETIC_SPECIFICATIONS) };
    const workshop = P0300();
    const live = run(workshop, [...TO_PUMP, pump("runs"), { nodeId: "fuel_pressure", kind: "measurement", value: 200, unit: "kPa" }], options);
    const saved = JSON.parse(JSON.stringify(live));
    const resumed = resumeSession(W, saved);
    expect(resumed.ok && sessionOutcome(resumed.session)).toEqual(sessionOutcome(live));
    const { requests, options: rec } = recording();
    expect(specificationDrift(saved, rec.specifications)).toEqual([]);
    expect(requests.map((r) => r.vehicle?.make)).toEqual(["synthetic motors"]);
  });
});

/* ───────────────────────── capabilities ───────────────────────── */

describe("V2C: capability context", () => {
  it("is explicit: skill, scan access, instruments and facilities each count", () => {
    const caps: DiagnosticCapabilityContext = { skill: "diy", scanAccess: "live_data", instruments: ["multimeter"], facilities: [] };
    expect(capabilityShortfall({ level: "diy", scan: "codes", instruments: ["multimeter"] }, caps)).toEqual({ ok: true });
    expect(capabilityShortfall({ level: "professional" }, caps)).toEqual({ ok: false, reason: "level", missing: ["level:professional"] });
    expect(capabilityShortfall({ level: "diy", scan: "bidirectional" }, caps)).toEqual({ ok: false, reason: "scan_access", missing: ["scan_access:bidirectional"] });
    expect(capabilityShortfall({ level: "diy", instruments: ["multimeter", "oscilloscope"] }, caps)).toEqual({ ok: false, reason: "instruments", missing: ["instrument:oscilloscope"] });
    expect(capabilityShortfall({ level: "diy", facilities: ["vehicle_lift"] }, caps)).toEqual({ ok: false, reason: "facilities", missing: ["facility:vehicle_lift"] });
    expect(capabilityShortfall({ level: "professional", scan: "bidirectional", facilities: ["vehicle_lift"] }, caps)).toMatchObject({ reason: "level", missing: ["level:professional", "scan_access:bidirectional", "facility:vehicle_lift"] });
  });

  it("refuses a capability context that is not explicit", () => {
    expect(startSession(W, facts({ skill: "diy", instruments: [], facilities: [] } as unknown as DiagnosticCapabilityContext))).toEqual({ ok: false, error: expect.stringMatching(/^invalid_facts: .*scan access/) });
    expect(startSession(W, facts({ ...capabilityPreset("diy"), instruments: ["sonic_screwdriver" as "multimeter"] }))).toEqual({ ok: false, error: expect.stringMatching(/unknown instruments/) });
    expect(startSession(W, facts({ maxLevel: "professional", tools: ["scan_tool"] } as unknown as DiagnosticCapabilityContext)).ok).toBe(false);
  });

  it("a missing instrument makes a step unavailable, with what is missing", () => {
    const noGauge = { ...capabilityPreset("workshop"), instruments: ["hand_tools" as const] };
    const s = run(P0300(noGauge), [...TO_PUMP, pump("runs")]);
    expect(skipped(s, "fuel_pressure")).toMatchObject({ unsupportedReason: "instruments", missingCapabilities: ["instrument:pressure_gauge"], source: "engine", to: "concl_professional" });
  });

  it("insufficient skill makes a step unavailable", () => {
    const s = run(facts(capabilityPreset("advanced_diy"), { dtcs: ["P0301"] }), [
      yes("confirm_symptom"),
      no("flashing_light"),
      { nodeId: "single_prereq", kind: "prerequisite", met: true },
      no("coil_swap"),
      { nodeId: "plug_inspection", kind: "observation", choice: "normal" },
    ]);
    expect(skipped(s, "injector_check")).toMatchObject({ unsupportedReason: "level", missingCapabilities: ["level:professional"] });
  });

  it("missing scan access makes a step unavailable", () => {
    const s = run(facts({ ...capabilityPreset("diy"), scanAccess: "none" }, { dtcs: ["P0301"] }), [yes("confirm_symptom"), no("flashing_light"), { nodeId: "single_prereq", kind: "prerequisite", met: true }]);
    expect(skipped(s, "coil_swap")).toMatchObject({ unsupportedReason: "scan_access", missingCapabilities: ["scan_access:codes"] });
  });

  it("an unavailable step is never evidence about a cause", () => {
    const before = run(P0300(capabilityPreset("advanced_diy")), TO_PUMP.slice(0, 2));
    const after = run(P0300(capabilityPreset("advanced_diy")), TO_PUMP);
    expect(skipped(after, "fuel_pump_actuator")).toMatchObject({ unsupportedReason: "scan_access" });
    expect(after.remainingCauses).toEqual(before.remainingCauses);
    expect(after.supportedCauses).toEqual(before.supportedCauses);
  });

  it("presets are only shorthand for explicit data, and grant nothing undeclared", () => {
    expect(CAPABILITY_PRESETS).toEqual(["basic", "diy", "advanced_diy", "workshop"]);
    expect(capabilityPreset("basic")).toEqual({ skill: "owner", scanAccess: "none", instruments: [], facilities: [] });
    expect(capabilityPreset("diy")).toMatchObject({ skill: "diy", scanAccess: "codes" });
    expect(capabilityPreset("advanced_diy")).toMatchObject({ skill: "diy", scanAccess: "live_data", instruments: expect.arrayContaining(["pressure_gauge"]) });
    expect(capabilityPreset("workshop")).toMatchObject({ skill: "professional", scanAccess: "bidirectional", facilities: expect.arrayContaining(["vehicle_lift"]) });
    // Fresh copies: changing one never changes the preset.
    const mine = capabilityPreset("workshop");
    mine.instruments.length = 0;
    expect(capabilityPreset("workshop").instruments.length).toBeGreaterThan(0);
    // The engine reads the data: a "workshop" context without bidirectional access cannot run the actuator test.
    const s = run(P0300({ ...capabilityPreset("workshop"), scanAccess: "live_data" }), TO_PUMP);
    expect(skipped(s, "fuel_pump_actuator")).toMatchObject({ unsupportedReason: "scan_access", missingCapabilities: ["scan_access:bidirectional"] });
  });
});

/* ───────────────────────── actuator tests ───────────────────────── */

describe("V2C: actuator tests (modelling only)", () => {
  it("are unavailable without bidirectional access, and route safely to the next test", () => {
    for (const preset of ["diy", "advanced_diy"] as const) {
      const s = run(P0300(capabilityPreset(preset)), TO_PUMP);
      expect(skipped(s, "fuel_pump_actuator")).toMatchObject({ unsupportedReason: "scan_access", to: "fuel_pressure" });
      expect(s.evidence.some((e) => e.kind === "actuator_test")).toBe(false);
    }
  });

  it("with bidirectional access, record the observed result with its provenance and follow it", () => {
    const at = run(P0300(), TO_PUMP);
    expect(at.currentNodeId).toBe("fuel_pump_actuator");
    const silent = ok(submitStep(W, at, pump("no_response"), "2026-10-15T10:05:00Z", SPECS));
    expect(silent.evidence.at(-1)).toMatchObject({
      nodeId: "fuel_pump_actuator",
      kind: "actuator_test",
      actuator: "fuel_pump",
      performedBy: "external_tool",
      source: "scan_tool",
      phase: "before_repair",
      value: "no_response",
      to: "concl_fuel_supply",
      at: "2026-10-15T10:05:00Z",
    });
    expect(silent).toMatchObject({ conclusionNodeId: "concl_fuel_supply", supportedCauses: ["fuel_supply"] });
    const runs = ok(submitStep(W, at, { ...pump("runs"), source: "person" }, undefined, SPECS));
    expect(runs.evidence.find((e) => e.kind === "actuator_test")).toMatchObject({ value: "runs", source: "person", performedBy: "external_tool", to: "fuel_pressure" });
    expect(runs.remainingCauses).toEqual(at.remainingCauses);
  });

  it("refuse results they do not offer, other input kinds and impossible sources; allow inconclusive", () => {
    const at = run(P0300(), TO_PUMP);
    expect(submitStep(W, at, pump("exploded"), undefined, SPECS)).toEqual({ ok: false, error: "unknown_result" });
    expect(submitStep(W, at, { nodeId: "fuel_pump_actuator", kind: "check", result: "pass" }, undefined, SPECS)).toEqual({ ok: false, error: "wrong_input_kind" });
    expect(submitStep(W, at, { ...pump("runs"), source: "instrument" }, undefined, SPECS)).toEqual({ ok: false, error: expect.stringMatching(/^invalid_source/) });
    const unclear = ok(submitStep(W, at, { nodeId: "fuel_pump_actuator", kind: "inconclusive", reason: "unclear_result" }, undefined, SPECS));
    expect(unclear).toMatchObject({ currentNodeId: "fuel_pressure", remainingCauses: at.remainingCauses });
  });

  it("must require bidirectional access, state hazards and use a generic id", () => {
    const actuator = W.nodes.find((n) => n.id === "fuel_pump_actuator") as Extract<WorkflowNode, { type: "actuator_test" }>;
    const codes = (change: Partial<typeof actuator>) => {
      const r = validateWorkflow({ ...W, nodes: W.nodes.map((n) => (n.id === actuator.id ? { ...actuator, ...change } : n)) as WorkflowNode[] });
      return r.ok ? [] : r.problems.map((p) => p.code);
    };
    expect(codes({ requires: { level: "diy", scan: "live_data", hazards: ["x"] } })).toContain("needs_bidirectional");
    expect(codes({ requires: { level: "diy", scan: "bidirectional" } })).toContain("no_hazards");
    expect(codes({ actuator: "0x31 01 FF00" })).toContain("invalid_generic_id");
    expect(codes({ results: [{ id: "runs", label: "Runs" }] })).toContain("incomplete_outcomes");
  });
});

/* ───────────────────────── service functions ───────────────────────── */

describe("V2C: service functions (modelling only)", () => {
  /** SYNTHETIC: a prerequisite establishes "key_on", then an external tool runs a generic routine. */
  const routine: WorkflowDefinition = {
    id: "test.service",
    version: 1,
    title: "Service function",
    provenance: "SYNTHETIC: test only",
    faultModel: "single_primary_fault",
    conditions: [{ id: "key_on", title: "Ignition on, engine off" }],
    causes: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
    nodes: [
      { id: "s", type: "start", title: "Start", next: "p" },
      { id: "p", type: "prerequisite", title: "Key on?", ifMet: "sf", ifNotMet: "e_ref", establishes: ["key_on"] },
      {
        id: "sf",
        type: "service_function",
        title: "Run the generic self-test routine",
        serviceFunction: "generic_self_test",
        requires: { level: "diy", scan: "bidirectional", hazards: ["Components may move while the routine runs"] },
        needsConditions: ["key_on"],
        outcomes: [
          { when: "completed", to: "e_ok", rulesOut: ["a"] },
          { when: "failed", to: "c", supports: ["a"], rulesOut: ["b"] },
        ],
        ifUnsupported: "e_ref",
        ifInconclusive: "e_inc",
      },
      { id: "c", type: "conclusion", title: "A", cause: "a", recommendation: "Have A checked.", next: "e_done" },
      { id: "e_ok", type: "end", title: "Completed", result: "concluded" },
      { id: "e_done", type: "end", title: "Done", result: "concluded" },
      { id: "e_ref", type: "end", title: "Referred", result: "referred" },
      { id: "e_inc", type: "end", title: "Inconclusive", result: "inconclusive" },
    ],
  };
  const f = (capabilities = capabilityPreset("workshop")) => ({ capabilities });
  const result = (r: "completed" | "failed" | "not_supported"): StepInput => ({ nodeId: "sf", kind: "service_result", result: r });
  const keyOn: StepInput = { nodeId: "p", kind: "prerequisite", met: true };

  it("is a valid workflow, and refuses a service function that could run without its prerequisite", () => {
    expect(validateWorkflow(routine)).toEqual({ ok: true });
    const bypass = { ...routine, nodes: routine.nodes.map((n) => (n.id === "p" ? { ...n, ifNotMet: "sf" } : n)) as WorkflowNode[] };
    expect(validateWorkflow(bypass)).toMatchObject({ ok: false, problems: [expect.objectContaining({ code: "condition_not_guaranteed", nodeId: "sf" })] });
  });

  it("is unavailable without bidirectional access or the skill it needs, and is not evidence", () => {
    for (const caps of [capabilityPreset("advanced_diy"), { ...capabilityPreset("workshop"), skill: "owner" as const }]) {
      const s = run(f(caps), [keyOn], {}, routine);
      expect(s).toMatchObject({ endResult: "referred", remainingCauses: ["a", "b"], supportedCauses: [] });
      expect(skipped(s, "sf")).toMatchObject({ source: "engine" });
    }
  });

  it("records completed and failed with provenance, and follows each", () => {
    const done = run(f(), [keyOn, result("completed")], {}, routine);
    expect(done.evidence.at(-1)).toMatchObject({ kind: "service_function", serviceFunction: "generic_self_test", performedBy: "external_tool", source: "scan_tool", value: "completed" });
    expect(done).toMatchObject({ endResult: "concluded", remainingCauses: ["b"] });
    const failed = run(f(), [keyOn, result("failed")], {}, routine);
    expect(failed).toMatchObject({ conclusionNodeId: "c", supportedCauses: ["a"], remainingCauses: ["a"] });
  });

  it("treats 'not supported' as unavailable, never as a failure", () => {
    const s = run(f(), [keyOn, result("not_supported")], {}, routine);
    expect(s.evidence.at(-1)).toMatchObject({ kind: "service_function", value: "not_supported", unsupportedReason: "function_not_supported", performedBy: "external_tool", to: "e_ref" });
    expect(s).toMatchObject({ endResult: "referred", remainingCauses: ["a", "b"], supportedCauses: [] });
  });

  it("can be inconclusive", () => {
    const s = run(f(), [keyOn, { nodeId: "sf", kind: "inconclusive", reason: "intermittent" }], {}, routine);
    expect(s).toMatchObject({ endResult: "inconclusive", remainingCauses: ["a", "b"] });
  });

  it("still applies prerequisites: not met never reaches the routine", () => {
    const s = run(f(), [{ nodeId: "p", kind: "prerequisite", met: false }], {}, routine);
    expect(s.evidence.some((e) => e.nodeId === "sf")).toBe(false);
    expect(s).toMatchObject({ endResult: "referred", refutedConditions: ["key_on"] });
  });

  it("requires routes for completed and failed, bidirectional access and hazards", () => {
    const sf = routine.nodes.find((n) => n.id === "sf") as Extract<WorkflowNode, { type: "service_function" }>;
    const codes = (change: Partial<typeof sf>) => {
      const r = validateWorkflow({ ...routine, nodes: routine.nodes.map((n) => (n.id === "sf" ? { ...sf, ...change } : n)) as WorkflowNode[] });
      return r.ok ? [] : r.problems.map((p) => p.code);
    };
    expect(codes({ outcomes: [{ when: "completed", to: "e_ok" }] })).toContain("incomplete_outcomes");
    expect(codes({ requires: { level: "diy", hazards: ["x"] } })).toContain("needs_bidirectional");
    expect(codes({ serviceFunction: "OEM Routine 0x0F" })).toContain("invalid_generic_id");
  });
});

/* ───────────────────────── determinism and the synthetic fixture ───────────────────────── */

describe("V2C: determinism and the synthetic misfire fixture at different capability levels", () => {
  it("replays deterministically", () => {
    const inputs = [...TO_PUMP, pump("runs"), { nodeId: "fuel_pressure", kind: "measurement", value: 380, unit: "kPa" } as StepInput];
    expect(JSON.stringify(run(P0300(), inputs))).toBe(JSON.stringify(run(P0300(), inputs)));
  });

  it("routes a basic user safely past every step they cannot do", () => {
    const s = run(P0300(capabilityPreset("basic")), TO_PUMP);
    expect(skipped(s, "fuel_pump_actuator")).toMatchObject({ unsupportedReason: "level" });
    expect(skipped(s, "fuel_pressure")).toMatchObject({ unsupportedReason: "level" });
    expect(s).toMatchObject({ conclusionNodeId: "concl_professional", endResult: "referred", supportedCauses: [] });
    expect(run(facts(capabilityPreset("basic"), { dtcs: ["P0301"] }), [yes("confirm_symptom"), no("flashing_light")])).toMatchObject({ conclusionNodeId: "concl_professional" });
  });

  it("lets an advanced DIYer measure but not command, and a workshop do both", () => {
    const advanced = run(P0300(capabilityPreset("advanced_diy")), TO_PUMP);
    expect(skipped(advanced, "fuel_pump_actuator")).toMatchObject({ missingCapabilities: ["scan_access:bidirectional"] });
    expect(skipped(advanced, "fuel_pressure")).toMatchObject({ unsupportedReason: "level" });
    const workshop = run(P0300(), [...TO_PUMP, pump("runs"), { nodeId: "fuel_pressure", kind: "measurement", value: 200, unit: "kPa" }]);
    expect(workshop.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["actuator_test", "specification", "measurement"]));
    expect(workshop).toMatchObject({ conclusionNodeId: "concl_fuel_supply", currentNodeId: "verify_fuel_repair" });
  });
});
