/**
 * Guided diagnostic workflows: the shapes.
 *
 * RESEARCH PROTOTYPE. Not used by any route, page or API. Nothing in the app
 * imports it yet.
 *
 * A workflow is a fixed, checked graph of steps ("nodes"). Each step asks for
 * one piece of evidence (an answer, an observation, a measurement, the result
 * of a check), and the evidence decides the next step. Running a workflow is
 * deterministic: the same workflow, the same starting facts and the same
 * answers always lead to the same steps and the same conclusion. No AI model
 * is involved in running one.
 *
 * V2A ("honest outcomes") adds: inconclusive results, evidence phase and
 * source, named conditions, plausible ranges separate from pass ranges, a
 * placeholder for specification trust, an explicit single-primary-fault
 * assumption, and repair verification that names its re-tests. See
 * docs/research/guided-diagnostics/v2a.md.
 *
 * V2B moves vehicle-specific values out of the session facts into a
 * SpecificationProvider: a measurement names a specification id, the
 * provider resolves it, and the engine records and pins what it used. See
 * docs/research/guided-diagnostics/v2b-specifications.md.
 *
 * V2C adds a pinned VehicleContext with declarative workflow applicability,
 * a structured DiagnosticCapabilityContext, and two modelling-only step
 * kinds for work an EXTERNAL tool does (actuator tests, service functions).
 * The engine never talks to a vehicle. See
 * docs/research/guided-diagnostics/v2c-context-capabilities.md.
 *
 * V2D replaces bare trouble-code strings with structured scan evidence
 * (raw and canonical code, format, REPORTED status flags, module origin,
 * completeness) and adds immutable freeze-frame snapshots, interpreted only
 * by an explicit snapshot_check step. See
 * docs/research/guided-diagnostics/v2d-dtc-freeze-frame.md.
 *
 * V2E adds explicit reorderable test regions (test_selection) with a
 * deterministic next-best-test ranking (no probabilities, no costs), and a
 * bounded post-repair recheck plan. See
 * docs/research/guided-diagnostics/v2e-next-best-test.md.
 *
 * Original CarCode design, written from general troubleshooting practice.
 */
import type { CheckLevel } from "../diagnosis-schema";

/* ───────────────────────── who can do a step, and with what ───────────────────────── */

/** Who can safely carry out a step: the same three levels the diagnosis already uses. */
export type SkillLevel = CheckLevel;
export const SKILL_ORDER: Record<SkillLevel, number> = { owner: 0, diy: 1, professional: 2 };

/**
 * How far the person's scan tool reaches, in order. Each level includes the
 * ones before it: reading codes, reading live data, then commanding
 * components (bidirectional).
 */
export const SCAN_ACCESS = ["none", "codes", "live_data", "bidirectional"] as const;
export type ScanAccess = (typeof SCAN_ACCESS)[number];
export const SCAN_ORDER: Record<ScanAccess, number> = { none: 0, codes: 1, live_data: 2, bidirectional: 3 };

/** Generic instrument categories. No brands, no models. */
export const INSTRUMENTS = ["hand_tools", "multimeter", "pressure_gauge", "compression_tester", "oscilloscope", "smoke_machine", "other"] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

/** Generic facility categories. */
export const FACILITIES = ["vehicle_lift", "workshop_space"] as const;
export type Facility = (typeof FACILITIES)[number];

/** What a step needs. A step with no requirements is an owner-level step needing nothing. */
export type StepRequirements = {
  level: SkillLevel;
  /** The minimum scan access. */
  scan?: ScanAccess;
  instruments?: Instrument[];
  facilities?: Facility[];
  /** Short hazard notes the page must show with the step (hot engine, high voltage, fuel). */
  hazards?: string[];
};

/**
 * What the person working through the workflow can actually do, stated
 * explicitly. The engine reads only this; a preset name grants nothing.
 */
export type DiagnosticCapabilityContext = {
  skill: SkillLevel;
  scanAccess: ScanAccess;
  instruments: Instrument[];
  facilities: Facility[];
};

/** Why a step cannot be done with the person's capabilities. */
export type CapabilityShortfall = "level" | "scan_access" | "instruments" | "facilities";

/* ───────────────────────── trouble codes and snapshots (V2D) ───────────────────────── */

/**
 * How a code is written.
 * - obd: the standard five-character P/B/C/U form (e.g. P0301). Upper-cased; nothing else changes.
 * - opaque: a manufacturer-specific identifier, kept exactly as given (trimmed).
 * - unclassified: not declared and not in the OBD form; kept exactly as given (trimmed).
 * No meanings or descriptions are attached to any code.
 */
