/**
 * Guided Diagnostics V2H: reviewed content foundation.
 *
 * Research prototype. No database, no network, no AI calls. The generic
 * workflow is a DRAFT candidate, not human-reviewed. Every specification value
 * and reviewer below is a TEST FIXTURE: SYNTHETIC / TEST ONLY / NOT OEM DATA.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  nextBestTests,
  recheckPlan,
  replaySession,
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
} from "../app/lib/diagnostic-workflow";
import { capabilityPreset } from "../app/lib/diagnostic-workflow/examples/capability-presets";
import { createInMemorySpecificationProvider } from "../app/lib/diagnostic-workflow/examples/in-memory-specification-provider";
import { SYNTHETIC_MISFIRE_WORKFLOW } from "../app/lib/diagnostic-workflow/examples/synthetic-misfire";
import { suggestWorkflows, type WorkflowSuggestionAdapter } from "../app/lib/diagnostic-workflow-bridge";
import { createInMemorySessionRepository, createSessionStore, ownerFromAuthenticatedUser, workflowFingerprint } from "../app/lib/diagnostic-workflow-persistence";
import {
  GENERIC_GASOLINE_MISFIRE,
  GENERIC_GASOLINE_MISFIRE_WORKFLOW as G,
  InvalidContentError,
  SYNTHETIC_MISFIRE,
  codesUsed,
  contentFingerprint,
  createContentCatalog,
  specificationsUsed,
  validateContent,
  type WorkflowContent,
} from "../app/lib/diagnostic-workflow-content";

/* ───────────────────────── helpers ───────────────────────── */

const clone = <T>(v: T): T => structuredClone(v);
const problemsOf = (c: WorkflowContent) => {
  const r = validateContent(c);
  return r.ok ? [] : r.problems.map((p) => p.code);
};
const edit = (mutate: (c: WorkflowContent) => void, base: WorkflowContent = GENERIC_GASOLINE_MISFIRE) => {
  const c = clone(base);
  mutate(c);
  return c;
};

const BASIC = capabilityPreset("basic");
const DIY = capabilityPreset("diy");
const ADVANCED = capabilityPreset("advanced_diy");
const WORKSHOP = capabilityPreset("workshop");
const PETROL = { fuel: "gasoline" as const };

const scan = (codes: DiagnosticScanInput["codes"], over: Partial<DiagnosticScanInput> = {}): DiagnosticScanInput => ({
  id: "start",
  source: "scan_tool",
  completeness: "complete",
  reportsStatus: ["pending", "confirmed", "permanent"],
  codes,
  ...over,
});
const facts = (capabilities: DiagnosticCapabilityContext, over: Partial<SessionStartFacts> = {}): SessionStartFacts => ({ capabilities, vehicle: PETROL, ...over });
const yes = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "yes" });
const no = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "no" });
const seen = (nodeId: string, choice: string): StepInput => ({ nodeId, kind: "observation", choice });
const pick = (selection: string, test: string): StepInput => ({ nodeId: selection, kind: "select_test", test });
const met = (nodeId: string): StepInput => ({ nodeId, kind: "prerequisite", met: true });

function run(f: SessionStartFacts, inputs: StepInput[], options: EngineOptions = {}, workflow: WorkflowDefinition = G): DiagnosticSession {
  const r = replaySession(workflow, f, inputs, "2026-10-16T10:00:00Z", options);
  if (!r.ok) throw new Error(r.error);
  return r.session;
}

const SINGLE = [yes("confirm_symptom"), no("mil_flashing"), met("single_secure")];
const P0302 = [scan([{ code: "P0302", status: ["confirmed"] }])];
const P0300 = [scan([{ code: "P0300", status: ["pending"] }])];
const atSingle = (caps: DiagnosticCapabilityContext) => run(facts(caps, { scans: P0302 }), SINGLE);
const atMulti = (caps: DiagnosticCapabilityContext, options: EngineOptions = {}) => run(facts(caps, { scans: P0300 }), [yes("confirm_symptom"), no("mil_flashing"), met("multi_secure")], options);
type Region = Extract<ReturnType<typeof nextBestTests>, { status: "region" }>;
const region = (s: DiagnosticSession): Region => {
  const r = nextBestTests(G, s);
  if (r.status !== "region") throw new Error(`not in a region: ${r.reason}`);
  return r;
};
const ranked = (r: Region) => [r.recommended, ...r.alternatives].filter(Boolean).map((x) => x!.step);

