/**
 * Guided Diagnostics V2A ("honest outcomes"), research prototype.
 *
 * Runs the engine directly: no network, no database, no AI. The workflow is
 * SYNTHETIC (app/lib/diagnostic-workflow/examples). Specification numbers
 * below are made up for tests and are not values for any vehicle.
 */
import { describe, expect, it } from "vitest";
import { afterScan, withCodes, type TypedCodes } from "./helpers/workflow-scans";
import {
  replaySession,
  resumeSession,
  sessionOutcome,
  startSession,
  submitStep,
  validateWorkflow,
  type DiagnosticCapabilityContext,
  type DiagnosticSpecification,
  type EngineOptions,
  type DiagnosticSession,
  type SessionStartFacts,
  type StepInput,
  type VerificationEntry,
  type WorkflowDefinition,
  type WorkflowNode,
} from "../app/lib/diagnostic-workflow";
import { SYNTHETIC_MISFIRE_WORKFLOW as W } from "../app/lib/diagnostic-workflow/examples/synthetic-misfire";
// Retired from the public API (nextBestTests replaced it); imported from the engine only to keep these regression checks.
import { separatingSteps } from "../app/lib/diagnostic-workflow/engine";
import { SYNTHETIC_SPECIFICATIONS } from "../app/lib/diagnostic-workflow/examples/synthetic-specifications";
import { createInMemorySpecificationProvider } from "../app/lib/diagnostic-workflow/examples/in-memory-specification-provider";

/** SYNTHETIC / TEST ONLY specifications through the in-memory provider. Not values for any vehicle. */
const SPECS: EngineOptions = { specifications: createInMemorySpecificationProvider(SYNTHETIC_SPECIFICATIONS) };
/** The synthetic specifications with one record replaced (or removed with `null`). */
const specsWith = (id: string, replacement: DiagnosticSpecification | null): EngineOptions => ({
  specifications: createInMemorySpecificationProvider([...SYNTHETIC_SPECIFICATIONS.filter((r) => r.id !== id), ...(replacement ? [replacement] : [])]),
});
/** Explicit capabilities (V2C). Live data but no bidirectional control, so actuator tests are skipped. */
const PRO: DiagnosticCapabilityContext = { skill: "professional", scanAccess: "live_data", instruments: ["hand_tools", "compression_tester", "pressure_gauge"], facilities: [] };
/** A synthetic vehicle the synthetic misfire workflow applies to. Not a real vehicle. */
const SYNTHETIC_VEHICLE = { fuel: "gasoline" as const, cylinders: 4 };
const facts = (over: Partial<SessionStartFacts> & TypedCodes = {}): SessionStartFacts => withCodes({ capabilities: PRO, vehicle: SYNTHETIC_VEHICLE, ...over });

function ok(r: ReturnType<typeof startSession>): DiagnosticSession {
  if (!r.ok) throw new Error(r.error);
  return r.session;
}
function run(f: SessionStartFacts, inputs: StepInput[], workflow: WorkflowDefinition = W, options: EngineOptions = SPECS): DiagnosticSession {
  return inputs.reduce((s, input) => ok(submitStep(workflow, s, input, undefined, options)), ok(startSession(workflow, f, "2026-10-15T10:00:00Z", options)));
}
const yes = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "yes" });
const no = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "no" });
const met = (nodeId: string): StepInput => ({ nodeId, kind: "prerequisite", met: true });
const codes = (w: WorkflowDefinition) => {
  const r = validateWorkflow(w);
  return r.ok ? [] : r.problems.map((p) => p.code);
};
const withNode = (id: string, change: (n: WorkflowNode) => WorkflowNode): WorkflowDefinition => ({ ...W, nodes: W.nodes.map((n) => (n.id === id ? change(n) : n)) });

const SINGLE = [yes("confirm_symptom"), no("flashing_light"), met("single_prereq")];
const MULTI = [yes("confirm_symptom"), no("flashing_light")];
const atCoilVerify = () => run(facts({ dtcs: ["P0301"] }), [...SINGLE, yes("coil_swap")]);
const atFuelVerify = () =>
  run(facts({ dtcs: ["P0300"] }), [...MULTI, { nodeId: "multi_vacuum", kind: "observation", choice: "nothing_found" }, { nodeId: "fuel_pressure", kind: "measurement", value: 200, unit: "kPa" }]);

/* ───────────────────────── checking a V2A workflow ───────────────────────── */