export const DTC_FORMATS = ["obd", "opaque", "unclassified"] as const;
export type DtcFormat = (typeof DTC_FORMATS)[number];
export type ObdSystem = "powertrain" | "body" | "chassis" | "network";

/**
 * A status a diagnostic SOURCE reported for a code. Reported data, never the
 * engine's interpretation, and never on its own proof that a part is bad,
 * that the fault is happening now, or that a cause is confirmed. Not every
 * source supports every flag: "active" (present now) may only be used by a
 * source that declares it reports it.
 */
export const DTC_STATUS_FLAGS = ["pending", "confirmed", "permanent", "history", "active"] as const;
export type DtcStatusFlag = (typeof DTC_STATUS_FLAGS)[number];

/**
 * Whether a scan holds everything its source claims to provide.
 * - complete: every code the source covers is listed, so a code not listed is not present (within its coverage).
 * - partial / unknown: a code not listed may still be present. No absence can be concluded.
 */
export const COMPLETENESS = ["complete", "partial", "unknown"] as const;
export type Completeness = (typeof COMPLETENESS)[number];

/** Where evidence came from inside the vehicle, when the source says. Provenance only: no addressing, no topology. */
export type ModuleOrigin = { id: string; name?: string };

/** One code as the source reported it (input). */
export type DtcObservationInput = {
  code: string;
  /** Declared by the source. Omitted: the OBD form is recognized, anything else is unclassified. */
  format?: "obd" | "opaque";
  /** Reported status flags. Omitted means unknown. Never empty. */
  status?: DtcStatusFlag[];
  module?: ModuleOrigin;
  /** The id of a snapshot in the same scan that was captured with this code. */
  snapshot?: string;
};

/** One freeze-frame / snapshot parameter. A missing value means the source did not provide it. */
export type SnapshotParameter = { id: string; value?: number | string; unit?: Unit };

/** Values captured at or around a fault event. Not a live measurement. */
export type SnapshotInput = {
  id: string;
  parameters: SnapshotParameter[];
  /** Capture time and/or order, as supplied by the source. */
  captured?: { at?: string; order?: number };
  completeness?: Completeness;
};

/** A set of codes (and snapshots) from one read, as supplied. Pinned in the session as given. */
export type DiagnosticScanInput = {
  /** Unique within the session. */
  id: string;
  /** "scan_tool" for a tool read, "person" for codes typed in. */
  source: "scan_tool" | "person";
  completeness: Completeness;
  /** The modules a complete scan covers. Omitted: the whole vehicle, as far as the source claims. */
  coverage?: { modules: string[] };
  /** The status flags this source is able to report. Omitted: not stated, so a missing flag proves nothing. */
  reportsStatus?: DtcStatusFlag[];
  codes: DtcObservationInput[];
  snapshots?: SnapshotInput[];
};

/** A code as recorded in the evidence. */
export type DtcObservation = {
  raw: string;
  /** The canonical form: upper case for OBD codes, the trimmed raw text otherwise. */
  code: string;
  format: DtcFormat;
  system?: ObdSystem;
  status: DtcStatusFlag[] | "unknown";
  module?: ModuleOrigin;
  snapshot?: string;
  scan: string;
};

/** A scan as recorded in the evidence (its codes and snapshots are recorded separately). */
export type ScanRecord = { id: string; completeness: Completeness; coverage?: { modules: string[] }; reportsStatus?: DtcStatusFlag[]; codeCount: number };

/** A snapshot as recorded in the evidence. */
export type SnapshotRecord = {
  id: string;
  scan: string;
  /** The canonical code it was captured with, when one code references it. Absent: standalone. */
  forCode?: string;
  captured?: { at?: string; order?: number };
  completeness: Completeness;
  parameters: SnapshotParameter[];
};

/** Declarative code question: at least a code or a module. A list of codes means "any of". */
export type DtcMatcher = { code?: string | string[]; status?: DtcStatusFlag; module?: string };

/* ───────────────────────── the fault model ───────────────────────── */

/**
 * What a workflow assumes about how many faults there are. V2A supports one
 * model only, and every workflow must say so: the symptom has ONE primary
 * cause. Ruling causes out relies on it (if the misfire follows the coil, the
 * plug is ruled out). A second, simultaneous fault is caught by repair
 * verification failing, not by the elimination logic.
 */
export const FAULT_MODELS = ["single_primary_fault"] as const;
export type FaultModel = (typeof FAULT_MODELS)[number];

/* ───────────────────────── named conditions ───────────────────────── */

