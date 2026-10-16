/**
 * Guided Diagnostics V2E: next best test inside explicit reorderable regions,
 * and the limited post-repair recheck plan.
 *
 * Research prototype. No network, no database, no AI, no probabilities, no
 * costs. Every workflow, test, vehicle and specification here is SYNTHETIC /
 * TEST ONLY / NOT OEM DATA.
 */
import { describe, expect, it } from "vitest";
import {
  nextBestTests,
  recheckPlan,
  replaySession,
  startSession,
  submitStep,
  validateWorkflow,
  type DiagnosticCapabilityContext,
  type DiagnosticSession,
  type EngineOptions,
  type NextBestTests,
  type SessionStartFacts,
  type StepInput,
  type TestProfile,
  type VehicleContext,
  type WorkflowDefinition,
  type WorkflowNode,
} from "../app/lib/diagnostic-workflow";
import { SYNTHETIC_MISFIRE_WORKFLOW as W } from "../app/lib/diagnostic-workflow/examples/synthetic-misfire";
import { SYNTHETIC_SPECIFICATIONS } from "../app/lib/diagnostic-workflow/examples/synthetic-specifications";
import { createInMemorySpecificationProvider } from "../app/lib/diagnostic-workflow/examples/in-memory-specification-provider";
import { capabilityPreset } from "../app/lib/diagnostic-workflow/examples/capability-presets";
import { afterScan, withCodes, type TypedCodes } from "./helpers/workflow-scans";

const SPECS: EngineOptions = { specifications: createInMemorySpecificationProvider(SYNTHETIC_SPECIFICATIONS) };
const CAR: VehicleContext = { fuel: "gasoline", cylinders: 4 };
const facts = (capabilities: DiagnosticCapabilityContext, over: Partial<SessionStartFacts> & TypedCodes = {}): SessionStartFacts =>
  withCodes({ capabilities, vehicle: CAR, ...over });

function ok(r: ReturnType<typeof startSession>): DiagnosticSession {
  if (!r.ok) throw new Error(r.error);
  return r.session;
}
const run = (f: SessionStartFacts, inputs: StepInput[], workflow: WorkflowDefinition = W) => ok(replaySession(workflow, f, inputs, "2026-10-16T10:00:00Z", SPECS));
const yes = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "yes" });
const no = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "no" });
const pick = (test: string, nodeId = "primary_tests"): StepInput => ({ nodeId, kind: "select_test", test });
const seen = (nodeId: string, choice: string): StepInput => ({ nodeId, kind: "observation", choice });

/** To the fixture's reorderable region: pattern unknown, "help me test", vehicle secured. */
const TO_REGION: StepInput[] = [yes("confirm_symptom"), no("flashing_light"), { nodeId: "ask_pattern", kind: "choice", choice: "help_me_test" }, { nodeId: "region_secure", kind: "prerequisite", met: true }];
const atRegion = (caps: DiagnosticCapabilityContext, over: Partial<SessionStartFacts> & TypedCodes = {}, more: StepInput[] = []) => run(facts(caps, over), [...TO_REGION, ...more]);
type Region = Extract<NextBestTests, { status: "region" }>;
const region = (s: DiagnosticSession, w: WorkflowDefinition = W): Region => {
  const r = nextBestTests(w, s);
  if (r.status !== "region") throw new Error(`not in a region: ${r.reason}`);
  return r;
};
const order = (r: Region) => [r.recommended, ...r.alternatives].filter(Boolean).map((x) => x!.step);
const WORKSHOP = capabilityPreset("workshop");

/* ───────────────────────── a tiny synthetic region to isolate each ranking key ───────────────────────── */