/** TEST FIXTURE ONLY: made-up values, not a real specification for any vehicle. */
const fuelSpec = (trust: DiagnosticSpecification["trust"]): DiagnosticSpecification => ({
  id: "fuel_supply_pressure_expected",
  revision: "TEST-FIXTURE-r1",
  unit: "kPa",
  expected: { min: 300, max: 400 },
  source: { name: "SYNTHETIC / TEST ONLY / NOT OEM DATA" },
  trust,
});
const withSpec = (trust: DiagnosticSpecification["trust"]): EngineOptions => ({ specifications: createInMemorySpecificationProvider([fuelSpec(trust)]) });

/** A clearly fictional reviewer, used only to test the rules. No real review has happened. */
const FIXTURE_REVIEWER = { kind: "human" as const, name: "TEST FIXTURE REVIEWER (not a real person)", qualification: "TEST FIXTURE" };

/* ───────────────────────── classification and review ───────────────────────── */

describe("V2H content classes", () => {
  it("keeps the synthetic fixture explicitly synthetic", () => {
    expect(SYNTHETIC_MISFIRE.contentClass).toBe("synthetic_test");
    expect(SYNTHETIC_MISFIRE.workflow).toBe(SYNTHETIC_MISFIRE_WORKFLOW);
    expect(SYNTHETIC_MISFIRE.workflow.provenance).toMatch(/^SYNTHETIC/);
    expect(validateContent(SYNTHETIC_MISFIRE).ok).toBe(true);
    const fixture = fs.readFileSync(path.join(__dirname, "../app/lib/diagnostic-workflow/examples/synthetic-misfire.ts"), "utf8");
    expect(fixture).toContain("SYNTHETIC / TEST ONLY / NOT OEM DATA");
    // It can never be reviewed or approved for use.
    expect(problemsOf(edit((c) => (c.review.status = "approved"), SYNTHETIC_MISFIRE))).toContain("synthetic_reviewed");
  });

  it("does not let content lose or fake its classification", () => {
    expect(problemsOf(edit((c) => ((c as { contentClass: string }).contentClass = "real")))).toContain("unknown_content_class");
    expect(problemsOf(edit((c) => delete (c as Partial<WorkflowContent>).contentClass))).toContain("unknown_content_class");
    // Synthetic content cannot pose as source-backed, and source-backed content cannot look synthetic.
    expect(problemsOf(edit((c) => (c.contentClass = "generic_source_backed"), SYNTHETIC_MISFIRE))).toEqual(expect.arrayContaining(["synthetic_masquerading", "no_sources", "no_claims"]));
    expect(problemsOf(edit((c) => (c.workflow.id = "synthetic.generic-misfire")))).toContain("synthetic_masquerading");
    expect(problemsOf(edit((c) => (c.contentClass = "synthetic_test")))).toContain("synthetic_unlabelled");
  });

  it("never lets generic content claim a manufacturer, or OEM-licensed content exist without a licence", () => {
    expect(problemsOf(edit((c) => (c.workflow.applicability = { fuel: ["gasoline"], make: ["bmw"] })))).toContain("generic_claims_oem");
    const oem = edit((c) => (c.contentClass = "oem_licensed"));
    expect(problemsOf(oem)).toEqual(expect.arrayContaining(["no_licensing", "no_licensed_source", "oem_without_make"]));
    expect(problemsOf(edit((c) => (c.licensing = { licensor: "x", licence: "x", reference: "x", permittedUse: "x" })))).toContain("unexpected_licensing");
  });
});

describe("V2H review status", () => {
  it("records the generic workflow honestly as an AI-assembled draft with no human review", () => {
    expect(GENERIC_GASOLINE_MISFIRE.review).toEqual({ status: "draft", contentRevision: 1, preparedBy: { kind: "ai_assisted", note: expect.stringMatching(/Not reviewed/) }, reviews: [] });
    expect(G.provenance).toMatch(/draft, not human-reviewed/);
  });

  it("rejects an unknown status and approval without a real review record", () => {
    expect(problemsOf(edit((c) => ((c.review as { status: string }).status = "verified")))).toContain("unknown_review_status");
    expect(problemsOf(edit((c) => (c.review.status = "approved")))).toContain("approval_without_review");
    expect(problemsOf(edit((c) => (c.review.status = "source_reviewed")))).toContain("review_without_record");
    // An AI cannot be the reviewer.
    const byAi = edit((c) => {
      c.review.status = "approved";
      c.review.reviews = [{ decision: "approved", reviewer: { kind: "ai" as "human", name: "Claude", qualification: "model" }, date: "2026-10-16", notes: "", reviewedFingerprint: contentFingerprint(c.workflow) }];
    });
    expect(problemsOf(byAi)).toContain("invalid_reviewer");
    // A review needs a name, a qualification and a real date.
    const thin = edit((c) => {
      c.review.status = "approved";
      c.review.reviews = [{ decision: "approved", reviewer: { kind: "human", name: " ", qualification: "" }, date: "2026-13-45", notes: "", reviewedFingerprint: contentFingerprint(c.workflow) }];
    });
    expect(problemsOf(thin)).toEqual(expect.arrayContaining(["invalid_reviewer", "invalid_review_date"]));
  });

  it("accepts an approval only for exactly the diagnostic content that was reviewed", () => {
    const approved = edit((c) => {
      c.review.status = "approved";
      c.review.reviews = [{ decision: "approved", reviewer: FIXTURE_REVIEWER, date: "2026-10-16", notes: "TEST FIXTURE", reviewedFingerprint: contentFingerprint(c.workflow) }];
    });
    expect(validateContent(approved).ok).toBe(true);
    // A change to the diagnosis after approval makes the approval stale.
    const changed = edit((c) => {
      const swap = c.workflow.nodes.find((n) => n.id === "ignition_swap") as Extract<WorkflowDefinition["nodes"][number], { type: "observation" }>;
      swap.outcomes[1].rulesOut = [];
    }, approved);
    expect(problemsOf(changed)).toEqual(["approval_stale"]);
  });
});

