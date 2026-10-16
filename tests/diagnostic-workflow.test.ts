/**
 * The guided diagnostic workflow engine (research prototype).
 *
 * Every test here runs the engine directly: no network, no database, no AI.
 * The workflow used is SYNTHETIC (see app/lib/diagnostic-workflow/examples).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { afterScan, withCodes, type TypedCodes } from "./helpers/workflow-scans";
import {
  convert,
  currentStep,
  replaySession,
  resumeSession,
  startSession,
  submitStep,
  validateWorkflow,
  type DiagnosticCapabilityContext,
  type DiagnosticSession,
  type EngineOptions,
  type SessionStartFacts,
  type StepInput,
  type WorkflowDefinition,
  type WorkflowNode,
} from "../app/lib/diagnostic-workflow";
import { SYNTHETIC_MISFIRE_WORKFLOW as W } from "../app/lib/diagnostic-workflow/examples/synthetic-misfire";
// Retired from the public API (nextBestTests replaced it); imported from the engine only to keep these regression checks.
import { separatingSteps } from "../app/lib/diagnostic-workflow/engine";
import { SYNTHETIC_SPECIFICATIONS } from "../app/lib/diagnostic-workflow/examples/synthetic-specifications";
import { createInMemorySpecificationProvider } from "../app/lib/diagnostic-workflow/examples/in-memory-specification-provider";

/** SYNTHETIC / TEST ONLY specifications, through the in-memory provider. Not values for any vehicle. */
const SPECS: EngineOptions = { specifications: createInMemorySpecificationProvider(SYNTHETIC_SPECIFICATIONS) };

/** Explicit capabilities (V2C). Live data but no bidirectional control, so actuator tests are skipped. */
const PRO: DiagnosticCapabilityContext = { skill: "professional", scanAccess: "live_data", instruments: ["hand_tools", "compression_tester", "pressure_gauge"], facilities: [] };
/** A synthetic vehicle the synthetic misfire workflow applies to. Not a real vehicle. */
const SYNTHETIC_VEHICLE = { fuel: "gasoline" as const, cylinders: 4 };
const DIY: DiagnosticCapabilityContext = { skill: "diy", scanAccess: "codes", instruments: ["hand_tools"], facilities: [] };
const OWNER: DiagnosticCapabilityContext = { skill: "owner", scanAccess: "none", instruments: [], facilities: [] };

const facts = (over: Partial<SessionStartFacts> & TypedCodes = {}): SessionStartFacts => withCodes({ capabilities: PRO, vehicle: SYNTHETIC_VEHICLE, ...over });

function started(f: SessionStartFacts = facts(), at = "2026-10-15T10:00:00Z"): DiagnosticSession {
  const r = startSession(W, f, at, SPECS);
  if (!r.ok) throw new Error(r.error);
  return r.session;
}

function step(session: DiagnosticSession, input: StepInput, at?: string): DiagnosticSession {
  const r = submitStep(W, session, input, at, SPECS);
  if (!r.ok) throw new Error(`${input.nodeId}: ${r.error}`);
  return r.session;
}

/** Answer a sequence of inputs, each for the step the session is waiting on. */
function run(f: SessionStartFacts, inputs: StepInput[]): DiagnosticSession {
  return inputs.reduce((s, input) => step(s, input), started(f));
}

const yes = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "yes" });
const no = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "no" });
const pathOf = (s: DiagnosticSession) => s.evidence.filter((e) => !["scan", "code", "snapshot", "symptom", "specification"].includes(e.kind)).map((e) => e.nodeId);