type Cand = { id: string; profile?: Partial<TestProfile>; instruments?: string[]; level?: "owner" | "diy" | "professional"; pass?: string[]; fail?: string[]; failSupports?: string[]; hazards?: string[] };
const LOW: TestProfile = { risk: "low", invasiveness: "observe", setup: "none" };
function regionWorkflow(cands: Cand[]): WorkflowDefinition {
  return {
    id: "test.region",
    version: 1,
    title: "Region",
    provenance: "SYNTHETIC: test only",
    faultModel: "single_primary_fault",
    causes: ["a", "b", "c", "d"].map((id) => ({ id, title: id.toUpperCase() })),
    nodes: [
      { id: "s", type: "start", title: "Start", next: "sel" },
      { id: "sel", type: "test_selection", title: "Choose", group: "test_group", candidates: cands.map((c) => ({ step: c.id })), next: "e" },
      ...cands.map(
        (c): WorkflowNode => ({
          id: c.id,
          type: "check",
          title: c.id,
          requires: { level: c.level ?? "owner", ...(c.instruments ? { instruments: c.instruments as never } : {}), ...(c.hazards ? { hazards: c.hazards } : {}) },
          testProfile: { ...LOW, ...c.profile },
          outcomes: [
            { when: "pass", to: "sel", rulesOut: c.pass ?? [] },
            { when: "fail", to: "sel", rulesOut: c.fail ?? [], supports: c.failSupports ?? [] },
          ],
          ...((c.level && c.level !== "owner") || c.instruments ? { ifUnsupported: "sel" } : {}),
        }),
      ),
      { id: "e", type: "end", title: "End", result: "concluded" },
    ],
  };
}
const ALL_TOOLS: DiagnosticCapabilityContext = { skill: "professional", scanAccess: "bidirectional", instruments: ["multimeter", "oscilloscope", "hand_tools"], facilities: [] };
const rankOf = (cands: Cand[], caps = ALL_TOOLS) => {
  const w = regionWorkflow(cands);
  const v = validateWorkflow(w);
  if (!v.ok) throw new Error(JSON.stringify(v.problems));
  return region(run({ capabilities: caps }, [], w), w);
};

/* ───────────────────────── explicit regions only ───────────────────────── */

describe("V2E: ranking happens only inside an explicit reorderable region", () => {
  it("outside a region the workflow order is authoritative", () => {
    const s = run(facts(WORKSHOP, { dtcs: ["P0301"] }), [yes("confirm_symptom"), no("flashing_light")]);
    expect(nextBestTests(W, s)).toEqual({ status: "follow_workflow", currentStep: "single_prereq", reason: "not_in_a_reorderable_region" });
    expect(submitStep(W, s, pick("misfire_counters", "single_prereq"), undefined, SPECS)).toEqual({ ok: false, error: "wrong_input_kind" });
  });

  it("cannot be used to bypass workflow order: only this region's eligible tests can be chosen", () => {
    const s = atRegion(WORKSHOP);
    expect(submitStep(W, s, pick("coil_swap"), undefined, SPECS)).toEqual({ ok: false, error: expect.stringMatching(/^not_eligible: "coil_swap" \(not_in_region\)/) });
    expect(submitStep(W, s, pick("concl_coil"), undefined, SPECS)).toMatchObject({ ok: false });
    // The prerequisite before the region cannot be skipped: not met never reaches it.
    const unsecured = run(facts(WORKSHOP), [...TO_REGION.slice(0, 3), { nodeId: "region_secure", kind: "prerequisite", met: false }]);
    expect(unsecured).toMatchObject({ conclusionNodeId: "concl_secure_first", status: "completed" });
    expect(unsecured.evidence.some((e) => e.nodeId === "primary_tests")).toBe(false);
  });

  it("the validator rejects malformed regions", () => {
    const base = regionWorkflow([{ id: "t1", pass: ["a"] }, { id: "t2", pass: ["b"] }]);
    expect(validateWorkflow(base)).toEqual({ ok: true });
    const codes = (w: WorkflowDefinition) => {
      const r = validateWorkflow(w);
      return r.ok ? [] : r.problems.map((p) => p.code);
    };
    const change = (fn: (n: WorkflowNode[]) => WorkflowNode[]) => codes({ ...base, nodes: fn(base.nodes) });
    const sel = (patch: object) => change((ns) => ns.map((n) => (n.id === "sel" ? ({ ...n, ...patch } as WorkflowNode) : n)));
    expect(sel({ candidates: [{ step: "t1" }] })).toContain("invalid_region"); // a single candidate
    expect(sel({ candidates: [{ step: "t1" }, { step: "t1" }] })).toContain("invalid_region"); // a duplicate
    expect(sel({ group: "Bad Group!" })).toContain("invalid_region");
    expect(change((ns) => ns.map((n) => (n.id === "t2" ? ({ ...n, testProfile: undefined } as WorkflowNode) : n)))).toContain("invalid_region"); // no profile
    // A candidate that leads straight to another candidate (a fixed order inside the region).
    expect(change((ns) => ns.map((n) => (n.id === "t1" ? ({ ...n, outcomes: [{ when: "pass", to: "t2" }, { when: "fail", to: "sel" }] } as WorkflowNode) : n)))).toContain("invalid_region");
    // Reached from outside the region: the order could be bypassed.
    expect(change((ns) => ns.map((n) => (n.id === "s" ? ({ ...n, next: "t1" } as WorkflowNode) : n)))).toContain("invalid_region");
    // A non-test step as a candidate.
    const withAction = { ...base, nodes: [...base.nodes.map((n) => (n.id === "sel" ? ({ ...n, candidates: [{ step: "t1" }, { step: "act" }] } as WorkflowNode) : n)), { id: "act", type: "action", title: "Act", next: "sel", testProfile: LOW } as WorkflowNode] };
    expect(codes(withAction)).toContain("invalid_region");
    // A high-risk test must state its hazards.
    expect(change((ns) => ns.map((n) => (n.id === "t1" ? ({ ...n, testProfile: { ...LOW, risk: "high" } } as WorkflowNode) : n)))).toContain("no_hazards");
  });
});