describe("V2A: checking a workflow", () => {
  it("accepts the synthetic misfire workflow (version 6 since V2E)", () => {
    expect(validateWorkflow(W)).toEqual({ ok: true });
    expect(W.version).toBe(6);
  });

  it("requires the single-primary-fault assumption to be stated", () => {
    const { faultModel: _omit, ...without } = W;
    void _omit;
    expect(codes(without as WorkflowDefinition)).toContain("unsupported_fault_model");
    expect(codes({ ...W, faultModel: "multiple_faults" as "single_primary_fault" })).toContain("unsupported_fault_model");
  });

  it("refuses undeclared or duplicate named conditions", () => {
    expect(codes(withNode("compression_test", (n) => ({ ...n, needsConditions: ["engine_warm"] })))).toContain("unknown_condition");
    expect(codes({ ...W, conditions: [...(W.conditions ?? []), { id: "engine_off_cool", title: "again" }] })).toContain("duplicate_condition");
  });

  it("proves every route to a step establishes the conditions it needs", () => {
    // The not-met route goes through "let the engine cool"; if that no longer establishes the condition, one route does not.
    const broken = withNode("wait_cool", (n) => ({ ...n, establishes: [] }) as WorkflowNode);
    const problems = validateWorkflow(broken);
    expect(problems.ok).toBe(false);
    if (!problems.ok) expect(problems.problems.filter((p) => p.code === "condition_not_guaranteed").map((p) => p.nodeId)).toEqual(["plug_inspection", "compression_test"]);
    // A step on a branch that never establishes it.
    expect(codes(withNode("multi_vacuum", (n) => ({ ...n, needsConditions: ["engine_off_cool"] })))).toContain("condition_not_guaranteed");
  });

  it("allows inconclusive routes only where a result can fail to decide", () => {
    expect(codes(withNode("confirm_symptom", (n) => ({ ...n, ifInconclusive: "concl_professional" })))).toContain("inconclusive_not_allowed");
    expect(codes(withNode("verify_repair", (n) => ({ ...n, ifInconclusive: undefined })))).toContain("no_inconclusive_route");
  });

  it("requires a plausible range on every measurement, with fixed pass bounds inside it, and named ranges", () => {
    const fuel = W.nodes.find((n) => n.id === "fuel_pressure") as Extract<WorkflowNode, { type: "measurement" }>;
    const set = (change: Partial<typeof fuel>) => withNode("fuel_pressure", () => ({ ...fuel, ...change }));
    expect(codes(set({ measurement: { ...fuel.measurement, plausible: { min: 500, max: 100 } } }))).toContain("invalid_plausible_range");
    expect(codes(set({ measurement: { quantity: "x", unit: "kPa" } as typeof fuel.measurement }))).toContain("invalid_plausible_range");
    expect(codes(set({ outcomes: [{ ...fuel.outcomes[0], when: { max: 5000 } }, fuel.outcomes[1]] }))).toContain("invalid_plausible_range");
    expect(codes(set({ outcomes: [fuel.outcomes[0], { ...fuel.outcomes[1], id: "below_min" }] }))).toContain("invalid_range_id");
  });

  it("requires a repair verification to name real criteria", () => {
    expect(codes(withNode("verify_repair", (n) => ({ ...n, criteria: [] }) as WorkflowNode))).toContain("no_verification_criteria");
    const retest = (step: string, passWhen: string[]) => withNode("verify_fuel_repair", (n) => ({ ...n, criteria: [{ id: "r", kind: "retest", step, passWhen }] }) as WorkflowNode);
    expect(codes(retest("confirm_symptom", ["yes"]))).toContain("invalid_retest");
    expect(codes(retest("fuel_pressure", ["perfect"]))).toContain("invalid_retest");
    expect(codes(retest("fuel_pressure", ["within"]))).toEqual([]);
    expect(codes(withNode("verify_repair", (n) => ({ ...n, criteria: [{ id: "c", kind: "codes_absent", codes: [] }] }) as WorkflowNode))).toContain("invalid_criterion");
  });
});

/* ───────────────────────── inconclusive results ───────────────────────── */