/**
 * A named state the vehicle must be in for a step to make sense, for example
 * "engine_off_cool" or "engine_idling_warm". Declared once per workflow,
 * established by a prerequisite (when met) or an action (when done), and
 * required by the steps that depend on it. The checker proves every route to a
 * step establishes what it needs first.
 */
export type ConditionId = string;
export type DiagnosticConditionDefinition = { id: ConditionId; title: string };

/* ───────────────────────── measurements and specifications ───────────────────────── */

export const UNITS = ["V", "mV", "ohm", "kohm", "A", "kPa", "bar", "psi", "ms", "Hz", "rpm", "percent", "degC"] as const;
export type Unit = (typeof UNITS)[number];

/**
 * A bound written into the workflow. Only for GENERIC checks (a value that
 * holds for any vehicle). A workflow never carries vehicle values: a
 * vehicle-specific limit is a specification the measurement names
 * (`MeasurementNode.specification`), resolved by a SpecificationProvider.
 */
export type Bound = number;

/** Inclusive by default on both ends. An open end is left out. */
export type NumericRange = { min?: Bound; max?: Bound; minInclusive?: boolean; maxInclusive?: boolean };

export type MeasurementDefinition = {
  /** What is measured, in plain words. */
  quantity: string;
  unit: Unit;
  /**
   * The values this quantity can physically take on a running vehicle, in
   * `unit`. Not a specification and not a pass range: it only catches typos
   * and wrong readings (4500 kPa typed for 450). A reading outside it is
   * refused and the session is unchanged. Generic numbers only.
   */
  plausible: { min: number; max: number };
};

/**
 * How far a specification can be trusted. Approved rule: only a "verified"
 * specification may drive the engine (pass or fail, ruling causes in or out,
 * choosing a route). "reference" and "unverified" ones are informational
 * only: kept and shown with the reading, never used to judge it. The engine
 * never upgrades trust.
 */
export const SPEC_TRUST = ["verified", "reference", "unverified"] as const;
export type SpecTrust = (typeof SPEC_TRUST)[number];

/* ───────────────────────── specifications (V2B) ───────────────────────── */

export type SpecificationId = string;

/**
 * A vehicle-specific expected value, kept OUTSIDE workflows. A workflow asks
 * for one by id; a SpecificationProvider resolves it.
 */
export type DiagnosticSpecification = {
  /** What the workflow asks for, e.g. "fuel_supply_pressure_idle". */
  id: SpecificationId;
  /**
   * Identity of this exact value set (source edition, dataset revision). A
   * session records it, so a later, different value is a different revision
   * and never silently replaces the one a judgement used.
   */
  revision: string;
  /** The unit the source gives the values in. The engine converts to the step's unit (same kind of quantity only). */
  unit: Unit;
  /** Inclusive expected (pass) range. At least one end. */
  expected: { min?: number; max?: number };
  /** Optional narrower plausible range for this vehicle. Applied only when the specification is verified. */
  plausible?: { min: number; max: number };
  /** Named conditions the value holds under (e.g. engine_idling). The engine checks them; the provider does not. */
  conditions?: ConditionId[];
  /** Where the value came from. */
  source: { name: string; reference?: string };
  trust: SpecTrust;
  note?: string;
};

/**
 * What the engine asks a provider for: an id and the session's PINNED vehicle
 * context (so a future provider can pick the value for that vehicle). Nothing else.
 */
export type SpecificationRequest = { id: SpecificationId; vehicle?: Readonly<VehicleContext> };

/**
 * A provider's answer. Never a bare number.
 * - verified: exactly one match, trust "verified". May drive the engine.
 * - informational: exactly one match that is not verified. Shown, never used to judge.
 * - not_found: no match.
 * - ambiguous: several candidates. The engine never picks one.
 * - unavailable: the lookup failed (reason says why).
 */
export type SpecificationResolution =
  | { status: "verified"; specification: DiagnosticSpecification }
  | { status: "informational"; specification: DiagnosticSpecification }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: DiagnosticSpecification[] }
  | { status: "unavailable"; reason: string };

/** Resolves specifications by id. Synchronous and deterministic for the engine; any slow lookup happens before the session runs. */
export interface SpecificationProvider {
  resolve(request: SpecificationRequest): SpecificationResolution;
}

/** How the engine reaches outside data. Only specifications so far. */
export type EngineOptions = { specifications?: SpecificationProvider };

/** Where a reading sits against its specification's expected range. */
export const SPEC_RELATIONS = ["below", "within", "above"] as const;
export type SpecRelation = (typeof SPEC_RELATIONS)[number];