/* ───────────────────────── eligibility ───────────────────────── */

describe("V2E: eligibility comes before ranking", () => {
  it("excludes an unreachable candidate (its guard is definitely false)", () => {
    const r = region(atRegion(WORKSHOP, { vehicle: { ...CAR, engine: "some-other-engine" } }));
    expect(order(r)).not.toContain("injector_balance");
    expect(r.potential).toEqual([]);
    expect(r.excluded).toContainEqual({ step: "injector_balance", reason: "not_applicable" });
  });

  it("keeps a candidate needing missing context out of the ranking, reported as potential (unknown is not no)", () => {
    const s = atRegion(WORKSHOP);
    const r = region(s);
    expect(order(r)).not.toContain("injector_balance");
    expect(r.potential).toEqual([{ step: "injector_balance", title: expect.any(String), missingContext: ["vehicle:engine"], separates: expect.arrayContaining(["injector"]) }]);
    expect(submitStep(W, s, pick("injector_balance"), undefined, SPECS)).toEqual({ ok: false, error: 'not_eligible: "injector_balance" (missing_context)' });
    // With the context known, it competes.
    expect(order(region(atRegion(WORKSHOP, { vehicle: { ...CAR, engine: "synthetic-i4-a" } })))).toContain("injector_balance");
  });

  it("excludes a candidate the person cannot do, and reports it separately (never as evidence)", () => {
    const s = atRegion(capabilityPreset("diy"));
    const r = region(s);
    expect(order(r)).not.toContain("misfire_counters");
    expect(r.blocked).toContainEqual({ step: "misfire_counters", title: expect.any(String), reason: "capability", missing: ["scan_access:live_data"], separates: expect.any(Array) });
    expect(submitStep(W, s, pick("misfire_counters"), undefined, SPECS)).toEqual({ ok: false, error: 'not_eligible: "misfire_counters" (capability)' });
    expect(s.remainingCauses).toEqual(W.causes.map((c) => c.id));
  });

  it("excludes a candidate whose prerequisite conditions are not established", () => {
    const r = region(atRegion(WORKSHOP));
    expect(r.blocked).toContainEqual({ step: "compression_check", title: expect.any(String), reason: "conditions", missing: ["condition:engine_off_cool"], separates: ["low_compression"] });
    expect(order(r)).not.toContain("compression_check");
  });

  it("does not recommend a completed test again", () => {
    const s = atRegion(WORKSHOP, {}, [pick("misfire_counters"), seen("misfire_counters", "one_cylinder")]);
    const r = region(s);
    expect(order(r)).not.toContain("misfire_counters");
    expect(r.excluded).toContainEqual({ step: "misfire_counters", reason: "already_done" });
    expect(submitStep(W, s, pick("misfire_counters"), undefined, SPECS)).toMatchObject({ ok: false, error: expect.stringMatching(/already_done/) });
  });

  it("does not offer a test that could conclude a cause the evidence already ruled out", () => {
    const s = atRegion(WORKSHOP, { vehicle: { ...CAR, engine: "synthetic-i4-a" } }, [pick("misfire_counters"), seen("misfire_counters", "several")]);
    expect(region(s).excluded).toContainEqual({ step: "injector_balance", reason: "could_conclude_a_ruled_out_cause" });
  });
});

