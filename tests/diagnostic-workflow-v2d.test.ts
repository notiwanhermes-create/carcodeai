/**
 * Guided Diagnostics V2D: structured trouble-code evidence and freeze-frame
 * snapshots.
 *
 * Research prototype. No network, no database, no AI, no vehicle
 * communication, no code definitions. Every code list, snapshot, vehicle and
 * specification here is SYNTHETIC / TEST ONLY / NOT OEM DATA.
 */
import { describe, expect, it } from "vitest";
import {
  matchDtc,
  normalizeCode,
  replaySession,
  resumeSession,
  sessionOutcome,
  startSession,
  submitStep,
  validateWorkflow,
  type DiagnosticCapabilityContext,
  type DiagnosticScanInput,
  type DiagnosticSession,
  type DiagnosticSpecification,
  type EngineOptions,
  type SessionStartFacts,
  type StepInput,
  type WorkflowDefinition,
  type WorkflowNode,
} from "../app/lib/diagnostic-workflow";
import { SYNTHETIC_MISFIRE_WORKFLOW as W } from "../app/lib/diagnostic-workflow/examples/synthetic-misfire";
import { SYNTHETIC_SPECIFICATIONS } from "../app/lib/diagnostic-workflow/examples/synthetic-specifications";
import { createInMemorySpecificationProvider } from "../app/lib/diagnostic-workflow/examples/in-memory-specification-provider";

const PRO: DiagnosticCapabilityContext = { skill: "professional", scanAccess: "live_data", instruments: ["hand_tools", "compression_tester", "pressure_gauge"], facilities: [] };
const VEHICLE = { fuel: "gasoline" as const, cylinders: 4 };
const SPECS: EngineOptions = { specifications: createInMemorySpecificationProvider(SYNTHETIC_SPECIFICATIONS) };
const WARM = SYNTHETIC_SPECIFICATIONS.find((r) => r.id === "synthetic.engine_warm_coolant_temp")!;
const specsWith = (replacement: DiagnosticSpecification): EngineOptions => ({
  specifications: createInMemorySpecificationProvider([...SYNTHETIC_SPECIFICATIONS.filter((r) => r.id !== replacement.id), replacement]),
});

/** A SYNTHETIC tool scan: complete, and states the flags it can report. */
const scan = (codes: DiagnosticScanInput["codes"], over: Partial<DiagnosticScanInput> = {}): DiagnosticScanInput => ({
  id: "start",
  source: "scan_tool",
  completeness: "complete",
  reportsStatus: ["pending", "confirmed", "permanent", "history"],
  codes,
  ...over,
});
const facts = (scans: DiagnosticScanInput[], over: Partial<SessionStartFacts> = {}): SessionStartFacts => ({ capabilities: PRO, vehicle: VEHICLE, scans, ...over });

function ok(r: ReturnType<typeof startSession>): DiagnosticSession {
  if (!r.ok) throw new Error(r.error);
  return r.session;
}
const run = (f: SessionStartFacts, inputs: StepInput[] = [], workflow: WorkflowDefinition = W, options: EngineOptions = SPECS) => ok(replaySession(workflow, f, inputs, "2026-10-15T10:00:00Z", options));
const yes = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "yes" });
const no = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "no" });
const codesOf = (s: DiagnosticSession) => s.evidence.filter((e) => e.kind === "code").map((e) => e.dtc);

/** A SYNTHETIC branch-only workflow: rule N leads to end "eN", otherwise to "e_other". */
function branchWorkflow(rules: Extract<WorkflowNode, { type: "branch" }>["rules"]): WorkflowDefinition {
  return {
    id: "test.codes",
    version: 1,
    title: "Codes",
    provenance: "SYNTHETIC: test only",
    faultModel: "single_primary_fault",
    causes: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
    nodes: [
      { id: "s", type: "start", title: "Start", next: "b" },
      { id: "b", type: "branch", title: "Codes", rules: rules.map((r, i) => ({ ...r, to: `e${i + 1}` })), otherwise: "e_other" },
      ...rules.map((_, i) => ({ id: `e${i + 1}`, type: "end" as const, title: `Rule ${i + 1}`, result: "concluded" as const })),
      { id: "e_other", type: "end", title: "Otherwise", result: "concluded" },
    ],
  };
}
const route = (w: WorkflowDefinition, scans: DiagnosticScanInput[]) => run(facts(scans), [], w).evidence.find((e) => e.kind === "branch")!.value;