describe("V2A: inconclusive results", () => {
  it("records an inconclusive result, follows its route, and rules nothing in or out", () => {
    const before = run(facts({ dtcs: ["P0301"] }), [...SINGLE, no("coil_swap")]);
    const after = ok(submitStep(W, before, { nodeId: "plug_inspection", kind: "inconclusive", reason: "unclear_result" }));
    expect(after.currentNodeId).toBe("injector_check");
    expect(after.remainingCauses).toEqual(before.remainingCauses);
    expect(after.supportedCauses).toEqual(before.supportedCauses);
    expect(after.evidence.at(-1)).toMatchObject({ nodeId: "plug_inspection", kind: "inconclusive", value: "unclear_result", to: "injector_check" });
  });

  it("refuses inconclusive where the step cannot be inconclusive or has no route for it, and an unknown reason", () => {
    const s = run(facts(), []);
    expect(submitStep(W, s, { nodeId: "confirm_symptom", kind: "inconclusive", reason: "unclear_result" })).toEqual({ ok: false, error: expect.stringMatching(/^inconclusive_not_allowed/) });
    const noRoute = withNode("plug_inspection", (n) => ({ ...n, ifInconclusive: undefined }));
    const atPlug = run(facts({ dtcs: ["P0301"] }), [...SINGLE, no("coil_swap")], noRoute);
    expect(submitStep(noRoute, atPlug, { nodeId: "plug_inspection", kind: "inconclusive", reason: "unclear_result" })).toEqual({ ok: false, error: expect.stringMatching(/^no_inconclusive_route/) });
    const atPlugW = run(facts({ dtcs: ["P0301"] }), [...SINGLE, no("coil_swap")]);
    expect(submitStep(W, atPlugW, { nodeId: "plug_inspection", kind: "inconclusive", reason: "guess" as "intermittent" })).toEqual({ ok: false, error: "invalid_reason" });
  });

  it("an inconclusive measurement is routed, not forced into pass or fail", () => {
    const s = run(facts({ dtcs: ["P0300"] }), [...MULTI, { nodeId: "multi_vacuum", kind: "observation", choice: "nothing_found" }, { nodeId: "fuel_pressure", kind: "inconclusive", reason: "reading_unstable" }]);
    expect(s).toMatchObject({ status: "completed", endResult: "referred", conclusionNodeId: "concl_professional" });
    expect(s.remainingCauses).toContain("fuel_supply");
    expect(s.evidence.find((e) => e.nodeId === "fuel_pressure" && e.kind !== "specification")).toMatchObject({ kind: "inconclusive", source: "instrument" });
  });
});

/* ───────────────────────── evidence phase and source ───────────────────────── */

describe("V2A: evidence phase and source", () => {
  it("marks everything before the repair verification as before_repair and from it on as after_repair", () => {
    const s = atCoilVerify();
    expect(s.phase).toBe("after_repair");
    expect(s.evidence.every((e) => e.phase === "before_repair")).toBe(true);
    const done = ok(submitStep(W, s, { nodeId: "verify_repair", kind: "verification", results: [{ criterion: "smooth", result: "met" }, { criterion: "codes_gone", scan: afterScan() }] }));
    const after = done.evidence.filter((e) => e.phase === "after_repair");
    expect(after.map((e) => [e.kind, e.criterion ?? null])).toEqual([
      ["verification_criterion", "smooth"],
      // V2D: the post-repair scan is its own after-repair evidence, recorded before the criterion it decides.
      ["scan", null],
      ["verification_criterion", "codes_gone"],
      ["verification", null],
    ]);
  });

  it("records who produced each piece of evidence", () => {
    const s = run(facts({ dtcs: ["P0300"], dtcSource: "scan_tool" }), [...MULTI, { nodeId: "multi_vacuum", kind: "observation", choice: "nothing_found" }, { nodeId: "fuel_pressure", kind: "measurement", value: 200, unit: "kPa" }]);
    const bySource = s.evidence.map((e) => [e.nodeId, e.kind, e.source]);
    expect(bySource).toEqual([
      ["start", "scan", "scan_tool"],
      ["start", "code", "scan_tool"],
      ["confirm_symptom", "answer", "person"],
      ["flashing_light", "answer", "person"],
      ["pattern", "branch", "engine"],
      ["multi_vacuum", "observation", "person"],
      // V2C: skipped for capability (no bidirectional access). Decided by the engine, not evidence about a cause.
      ["fuel_pump_actuator", "unsupported", "engine"],
      ["fuel_pressure", "specification", "specification_provider"],
      ["fuel_pressure", "measurement", "instrument"],
    ]);
    // Steps the engine skips are the engine's doing.
    const owner = run(facts({ dtcs: ["P0301"], capabilities: { skill: "owner", scanAccess: "none", instruments: [], facilities: [] } }), MULTI);
    expect(owner.evidence.find((e) => e.kind === "unsupported")).toMatchObject({ source: "engine" });
  });

  it("accepts a source only where it could have produced the input", () => {
    const atFuel = run(facts({ dtcs: ["P0300"] }), [...MULTI, { nodeId: "multi_vacuum", kind: "observation", choice: "nothing_found" }]);
    const viaScan = ok(submitStep(W, atFuel, { nodeId: "fuel_pressure", kind: "measurement", value: 200, unit: "kPa", source: "scan_tool" }));
    expect(viaScan.evidence.find((e) => e.nodeId === "fuel_pressure" && e.kind !== "specification")?.source).toBe("scan_tool");
    expect(submitStep(W, atFuel, { nodeId: "fuel_pressure", kind: "measurement", value: 200, unit: "kPa", source: "person" })).toEqual({ ok: false, error: expect.stringMatching(/^invalid_source/) });
    expect(submitStep(W, run(facts(), []), { ...yes("confirm_symptom"), source: "scan_tool" })).toEqual({ ok: false, error: expect.stringMatching(/^invalid_source/) });
    expect(startSession(W, facts({ dtcSource: "ai" as "person" }))).toEqual({ ok: false, error: expect.stringMatching(/^invalid_facts/) });
  });
});