/* ───────────────────────── ranking ───────────────────────── */

describe("V2E: deterministic ranking", () => {
  it("prefers the more discriminating test when otherwise comparable", () => {
    const r = rankOf([{ id: "narrow", pass: ["a"], failSupports: ["b"] }, { id: "wide", pass: ["a", "b"], fail: ["c", "d"] }]);
    expect(order(r)).toEqual(["wide", "narrow"]);
    expect(r.recommended!.preferredOver[0]).toEqual({ step: "narrow", because: "separates more: at most 2 causes remain whatever the result, vs 4" });
  });

  it("lets decisiveness break a tie in worst-case separation", () => {
    const r = rankOf([{ id: "partial", pass: ["a"] }, { id: "decisive", pass: ["a"], failSupports: ["b"] }]);
    expect(order(r)).toEqual(["decisive", "partial"]);
    expect(r.recommended).toMatchObject({ decisiveness: "decisive", preferredOver: [{ step: "partial", because: "every possible result changes the remaining causes" }] });
  });

  it("prefers the less invasive, then the lower-setup, then the fewer-instrument test when diagnostic value is equal", () => {
    const same = { pass: ["a"], fail: ["b"] };
    expect(order(rankOf([{ id: "unplug", profile: { invasiveness: "disconnect" }, ...same }, { id: "look", ...same }]))).toEqual(["look", "unplug"]);
    expect(order(rankOf([{ id: "rig", profile: { setup: "significant" }, ...same }, { id: "quick", profile: { setup: "minor" }, ...same }]))).toEqual(["quick", "rig"]);
    const tools = rankOf([{ id: "two", instruments: ["multimeter", "oscilloscope"], ...same }, { id: "one", instruments: ["multimeter"], ...same }]);
    expect(order(tools)).toEqual(["one", "two"]);
    expect(tools.recommended!.preferredOver[0].because).toBe("needs fewer additional instruments or facilities");
  });

  it("lets safety dominate: a riskier test loses even when it separates more, and keeps its warnings", () => {
    const r = rankOf([{ id: "powerful", profile: { risk: "moderate" }, pass: ["a", "b"], fail: ["c", "d"], hazards: ["High voltage"] }, { id: "gentle", pass: ["a"], fail: ["b"] }]);
    expect(order(r)).toEqual(["gentle", "powerful"]);
    expect(r.recommended!.preferredOver[0].because).toBe("lower risk (low vs moderate)");
    expect(r.alternatives[0].hazards).toEqual(["High voltage"]);
    // When the hazardous test is the only legitimate one, it is recommended with its hazards intact.
    const only = rankOf([{ id: "only", profile: { risk: "high" }, pass: ["a"], fail: ["b"], hazards: ["Disable fuel and ignition before cranking"] }, { id: "useless" }]);
    expect(only.recommended).toMatchObject({ step: "only", profile: { risk: "high" }, hazards: ["Disable fuel and ignition before cranking"] });
    expect(only.excluded).toContainEqual({ step: "useless", reason: "cannot_change_remaining_causes" });
  });

  it("breaks exact ties by the author's order, stably", () => {
    const same = { pass: ["a"], fail: ["b"] };
    expect(order(rankOf([{ id: "first", ...same }, { id: "second", ...same }]))).toEqual(["first", "second"]);
    expect(order(rankOf([{ id: "second", ...same }, { id: "first", ...same }]))).toEqual(["second", "first"]);
    const r = rankOf([{ id: "x", ...same }, { id: "y", ...same }]);
    expect(r.recommended!.preferredOver[0].because).toBe("listed earlier by the workflow author (otherwise equivalent)");
    expect(JSON.stringify(rankOf([{ id: "x", ...same }, { id: "y", ...same }]))).toBe(JSON.stringify(r));
  });

  it("explains a recommendation with facts, never a score, probability, confidence or cost", () => {
    const r = region(atRegion(WORKSHOP));
    expect(r.recommended).toMatchObject({
      step: "misfire_counters",
      eligibleBecause: expect.arrayContaining(['part of the reorderable region "misfire_primary_tests"', "your capabilities cover it"]),
      separates: { causes: expect.arrayContaining(["vacuum_leak", "ignition_coil"]), remainingNow: 7, worstCaseRemaining: 5 },
      decisiveness: "decisive",
      profile: { risk: "low", invasiveness: "read_data", setup: "minor" },
      requires: { level: "diy", scan: "live_data", instruments: [], facilities: [] },
      hazards: ["Engine running: keep clear of moving parts"],
    });
    expect(JSON.stringify(nextBestTests(W, atRegion(WORKSHOP)))).not.toMatch(/probab|confiden|percent|%|score|cost|price|\$|minute|hour/i);
  });
});