/* ───────────────────────── codes ───────────────────────── */

describe("V2D: structured codes", () => {
  it("normalizes standard P/B/C/U codes, including lower case, and keeps the raw text", () => {
    expect(normalizeCode("P0301")).toEqual({ ok: true, value: { raw: "P0301", code: "P0301", format: "obd", system: "powertrain" } });
    expect(normalizeCode(" p0a0f ")).toEqual({ ok: true, value: { raw: " p0a0f ", code: "P0A0F", format: "obd", system: "powertrain" } });
    expect(normalizeCode("b1234")).toMatchObject({ value: { code: "B1234", system: "body" } });
    expect(normalizeCode("C0035")).toMatchObject({ value: { system: "chassis" } });
    expect(normalizeCode("u0100")).toMatchObject({ value: { code: "U0100", system: "network" } });
  });

  it("preserves opaque manufacturer identifiers and unclassified codes exactly", () => {
    expect(normalizeCode("2A82", "opaque")).toEqual({ ok: true, value: { raw: "2A82", code: "2A82", format: "opaque" } });
    // Declared opaque: even an OBD-looking code keeps its exact case and is not treated as OBD.
    expect(normalizeCode("p0301", "opaque")).toEqual({ ok: true, value: { raw: "p0301", code: "p0301", format: "opaque" } });
    expect(normalizeCode("ab-12:x")).toEqual({ ok: true, value: { raw: "ab-12:x", code: "ab-12:x", format: "unclassified" } });
  });

  it("rejects invalid codes rather than repairing them", () => {
    // Surrounding whitespace is trimmed (the raw text is kept); anything inside a code is refused.
    for (const bad of ["", "   ", "P03 01", "P 0301", "x".repeat(40), "P03\u00001", "P0301\nP0302"]) expect(normalizeCode(bad).ok, JSON.stringify(bad)).toBe(false);
    expect(normalizeCode("P4301", "obd").ok).toBe(false); // not a standard form, and declared OBD
    expect(normalizeCode("X0301", "obd").ok).toBe(false);
    expect(normalizeCode(301 as unknown as string).ok).toBe(false);
    expect(startSession(W, facts([scan([{ code: "P03 01" }])]))).toEqual({ ok: false, error: expect.stringMatching(/^invalid_facts: scan "start": .*not a usable code/) });
  });

  it("records each code with its raw text, canonical form, format, status, module and scan", () => {
    const s = run(facts([scan([{ code: " p0301 ", status: ["confirmed"], module: { id: " Engine ", name: "Engine control (as the tool names it)" } }, { code: "2A82", format: "opaque" }])]));
    expect(codesOf(s)).toEqual([
      { raw: " p0301 ", code: "P0301", format: "obd", system: "powertrain", status: ["confirmed"], module: { id: "engine", name: "Engine control (as the tool names it)" }, scan: "start" },
      { raw: "2A82", code: "2A82", format: "opaque", status: "unknown", scan: "start" },
    ]);
    expect(s.evidence[0]).toMatchObject({ kind: "scan", value: "start", source: "scan_tool", scanInfo: { completeness: "complete", codeCount: 2 } });
  });

  it("rejects malformed scans: unknown flags, undeclared flags, active without support, duplicates, unknown fields", () => {
    const bad = (s: DiagnosticScanInput) => startSession(W, facts([s]));
    expect(bad(scan([{ code: "P0301", status: ["stored" as "confirmed"] }]))).toMatchObject({ ok: false, error: expect.stringMatching(/unknown flag/) });
    expect(bad(scan([{ code: "P0301", status: [] }]))).toMatchObject({ ok: false });
    expect(bad(scan([{ code: "P0301", status: ["pending"] }], { reportsStatus: ["confirmed"] }))).toMatchObject({ ok: false, error: expect.stringMatching(/does not declare it reports/) });
    expect(bad(scan([{ code: "P0301", status: ["active"] }], { reportsStatus: undefined }))).toMatchObject({ ok: false, error: expect.stringMatching(/active/) });
    expect(bad(scan([{ code: "P0301", status: ["active"] }], { reportsStatus: ["confirmed", "active"] })).ok).toBe(true);
    expect(bad(scan([{ code: "P0301" }, { code: "p0301" }]))).toMatchObject({ ok: false, error: expect.stringMatching(/listed twice/) });
    expect(bad({ ...scan([]), completeness: "mostly" as "complete" })).toMatchObject({ ok: false });
    expect(bad({ ...scan([]), canId: "0x7E8" } as DiagnosticScanInput)).toMatchObject({ ok: false, error: expect.stringMatching(/unsupported fields: canId/) });
    expect(startSession(W, { ...facts([]), dtcs: ["P0301"] } as SessionStartFacts)).toMatchObject({ ok: false, error: expect.stringMatching(/structured scans/) });
  });
});