/** A small valid workflow to break in different ways. */
function tiny(): WorkflowDefinition {
  return {
    id: "test.tiny",
    version: 1,
    title: "Tiny",
    provenance: "SYNTHETIC: test only",
    faultModel: "single_primary_fault",
    causes: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
    nodes: [
      { id: "s", type: "start", title: "Start", next: "q" },
      { id: "q", type: "question", answer: "yes_no", title: "Q", outcomes: [{ when: "yes", to: "c1", rulesOut: ["b"] }, { when: "no", to: "c2", rulesOut: ["a"] }] },
      { id: "c1", type: "conclusion", title: "A", cause: "a", recommendation: "Fix A.", next: "e" },
      { id: "c2", type: "conclusion", title: "B", cause: "b", recommendation: "Fix B.", next: "e" },
      { id: "e", type: "end", title: "End", result: "concluded" },
    ],
  };
}
const codes = (w: WorkflowDefinition) => {
  const r = validateWorkflow(w);
  return r.ok ? [] : r.problems.map((p) => p.code);
};
const withNodes = (mutate: (nodes: WorkflowNode[]) => WorkflowNode[]): WorkflowDefinition => {
  const w = tiny();
  return { ...w, nodes: mutate(w.nodes) };
};

/* ───────────────────────── checking a workflow ───────────────────────── */

describe("checking a workflow", () => {
  it("accepts a valid workflow, including the synthetic misfire example", () => {
    expect(validateWorkflow(tiny())).toEqual({ ok: true });
    expect(validateWorkflow(W)).toEqual({ ok: true });
    expect(W.provenance).toMatch(/SYNTHETIC/);
    expect(W.provenance).toMatch(/Not BMW data, not ISTA data/);
  });

  it("refuses a workflow that is not well formed, and will not run it", () => {
    expect(codes({} as WorkflowDefinition)).toEqual(["malformed"]);
    expect(codes({ ...tiny(), version: 0 })).toContain("malformed");
    expect(codes({ ...tiny(), provenance: " " })).toContain("no_provenance");
    const r = startSession({ ...tiny(), provenance: "" }, facts());
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/^invalid_workflow/);
  });

  it("needs exactly one start node", () => {
    expect(codes(withNodes((n) => n.filter((x) => x.type !== "start")))).toContain("no_start");
    expect(codes(withNodes((n) => [...n, { id: "s2", type: "start", title: "Again", next: "q" }]))).toContain("multiple_starts");
  });

  it("refuses duplicate node ids", () => {
    expect(codes(withNodes((n) => [...n, { id: "q", type: "end", title: "Dup", result: "concluded" }]))).toContain("duplicate_id");
  });

  it("refuses a transition to a step that does not exist", () => {
    expect(codes(withNodes((n) => n.map((x) => (x.id === "c1" ? { ...x, next: "nowhere" } : x)) as WorkflowNode[]))).toContain("broken_transition");
  });

  it("finds steps that can never be reached", () => {
    const w = withNodes((n) => [...n, { id: "orphan", type: "end", title: "Orphan", result: "concluded" }]);
    const r = validateWorkflow(w);
    expect(!r.ok && r.problems.find((p) => p.code === "unreachable")?.nodeId).toBe("orphan");
  });

  it("refuses loops, so every run is guaranteed to end", () => {
    const w = withNodes((n) =>
      n.map((x) => (x.id === "q" ? { ...x, outcomes: [{ when: "yes", to: "back" }, { when: "no", to: "c2" }] } : x)).concat([{ id: "back", type: "action", title: "Back", next: "q" }]) as WorkflowNode[],
    );
    const r = validateWorkflow(w);
    expect(!r.ok && r.problems.find((p) => p.code === "cycle")?.message).toMatch(/q → back → q/);
    expect(startSession(w, facts()).ok).toBe(false);
  });

  it("requires every possible answer to lead somewhere", () => {
    expect(codes(withNodes((n) => n.map((x) => (x.id === "q" ? { ...x, outcomes: [{ when: "yes", to: "c1" }] } : x)) as WorkflowNode[]))).toContain("incomplete_outcomes");
    const choice = withNodes((n) =>
      n.map((x) => (x.id === "q" ? { id: "q", type: "question", answer: "choice", title: "Q", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }], outcomes: [{ when: "x", to: "c1" }, { when: "z", to: "c2" }] } : x)) as WorkflowNode[],
    );
    expect(codes(choice)).toEqual(expect.arrayContaining(["unknown_option", "incomplete_outcomes"]));
  });

  it("refuses bad measurements: unknown units and impossible ranges", () => {
    const m = (unit: string, when: object) =>
      withNodes((n) =>
        n.map((x) => (x.id === "q" ? { id: "q", type: "measurement", title: "M", measurement: { quantity: "Q", unit }, outcomes: [{ when, to: "c1" }], otherwise: "c2" } : x)) as WorkflowNode[],
      );
    expect(codes(m("furlongs", { min: 1 }))).toContain("unknown_unit");
    expect(codes(m("V", { min: 5, max: 1 }))).toContain("invalid_range");
    expect(codes(m("V", {}))).toContain("invalid_range");
    expect(codes(m("V", { min: Number.NaN }))).toContain("invalid_range");
    // A vehicle specification needs a route for when it is missing.
    // Vehicle values never sit in a workflow range.
    expect(codes(m("kPa", { min: { spec: "x" } }))).toContain("invalid_range");
    // A step judged against a specification needs a route for when it cannot be resolved.
    const withSpec = withNodes((n) =>
      n.map((x) => (x.id === "q" ? { id: "q", type: "measurement", title: "M", measurement: { quantity: "Q", unit: "kPa", plausible: { min: 0, max: 10 } }, specification: "x", outcomes: [{ id: "low", when: { relativeToSpec: "below" }, to: "c1" }], otherwise: "c2" } : x)) as WorkflowNode[],
    );
    expect(codes(withSpec)).toContain("no_unsupported_route");
  });

  it("requires a 'cannot be done' route for any step needing skill or tools", () => {
    const w = withNodes((n) => n.map((x) => (x.id === "q" ? { ...x, requires: { level: "professional" } } : x)) as WorkflowNode[]);
    expect(codes(w)).toContain("no_unsupported_route");
  });

  it("refuses references to unknown causes, and a conclusion that leads anywhere but a verification or the end", () => {
    expect(codes(withNodes((n) => n.map((x) => (x.id === "c1" ? { ...x, cause: "zzz" } : x)) as WorkflowNode[]))).toContain("unknown_cause");
    expect(codes(withNodes((n) => n.map((x) => (x.id === "c1" ? { ...x, next: "q" } : x)) as WorkflowNode[]))).toEqual(expect.arrayContaining(["bad_conclusion_next"]));
  });
});