/* ───────────────────────── capability levels and evidence ───────────────────────── */

describe("V2E: recommendations follow capability and evidence", () => {
  it("gives each capability level the best test it can actually do", () => {
    expect(region(atRegion(capabilityPreset("basic"))).recommended?.step).toBe("listen_intake_leak");
    const diy = region(atRegion(capabilityPreset("diy")));
    expect(order(diy)).toEqual(["listen_intake_leak", "coil_connector_check"]);
    expect(diy.recommended!.preferredOver).toEqual([{ step: "coil_connector_check", because: "less invasive (observe vs disconnect)" }]);
    expect(region(atRegion(capabilityPreset("advanced_diy"))).recommended?.step).toBe("misfire_counters");
    expect(order(region(atRegion(WORKSHOP)))).toEqual(["misfire_counters", "listen_intake_leak", "coil_connector_check", "ignition_scope", "fuel_pump_command"]);
  });

  it("never lets an unavailable advanced test beat an available one, and reports the blocked useful tests", () => {
    const diy = region(atRegion(capabilityPreset("diy")));
    expect(diy.blocked.map((b) => [b.step, b.reason])).toEqual([
      ["misfire_counters", "capability"],
      ["ignition_scope", "capability"],
      ["fuel_pump_command", "capability"],
      ["compression_check", "capability"],
    ]);
  });

  it("changes the next recommendation as evidence changes the causes", () => {
    const after = region(atRegion(WORKSHOP, {}, [pick("misfire_counters"), seen("misfire_counters", "one_cylinder")]));
    // The intake and fuel tests can no longer change anything; the safer connector check now beats the scope.
    expect(order(after)).toEqual(["coil_connector_check", "ignition_scope"]);
    expect(after.excluded).toEqual(expect.arrayContaining([{ step: "listen_intake_leak", reason: "cannot_change_remaining_causes" }, { step: "fuel_pump_command", reason: "cannot_change_remaining_causes" }]));
    expect(after.alternatives[0].separates).toMatchObject({ remainingNow: 5, worstCaseRemaining: 3 });
    const several = region(atRegion(WORKSHOP, {}, [pick("misfire_counters"), seen("misfire_counters", "several")]));
    expect(order(several)).toEqual(["listen_intake_leak", "coil_connector_check", "fuel_pump_command"]);
  });

  it("records the choice and the recommendation; the recommendation is advice, not a constraint", () => {
    const s = atRegion(WORKSHOP, {}, [pick("ignition_scope")]);
    expect(s.evidence.find((e) => e.kind === "test_selection")).toMatchObject({ value: "ignition_scope", recommendedTest: "misfire_counters", source: "person", to: "ignition_scope" });
    expect(s.currentNodeId).toBe("ignition_scope");
  });

  it("leaves the region on its own when no eligible test can change the causes", () => {
    const s = atRegion(capabilityPreset("basic"), {}, [pick("listen_intake_leak"), seen("listen_intake_leak", "nothing_found")]);
    expect(s.evidence.find((e) => e.kind === "test_selection" && e.source === "engine")).toMatchObject({ value: "exhausted:no_eligible_test_can_change_the_causes", to: "concl_professional" });
    expect(s).toMatchObject({ conclusionNodeId: "concl_professional", endResult: "referred" });
  });
});