/* ───────────────────────── status ───────────────────────── */

describe("V2D: reported status", () => {
  const statusOf = (code: DiagnosticScanInput["codes"][number]) => codesOf(run(facts([scan([code])])))[0]?.status;

  it("keeps pending, confirmed, permanent and unknown exactly as reported", () => {
    expect(statusOf({ code: "P0301", status: ["pending"] })).toEqual(["pending"]);
    expect(statusOf({ code: "P0301", status: ["confirmed"] })).toEqual(["confirmed"]);
    expect(statusOf({ code: "P0301", status: ["permanent", "confirmed"] })).toEqual(["permanent", "confirmed"]);
    expect(statusOf({ code: "P0301" })).toBe("unknown");
  });

  it("never changes causes on its own: only a workflow rule does", () => {
    for (const status of [["pending"], ["confirmed"], ["permanent"], undefined] as const) {
      const s = run(facts([scan([{ code: "P0301", ...(status ? { status: [...status] } : {}) }])]));
      expect(s.currentNodeId).toBe("confirm_symptom");
      expect(s.remainingCauses).toEqual(W.causes.map((c) => c.id));
      expect(s.supportedCauses).toEqual([]);
    }
  });

  it("can be matched explicitly by a workflow, honestly", () => {
    const w = branchWorkflow([{ if: { dtc: { code: "P0171", status: "confirmed" } }, to: "" }, { if: { not: { dtc: { code: "P0171", status: "confirmed" } } }, to: "" }]);
    expect(validateWorkflow(w)).toEqual({ ok: true });
    expect(route(w, [scan([{ code: "P0171", status: ["confirmed"] }])])).toBe("rule:1");
    // Known to be only pending, from a source that reports "confirmed": definitely not confirmed.
    expect(route(w, [scan([{ code: "P0171", status: ["pending"] }])])).toBe("rule:2");
    // Status unknown, or a source that does not say it reports "confirmed": cannot tell either way.
    expect(route(w, [scan([{ code: "P0171" }])])).toBe("otherwise");
    expect(route(w, [scan([{ code: "P0171", status: ["pending"] }], { reportsStatus: ["pending"] })])).toBe("otherwise");
  });
});

/* ───────────────────────── completeness and absence ───────────────────────── */