/* ───────────────────────── running a workflow ───────────────────────── */

describe("running a workflow", () => {
  it("records the starting codes and symptoms as evidence and stops at the first question", () => {
    const s = started(facts({ dtcs: [" p0303 "], symptoms: ["rough_idle"] }));
    expect(s.status).toBe("in_progress");
    expect(s.currentNodeId).toBe("confirm_symptom");
    expect(currentStep(W, s)?.title).toBe("Confirm the symptom");
    expect(s.evidence.map((e) => [e.seq, e.kind, e.value])).toEqual([
      [1, "scan", "start"],
      [2, "code", "P0303"],
      [3, "symptom", "rough_idle"],
    ]);
    expect(s.remainingCauses).toEqual(W.causes.map((c) => c.id));
  });

  it("branches on yes and no", () => {
    const yesPath = step(started(), yes("confirm_symptom"));
    expect(yesPath.currentNodeId).toBe("flashing_light");
    const noPath = step(started(), no("confirm_symptom"));
    expect(noPath).toMatchObject({ status: "completed", conclusionNodeId: "concl_intermittent", endResult: "not_reproducible" });
  });

  it("branches on a multiple choice answer", () => {
    const base = run(facts(), [yes("confirm_symptom"), no("flashing_light")]);
    expect(base.currentNodeId).toBe("ask_pattern"); // no codes: it has to ask
    expect(step(base, { nodeId: "ask_pattern", kind: "choice", choice: "one" }).currentNodeId).toBe("single_prereq");
    expect(step(base, { nodeId: "ask_pattern", kind: "choice", choice: "several" }).currentNodeId).toBe("multi_vacuum");
    expect(step(base, { nodeId: "ask_pattern", kind: "choice", choice: "unknown" })).toMatchObject({ status: "completed", conclusionNodeId: "concl_read_codes" });
  });

  it("decides automatic branches from the codes it was given", () => {
    expect(run(facts({ dtcs: ["P0302"] }), [yes("confirm_symptom"), no("flashing_light")]).currentNodeId).toBe("single_prereq");
    expect(run(facts({ dtcs: ["P0300"] }), [yes("confirm_symptom"), no("flashing_light")]).currentNodeId).toBe("multi_vacuum");
    const s = run(facts({ dtcs: ["P0302"] }), [yes("confirm_symptom"), no("flashing_light")]);
    expect(s.evidence.find((e) => e.nodeId === "pattern")).toMatchObject({ kind: "branch", value: "rule:1", to: "single_prereq" });
    expect(s.remainingCauses).not.toContain("fuel_supply"); // one cylinder: the shared fuel supply is ruled out
  });

  it("handles prerequisites: met goes on, not met goes through what makes it true", () => {
    const at = run(facts({ dtcs: ["P0301"] }), [yes("confirm_symptom"), no("flashing_light")]);
    expect(step(at, { nodeId: "single_prereq", kind: "prerequisite", met: true }).currentNodeId).toBe("coil_swap");
    const notMet = step(at, { nodeId: "single_prereq", kind: "prerequisite", met: false });
    expect(notMet.currentNodeId).toBe("wait_cool");
    expect(step(notMet, { nodeId: "wait_cool", kind: "done" }).currentNodeId).toBe("coil_swap");
    expect(notMet.evidence.at(-1)).toMatchObject({ kind: "prerequisite", value: "not_met" });
  });

  it("branches on a measurement, with inclusive and exclusive bounds", () => {
    const toCompression = run(facts({ dtcs: ["P0301"] }), [
      yes("confirm_symptom"), no("flashing_light"),
      { nodeId: "single_prereq", kind: "prerequisite", met: true },
      no("coil_swap"),
      { nodeId: "plug_inspection", kind: "observation", choice: "normal" },
      { nodeId: "injector_check", kind: "check", result: "pass" },
    ]);
    expect(toCompression.currentNodeId).toBe("compression_test");
    const measure = (value: number) => step(toCompression, { nodeId: "compression_test", kind: "measurement", value, unit: "kPa" });
    // Below the minimum: mechanical. Exactly the minimum counts as within (inclusive). Above: not mechanical.
    expect(measure(899.5).conclusionNodeId).toBe("concl_mechanical");
    expect(measure(900).conclusionNodeId).toBe("concl_wiring");
    expect(measure(1250).conclusionNodeId).toBe("concl_wiring");
    expect(measure(899.5).evidence.at(-1)).toMatchObject({ kind: "measurement", value: "899.5 kPa", measured: { value: 899.5, unit: "kPa" } });
  });

  it("converts readings between units of the same kind, and refuses the wrong kind", () => {
    expect(convert(1, "bar", "kPa")).toBe(100);
    expect(convert(130, "psi", "kPa")).toBeCloseTo(896.318448, 5);
    expect(convert(1500, "mV", "V")).toBe(1.5);
    expect(convert(2, "kohm", "ohm")).toBe(2000);
    expect(convert(12, "V", "kPa")).toBeNull();

    const at = run(facts({ dtcs: ["P0300"] }), [yes("confirm_symptom"), no("flashing_light"), { nodeId: "multi_vacuum", kind: "observation", choice: "nothing_found" }]);
    expect(at.currentNodeId).toBe("fuel_pressure");
    // 40 psi is about 276 kPa: below the test minimum of 300 kPa.
    expect(step(at, { nodeId: "fuel_pressure", kind: "measurement", value: 40, unit: "psi" }).conclusionNodeId).toBe("concl_fuel_supply");
    // 3.5 bar is 350 kPa: within the test range.
    const within = step(at, { nodeId: "fuel_pressure", kind: "measurement", value: 3.5, unit: "bar" });
    expect(within.conclusionNodeId).toBe("concl_professional");
    expect(within.remainingCauses).not.toContain("fuel_supply");
    // Above the range: no outcome matches, so "otherwise".
    expect(step(at, { nodeId: "fuel_pressure", kind: "measurement", value: 600, unit: "kPa" }).conclusionNodeId).toBe("concl_professional");
    // Volts for a pressure: refused, nothing recorded.
    expect(submitStep(W, at, { nodeId: "fuel_pressure", kind: "measurement", value: 12, unit: "V" })).toEqual({ ok: false, error: "wrong_unit: this step measures in kPa" });
    expect(submitStep(W, at, { nodeId: "fuel_pressure", kind: "measurement", value: Number.NaN, unit: "kPa" })).toEqual({ ok: false, error: "invalid_measurement" });
  });

  it("does not evaluate a measurement without the vehicle's specification, and says so", () => {
    const r = replaySession(W, facts({ dtcs: ["P0300"] }), [yes("confirm_symptom"), no("flashing_light"), { nodeId: "multi_vacuum", kind: "observation", choice: "nothing_found" }], undefined, {
      specifications: createInMemorySpecificationProvider([]),
    });
    const s = r.ok ? r.session : null;
    expect(s).toMatchObject({ status: "completed", conclusionNodeId: "concl_professional", endResult: "referred" });
    expect(s!.evidence.find((e) => e.nodeId === "fuel_pressure" && e.kind === "unsupported")).toMatchObject({ unsupportedReason: "spec_not_found" });
  });

  it("never presents a step above the person's level or needing a tool they lack", () => {
    // An owner reaches the first do-it-yourself step and is referred instead.
    const owner = run(facts({ dtcs: ["P0301"], capabilities: OWNER }), [yes("confirm_symptom"), no("flashing_light")]);
    expect(owner).toMatchObject({ status: "completed", conclusionNodeId: "concl_professional", endResult: "referred" });
    expect(owner.evidence.find((e) => e.nodeId === "single_prereq")).toMatchObject({ kind: "unsupported", unsupportedReason: "level" });
    // A capable DIYer without a scan tool cannot do the swap test.
    const noScanTool = run(facts({ dtcs: ["P0301"], capabilities: { skill: "diy", scanAccess: "none", instruments: ["hand_tools"], facilities: [] } }), [yes("confirm_symptom"), no("flashing_light"), { nodeId: "single_prereq", kind: "prerequisite", met: true }]);
    expect(noScanTool.evidence.find((e) => e.nodeId === "coil_swap")).toMatchObject({ kind: "unsupported", unsupportedReason: "scan_access", missingCapabilities: ["scan_access:codes"] });
    // The owner-level air-leak check is offered to an owner.
    expect(run(facts({ dtcs: ["P0300"], capabilities: OWNER }), [yes("confirm_symptom"), no("flashing_light")]).currentNodeId).toBe("multi_vacuum");
  });

  it("lets the person say they cannot do a step, where the step allows it", () => {
    const at = run(facts({ dtcs: ["P0301"] }), [yes("confirm_symptom"), no("flashing_light"), { nodeId: "single_prereq", kind: "prerequisite", met: true }]);
    const unable = step(at, { nodeId: "coil_swap", kind: "unable", reason: "not_comfortable" });
    expect(unable.evidence.at(-1)).toMatchObject({ kind: "unsupported", unsupportedReason: "not_comfortable", to: "concl_professional" });
    // A step with no alternative route cannot be skipped.
    expect(submitStep(W, started(), { nodeId: "confirm_symptom", kind: "unable", reason: "not_possible" })).toMatchObject({ ok: false, error: expect.stringMatching(/^no_alternative/) });
  });

  it("refuses input that does not fit the current step, and changes nothing", () => {
    const s = started();
    const before = JSON.stringify(s);
    expect(submitStep(W, s, { nodeId: "flashing_light", kind: "yes_no", answer: "yes" })).toEqual({ ok: false, error: "not_current_step" });
    expect(submitStep(W, s, { nodeId: "confirm_symptom", kind: "choice", choice: "one" })).toEqual({ ok: false, error: "wrong_input_kind" });
    expect(submitStep(W, s, { nodeId: "confirm_symptom", kind: "yes_no", answer: "maybe" as "yes" })).toEqual({ ok: false, error: "wrong_input_kind" });
    const choiceStep = run(facts(), [yes("confirm_symptom"), no("flashing_light")]);
    expect(submitStep(W, choiceStep, { nodeId: "ask_pattern", kind: "choice", choice: "eight" })).toEqual({ ok: false, error: "unknown_option" });
    expect(submitStep({ ...W, version: W.version + 1 }, s, yes("confirm_symptom"))).toEqual({ ok: false, error: "wrong_workflow" });
    expect(JSON.stringify(s)).toBe(before);
  });
});