/** A specification as a judgement used (or could not use) it, for display and history. */
export type SpecificationReference = {
  id: SpecificationId;
  revision: string;
  status: "verified" | "informational";
  trust: SpecTrust;
  source: { name: string; reference?: string };
  /** The unit the source gave. */
  sourceUnit: Unit;
  /** The expected range converted into the step's unit. */
  expected: { min?: number; max?: number };
  /** Each required condition and its state when the reading was taken. */
  conditions: Array<{ id: ConditionId; state: "met" | "not_met" | "unknown" }>;
};

/* ───────────────────────── steps ───────────────────────── */

export type NodeId = string;
export type CauseId = string;

/** What an outcome tells us about the candidate causes. Never a probability. */
export type CauseEffect = {
  /** Causes this outcome rules out. */
  rulesOut?: CauseId[];
  /** Causes this outcome points to (they stay in the list, marked as supported). */
  supports?: CauseId[];
};

/* ───────────────────────── test profile (V2E) ───────────────────────── */

/** Categorical, reviewable comparisons between interchangeable tests. Never probabilities, times or money. */
export const TEST_RISK = ["low", "moderate", "high"] as const;
export type TestRisk = (typeof TEST_RISK)[number];
/** How much a test disturbs the vehicle, least first. */
export const INVASIVENESS = ["observe", "read_data", "command", "disconnect", "disassemble"] as const;
export type Invasiveness = (typeof INVASIVENESS)[number];
/** How much has to be set up before the test can start. */
export const SETUP = ["none", "minor", "significant"] as const;
export type Setup = (typeof SETUP)[number];
export type TestProfile = { risk: TestRisk; invasiveness: Invasiveness; setup: Setup };

type NodeBase = {
  id: NodeId;
  /** Short title for lists and history. */
  title: string;
  /** What the person is asked or told, in plain words. */
  prompt?: string;
  requires?: StepRequirements;
  /** Named conditions that must be established before this step. */
  needsConditions?: ConditionId[];
  /**
   * Where to go when the person cannot do this step (level or tools missing,
   * or they say they cannot). Required for any step above owner level or
   * needing a tool.
   */
  ifUnsupported?: NodeId;
  /** Required on every candidate of a reorderable region: how risky, invasive and involved the test is. */
  testProfile?: TestProfile;
  /**
   * False when repeating this test after a repair would be unsafe or
   * meaningless (a swap test, a destructive check). A post-repair recheck plan
   * then records that it is not repeated, and why. Default: repeatable.
   */
  repeatableAfterRepair?: boolean;
  /**
   * Where to go when the step was done but the result does not decide
   * anything (unclear, intermittent, unstable). Allowed on check, observation
   * and measurement steps, required on repair verification. An inconclusive
   * result never rules a cause in or out.
   */
  ifInconclusive?: NodeId;
};

export type Outcome<W> = { when: W; to: NodeId } & CauseEffect;

export type StartNode = NodeBase & { type: "start"; next: NodeId };

/** Something that must be true before going on. When met, it establishes `establishes`. */
export type PrerequisiteNode = NodeBase & { type: "prerequisite"; ifMet: NodeId; ifNotMet: NodeId; establishes?: ConditionId[] };

export type YesNo = "yes" | "no";
export type QuestionNode = NodeBase &
  (
    | { type: "question"; answer: "yes_no"; outcomes: Outcome<YesNo>[]; otherwise?: NodeId }
    | { type: "question"; answer: "choice"; options: { id: string; label: string }[]; outcomes: Outcome<string>[]; otherwise?: NodeId }
  );

/** Something the person looks at or listens for, with fixed possible findings. */
export type ObservationNode = NodeBase & {
  type: "observation";
  options: { id: string; label: string }[];
  outcomes: Outcome<string>[];
  otherwise?: NodeId;
};

/**
 * A pass range for a measurement. `id` names it in the evidence ("below_min",
 * "within"). With a specification, `when` says where the reading sits against
 * the specification's expected range; without one, `when` is a fixed generic
 * range.
 */
export type MeasurementOutcome = Outcome<NumericRange | { relativeToSpec: SpecRelation }> & { id: string };

export type MeasurementNode = NodeBase & {
  type: "measurement";
  measurement: MeasurementDefinition;
  /**
   * The vehicle-specific specification this reading is judged against, by id.
   * Resolved through the SpecificationProvider when the step is reached. With
   * it, every outcome uses `relativeToSpec`, and `ifUnsupported` is required
   * (for a specification that cannot be resolved).
   */
  specification?: SpecificationId;
  /** First matching range wins. */
  outcomes: MeasurementOutcome[];
  /** For a plausible value that matches no range. Required. */
  otherwise: NodeId;
};

/** A test with a pass or fail result (a component test, a swap test, an actuator test). */
export type CheckNode = NodeBase & { type: "check"; outcomes: Outcome<"pass" | "fail">[] };