describe("V2D: completeness decides whether absence can be concluded", () => {
  const w = branchWorkflow([{ if: { dtc: { code: "P0420" } }, to: "" }, { if: { noDtc: { code: "P0420" } }, to: "" }]);

  it("a complete scan allows a definite 'not present'", () => {
    expect(route(w, [scan([{ code: "P0301" }])])).toBe("rule:2");
    expect(route(w, [scan([])])).toBe("rule:2");
  });

  it("a partial or unknown scan never does: 'not observed in the supplied evidence' is not 'absent'", () => {
    expect(route(w, [scan([{ code: "P0301" }], { completeness: "partial" })])).toBe("otherwise");
    expect(route(w, [scan([{ code: "P0301" }], { completeness: "unknown" })])).toBe("otherwise");
    expect(route(w, [])).toBe("otherwise");
  });

  it("presence is presence, whatever the completeness", () => {
    expect(route(w, [scan([{ code: "P0420" }], { completeness: "partial" })])).toBe("rule:1");
  });

  it("matches by module, and respects what a complete scan covers", () => {
    const m = branchWorkflow([{ if: { dtc: { module: "abs" } }, to: "" }, { if: { noDtc: { code: "C0035", module: "abs" } }, to: "" }]);
    expect(route(m, [scan([{ code: "C0035", module: { id: "ABS" } }])])).toBe("rule:1");
    // A complete scan of the engine module only cannot show anything is absent from the abs module.
    expect(route(m, [scan([], { coverage: { modules: ["engine"] } })])).toBe("otherwise");
    expect(route(m, [scan([], { coverage: { modules: ["engine", "abs"] } })])).toBe("rule:2");
    // A matching code whose module is unknown might be from abs: no definite "absent".
    expect(route(m, [scan([{ code: "C0035" }])])).toBe("otherwise");
  });

  it("matchDtc is three-valued", () => {
    const s = run(facts([scan([{ code: "P0301", status: ["pending"] }], { completeness: "partial" })]));
    expect(matchDtc(s.evidence, { code: "P0301" })).toBe(true);
    expect(matchDtc(s.evidence, { code: "P0420" })).toBeNull();
    expect(matchDtc(s.evidence, { code: "P0301", status: "confirmed" })).toBeNull();
  });

  it("refuses invalid code conditions", () => {
    const bad = branchWorkflow([{ if: { dtc: { code: "P03 01" } }, to: "" }, { if: { dtc: {} }, to: "" }, { if: { dtc: { code: "P0301", status: "stored" as "confirmed" } }, to: "" }]);
    const r = validateWorkflow(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.filter((p) => p.code === "invalid_dtc_matcher")).toHaveLength(3);
  });
});

/* ───────────────────────── snapshots ───────────────────────── */