/* ───────────────────────── named conditions ───────────────────────── */

describe("V2A: named conditions", () => {
  it("are established by a prerequisite that is met, or by the action that makes it true", () => {
    const direct = run(facts({ dtcs: ["P0301"] }), SINGLE);
    expect(direct.establishedConditions).toEqual(["engine_off_cool"]);
    expect(direct.evidence.find((e) => e.nodeId === "single_prereq")).toMatchObject({ value: "met", established: ["engine_off_cool"] });
    const waited = run(facts({ dtcs: ["P0301"] }), [...MULTI, { nodeId: "single_prereq", kind: "prerequisite", met: false }]);
    expect(waited.establishedConditions).toEqual([]);
    const cooled = ok(submitStep(W, waited, { nodeId: "wait_cool", kind: "done" }));
    expect(cooled.establishedConditions).toEqual(["engine_off_cool"]);
  });

  it("can be branched on", () => {
    const w: WorkflowDefinition = {
      id: "test.conditions",
      version: 1,
      title: "Conditions",
      provenance: "SYNTHETIC: test only",
      faultModel: "single_primary_fault",
      conditions: [{ id: "warm", title: "Engine warm" }],
      causes: [{ id: "a", title: "A" }],
      nodes: [
        { id: "s", type: "start", title: "Start", next: "p" },
        { id: "p", type: "prerequisite", title: "Warm?", ifMet: "b", ifNotMet: "b", establishes: ["warm"] },
        { id: "b", type: "branch", title: "Branch", rules: [{ if: { established: "warm" }, to: "e1" }], otherwise: "e2" },
        { id: "e1", type: "end", title: "Warm", result: "concluded" },
        { id: "e2", type: "end", title: "Cold", result: "concluded" },
      ],
    };
    expect(validateWorkflow(w)).toEqual({ ok: true });
    expect(run(facts(), [met("p")], w).evidence.at(-1)?.value).toBe("rule:1");
    expect(run(facts(), [{ nodeId: "p", kind: "prerequisite", met: false }], w).evidence.at(-1)?.value).toBe("otherwise");
  });
});

/* ───────────────────────── plausible range, pass range, specification trust ───────────────────────── */

describe("V2A: measurements", () => {
  const atCompression = () =>
    run(facts({ dtcs: ["P0301"] }), [...SINGLE, no("coil_swap"), { nodeId: "plug_inspection", kind: "observation", choice: "normal" }, { nodeId: "injector_check", kind: "check", result: "pass" }]);

  it("refuses an implausible reading (a typo) and leaves the session unchanged", () => {
    const s = atCompression();
    const before = JSON.stringify(s);
    expect(submitStep(W, s, { nodeId: "compression_test", kind: "measurement", value: 9000, unit: "kPa" })).toEqual({ ok: false, error: expect.stringMatching(/^implausible_measurement/) });
    expect(submitStep(W, s, { nodeId: "compression_test", kind: "measurement", value: -5, unit: "kPa" })).toEqual({ ok: false, error: expect.stringMatching(/^implausible_measurement/) });
    // Plausibility is judged after conversion: 600 psi is about 4137 kPa.
    expect(submitStep(W, s, { nodeId: "compression_test", kind: "measurement", value: 600, unit: "psi" })).toEqual({ ok: false, error: expect.stringMatching(/^implausible_measurement/) });
    expect(JSON.stringify(s)).toBe(before);
    // The edge of the plausible range is accepted and judged against the pass ranges.
    expect(ok(submitStep(W, s, { nodeId: "compression_test", kind: "measurement", value: 3500, unit: "kPa" })).conclusionNodeId).toBe("concl_wiring");
  });

  it("records which range judged the reading and the specifications used, with their trust", () => {
    const low = ok(submitStep(W, atCompression(), { nodeId: "compression_test", kind: "measurement", value: 600, unit: "kPa" }));
    expect(low.evidence.find((e) => e.nodeId === "compression_test" && e.kind !== "specification")).toMatchObject({
      measured: { value: 600, unit: "kPa" },
      judgement: { evaluated: true, range: "below_min", relation: "below", specification: { id: "synthetic.cylinder_compression_min", trust: "verified", expected: { min: 900 } } },
    });
    const sourced = run(facts({ dtcs: ["P0300"] }), [...MULTI, { nodeId: "multi_vacuum", kind: "observation", choice: "nothing_found" }, { nodeId: "fuel_pressure", kind: "measurement", value: 400, unit: "kPa" }]);
    expect(sourced.evidence.find((e) => e.nodeId === "fuel_pressure" && e.kind !== "specification")?.judgement).toEqual({
      evaluated: true,
      range: "within",
      relation: "within",
      specification: {
        id: "synthetic.fuel_supply_pressure_idle",
        revision: "SYNTHETIC-TEST-ONLY-r1",
        status: "verified",
        trust: "verified",
        source: { name: "SYNTHETIC / TEST ONLY: made up for CarCode's engine tests", reference: "not a real source" },
        sourceUnit: "kPa",
        expected: { min: 300, max: 450 },
        conditions: [],
      },
    });
    // A plausible reading above every range is judged "otherwise".
    const high = run(facts({ dtcs: ["P0300"] }), [...MULTI, { nodeId: "multi_vacuum", kind: "observation", choice: "nothing_found" }, { nodeId: "fuel_pressure", kind: "measurement", value: 800, unit: "kPa" }]);
    expect(high.evidence.find((e) => e.nodeId === "fuel_pressure" && e.kind !== "specification")?.judgement).toMatchObject({ evaluated: true, range: "otherwise" });
  });

  it("refuses specification values in the session facts: they come from a provider", () => {
    expect(startSession(W, { ...facts(), specs: { compression_min: 900 } } as SessionStartFacts)).toEqual({ ok: false, error: expect.stringMatching(/^invalid_facts/) });
  });
});