/* ───────────────────────── evidence, replay and resume ───────────────────────── */

describe("evidence, replay and resume", () => {
  const coilPath: StepInput[] = [yes("confirm_symptom"), no("flashing_light"), { nodeId: "single_prereq", kind: "prerequisite", met: true }, yes("coil_swap")];

  it("stores every piece of evidence in order, with the caller's timestamps, and never reads the clock", () => {
    let s = started(facts({ dtcs: ["P0304"] }), "2026-10-15T10:00:00Z");
    s = step(s, yes("confirm_symptom"), "2026-10-15T10:01:00Z");
    s = step(s, no("flashing_light"), "2026-10-15T10:02:00Z");
    expect(s.evidence.map((e) => [e.seq, e.nodeId, e.kind, e.value, e.at])).toEqual([
      [1, "start", "scan", "start", "2026-10-15T10:00:00Z"],
      [2, "start", "code", "P0304", "2026-10-15T10:00:00Z"],
      [3, "confirm_symptom", "answer", "yes", "2026-10-15T10:01:00Z"],
      [4, "flashing_light", "answer", "no", "2026-10-15T10:02:00Z"],
      [5, "pattern", "branch", "rule:1", "2026-10-15T10:02:00Z"],
    ]);
    expect(s.inputs).toEqual([{ ...yes("confirm_symptom"), at: "2026-10-15T10:01:00Z" }, { ...no("flashing_light"), at: "2026-10-15T10:02:00Z" }]);
  });

  it("keeps earlier evidence exactly as it was: every call returns a new session", () => {
    const first = started(facts({ dtcs: ["P0301"] }));
    const snapshot = JSON.stringify(first);
    const second = step(first, yes("confirm_symptom"));
    expect(JSON.stringify(first)).toBe(snapshot);
    expect(second.evidence.slice(0, first.evidence.length)).toEqual(first.evidence);
    expect(second.evidence[0]).toBe(first.evidence[0]); // the same frozen record, not a copy
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.evidence)).toBe(true);
    expect(Object.isFrozen(second.evidence[0])).toBe(true);
    expect(() => {
      (second.evidence[0] as { value: string }).value = "changed";
    }).toThrow();
    expect(() => (second.evidence as unknown as unknown[]).push({})).toThrow();
  });

  it("replays: the same workflow, facts and inputs always give the same session", () => {
    const f = facts({ dtcs: ["P0301"] });
    const live = run(f, coilPath);
    const replayed = replaySession(W, f, live.inputs, "2026-10-15T10:00:00Z", SPECS);
    expect(replayed.ok && JSON.stringify(replayed.session)).toBe(JSON.stringify(live));
    const again = replaySession(W, f, live.inputs, "2026-10-15T10:00:00Z", SPECS);
    expect(again.ok && JSON.stringify(again.session)).toBe(JSON.stringify(live));
  });

  it("resumes a saved session and carries on exactly as if it had never stopped", () => {
    const f = facts({ dtcs: ["P0301"] });
    const halfway = run(f, coilPath.slice(0, 2));
    const saved = JSON.parse(JSON.stringify(halfway));
    const resumed = resumeSession(W, saved);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    const continued = coilPath.slice(2).reduce((s, input) => step(s, input), resumed.session);
    expect(JSON.stringify(continued)).toBe(JSON.stringify(run(f, coilPath)));
  });

  it("refuses to resume a session that was edited, or saved against another version", () => {
    const saved = JSON.parse(JSON.stringify(run(facts({ dtcs: ["P0301"] }), coilPath.slice(0, 2))));
    const edited = { ...saved, remainingCauses: ["ignition_coil"] };
    expect(resumeSession(W, edited)).toMatchObject({ ok: false, error: expect.stringMatching(/^invalid_session/) });
    const rewritten = { ...saved, evidence: saved.evidence.map((e: { value: string }, i: number) => (i === 1 ? { ...e, value: "no" } : e)) };
    expect(resumeSession(W, rewritten).ok).toBe(false);
    expect(resumeSession({ ...W, version: W.version + 1 }, saved)).toEqual({ ok: false, error: "wrong_workflow" });
    expect(resumeSession(W, null)).toEqual({ ok: false, error: "invalid_session" });
  });
});