/* ───────────────────────── recheck after repair ───────────────────────── */

describe("V2E: limited recheck after repair", () => {
  const MULTI = (last: StepInput): StepInput[] => [yes("confirm_symptom"), no("flashing_light"), seen("multi_vacuum", "nothing_found"), last];
  const pumpSilent = () => run(facts(WORKSHOP, { dtcs: ["P0300"] }), MULTI({ nodeId: "fuel_pump_actuator", kind: "actuator_result", result: "no_response" }));
  const coilRoute = () => run(facts(WORKSHOP, { dtcs: ["P0301"] }), [yes("confirm_symptom"), no("flashing_light"), { nodeId: "single_prereq", kind: "prerequisite", met: true }, yes("coil_swap")]);

  it("starts from the test that actually detected the fault, then the workflow's own criteria, nothing unrelated", () => {
    const s = pumpSilent();
    expect(s.currentNodeId).toBe("verify_fuel_repair");
    const plan = recheckPlan(W, s);
    expect(plan).toMatchObject({ status: "plan", verificationStep: "verify_fuel_repair", conclusion: "concl_fuel_supply", cause: "fuel_supply" });
    if (plan.status !== "plan") return;
    expect(plan.items.map((i) => (i.kind === "detecting_test" ? `detect:${i.step}` : `${i.criterionKind}:${i.criterion}`))).toEqual(["detect:fuel_pump_actuator", "retest:pressure_ok", "symptom_absent:smooth"]);
    expect(plan.items[0]).toMatchObject({ repeatable: true, result: "no_response", hazards: [expect.stringMatching(/no open flames/)] });
    expect(plan.items[0]).not.toHaveProperty("coveredBy");
    expect(JSON.stringify(plan)).not.toMatch(/multi_vacuum|confirm_symptom|flashing_light/);
  });

  it("links a detecting test to the criterion that repeats it, without listing it twice", () => {
    const s = run(facts(WORKSHOP, { dtcs: ["P0300"] }), [...MULTI({ nodeId: "fuel_pump_actuator", kind: "actuator_result", result: "runs" }), { nodeId: "fuel_pressure", kind: "measurement", value: 200, unit: "kPa" }]);
    const plan = recheckPlan(W, s);
    if (plan.status !== "plan") throw new Error("no plan");
    expect(plan.items.map((i) => (i.kind === "detecting_test" ? `detect:${i.step}` : `${i.criterionKind}:${i.criterion}`))).toEqual(["detect:fuel_pressure", "symptom_absent:smooth"]);
    expect(plan.items[0]).toMatchObject({ repeatable: true, result: "below_min", coveredBy: "pressure_ok" });
  });

  it("does not blindly repeat a detecting test the workflow marks as not repeatable", () => {
    const plan = recheckPlan(W, coilRoute());
    if (plan.status !== "plan") throw new Error("no plan");
    expect(plan.items[0]).toEqual({ kind: "detecting_test", step: "coil_swap", title: expect.any(String), evidenceSeq: expect.any(Number), result: "yes", repeatable: false, reason: "workflow_marks_not_repeatable" });
    expect(plan.items[1]).toMatchObject({ kind: "criterion", criterionKind: "codes_absent", note: expect.stringMatching(/COMPLETE post-repair scan/) });
  });

  it("does not mark anything verified, and V2D scan rules still decide the verdict", () => {
    const s = coilRoute();
    const before = JSON.stringify(s);
    recheckPlan(W, s);
    expect(JSON.stringify(s)).toBe(before);
    expect(s).toMatchObject({ verification: null, repairVerified: null, status: "in_progress" });
    const verify = (scan = afterScan()) => ok(submitStep(W, s, { nodeId: "verify_repair", kind: "verification", results: [{ criterion: "smooth", result: "met" }, { criterion: "codes_gone", scan }] }, undefined, SPECS));
    expect(verify(afterScan([], { completeness: "partial" }))).toMatchObject({ verification: "inconclusive" });
    expect(verify(afterScan([{ code: "P0301", status: ["permanent"] }]))).toMatchObject({ verification: "inconclusive" });
    expect(verify()).toMatchObject({ verification: "verified" });
    expect(recheckPlan(W, verify())).toEqual({ status: "not_at_verification" });
  });
});