/* ───────────────────────── single primary fault ───────────────────────── */

describe("V2A: the single-primary-fault assumption", () => {
  it("is carried on every session", () => {
    expect(run(facts(), []).faultModel).toBe("single_primary_fault");
  });

  it("does not conclude a cause the evidence already ruled out: it ends inconclusive, recording the conflict (V2E correction)", () => {
    const w: WorkflowDefinition = {
      id: "test.contradiction",
      version: 1,
      title: "Contradiction",
      provenance: "SYNTHETIC: test only",
      faultModel: "single_primary_fault",
      causes: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
      nodes: [
        { id: "s", type: "start", title: "Start", next: "q" },
        { id: "q", type: "question", answer: "yes_no", title: "Q", outcomes: [{ when: "yes", to: "c", rulesOut: ["a"] }, { when: "no", to: "c" }] },
        { id: "c", type: "conclusion", title: "A", cause: "a", recommendation: "Fix A.", next: "e" },
        { id: "e", type: "end", title: "End", result: "concluded" },
      ],
    };
    const s = ok(startSession(w, facts()));
    const conflicted = ok(submitStep(w, s, yes("q")));
    expect(conflicted).toMatchObject({ status: "completed", endResult: "inconclusive", conclusionNodeId: null, remainingCauses: ["b"] });
    expect(conflicted.evidence.at(-1)).toMatchObject({ kind: "conflict", nodeId: "c", conflict: { causes: [{ cause: "a", earlierState: "ruled_out", newEvidenceWould: "conclude", earlierEvidence: [1] }] } });
    expect(ok(submitStep(w, s, no("q"))).conclusionNodeId).toBe("c");
  });
});

/* ───────────────────────── separating tests: reachable only ───────────────────────── */