/* ───────────────────────── provenance ───────────────────────── */

describe("V2H provenance", () => {
  it("gives the generic workflow structured, resolvable provenance", () => {
    expect(validateContent(GENERIC_GASOLINE_MISFIRE).ok).toBe(true);
    expect(GENERIC_GASOLINE_MISFIRE.sources.map((s) => [s.id, s.type])).toEqual([
      ["carb-13ccr-1968.2-fro", "regulation"],
      ["sae-j2012-catalogue", "standard_summary"],
      ["ase-a8-task-list-2025", "technical_education"],
    ]);
    for (const s of GENERIC_GASOLINE_MISFIRE.sources) {
      expect(s).toMatchObject({ title: expect.any(String), publisher: expect.any(String), edition: expect.any(String), accessed: "2026-10-16", limitations: expect.any(String) });
      expect(s.url ?? s.reference).toBeTruthy();
    }
    const ids = new Set(GENERIC_GASOLINE_MISFIRE.sources.map((s) => s.id));
    for (const c of GENERIC_GASOLINE_MISFIRE.claims) for (const r of c.sources) expect(ids.has(r.source)).toBe(true);
    // The catalogue page is recorded as only that, and its claim as only partly supported.
    expect(GENERIC_GASOLINE_MISFIRE.sources[1].consulted).toBe("catalogue_only");
    expect(GENERIC_GASOLINE_MISFIRE.claims.find((c) => c.id === "misfire-code-identifiers")).toMatchObject({ support: "partially_supported", note: expect.stringMatching(/NOT verified/) });
  });

  it("rejects non-synthetic content without sources, with unknown or duplicate sources, or with unaccounted parts", () => {
    expect(problemsOf(edit((c) => ((c.sources = []), (c.claims = []))))).toEqual(expect.arrayContaining(["no_sources", "no_claims"]));
    expect(problemsOf(edit((c) => (c.claims[0].sources = [{ source: "some-forum-thread", locator: "post 3" }])))).toContain("unknown_source");
    expect(problemsOf(edit((c) => c.sources.push(clone(c.sources[0]))))).toContain("duplicate_source");
    expect(problemsOf(edit((c) => ((c.sources[0] as { type: string }).type = "forum")))).toContain("unknown_source_type");
    expect(problemsOf(edit((c) => (c.claims[0].sources = []))).filter((p) => p !== "unused_source" && p !== "no_primary_source")).toContain("unsourced_claim");
    expect(problemsOf(edit((c) => (c.claims.find((x) => x.support === "author_judgement")!.sources = [{ source: c.sources[0].id, locator: "x" }])))).toContain("judgement_with_sources");
    expect(problemsOf(edit((c) => (c.claims = c.claims.filter((x) => !x.covers.causes?.includes("air_intake")))))).toContain("uncovered_cause");
    expect(problemsOf(edit((c) => (c.claims = c.claims.filter((x) => !x.covers.codes))))).toContain("uncovered_code");
    expect(problemsOf(edit((c) => (c.claims = c.claims.filter((x) => !x.covers.specifications))))).toContain("uncovered_specification");
    expect(problemsOf(edit((c) => (c.claims[1].covers = { nodes: ["no_such_step"] })))).toContain("unknown_claim_target");
    // Secondary sources alone cannot carry it.
    expect(problemsOf(edit((c) => c.claims.forEach((x) => x.support === "supported" && (x.support = "partially_supported", (x.note = "x")))))).toContain("no_primary_source");
  });

  it("refuses a numeric pass range written into generic content", () => {
    const fixed = edit((c) => {
      const m = c.workflow.nodes.find((n) => n.id === "fuel_pressure") as Extract<WorkflowDefinition["nodes"][number], { type: "measurement" }>;
      delete m.specification;
      m.outcomes = [{ id: "below_spec", when: { max: 299 }, to: "concl_fuel", supports: ["fuel_delivery"] }, { id: "within_spec", when: { min: 300 }, to: "multi_tests" }];
    });
    expect(problemsOf(fixed)).toContain("embedded_numeric_range");
  });

  it("contains no real or OEM numeric specification, manufacturer, or proprietary procedure", () => {
    const numbers: Array<[string, number]> = [];
    const walk = (v: unknown, at: string) => {
      if (typeof v === "number") numbers.push([at, v]);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    };
    walk(G, "workflow");
    // Only the version and the documented plausibility guard on the one measurement.
    expect(numbers).toEqual([
      ["workflow.version", 1],
      [expect.stringMatching(/measurement\.plausible\.min$/), 0],
      [expect.stringMatching(/measurement\.plausible\.max$/), 1000],
    ]);
    expect(specificationsUsed(G)).toEqual(["fuel_supply_pressure_expected"]);
    expect(G.applicability).toEqual({ fuel: ["gasoline"] });
    const text = JSON.stringify(G);
    expect(text).not.toMatch(/\b(BMW|ISTA|Toyota|Ford|Honda|Volkswagen|Mercedes|GM|Chevrolet|Nissan|Hyundai)\b/i);
    expect(text).not.toMatch(/\bpsi\b|\bohms?\b|\d+\s*(kpa|bar|psi|v|ohm)\b/i);
    expect(G.nodes.some((n) => n.type === "actuator_test" || n.type === "service_function")).toBe(false);
  });
});