/* ───────────────────────── completion and repair verification ───────────────────────── */

describe("completion and repair verification", () => {
  const toCoil = (f = facts({ dtcs: ["P0301"] })) => run(f, [yes("confirm_symptom"), no("flashing_light"), { nodeId: "single_prereq", kind: "prerequisite", met: true }, yes("coil_swap")]);

  it("stops at the repair verification after a repairable conclusion", () => {
    const s = toCoil();
    expect(s).toMatchObject({ status: "in_progress", currentNodeId: "verify_repair", conclusionNodeId: "concl_coil", repairVerified: null });
    expect(s.supportedCauses).toEqual(["ignition_coil"]);
    expect(s.remainingCauses).toEqual(["ignition_coil", "wiring_or_control", "vacuum_leak"]);
  });

  it("ends as resolved when the repair is verified", () => {
    const done = step(toCoil(), { nodeId: "verify_repair", kind: "verification", results: [{ criterion: "smooth", result: "met" }, { criterion: "codes_gone", scan: afterScan() }] });
    expect(done).toMatchObject({ status: "completed", currentNodeId: null, endResult: "resolved", repairVerified: true, conclusionNodeId: "concl_coil" });
    // A completed session takes no more input.
    expect(submitStep(W, done, yes("confirm_symptom"))).toEqual({ ok: false, error: "session_complete" });
    expect(currentStep(W, done)).toBeNull();
  });

  it("does not claim success when the repair did not fix it", () => {
    const failed = step(toCoil(), { nodeId: "verify_repair", kind: "verification", results: [{ criterion: "smooth", result: "not_met" }, { criterion: "codes_gone", scan: afterScan() }] });
    expect(failed).toMatchObject({ status: "completed", endResult: "referred", repairVerified: false, conclusionNodeId: "concl_not_fixed" });
    // The earlier conclusion stays in the evidence: what was tried is never lost.
    expect(failed.evidence.map((e) => e.nodeId)).toContain("coil_swap");
    expect(failed.evidence.at(-1)).toMatchObject({ kind: "verification", value: "not_verified" });
  });
});