describe("V2D: freeze-frame snapshots", () => {
  const frame = (coolant: number | string | undefined, unit: "degC" | "kPa" | undefined = "degC", extra: object = {}) => ({
    id: "ff1",
    completeness: "partial" as const,
    captured: { order: 1 },
    parameters: [{ id: "engine_speed", value: 820, unit: "rpm" as const }, ...(coolant === undefined ? [] : [{ id: "coolant_temperature", value: coolant, ...(unit && typeof coolant === "number" ? { unit } : {}) }])],
    ...extra,
  });
  const confirmed = (snapshots: DiagnosticScanInput["snapshots"], status: DiagnosticScanInput["codes"][number]["status"] = ["confirmed"]) =>
    facts([scan([{ code: "P0301", status, snapshot: snapshots?.[0]?.id }], { snapshots })]);
  const notNow = [no("confirm_symptom")];
  const check = (s: DiagnosticSession) => s.evidence.find((e) => e.kind === "snapshot_check");

  it("attaches a snapshot to its code, frozen", () => {
    const s = run(confirmed([frame(20)]));
    const snap = s.evidence.find((e) => e.kind === "snapshot")!;
    expect(snap).toMatchObject({ value: "ff1", source: "scan_tool", phase: "before_repair", snapshot: { id: "ff1", scan: "start", forCode: "P0301", completeness: "partial", captured: { order: 1 } } });
    expect(codesOf(s)[0]).toMatchObject({ snapshot: "ff1" });
    expect(Object.isFrozen(snap.snapshot!.parameters[0])).toBe(true);
  });

  it("records a standalone snapshot, and refuses a reference to a snapshot that is not there", () => {
    const s = run(facts([scan([], { snapshots: [frame(20)] })]));
    expect(s.evidence.find((e) => e.kind === "snapshot")?.snapshot).not.toHaveProperty("forCode");
    expect(startSession(W, facts([scan([{ code: "P0301", snapshot: "nope" }])]))).toMatchObject({ ok: false, error: expect.stringMatching(/snapshot "nope"/) });
    expect(startSession(W, facts([scan([], { snapshots: [{ id: "x", parameters: [{ id: "Engine Speed", value: 1 }] }] })]))).toMatchObject({ ok: false });
  });

  it("is not a live measurement, and alone produces no pass, fail, route or cause change", () => {
    // A frame that happens to hold a fuel pressure value: the workflow still asks for its own live reading.
    const f = facts([scan([{ code: "P0300", status: ["confirmed"], snapshot: "ff1" }], { snapshots: [{ id: "ff1", parameters: [{ id: "fuel_pressure", value: 200, unit: "kPa" }] }] })]);
    const s = run(f, [yes("confirm_symptom"), no("flashing_light"), { nodeId: "multi_vacuum", kind: "observation", choice: "nothing_found" }]);
    expect(s.currentNodeId).toBe("fuel_pressure");
    expect(s.evidence.some((e) => e.kind === "measurement" || e.kind === "snapshot_check")).toBe(false);
    expect(s.remainingCauses).toContain("fuel_supply");
    expect(s.supportedCauses).toEqual([]);
  });

  it("is interpreted only by an explicit check against a verified specification, recording snapshot and pinned spec", () => {
    const cold = run(confirmed([frame(20)]), notNow);
    expect(check(cold)).toMatchObject({
      source: "engine",
      value: "20 degC",
      snapshotRef: { snapshot: "ff1", parameter: "coolant_temperature", value: 20, unit: "degC" },
      judgement: { evaluated: true, relation: "below", range: "cold", specification: { id: WARM.id, revision: "SYNTHETIC-TEST-ONLY-r1", trust: "verified" } },
      to: "concl_intermittent_cold",
    });
    expect(run(confirmed([frame(88)]), notNow).conclusionNodeId).toBe("concl_intermittent_warm");
    // Fahrenheit is not a supported unit; another compatible unit kind would be converted, a different kind refused (below).
  });

  it("an unverified specification cannot interpret a snapshot", () => {
    const s = run(confirmed([frame(20)]), notNow, W, specsWith({ ...WARM, trust: "unverified" }));
    expect(check(s)).toMatchObject({ judgement: { evaluated: false, reason: "untrusted_spec" }, to: "concl_intermittent" });
    expect(s.conclusionNodeId).toBe("concl_intermittent");
  });

  it("incompatible units, missing or text values refuse interpretation", () => {
    expect(check(run(confirmed([frame(20, "kPa")]), notNow))).toMatchObject({ value: "unavailable: incompatible_unit", to: "concl_intermittent" });
    expect(check(run(confirmed([frame(undefined)]), notNow))).toMatchObject({ value: "unavailable: parameter_missing" });
    expect(check(run(confirmed([frame("warm")]), notNow))).toMatchObject({ value: "unavailable: not_numeric" });
    expect(check(run(confirmed([frame(400)]), notNow))).toMatchObject({ value: "unavailable: implausible_value" });
    expect(check(run(confirmed([frame(20)]), notNow, W, specsWith({ ...WARM, unit: "kPa" })))).toMatchObject({ value: "unavailable: spec_incompatible_unit" });
    expect(check(run(facts([scan([{ code: "P0301", status: ["confirmed"] }])]), notNow))).toMatchObject({ value: "unavailable: no_snapshot" });
  });

  it("is immutable: changing the supplied input afterwards changes nothing", () => {
    const input = confirmed([frame(20)]);
    const s = run(input, notNow);
    const before = JSON.stringify(s);
    (input.scans![0].snapshots![0].parameters[1] as { value: number }).value = 95;
    input.scans![0].codes[0].status = ["pending"];
    expect(JSON.stringify(s)).toBe(before);
    expect(Object.isFrozen(s.facts.scans![0].snapshots![0].parameters[1])).toBe(true);
  });
});