describe("V2A: only a verified specification may drive the engine", () => {
  const toCompression: StepInput[] = [...SINGLE, no("coil_swap"), { nodeId: "plug_inspection", kind: "observation", choice: "normal" }, { nodeId: "injector_check", kind: "check", result: "pass" }];
  const COMPRESSION = SYNTHETIC_SPECIFICATIONS.find((r) => r.id === "synthetic.cylinder_compression_min")!;
  const compressionWith = (trust: DiagnosticSpecification["trust"], source = COMPRESSION.source) => specsWith(COMPRESSION.id, { ...COMPRESSION, trust, source });
  const reading = (value: number): StepInput => ({ nodeId: "compression_test", kind: "measurement", value, unit: "kPa" });
  const UNTRUSTED = ["unverified", "reference"] as const;

  it("1. a verified specification can drive a pass", () => {
    const s = run(facts({ dtcs: ["P0301"] }), [...toCompression, reading(1100)], W, compressionWith("verified"));
    expect(s.evidence.at(-1)).toMatchObject({ nodeId: "compression_test", judgement: { evaluated: true, range: "at_or_above_min" }, to: "concl_wiring" });
    expect(s.conclusionNodeId).toBe("concl_wiring");
    expect(s.remainingCauses).not.toContain("low_compression");
  });

  it("2. a verified specification can drive a fail", () => {
    const s = run(facts({ dtcs: ["P0301"] }), [...toCompression, reading(600)], W, compressionWith("verified"));
    expect(s.evidence.at(-1)).toMatchObject({ judgement: { evaluated: true, range: "below_min" }, to: "concl_mechanical" });
    expect(s.supportedCauses).toEqual(["low_compression"]);
  });

  for (const trust of UNTRUSTED) {
    it(`3-6. a ${trust} specification cannot drive pass or fail, change causes, or pick a pass/fail route`, () => {
      const options = compressionWith(trust);
      const before = run(facts({ dtcs: ["P0301"] }), toCompression, W, options);
      for (const value of [1100, 600]) {
        const s = ok(submitStep(W, before, reading(value), undefined, options));
        const e = s.evidence.at(-1)!;
        expect(e.judgement).toMatchObject({ evaluated: false, reason: "untrusted_spec" });
        expect(e.judgement && "range" in e.judgement).toBe(false);
        expect(s.remainingCauses).toEqual(before.remainingCauses);
        expect(s.supportedCauses).toEqual(before.supportedCauses);
        expect(e.to).toBe("concl_professional");
        expect(s.conclusionNodeId).not.toMatch(/concl_wiring|concl_mechanical/);
      }
    });
  }

  /** A tiny workflow judged against "test.v_min" (SYNTHETIC), with or without an inconclusive route. */
  const vWorkflow = (withInconclusive: boolean): WorkflowDefinition => ({
    id: "test.trust",
    version: 1,
    title: "Trust",
    provenance: "SYNTHETIC: test only",
    faultModel: "single_primary_fault",
    causes: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
    nodes: [
      { id: "s", type: "start", title: "Start", next: "m" },
      {
        id: "m",
        type: "measurement",
        title: "M",
        measurement: { quantity: "Q", unit: "V", plausible: { min: 0, max: 20 } },
        specification: "test.v_min",
        outcomes: [
          { id: "low", when: { relativeToSpec: "below" }, to: "e_fail", supports: ["a"], rulesOut: ["b"] },
          { id: "ok", when: { relativeToSpec: "within" }, to: "e_pass", rulesOut: ["a"] },
        ],
        otherwise: "e_ref",
        ifUnsupported: "e_ref",
        ...(withInconclusive ? { ifInconclusive: "e_inc" } : {}),
      },
      { id: "e_fail", type: "end", title: "Fail", result: "concluded" },
      { id: "e_pass", type: "end", title: "Pass", result: "concluded" },
      { id: "e_ref", type: "end", title: "Referred", result: "referred" },
      ...(withInconclusive ? [{ id: "e_inc", type: "end" as const, title: "Inconclusive", result: "inconclusive" as const }] : []),
    ],
  });
  const vSpec = (trust: DiagnosticSpecification["trust"]): EngineOptions => ({
    specifications: createInMemorySpecificationProvider([{ id: "test.v_min", revision: "SYNTHETIC-r1", unit: "V", expected: { min: 12 }, source: { name: "SYNTHETIC / TEST ONLY" }, trust }]),
  });

  it("6. without an inconclusive route, an untrusted specification takes the cannot-be-done route, not a pass/fail route", () => {
    const w = vWorkflow(false);
    expect(validateWorkflow(w)).toEqual({ ok: true });
    const untrusted = run(facts(), [{ nodeId: "m", kind: "measurement", value: 9, unit: "V" }], w, vSpec("unverified"));
    expect(untrusted).toMatchObject({ endResult: "referred", remainingCauses: ["a", "b"], supportedCauses: [] });
    const trusted = run(facts(), [{ nodeId: "m", kind: "measurement", value: 9, unit: "V" }], w, vSpec("verified"));
    expect(trusted).toMatchObject({ endResult: "concluded", remainingCauses: ["a"], supportedCauses: ["a"] });
  });

  it("7. keeps the untrusted value, source and trust, and the reading, as information", () => {
    const source = { name: "SYNTHETIC / TEST ONLY forum post" };
    const s = run(facts({ dtcs: ["P0301"] }), [...toCompression, reading(600)], W, compressionWith("unverified", source));
    expect(s.evidence.at(-1)).toMatchObject({
      value: "600 kPa",
      measured: { value: 600, unit: "kPa" },
      judgement: { evaluated: false, reason: "untrusted_spec", specification: { id: COMPRESSION.id, status: "informational", trust: "unverified", source, expected: { min: 900 } } },
    });
    expect(s.specifications[COMPRESSION.id]).toMatchObject({ status: "informational", specification: { trust: "unverified", source } });
  });

  it("8. replays deterministically, and a saved untrusted session resumes to the same result", () => {
    const options = compressionWith("unverified");
    const f = facts({ dtcs: ["P0301"] });
    const live = run(f, [...toCompression, reading(600)], W, options);
    const replayed = ok(replaySession(W, f, live.inputs, "2026-10-15T10:00:00Z", options));
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(live));
    const resumed = resumeSession(W, JSON.parse(JSON.stringify(live)));
    expect(resumed.ok && sessionOutcome(resumed.session)).toEqual(sessionOutcome(live));
  });

  it("an untrusted specification never decides whether a repair worked", () => {
    const w: WorkflowDefinition = {
      id: "test.trust-retest",
      version: 1,
      title: "Trust re-test",
      provenance: "SYNTHETIC: test only",
      faultModel: "single_primary_fault",
      causes: [{ id: "a", title: "A" }],
      nodes: [
        { id: "s", type: "start", title: "Start", next: "m" },
        {
          id: "m",
          type: "measurement",
          title: "M",
          measurement: { quantity: "Q", unit: "V", plausible: { min: 0, max: 20 } },
          specification: "test.v_min",
          outcomes: [{ id: "ok", when: { relativeToSpec: "within" }, to: "c" }],
          otherwise: "c",
          ifUnsupported: "e",
          ifInconclusive: "c",
        },
        { id: "c", type: "conclusion", title: "A", cause: "a", recommendation: "Fix A.", next: "v" },
        { id: "v", type: "repair_verification", title: "V", criteria: [{ id: "r", kind: "retest", step: "m", passWhen: ["ok"] }], ifVerified: "e", ifNotVerified: "e", ifInconclusive: "e" },
        { id: "e", type: "end", title: "End", result: "concluded" },
      ],
    };
    const options = vSpec("reference");
    const s = run(facts(), [{ nodeId: "m", kind: "measurement", value: 13, unit: "V" }], w, options);
    const done = ok(submitStep(w, s, { nodeId: "v", kind: "verification", results: [{ criterion: "r", value: 13, unit: "V" }] }, undefined, options));
    expect(done).toMatchObject({ verification: "inconclusive", repairVerified: null });
    expect(done.evidence.find((e) => e.criterion === "r")).toMatchObject({ judgement: { evaluated: false, reason: "untrusted_spec" } });
  });
});