/* ───────────────────────── the generic workflow on the unchanged engine ───────────────────────── */

describe("V2H generic workflow: applicability and context", () => {
  it("validates as an ordinary workflow and starts on a gasoline engine", () => {
    expect(validateWorkflow(G)).toEqual({ ok: true });
    expect(startSession(G, facts(BASIC)).ok).toBe(true);
  });

  it("does not start for diesel, electric or hybrid propulsion", () => {
    for (const fuel of ["diesel", "electric", "hybrid"] as const) {
      expect(startSession(G, facts(BASIC, { vehicle: { fuel } }))).toEqual({ ok: false, error: "not_applicable: the vehicle does not match fuel" });
    }
  });

  it("does not guess when the fuel type is unknown", () => {
    expect(startSession(G, facts(BASIC, { vehicle: {} }))).toEqual({ ok: false, error: "insufficient_context: the vehicle's fuel must be known" });
    expect(startSession(G, { capabilities: BASIC })).toMatchObject({ ok: false, error: expect.stringMatching(/^insufficient_context/) });
  });
});

describe("V2H generic workflow: capability-aware", () => {
  it("offers a basic owner only what they can do, and is honest about the rest", () => {
    const r = region(atSingle(BASIC));
    expect(ranked(r)).toEqual(["connector_inspection"]);
    expect(r.blocked.map((b) => [b.step, b.reason])).toEqual([
      ["ignition_swap", "capability"],
      ["plug_inspection", "capability"],
      ["relative_compression", "capability"],
    ]);
    // Without live data, an unknown pattern is referred to a code read, not guessed.
    const s = run(facts(BASIC), [yes("confirm_symptom"), no("mil_flashing"), { nodeId: "ask_pattern", kind: "choice", choice: "unknown" }, met("data_secure")]);
    expect(s).toMatchObject({ conclusionNodeId: "concl_read_codes", endResult: "referred", supportedCauses: [] });
    expect(s.evidence.find((e) => e.nodeId === "read_misfire_data")).toMatchObject({ kind: "unsupported" });
  });

  it("gives advanced DIY live data, and a workshop every check, while V2E ranking still decides", () => {
    const s = run(facts(ADVANCED), [yes("confirm_symptom"), no("mil_flashing"), { nodeId: "ask_pattern", kind: "choice", choice: "unknown" }, met("data_secure"), seen("read_misfire_data", "several")]);
    expect(s.currentNodeId).toBe("multi_secure");
    expect(ranked(region(atSingle(DIY)))).toEqual(["ignition_swap", "connector_inspection", "plug_inspection"]);
    const workshop = region(atSingle(WORKSHOP));
    expect(ranked(workshop)).toEqual(["ignition_swap", "connector_inspection", "plug_inspection", "relative_compression"]);
    expect(workshop.blocked).toEqual([]);
    // The most advanced check does not win because it exists: lower risk comes first.
    expect(workshop.recommended?.preferredOver.find((p) => p.step === "relative_compression")?.because).toMatch(/risk/i);
    expect(ranked(region(atMulti(WORKSHOP)))).toEqual(["intake_leak_check", "fuel_pressure"]);
  });
});