/* ───────────────────────── the synthetic misfire example, end to end ───────────────────────── */

describe("the synthetic misfire workflow reaches the right branches", () => {
  const single = [yes("confirm_symptom"), no("flashing_light"), { nodeId: "single_prereq", kind: "prerequisite", met: true } as StepInput];
  const cases: Array<[string, SessionStartFacts, StepInput[], { conclusion: string; end?: string; verify?: string }]> = [
    ["fault follows the coil", facts({ dtcs: ["P0301"] }), [...single, yes("coil_swap")], { conclusion: "concl_coil" }],
    ["worn spark plug", facts({ dtcs: ["P0301"] }), [...single, no("coil_swap"), { nodeId: "plug_inspection", kind: "observation", choice: "worn_or_damaged" }], { conclusion: "concl_plug" }],
    ["injector fails its test", facts({ dtcs: ["P0301"] }), [...single, no("coil_swap"), { nodeId: "plug_inspection", kind: "observation", choice: "fouled" }, { nodeId: "injector_check", kind: "check", result: "fail" }], { conclusion: "concl_injector" }],
    ["low compression", facts({ dtcs: ["P0301"] }), [...single, no("coil_swap"), { nodeId: "plug_inspection", kind: "observation", choice: "normal" }, { nodeId: "injector_check", kind: "check", result: "pass" }, { nodeId: "compression_test", kind: "measurement", value: 600, unit: "kPa" }], { conclusion: "concl_mechanical", end: "referred" }],
    ["everything mechanical is fine", facts({ dtcs: ["P0301"] }), [...single, no("coil_swap"), { nodeId: "plug_inspection", kind: "observation", choice: "normal" }, { nodeId: "injector_check", kind: "check", result: "pass" }, { nodeId: "compression_test", kind: "measurement", value: 1100, unit: "kPa" }], { conclusion: "concl_wiring", end: "referred" }],
    ["air leak on a random misfire", facts({ dtcs: ["P0300"] }), [yes("confirm_symptom"), no("flashing_light"), { nodeId: "multi_vacuum", kind: "observation", choice: "hiss_or_damage" }], { conclusion: "concl_vacuum" }],
    ["low fuel pressure", facts({ dtcs: ["P0300"] }), [yes("confirm_symptom"), no("flashing_light"), { nodeId: "multi_vacuum", kind: "observation", choice: "nothing_found" }, { nodeId: "fuel_pressure", kind: "measurement", value: 200, unit: "kPa" }], { conclusion: "concl_fuel_supply", verify: "verify_fuel_repair" }],
    ["flashing light: stop", facts({ dtcs: ["P0300"] }), [yes("confirm_symptom"), yes("flashing_light")], { conclusion: "concl_stop_driving", end: "referred" }],
  ];

  for (const [name, f, inputs, expected] of cases) {
    it(name, () => {
      const s = run(f, inputs);
      expect(s.conclusionNodeId).toBe(expected.conclusion);
      if (expected.end) expect(s).toMatchObject({ status: "completed", endResult: expected.end });
      else expect(s.currentNodeId).toBe(expected.verify ?? "verify_repair");
      // Every recorded step is on a real transition of the workflow.
      const ids = new Set(W.nodes.map((n) => n.id));
      for (const e of s.evidence) expect(ids.has(e.to)).toBe(true);
    });
  }

  it("follows the expected route through the single-cylinder branch", () => {
    const s = run(facts({ dtcs: ["P0301"] }), [...single, no("coil_swap"), { nodeId: "plug_inspection", kind: "observation", choice: "normal" }, { nodeId: "injector_check", kind: "check", result: "pass" }]);
    expect(pathOf(s)).toEqual(["confirm_symptom", "flashing_light", "pattern", "single_prereq", "coil_swap", "plug_inspection", "injector_check"]);
    expect(s.remainingCauses).toEqual(["low_compression", "wiring_or_control", "vacuum_leak"]);
  });
});