describe("V2A: separating tests are only steps the session can still reach", () => {
  it("leaves out steps on another branch", () => {
    const atVacuum = run(facts({ dtcs: ["P0300"] }), MULTI);
    expect(atVacuum.currentNodeId).toBe("multi_vacuum");
    // The coil swap and plug check could separate causes, but this session cannot reach them.
    expect(separatingSteps(W, atVacuum).map((x) => x.nodeId)).toEqual(["fuel_pressure"]);
    const atPrereq = run(facts({ dtcs: ["P0301"] }), MULTI);
    expect(separatingSteps(W, atPrereq).map((x) => x.nodeId)).not.toContain("fuel_pressure");
  });

  it("lists nothing once the session is complete or only verification is left", () => {
    expect(separatingSteps(W, atCoilVerify())).toEqual([]);
    expect(separatingSteps(W, run(facts({ dtcs: ["P0300"] }), [yes("confirm_symptom"), yes("flashing_light")]))).toEqual([]);
  });
});

/* ───────────────────────── repair verification ───────────────────────── */

describe("V2A: repair verification", () => {
  const verifyCoil = (results: VerificationEntry[]) =>
    submitStep(W, atCoilVerify(), { nodeId: "verify_repair", kind: "verification", results });

  it("is verified only when every criterion is met", () => {
    const s = ok(verifyCoil([{ criterion: "smooth", result: "met" }, { criterion: "codes_gone", scan: afterScan() }]));
    expect(s).toMatchObject({ status: "completed", endResult: "resolved", verification: "verified", repairVerified: true, conclusionNodeId: "concl_coil" });
  });

  it("is not verified when any criterion is not met, even if another is inconclusive", () => {
    const s = ok(verifyCoil([{ criterion: "smooth", result: "inconclusive" }, { criterion: "codes_gone", result: "not_met" }]));
    expect(s).toMatchObject({ endResult: "referred", verification: "not_verified", repairVerified: false, conclusionNodeId: "concl_not_fixed" });
  });

  it("is inconclusive when nothing failed but something could not be confirmed, and does not claim success", () => {
    const s = ok(verifyCoil([{ criterion: "smooth", result: "met" }, { criterion: "codes_gone", result: "inconclusive" }]));
    expect(s).toMatchObject({ status: "completed", endResult: "inconclusive", verification: "inconclusive", repairVerified: null, conclusionNodeId: "concl_verify_inconclusive" });
  });

  it("refuses a verification that does not answer each criterion exactly once", () => {
    expect(verifyCoil([{ criterion: "smooth", result: "met" }])).toEqual({ ok: false, error: expect.stringMatching(/^invalid_verification/) });
    expect(verifyCoil([{ criterion: "smooth", result: "met" }, { criterion: "smooth", result: "met" }])).toEqual({ ok: false, error: expect.stringMatching(/^invalid_verification/) });
    expect(verifyCoil([{ criterion: "smooth", result: "met" }, { criterion: "other", result: "met" }])).toEqual({ ok: false, error: expect.stringMatching(/^invalid_verification/) });
    expect(submitStep(W, atCoilVerify(), { nodeId: "verify_repair", kind: "verification", results: [{ criterion: "smooth", observed: "pass" }, { criterion: "codes_gone", scan: afterScan() }] })).toEqual({
      ok: false,
      error: expect.stringMatching(/^invalid_verification/),
    });
  });

  it("re-tests the step that found the fault and links the new result to the old one", () => {
    const s = atFuelVerify();
    const before = s.evidence.find((e) => e.nodeId === "fuel_pressure" && e.kind !== "specification")!;
    expect(before).toMatchObject({ phase: "before_repair", judgement: { evaluated: true, range: "below_min" } });
    const fixed = ok(submitStep(W, s, { nodeId: "verify_fuel_repair", kind: "verification", results: [{ criterion: "pressure_ok", value: 380, unit: "kPa" }, { criterion: "smooth", result: "met" }] }));
    expect(fixed).toMatchObject({ endResult: "resolved", verification: "verified" });
    expect(fixed.evidence.find((e) => e.criterion === "pressure_ok")).toMatchObject({
      kind: "verification_criterion",
      phase: "after_repair",
      source: "instrument",
      value: "met (380 kPa)",
      comparesTo: before.seq,
      measured: { value: 380, unit: "kPa" },
      judgement: { evaluated: true, range: "within" },
    });
    // Still low after the repair: not fixed, whatever the person feels.
    const still = ok(submitStep(W, s, { nodeId: "verify_fuel_repair", kind: "verification", results: [{ criterion: "pressure_ok", value: 210, unit: "kPa" }, { criterion: "smooth", result: "met" }] }));
    expect(still).toMatchObject({ verification: "not_verified", conclusionNodeId: "concl_not_fixed" });
  });

  it("refuses an implausible or wrong-kind re-test reading", () => {
    const s = atFuelVerify();
    expect(submitStep(W, s, { nodeId: "verify_fuel_repair", kind: "verification", results: [{ criterion: "pressure_ok", value: 4000, unit: "kPa" }, { criterion: "smooth", result: "met" }] })).toEqual({
      ok: false,
      error: expect.stringMatching(/implausible_measurement/),
    });
    expect(submitStep(W, s, { nodeId: "verify_fuel_repair", kind: "verification", results: [{ criterion: "pressure_ok", value: 12, unit: "V" }, { criterion: "smooth", result: "met" }] })).toEqual({
      ok: false,
      error: expect.stringMatching(/wrong_unit/),
    });
  });
});