describe("V2H generic workflow: specifications", () => {
  const toPressure = (options: EngineOptions, value = 200) => {
    const s = atMulti(WORKSHOP, options);
    const chosen = submitStep(G, s, pick("multi_tests", "fuel_pressure"), undefined, options);
    if (!chosen.ok) throw new Error(chosen.error);
    return submitStep(G, chosen.session, { nodeId: "fuel_pressure", kind: "measurement", value, unit: "kPa" }, undefined, options);
  };

  it("judges a reading only against a VERIFIED specification", () => {
    const r = toPressure(withSpec("verified"));
    expect(r).toMatchObject({ ok: true, session: { conclusionNodeId: "concl_fuel", supportedCauses: ["fuel_delivery"] } });
  });

  it("invents no pass or fail when the specification is absent", () => {
    // No specification: the step is routed away as soon as it is reached; no reading is ever judged.
    const s = atMulti(WORKSHOP);
    const r = submitStep(G, s, pick("multi_tests", "fuel_pressure"));
    if (!r.ok) throw new Error(r.error);
    expect(r.session.currentNodeId).toBe("multi_tests");
    expect([r.session.supportedCauses, r.session.remainingCauses]).toEqual([[], G.causes.map((c) => c.id)]);
    expect(r.session.evidence.filter((e) => e.nodeId === "fuel_pressure").map((e) => e.kind)).toEqual(["specification", "unsupported"]);
    expect(submitStep(G, r.session, { nodeId: "fuel_pressure", kind: "measurement", value: 200, unit: "kPa" })).toEqual({ ok: false, error: "not_current_step" });
  });

  it("keeps an unverified specification informational", () => {
    const r = toPressure(withSpec("unverified"));
    if (!r.ok) throw new Error(r.error);
    expect(r.session).toMatchObject({ currentNodeId: "multi_tests", supportedCauses: [], remainingCauses: G.causes.map((c) => c.id) });
    expect(r.session.evidence.find((e) => e.nodeId === "fuel_pressure" && e.kind === "measurement")).toMatchObject({ judgement: { evaluated: false, reason: "untrusted_spec" } });
  });
});

describe("V2H generic workflow: structured codes under the V2D rules", () => {
  const routeOf = (scans: DiagnosticScanInput[]) => run(facts(WORKSHOP, { scans }), [yes("confirm_symptom"), no("mil_flashing")]).currentNodeId;

  it("routes by current codes only, and a code never changes a cause", () => {
    expect(routeOf(P0302)).toBe("single_secure");
    expect(routeOf(P0300)).toBe("multi_secure");
    expect(routeOf([scan([{ code: "P0300", status: ["confirmed"] }, { code: "P0302", status: ["confirmed"] }])])).toBe("multi_secure");
    // Permanent or history alone is not a current fault, and an unknown status is not assumed current.
    expect(routeOf([scan([{ code: "P0302", status: ["permanent"] }])])).toBe("ask_pattern");
    expect(routeOf([scan([{ code: "P0302", status: ["history"] }], { reportsStatus: ["pending", "confirmed", "history"] })])).toBe("ask_pattern");
    expect(routeOf([{ id: "typed", source: "person", completeness: "unknown", codes: [{ code: "P0302" }] }])).toBe("ask_pattern");
    const s = run(facts(WORKSHOP, { scans: P0302 }), [yes("confirm_symptom"), no("mil_flashing")]);
    expect([s.remainingCauses, s.supportedCauses]).toEqual([G.causes.map((c) => c.id), []]);
    expect(codesUsed(G)).toEqual(["P0300", "P0301", "P0302", "P0303", "P0304", "P0305", "P0306", "P0307", "P0308", "P0309", "P0310", "P0311", "P0312"]);
  });

  it("ends early and refers when the check-engine light flashes", () => {
    const s = run(facts(BASIC), [yes("confirm_symptom"), yes("mil_flashing")]);
    expect(s).toMatchObject({ status: "completed", conclusionNodeId: "concl_severe_misfire", endResult: "referred", supportedCauses: [] });
  });
});