/** Something to do before going on (an instruction, an actuator run, clearing codes). When done, it establishes `establishes`. */
export type ActionNode = NodeBase & { type: "action"; next: NodeId; establishes?: ConditionId[] };

/** Decided automatically from what is already known. First matching rule wins. */
export type BranchNode = NodeBase & {
  type: "branch";
  rules: Array<{ if: Condition; to: NodeId } & CauseEffect>;
  otherwise: NodeId;
};

/** Where the evidence led. `cause` names the candidate it points to, if any. */
export type ConclusionNode = NodeBase & {
  type: "conclusion";
  cause?: CauseId;
  /** What to do about it, in plain words. Kept short; no prices or labour times. */
  recommendation: string;
  /** What follows: a repair verification step, or an end node. */
  next: NodeId;
};

/**
 * One thing that must hold after the repair. Each is answered separately and
 * recorded as its own after-repair evidence.
 * - symptom_absent: the original symptom is gone, in the conditions where it happened.
 * - codes_absent: the codes do not come back ("reported" means every code reported before the repair).
 *   Met only from a COMPLETE post-repair scan that does not list them. A code still pending, confirmed or
 *   active is not met; one reported only as permanent or history, or with unknown status, is inconclusive
 *   (reported data, not proof of failure); a partial or unknown scan is inconclusive.
 * - retest: an earlier step is repeated and its result must be one of `passWhen`
 *   (check: "pass"/"fail"; observation: option ids; measurement: range ids).
 *   The new result is linked to the before-repair result of the same step.
 */
export type VerificationCriterion =
  | { id: string; kind: "symptom_absent"; prompt: string }
  | { id: string; kind: "codes_absent"; codes: "reported" | string[] }
  | { id: string; kind: "retest"; step: NodeId; passWhen: string[] };

/**
 * After a repair: did it actually fix the problem? Decided from its criteria:
 * any criterion not met means not verified; otherwise any inconclusive means
 * inconclusive; only all met means verified.
 */
export type RepairVerificationNode = NodeBase & {
  type: "repair_verification";
  criteria: VerificationCriterion[];
  ifVerified: NodeId;
  ifNotVerified: NodeId;
};

/**
 * MODELLING ONLY. An external, compatible diagnostic tool commands a
 * component (a pump, a fan, a valve) and the person reports what happened.
 * The engine never connects to the vehicle or sends anything. `actuator` is a
 * generic id, never a manufacturer command. Requires bidirectional scan access
 * and hazard notes; `results` are the possible observations.
 */
export type ActuatorTestNode = NodeBase & {
  type: "actuator_test";
  actuator: string;
  results: { id: string; label: string }[];
  outcomes: Outcome<string>[];
};

/** What an external tool reports after a service function. */
export const SERVICE_RESULTS = ["completed", "failed", "not_supported"] as const;
export type ServiceResult = (typeof SERVICE_RESULTS)[number];

/**
 * MODELLING ONLY. An external tool runs a generic routine or service
 * procedure (a test routine, an adaptation reset) and reports its status. The
 * engine never runs anything. "not_supported" (the tool or vehicle lacks the
 * function) is not a failure: it takes the cannot-be-done route and can never
 * rule a cause in or out. Requires bidirectional scan access and hazard notes.
 */
export type ServiceFunctionNode = NodeBase & {
  type: "service_function";
  serviceFunction: string;
  outcomes: Outcome<"completed" | "failed">[];
};

/**
 * Interpret ONE snapshot parameter, explicitly. Automatic (no input): it
 * reads the parameter from the before-repair snapshot captured with the first
 * matching code (`from: { dtc }`) or the first snapshot (`from: "any"`), and
 * judges it like a measurement: against a fixed generic range, or against a
 * pinned specification (verified only, conditions confirmed). Anything it
 * cannot interpret (no snapshot or parameter, a text value, another kind of
 * unit, an implausible value, an unresolvable specification) takes
 * `ifUnavailable`; an untrusted specification or unconfirmed condition takes
 * `ifInconclusive`. Importing a snapshot alone never does any of this.
 */
export type SnapshotCheckNode = NodeBase & {
  type: "snapshot_check";
  from: { dtc: DtcMatcher } | "any";
  /** Generic parameter id, e.g. "coolant_temperature". */
  parameter: string;
  measurement: MeasurementDefinition;
  specification?: SpecificationId;
  outcomes: MeasurementOutcome[];
  otherwise: NodeId;
  ifUnavailable: NodeId;
};