/* ───────────────────────── replay ───────────────────────── */

describe("V2D: replay keeps the original code and snapshot evidence", () => {
  const f = () =>
    facts([scan([{ code: "P0301", status: ["confirmed"], snapshot: "ff1" }], { snapshots: [{ id: "ff1", parameters: [{ id: "coolant_temperature", value: 20, unit: "degC" }] }] })]);

  it("replays deterministically and resumes to the same result", () => {
    const live = run(f(), [no("confirm_symptom")]);
    expect(JSON.stringify(run(f(), [no("confirm_symptom")]))).toBe(JSON.stringify(live));
    const resumed = resumeSession(W, JSON.parse(JSON.stringify(live)));
    expect(resumed.ok && sessionOutcome(resumed.session)).toEqual(sessionOutcome(live));
  });

  it("refuses a saved session whose code or snapshot evidence was edited", () => {
    const saved = JSON.parse(JSON.stringify(run(f(), [no("confirm_symptom")])));
    const editedStatus = structuredClone(saved);
    editedStatus.evidence.find((e: { kind: string }) => e.kind === "code").dtc.status = ["pending"];
    expect(resumeSession(W, editedStatus)).toMatchObject({ ok: false, error: expect.stringMatching(/^invalid_session/) });
    const editedFrame = structuredClone(saved);
    editedFrame.facts.scans[0].snapshots[0].parameters[0].value = 90;
    expect(resumeSession(W, editedFrame)).toMatchObject({ ok: false });
  });
});

/* ───────────────────────── before and after the repair ───────────────────────── */

describe("V2D: before- and after-repair code evidence", () => {
  const COIL: StepInput[] = [yes("confirm_symptom"), no("flashing_light"), { nodeId: "single_prereq", kind: "prerequisite", met: true }, yes("coil_swap")];
  const atVerify = () => run(facts([scan([{ code: "P0301", status: ["confirmed"] }])]), COIL);
  const verify = (codes: DiagnosticScanInput, s = atVerify()) =>
    submitStep(W, s, { nodeId: "verify_repair", kind: "verification", results: [{ criterion: "smooth", result: "met" }, { criterion: "codes_gone", scan: codes }] }, undefined, SPECS);
  const after = (codes: DiagnosticScanInput["codes"], over: Partial<DiagnosticScanInput> = {}) => scan(codes, { id: "after", ...over });
  const criterion = (s: DiagnosticSession) => s.evidence.find((e) => e.criterion === "codes_gone")!;

  it("keeps the before-repair scan and records the after-repair scan separately", () => {
    const s = ok(verify(after([])));
    expect(s.evidence.filter((e) => e.kind === "scan").map((e) => [e.value, e.phase])).toEqual([
      ["start", "before_repair"],
      ["after", "after_repair"],
    ]);
    expect(codesOf(s)).toEqual([expect.objectContaining({ code: "P0301", status: ["confirmed"], scan: "start" })]);
    expect(s).toMatchObject({ verification: "verified", endResult: "resolved" });
    expect(criterion(s).value).toMatch(/^met \(complete scan "after" does not report P0301\)/);
  });

  it("a code still detected after the repair means not verified", () => {
    const s = ok(verify(after([{ code: "P0301", status: ["pending"] }])));
    expect(s).toMatchObject({ verification: "not_verified", conclusionNodeId: "concl_not_fixed" });
    expect(codesOf(s).map((d) => [d?.scan, d?.status])).toEqual([["start", ["confirmed"]], ["after", ["pending"]]]);
  });

  it("needs sufficiently complete post-repair evidence: partial or unknown is inconclusive, a bare 'met' is refused", () => {
    expect(ok(verify(after([], { completeness: "partial" })))).toMatchObject({ verification: "inconclusive", repairVerified: null });
    expect(criterion(ok(verify(after([], { completeness: "unknown" })))).value).toMatch(/not observed in the supplied evidence/);
    expect(ok(verify(after([], { coverage: { modules: ["body"] } })))).toMatchObject({ verification: "inconclusive" });
    const bare = submitStep(W, atVerify(), { nodeId: "verify_repair", kind: "verification", results: [{ criterion: "smooth", result: "met" }, { criterion: "codes_gone", result: "met" }] }, undefined, SPECS);
    expect(bare).toMatchObject({ ok: false, error: expect.stringMatching(/needs a post-repair scan/) });
    // Saying the codes came back needs no scan.
    expect(ok(submitStep(W, atVerify(), { nodeId: "verify_repair", kind: "verification", results: [{ criterion: "smooth", result: "met" }, { criterion: "codes_gone", result: "not_met" }] }, undefined, SPECS))).toMatchObject({ verification: "not_verified" });
  });

  it("a permanent code remaining is not by itself a failed repair", () => {
    const s = ok(verify(after([{ code: "P0301", status: ["permanent"] }])));
    expect(s).toMatchObject({ verification: "inconclusive", repairVerified: null });
    expect(criterion(s).value).toMatch(/P0301 permanent still listed; not proof the repair failed/);
    expect(ok(verify(after([{ code: "P0301" }])))).toMatchObject({ verification: "inconclusive" });
  });

  it("a later scan can never replace an earlier one", () => {
    expect(verify(after([], { id: "start" }))).toMatchObject({ ok: false, error: expect.stringMatching(/already in this session/) });
  });
});