describe("V2H generic workflow: next best test, conflicts and verification", () => {
  it("ranks only inside its two declared regions", () => {
    expect(nextBestTests(G, run(facts(WORKSHOP), [yes("confirm_symptom")]))).toMatchObject({ status: "follow_workflow", currentStep: "mil_flashing" });
    expect(G.nodes.filter((n) => n.type === "test_selection").map((n) => (n as { group: string }).group)).toEqual(["single_cylinder_tests", "multiple_cylinder_tests"]);
    expect(submitStep(G, atSingle(WORKSHOP), pick("single_tests", "fuel_pressure"))).toMatchObject({ ok: false, error: expect.stringMatching(/^not_eligible/) });
  });

  it("recommends without probabilities, costs or confidence", () => {
    for (const caps of [BASIC, DIY, ADVANCED, WORKSHOP]) {
      const text = JSON.stringify([nextBestTests(G, atSingle(caps)), nextBestTests(G, atMulti(caps))]);
      expect(text).not.toMatch(/probab|percent|%|confiden|cost|price|\$|likelihood|score/i);
    }
  });

  it("cannot even reach a contradiction in the draft's own region: a test that could only support a ruled-out cause is not offered", () => {
    const s = run(facts(WORKSHOP, { scans: P0302 }), [...SINGLE, pick("single_tests", "ignition_swap"), seen("ignition_swap", "stayed")]);
    expect(region(s).excluded).toEqual(expect.arrayContaining([expect.objectContaining({ step: "plug_inspection", reason: "cannot_change_remaining_causes" })]));
  });

  it("ends inconclusive on contradictory evidence instead of picking a side", () => {
    // A reviewer variant in which a plug with no visible difference rules ignition out: then a swap that moves the misfire contradicts it.
    const variant = edit((c) => ((c.workflow.nodes.find((n) => n.id === "plug_inspection") as { outcomes: Array<{ rulesOut?: string[] }> }).outcomes[1].rulesOut = ["ignition"])).workflow;
    const s = run(facts(WORKSHOP, { scans: P0302 }), [...SINGLE, pick("single_tests", "plug_inspection"), seen("plug_inspection", "no_difference"), pick("single_tests", "ignition_swap"), seen("ignition_swap", "moved")], {}, variant);
    expect(s).toMatchObject({ status: "completed", endResult: "inconclusive", conclusionNodeId: null });
    expect(s.evidence.at(-1)).toMatchObject({ kind: "conflict", conflict: { causes: [{ cause: "ignition", earlierState: "ruled_out", newEvidenceWould: "support" }] } });
  });

  it("plans a bounded recheck: the detecting check, then the workflow's criteria, nothing unrelated", () => {
    const viaConnector = run(facts(WORKSHOP, { scans: P0302 }), [...SINGLE, pick("single_tests", "connector_inspection"), seen("connector_inspection", "damaged_or_loose")]);
    const plan = recheckPlan(G, viaConnector);
    if (plan.status !== "plan") throw new Error("no plan");
    expect(plan.items.map((i) => (i.kind === "detecting_test" ? `detect:${i.step}` : `${i.criterionKind}:${i.criterion}`))).toEqual(["detect:connector_inspection", "codes_absent:codes_not_returned", "symptom_absent:symptom_gone"]);
    expect(plan.items[0]).toMatchObject({ repeatable: true, coveredBy: "detecting_check_passes" });
    // A swap test is never repeated after the repair.
    const viaSwap = run(facts(WORKSHOP, { scans: P0302 }), [...SINGLE, pick("single_tests", "ignition_swap"), seen("ignition_swap", "moved")]);
    const swapPlan = recheckPlan(G, viaSwap);
    expect(swapPlan.status === "plan" && swapPlan.items[0]).toMatchObject({ step: "ignition_swap", repeatable: false, reason: "workflow_marks_not_repeatable" });
    expect(JSON.stringify(swapPlan)).not.toMatch(/relative_compression|intake_leak_check|fuel_pressure/);
  });

  it("verifies only with objective evidence: a complete post-repair scan, the symptom gone and the detecting check passing", () => {
    const at = run(facts(WORKSHOP, { scans: P0302 }), [...SINGLE, pick("single_tests", "connector_inspection"), seen("connector_inspection", "damaged_or_loose")]);
    const verify = (codes: DiagnosticScanInput | "said_ok") =>
      submitStep(G, at, {
        nodeId: "verify_electrical",
        kind: "verification",
        results: [{ criterion: "detecting_check_passes", observed: "look_ok" }, { criterion: "symptom_gone", result: "met" }, codes === "said_ok" ? { criterion: "codes_not_returned", result: "inconclusive" } : { criterion: "codes_not_returned", scan: codes }],
      } as StepInput);
    const after = (codes: DiagnosticScanInput["codes"], over: Partial<DiagnosticScanInput> = {}) => scan(codes, { id: "after", ...over });
    expect(verify(after([]))).toMatchObject({ ok: true, session: { verification: "verified", endResult: "resolved" } });
    // A partial scan cannot prove the codes are gone.
    expect(verify(after([], { completeness: "partial" }))).toMatchObject({ ok: true, session: { verification: "inconclusive" } });
    // A code reported only as permanent is not proof of failure, nor of success.
    expect(verify(after([{ code: "P0302", status: ["permanent"] }]))).toMatchObject({ ok: true, session: { verification: "inconclusive" } });
    expect(verify(after([{ code: "P0302", status: ["confirmed"] }]))).toMatchObject({ ok: true, session: { verification: "not_verified" } });
    // The person's word alone is not enough.
    expect(verify("said_ok")).toMatchObject({ ok: true, session: { verification: "inconclusive" } });
    const said = submitStep(G, at, { nodeId: "verify_electrical", kind: "verification", results: [{ criterion: "detecting_check_passes", observed: "look_ok" }, { criterion: "symptom_gone", result: "met" }, { criterion: "codes_not_returned", result: "met" }] } as StepInput);
    expect(said.ok).toBe(false);
  });
});