/**
 * An EXPLICIT reorderable region: the workflow author states that these
 * tests are interchangeable at this point. Only here does the engine rank
 * tests; everywhere else the workflow's order is authoritative.
 *
 * The person picks one eligible candidate (the engine recommends one); its
 * outcomes either come back here or leave the region (for example to a
 * conclusion). Each candidate runs at most once, so the region always ends.
 * When no eligible candidate can still change the remaining causes, the
 * region exits to `next` on its own.
 */
export type TestSelectionNode = NodeBase & {
  type: "test_selection";
  /** The region's name, e.g. "misfire_primary_tests". Unique in the workflow. */
  group: string;
  /** In the author's order (the final tie-break). `when` must be definitely true for the candidate to be eligible. */
  candidates: Array<{ step: NodeId; when?: Condition }>;
  next: NodeId;
};

/** The end of a workflow. `result` says how it ended. */
export type EndNode = NodeBase & { type: "end"; result: "resolved" | "concluded" | "referred" | "not_reproducible" | "inconclusive" };

export type WorkflowNode =
  | StartNode
  | PrerequisiteNode
  | QuestionNode
  | ObservationNode
  | MeasurementNode
  | CheckNode
  | ActionNode
  | BranchNode
  | ConclusionNode
  | RepairVerificationNode
  | ActuatorTestNode
  | ServiceFunctionNode
  | SnapshotCheckNode
  | TestSelectionNode
  | EndNode;

export type NodeType = WorkflowNode["type"];

/** Step types that may declare `ifInconclusive` (repair verification must). */
export const INCONCLUSIVE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "check",
  "observation",
  "measurement",
  "repair_verification",
  "actuator_test",
  "service_function",
  "snapshot_check",
  // A branch whose rules ask about vehicle facts routes "cannot evaluate" (a fact unknown) here.
  "branch",
]);

/* ───────────────────────── conditions (for automatic branches) ───────────────────────── */

/**
 * Conditions are evaluated three ways (yes / no / unknown) and a branch rule
 * fires only on a definite yes. Code conditions look at before-repair scan
 * evidence: presence is yes; absence is no only when a complete scan covers
 * the question, otherwise unknown.
 */
export type Condition =
  /** A matching code was reported (with the given status, from the given module, when stated). */
  | { dtc: DtcMatcher }
  /** No matching code: a definite no needs a complete scan that covers it. */
  | { noDtc: DtcMatcher }
  /** One of these symptoms was reported at the start. */
  | { symptomAny: string[] }
  /**
   * A vehicle fact equals a value: yes when the pinned fact matches, no when it
   * is known and differs, UNKNOWN when it is missing. A branch that asks one
   * must declare `ifInconclusive` for the unknown case.
   */
  | { vehicle: keyof VehicleContext; equals: string | number }
  /** An earlier step was answered this way. */
  | { answered: NodeId; is: string }
  /** A named condition has been established. */
  | { established: ConditionId }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

/* ───────────────────────── the workflow ───────────────────────── */

export type WorkflowDefinition = {
  id: string;
  version: number;
  title: string;
  /** Where the content came from, said plainly (for example "SYNTHETIC: written for tests"). */
  provenance: string;
  /** Required: the fault model the elimination logic relies on. */
  faultModel: FaultModel;
  /** Which vehicles it applies to. Absent means any vehicle. A session never starts unless it is applicable. */
  applicability?: WorkflowApplicability;
  /** The candidate causes this workflow separates. */
  causes: Array<{ id: CauseId; title: string }>;
  /** Named conditions its steps establish and need. */
  conditions?: DiagnosticConditionDefinition[];
  nodes: WorkflowNode[];
};

/* ───────────────────────── a session ───────────────────────── */

export const FUELS = ["gasoline", "diesel", "hybrid", "electric"] as const;
export type Fuel = (typeof FUELS)[number];

/**
 * The vehicle facts that decide which workflows and specifications apply.
 * Normalized when a session starts (strings trimmed, lower case; blanks are
 * unknown) and pinned in the session's facts, so a later change of the
 * selected vehicle never reaches an existing session. An absent field is
 * UNKNOWN, never assumed.
 */
export type VehicleContext = {
  year?: number;
  make?: string;
  model?: string;
  /** Engine or powertrain identifier, free text (e.g. "synthetic-i4-a"). */
  engine?: string;
  fuel?: Fuel;
  cylinders?: number;
  /** Market or region, when a specification differs by it. */
  market?: string;
};

/**
 * Which vehicles a workflow applies to. Declarative: every stated field must
 * hold, and a list means "any of". Unknown vehicle facts are never guessed.
 */