/* ───────────────────────── the synthetic misfire fixture ───────────────────────── */

describe("V2D: the synthetic misfire fixture (version 5)", () => {
  const frame = { id: "ff1", parameters: [{ id: "coolant_temperature", value: 20, unit: "degC" as const }] };

  it("is valid and carries no text matching of codes", () => {
    expect(validateWorkflow(W)).toEqual({ ok: true });
    expect(W.version).toBe(5);
    expect(JSON.stringify(W)).not.toMatch(/dtcAny|"dtc:/);
  });

  it("routes a cylinder-specific code to the single-cylinder branch, whatever its status", () => {
    for (const status of [["pending"], ["confirmed"], undefined] as const) {
      const s = run(facts([scan([{ code: "P0302", ...(status ? { status: [...status] } : {}) }])]), [yes("confirm_symptom"), no("flashing_light")]);
      expect(s.currentNodeId).toBe("single_prereq");
    }
  });

  it("looks at the freeze frame only for a confirmed code, not a pending one", () => {
    const confirmed = run(facts([scan([{ code: "P0304", status: ["confirmed"], snapshot: "ff1" }], { snapshots: [frame] })]), [no("confirm_symptom")]);
    expect(confirmed).toMatchObject({ conclusionNodeId: "concl_intermittent_cold", endResult: "not_reproducible" });
    const pending = run(facts([scan([{ code: "P0304", status: ["pending"], snapshot: "ff1" }], { snapshots: [frame] })]), [no("confirm_symptom")]);
    expect(pending).toMatchObject({ conclusionNodeId: "concl_intermittent" });
    expect(pending.evidence.some((e) => e.kind === "snapshot_check")).toBe(false);
  });

  it("does not assume a code is absent from an incomplete scan", () => {
    // A partial scan listing nothing: the pattern is unknown, so the workflow asks rather than guessing.
    const s = run(facts([scan([], { completeness: "partial" })]), [yes("confirm_symptom"), no("flashing_light")]);
    expect(s.currentNodeId).toBe("ask_pattern");
  });
});