/* ───────────────────────── catalog and fingerprints ───────────────────────── */

describe("V2H content catalog", () => {
  const catalog = createContentCatalog([SYNTHETIC_MISFIRE, GENERIC_GASOLINE_MISFIRE]);

  it("resolves exact id and version only", () => {
    expect(catalog.resolve(G.id, 1)).toMatchObject({ contentClass: "generic_source_backed", review: { status: "draft" }, fingerprint: workflowFingerprint(G) });
    expect(catalog.resolve(G.id, 2)).toBeNull();
    expect(catalog.resolve(G.id, 0)).toBeNull();
    expect(catalog.resolve("generic.unknown", 1)).toBeNull();
    expect(catalog.workflowResolver().resolve(G.id, 2)).toBeNull();
    expect(catalog.workflowResolver({ minReview: "approved" }).resolve(G.id, 1)).toBeNull();
    expect(catalog.workflowResolver().resolve(SYNTHETIC_MISFIRE_WORKFLOW.id, SYNTHETIC_MISFIRE_WORKFLOW.version)).toEqual(SYNTHETIC_MISFIRE_WORKFLOW);
  });

  it("holds only valid content, once, frozen", () => {
    expect(() => createContentCatalog([edit((c) => (c.sources = []))])).toThrow(InvalidContentError);
    expect(() => createContentCatalog([GENERIC_GASOLINE_MISFIRE, edit((c) => (c.review.contentRevision = 2))])).toThrow(/duplicate_entry/);
    const entry = catalog.resolve(G.id, 1)!;
    expect(Object.isFrozen(entry.workflow.nodes[0])).toBe(true);
    expect(() => ((entry.review as { status: string }).status = "approved")).toThrow();
    // The caller's object is copied, so later edits to it never reach the catalog.
    const mine = clone(GENERIC_GASOLINE_MISFIRE);
    const own = createContentCatalog([mine]);
    mine.workflow.title = "changed";
    expect(own.resolve(G.id, 1)!.workflow.title).toBe(G.title);
  });

  it("follows the fingerprint rule: diagnostic content changes it, administrative metadata does not", () => {
    const fp = contentFingerprint(G);
    expect(fp).toBe(workflowFingerprint(G));
    const admin = edit((c) => {
      c.review.contentRevision = 2;
      c.sources[0].limitations += " Re-checked.";
      c.claims[0].note = "Reworded note.";
      c.excludes.push("Another exclusion");
    });
    expect(validateContent(admin)).toEqual({ ok: true, fingerprint: fp });
    const diagnostic = [
      edit((c) => ((c.workflow.nodes.find((n) => n.id === "plug_inspection") as { outcomes: Array<{ supports?: string[] }> }).outcomes[0].supports = [])),
      edit((c) => (c.workflow.nodes.find((n) => n.id === "fuel_pressure")!.requires!.hazards = [])),
      edit((c) => (c.workflow.applicability = { fuel: ["gasoline", "hybrid"] })),
      edit((c) => ((c.workflow.nodes.find((n) => n.id === "concl_air") as { recommendation: string }).recommendation = "Something else.")),
    ];
    for (const d of diagnostic) expect(contentFingerprint(d.workflow)).not.toBe(fp);
  });

  it("lets a persisted session resolve the workflow by exact version, through metadata-only changes but never through diagnostic ones", async () => {
    const repository = createInMemorySessionRepository({ vehicles: { car: "ann" } });
    const ann = ownerFromAuthenticatedUser("ann")!;
    const store = (c: ReturnType<typeof createContentCatalog>) => createSessionStore({ repository, workflows: c.workflowResolver(), newId: () => "s-1" });
    const started = startSession(G, facts(WORKSHOP, { scans: P0302 }), "2026-10-16T10:00:00Z");
    if (!started.ok) throw new Error(started.error);
    expect(await store(catalog).start(ann, { vehicleId: "car", session: started.session })).toMatchObject({ status: "saved" });
    // Administrative change (review notes, a source's limitations, the content revision): same workflow, still loads.
    const adminCatalog = createContentCatalog([edit((c) => ((c.review.contentRevision = 2), (c.sources[2].limitations += " More.")))]);
    expect(await store(adminCatalog).load(ann, "s-1")).toMatchObject({ status: "loaded", workflow: { id: G.id, version: 1 } });
    // A diagnostic change under the same version is refused, never silently applied to history.
    const changedCatalog = createContentCatalog([edit((c) => (c.workflow.causes[0].title = "Ignition (changed)"))]);
    expect(await store(changedCatalog).load(ann, "s-1")).toMatchObject({ status: "incompatible_workflow", reason: "workflow_changed" });
    // A catalog without that version cannot load it, and does not substitute another.
    const v2 = createContentCatalog([edit((c) => (c.workflow.version = 2))]);
    expect(await store(v2).load(ann, "s-1")).toMatchObject({ status: "incompatible_workflow", reason: "workflow_unavailable" });
  });

  it("lets a model suggest catalog ids only, without gaining any authority over the content", async () => {
    const fakeModel: WorkflowSuggestionAdapter = {
      async suggest({ catalog: offered }) {
        // Tries to suggest a real catalog id, an invented one, and to smuggle an upgrade in its output.
        return { workflowIds: [...offered.map((w) => w.id), "invented.bmw-misfire"] };
      },
    };
    const offered = catalog.suggestionCatalog();
    expect(offered.map((w) => w.id)).toEqual([G.id]); // synthetic content is not offered
    const result = await suggestWorkflows(fakeModel, "my engine misfires", offered, { fuel: "gasoline" });
    expect(result).toEqual({ status: "ok", suggestions: [{ workflowId: G.id, status: "startable" }], rejected: [{ id: "invented.bmw-misfire", reason: "not_in_catalog" }] });
    expect(await suggestWorkflows(fakeModel, "misfire", offered, { fuel: "diesel" })).toMatchObject({ suggestions: [{ workflowId: G.id, status: "not_applicable" }] });
    const sneaky: WorkflowSuggestionAdapter = { async suggest() { return { workflowIds: [G.id], reviewStatus: "approved" }; } };
    expect(await suggestWorkflows(sneaky, "misfire", offered, { fuel: "gasoline" })).toMatchObject({ status: "invalid", reason: "malformed_output" });
    // Nothing about the content changed.
    expect(catalog.resolve(G.id, 1)).toMatchObject({ review: { status: "draft", reviews: [] }, fingerprint: contentFingerprint(G) });
  });
});