/* ───────────────────────── determinism and the fixture ───────────────────────── */

describe("V2E: determinism and the synthetic fixture", () => {
  it("replays to identical recommendations and recheck plans", () => {
    const inputs = [...TO_REGION, pick("misfire_counters"), seen("misfire_counters", "one_cylinder")];
    const a = run(facts(WORKSHOP), inputs);
    const b = run(facts(WORKSHOP), a.inputs as StepInput[]);
    expect(JSON.stringify(nextBestTests(W, b))).toBe(JSON.stringify(nextBestTests(W, a)));
    const f = facts(WORKSHOP, { dtcs: ["P0300"] });
    const multi = [yes("confirm_symptom"), no("flashing_light"), seen("multi_vacuum", "nothing_found"), { nodeId: "fuel_pump_actuator", kind: "actuator_result", result: "no_response" } as StepInput];
    expect(JSON.stringify(recheckPlan(W, run(f, multi)))).toBe(JSON.stringify(recheckPlan(W, run(f, multi))));
  });

  it("runs the region end to end in a workshop: counters, connectors, then the scope finds the coil", () => {
    const s = atRegion(WORKSHOP, {}, [
      pick("misfire_counters"),
      seen("misfire_counters", "one_cylinder"),
      pick("coil_connector_check"),
      seen("coil_connector_check", "ok"),
      pick("ignition_scope"),
      { nodeId: "ignition_scope", kind: "check", result: "fail" },
    ]);
    expect(s).toMatchObject({ conclusionNodeId: "concl_coil", currentNodeId: "verify_repair", supportedCauses: ["ignition_coil"] });
    expect(s.evidence.filter((e) => e.kind === "test_selection").map((e) => [e.value, e.recommendedTest])).toEqual([
      ["misfire_counters", "misfire_counters"],
      ["coil_connector_check", "coil_connector_check"],
      ["ignition_scope", "ignition_scope"],
    ]);
    const plan = recheckPlan(W, s);
    expect(plan.status === "plan" && plan.items[0]).toMatchObject({ kind: "detecting_test", step: "ignition_scope", repeatable: true });
  });

  it("is a valid version 6 workflow whose earlier routes are unchanged", () => {
    expect(validateWorkflow(W)).toEqual({ ok: true });
    expect(W.version).toBe(6);
    expect(run(facts(WORKSHOP, { dtcs: ["P0301"] }), [yes("confirm_symptom"), no("flashing_light")]).currentNodeId).toBe("single_prereq");
  });
});