export type WorkflowApplicability = {
  fuel?: Fuel[];
  make?: string[];
  engine?: string[];
  market?: string[];
  years?: { from?: number; to?: number };
  cylinders?: { min?: number; max?: number };
};

export type ApplicabilityField = keyof WorkflowApplicability;

export type ApplicabilityResult =
  | { status: "applicable" }
  | { status: "not_applicable"; mismatched: ApplicabilityField[] }
  | { status: "insufficient_context"; missing: ApplicabilityField[] };

export type SessionStartFacts = {
  vehicle?: VehicleContext;
  /** Code scans available at the start (before the repair), pinned as given. */
  scans?: DiagnosticScanInput[];
  /** Symptom ids the workflow understands (for example "rough_idle"). */
  symptoms?: string[];
  capabilities: DiagnosticCapabilityContext;
};

/** Where a reading or answer came from. */
export type InputSource = "person" | "instrument" | "scan_tool";

/** Why a step was done but did not decide anything. */
export const INCONCLUSIVE_REASONS = ["unclear_result", "intermittent", "reading_unstable", "conditions_not_met"] as const;
export type InconclusiveReason = (typeof INCONCLUSIVE_REASONS)[number];

/** The answer to one verification criterion. */
export type VerificationEntry =
  /** symptom_absent: did it hold? codes_absent without a scan: only not_met or inconclusive. */
  | { criterion: string; result: "met" | "not_met" | "inconclusive" }
  /** codes_absent: the post-repair scan, recorded as after-repair evidence and judged by the engine. */
  | { criterion: string; scan: DiagnosticScanInput }
  /** retest of a check or observation: the new result ("pass", "fail" or an option id). */
  | { criterion: string; observed: string }
  /** retest of a measurement: the new reading. */
  | { criterion: string; value: number; unit: Unit };

/** What the person enters for the current step. `source` defaults by kind (see EvidenceSource). */
export type StepInput = (
  | { nodeId: NodeId; kind: "prerequisite"; met: boolean }
  | { nodeId: NodeId; kind: "yes_no"; answer: YesNo }
  | { nodeId: NodeId; kind: "choice"; choice: string }
  | { nodeId: NodeId; kind: "observation"; choice: string }
  | { nodeId: NodeId; kind: "measurement"; value: number; unit: Unit }
  | { nodeId: NodeId; kind: "check"; result: "pass" | "fail" }
  /** What was observed while an external tool commanded the actuator. */
  | { nodeId: NodeId; kind: "actuator_result"; result: string }
  /** In a reorderable region: the test the person chose. */
  | { nodeId: NodeId; kind: "select_test"; test: NodeId }
  /** What the external tool reported for a service function. */
  | { nodeId: NodeId; kind: "service_result"; result: ServiceResult }
  | { nodeId: NodeId; kind: "done" }
  | { nodeId: NodeId; kind: "verification"; results: VerificationEntry[] }
  /** The step was done, but the result does not decide anything. */
  | { nodeId: NodeId; kind: "inconclusive"; reason: InconclusiveReason }
  /** The person cannot do this step. */
  | { nodeId: NodeId; kind: "unable"; reason: "no_tool" | "not_comfortable" | "not_possible" }
) & { source?: InputSource };

/** Before the repair (finding the fault) or after it (checking the repair worked). */
export type EvidencePhase = "before_repair" | "after_repair";

/**
 * Who produced a piece of evidence. "engine" means the engine decided it from
 * earlier evidence (a branch, a skipped step); "specification_provider" is a
 * specification resolution.
 */
export type EvidenceSource = InputSource | "engine" | "specification_provider";