/* ───────────────────────── choosing the next test ───────────────────────── */

describe("steps that separate the remaining causes", () => {
  it("lists the steps that can rule causes out, those the person can do first, cheapest first, without probabilities", () => {
    const s = run(facts({ dtcs: ["P0301"], capabilities: DIY }), [yes("confirm_symptom"), no("flashing_light")]);
    const steps = separatingSteps(W, s);
    // The swap test can rule out three causes, the plug check one: the swap comes first. Steps needing a professional come last.
    expect(steps.map((x) => x.nodeId)).toEqual(["coil_swap", "plug_inspection", "compression_test", "injector_check"]);
    expect(steps[0]).toMatchObject({ canDo: true, level: "diy", rulesOutUpTo: 3 });
    expect(steps.find((x) => x.nodeId === "injector_check")).toMatchObject({ canDo: false, level: "professional" });
    expect(JSON.stringify(steps)).not.toMatch(/percent|probab|confidence/i);
    // Deterministic.
    expect(separatingSteps(W, s)).toEqual(steps);
  });
});

/* ───────────────────────── the engine stays self-contained ───────────────────────── */

describe("the engine stays self-contained", () => {
  it("uses no AI, network, clock or randomness, and nothing in the app imports it yet", () => {
    const dir = path.join(__dirname, "../app/lib/diagnostic-workflow");
    const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      expect(text, file).not.toMatch(/from ["']openai["']|fetch\(|Date\.now\(|new Date\(|Math\.random\(/);
    }
    const appFiles = (fs.readdirSync(path.join(__dirname, "../app"), { recursive: true }) as string[])
      .map(String)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("diagnostic-workflow") && !f.includes("generated"));
    for (const file of appFiles) {
      expect(fs.readFileSync(path.join(__dirname, "../app", file), "utf8"), file).not.toMatch(/diagnostic-workflow/);
    }
  });
});