/* ───────────────────────── boundaries ───────────────────────── */

describe("V2H boundaries", () => {
  const ROOT = path.join(__dirname, "..");
  const tsFiles = (dir: string) => (fs.readdirSync(path.join(ROOT, dir), { recursive: true }) as string[]).map(String).filter((f) => /\.(ts|tsx)$/.test(f));

  it("keeps content out of the engine, and the engine free of content and research tooling", () => {
    for (const f of tsFiles("app/lib/diagnostic-workflow")) {
      const text = fs.readFileSync(path.join(ROOT, "app/lib/diagnostic-workflow", f), "utf8");
      expect(text, f).not.toMatch(/diagnostic-workflow-content|diagnostic-workflow-persistence|diagnostic-workflow-bridge|generated\/prisma|@prisma\/|from ["'](zod|openai|node:crypto|crypto)["']|fetch\(/);
    }
    // Real content lives outside the engine; the engine folder holds only the synthetic fixture.
    expect(fs.readFileSync(path.join(ROOT, "app/lib/diagnostic-workflow/engine.ts"), "utf8")).not.toMatch(/generic\.gasoline|P030\d|fuel_supply_pressure_expected/);
  });

  it("keeps the content folder free of AI, network and database code", () => {
    for (const f of tsFiles("app/lib/diagnostic-workflow-content")) {
      const text = fs.readFileSync(path.join(ROOT, "app/lib/diagnostic-workflow-content", f), "utf8");
      expect(text, f).not.toMatch(/diagnostic-workflow-bridge|prisma|from ["'](openai|ai|pg)["']|@anthropic-ai|fetch\(|XMLHttpRequest/);
    }
  });

  it("is not used by the production app", () => {
    for (const f of tsFiles("app").filter((f) => !f.includes("diagnostic-workflow") && !f.startsWith("generated"))) {
      expect(fs.readFileSync(path.join(ROOT, "app", f), "utf8"), f).not.toMatch(/diagnostic-workflow/);
    }
  });
});