/** One recorded fact. Never changed once recorded. */
export type Evidence = {
  /** 1, 2, 3 ... in the order recorded. */
  seq: number;
  nodeId: NodeId;
  /**
   * What the evidence IS (the step kind): a reported trouble code, a
   * reported symptom, an answer, a visual or audible observation, a
   * measurement, a component test (check), an action, an inconclusive
   * result, a repair-verification criterion or verdict, a skipped step, an
   * automatic branch. `source` says who produced it (scan/live data is
   * source "scan_tool").
   */
  kind:
    | "scan"
    | "code"
    | "snapshot"
    | "snapshot_check"
    | "test_selection"
    | "symptom"
    | "specification"
    | "prerequisite"
    | "answer"
    | "observation"
    | "measurement"
    | "check"
    | "actuator_test"
    | "service_function"
    | "action"
    | "inconclusive"
    | "verification_criterion"
    | "verification"
    | "unsupported"
    | "branch";
  /** What was recorded, in a stable plain form ("P0301", "rough_idle", "yes", "fail", "412 kPa", a rule index ...). */
  value: string;
  phase: EvidencePhase;
  source: EvidenceSource;
  /** For a measurement: the value converted into the step's unit. */
  measured?: { value: number; unit: Unit };
  /**
   * For a measurement: whether it was judged. Evaluated: which range judged it
   * ("otherwise" when none matched). Not evaluated: why (a specification it
   * needs is not verified). Either way, the specifications involved with their
   * value, source and trust, for display.
   */
  judgement?:
    | { evaluated: true; range: string; relation?: SpecRelation; specification?: SpecificationReference }
    | { evaluated: false; reason: "untrusted_spec" | "condition_not_met" | "condition_unknown"; specification: SpecificationReference };
  /** For a verification criterion: which one. */
  criterion?: string;
  /** For a re-test after repair: the seq of the same step's before-repair evidence. */
  comparesTo?: number;
  /** Named conditions this evidence established. */
  established?: ConditionId[];
  /** Named conditions this evidence showed NOT to hold (a prerequisite answered "not met"). */
  refuted?: ConditionId[];
  /** For a specification resolution: the specification id. */
  specification?: SpecificationId;
  /** For a scan: its completeness, coverage and the flags its source reports. */
  scanInfo?: ScanRecord;
  /** For a code: the structured observation (raw, canonical, format, reported status, module, snapshot). */
  dtc?: DtcObservation;
  /** For a snapshot: the frozen snapshot. */
  snapshot?: SnapshotRecord;
  /** For a snapshot check: which snapshot and parameter were read, and the value. */
  snapshotRef?: { snapshot: string; parameter: string; value?: number | string; unit?: Unit };
  /** For a test selection: the test the engine recommended at that moment (the choice is in `value`). */
  recommendedTest?: NodeId;
  /** For an actuator test or service function: its generic id. */
  actuator?: string;
  serviceFunction?: string;
  /** Actuator tests and service functions are carried out by an external tool, never by the engine. */
  performedBy?: "external_tool";
  /** For a step skipped for capability: what was missing (e.g. "scan_access:bidirectional", "instrument:pressure_gauge"). */
  missingCapabilities?: string[];
  /** Why a step could not be done, when it could not. */
  unsupportedReason?:
    | CapabilityShortfall
    | "function_not_supported"
    | "spec_not_found"
    | "spec_ambiguous"
    | "spec_unavailable"
    | "spec_incompatible_unit"
    | "no_tool"
    | "not_comfortable"
    | "not_possible";
  /** Where the evidence sent the workflow. A verification criterion stays at its verification step (the verdict routes). */
  to: NodeId;
  /** Supplied by the caller. The engine never reads the clock, so replays are exact. */
  at?: string;
};

export type SessionStatus = "in_progress" | "completed";

export type DiagnosticSession = {
  workflowId: string;
  workflowVersion: number;
  /** The workflow's fault model, carried so every result states its assumption. */
  faultModel: FaultModel;
  facts: SessionStartFacts;
  /** When the session was started, as given by the caller. */
  startedAt?: string;
  status: SessionStatus;
  /** The step waiting for input. Null once completed. */
  currentNodeId: NodeId | null;
  /** Before the repair until a repair verification is reached, after it from then on. */
  phase: EvidencePhase;
  evidence: readonly Evidence[];
  /** Everything entered, in order. Replaying these against the same workflow and facts rebuilds the session exactly. */
  inputs: readonly (StepInput & { at?: string })[];
  /** Named conditions established so far, in the order established. */
  establishedConditions: readonly ConditionId[];
  /** Named conditions known NOT to hold (until something establishes them). Anything in neither list is unknown. */
  refutedConditions: readonly ConditionId[];
  /**
   * Every specification resolution this session used, by id, exactly as
   * recorded (pinned). Later steps, replays on resume and repair re-tests use
   * these, never a fresh lookup, so history does not change when the
   * provider's data does.
   */
  specifications: Readonly<Record<SpecificationId, SpecificationResolution>>;
  /** Candidate causes still in play, in the workflow's order. */
  remainingCauses: readonly CauseId[];
  /** Causes some evidence pointed to. */
  supportedCauses: readonly CauseId[];
  /** The conclusion reached, if any (kept when a verification follows it). */
  conclusionNodeId: NodeId | null;
  /** How it ended, once completed. */
  endResult: EndNode["result"] | null;
  /** The repair verification verdict, null until one is answered. */
  verification: "verified" | "not_verified" | "inconclusive" | null;
  /** True or false once a verification decided it; null until then, and when it was inconclusive. */
  repairVerified: boolean | null;
};

export type StepResult = { ok: true; session: DiagnosticSession } | { ok: false; error: string };