/* ───────────────────────── resume: replay and compare results ───────────────────────── */

describe("V2A: resume replays the inputs and compares results, not the saved file", () => {
  const halfway = () => JSON.parse(JSON.stringify(run(facts({ dtcs: ["P0301"] }), [...SINGLE]))) as Record<string, unknown>;

  it("accepts a save with another key order, extra fields, and no V2A-only fields", () => {
    const saved = halfway();
    const reordered = Object.fromEntries(Object.entries(saved).reverse());
    expect(resumeSession(W, reordered).ok).toBe(true);
    const extra = { ...saved, savedBy: "some later version", evidence: (saved.evidence as object[]).map((e) => ({ note: "kept", ...e })) };
    expect(resumeSession(W, extra).ok).toBe(true);
    const older = { ...saved };
    for (const field of ["phase", "verification", "establishedConditions", "faultModel", "startedAt"]) delete older[field];
    const resumed = resumeSession(W, older);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(sessionOutcome(resumed.session)).toEqual(sessionOutcome(run(facts({ dtcs: ["P0301"] }), [...SINGLE])));
  });

  it("refuses a save whose inputs no longer lead to what it recorded", () => {
    const saved = halfway();
    expect(resumeSession(W, { ...saved, currentNodeId: "plug_inspection" }).ok).toBe(false);
    expect(resumeSession(W, { ...saved, supportedCauses: ["ignition_coil"] }).ok).toBe(false);
    expect(resumeSession(W, { ...saved, phase: "after_repair" })).toEqual({ ok: false, error: expect.stringMatching(/phase/) });
    expect(resumeSession(W, { ...saved, establishedConditions: [] })).toEqual({ ok: false, error: expect.stringMatching(/establishedConditions/) });
    const reRouted = { ...saved, evidence: (saved.evidence as Array<{ to: string }>).map((e, i) => (i === 1 ? { ...e, to: "concl_professional" } : e)) };
    expect(resumeSession(W, reRouted).ok).toBe(false);
    const dropped = { ...saved, evidence: (saved.evidence as object[]).slice(0, -1) };
    expect(resumeSession(W, dropped).ok).toBe(false);
  });

  it("resumes after the repair verification was reached, keeping the after-repair phase", () => {
    const saved = JSON.parse(JSON.stringify(atFuelVerify()));
    const resumed = resumeSession(W, saved);
    expect(resumed.ok && resumed.session.phase).toBe("after_repair");
  });
});
