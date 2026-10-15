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
 * Original CarCode design, written from general troubleshooting practice.
 */
import type { CheckLevel } from "../diagnosis-schema";

/* ───────────────────────── who can do a step, and with what ───────────────────────── */

/** Who can safely carry out a step: the same three levels the diagnosis already uses. */
export type SkillLevel = CheckLevel;
export const SKILL_ORDER: Record<SkillLevel, number> = { owner: 0, diy: 1, professional: 2 };

export const TOOLS = [
  "scan_tool",
  "multimeter",
  "pressure_gauge",
  "compression_tester",
  "oscilloscope",
  "vehicle_lift",
  "smoke_machine",
  "hand_tools",
  "other",
] as const;
export type Tool = (typeof TOOLS)[number];

/** What a step needs. A step with no requirements is an owner-level step needing no tools. */
export type StepRequirements = {
  level: SkillLevel;
  tools?: Tool[];
  /** Short hazard notes the page must show with the step (hot engine, high voltage, fuel). */
  hazards?: string[];
};

/** What the person working through the workflow can do. */
export type Capabilities = { maxLevel: SkillLevel; tools: Tool[] };

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

/** What the engine asks a provider for. Deliberately narrow: an id, nothing else yet (no vehicle applicability in V2B). */
export type SpecificationRequest = { id: SpecificationId };

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
 * - codes_absent: the codes do not come back ("reported" means the codes the session started with).
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
  | EndNode;

export type NodeType = WorkflowNode["type"];

/** Step types that may declare `ifInconclusive` (repair verification must). */
export const INCONCLUSIVE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["check", "observation", "measurement", "repair_verification"]);

/* ───────────────────────── conditions (for automatic branches) ───────────────────────── */

export type Condition =
  /** Any of these trouble codes was reported at the start. Upper case, exact. */
  | { dtcAny: string[] }
  /** One of these symptoms was reported at the start. */
  | { symptomAny: string[] }
  /** A vehicle fact equals a value. */
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
  /** The candidate causes this workflow separates. */
  causes: Array<{ id: CauseId; title: string }>;
  /** Named conditions its steps establish and need. */
  conditions?: DiagnosticConditionDefinition[];
  nodes: WorkflowNode[];
};

/* ───────────────────────── a session ───────────────────────── */

export type VehicleContext = {
  year?: number;
  make?: string;
  model?: string;
  engine?: string;
  fuel?: "gasoline" | "diesel" | "hybrid" | "electric" | "unknown";
  cylinders?: number;
  mileage?: { value: number; unit: "km" | "mi" };
};

export type SessionStartFacts = {
  vehicle?: VehicleContext;
  /** Trouble codes as read, upper case. */
  dtcs?: string[];
  /** How the codes were obtained. Defaults to "person" (typed in). */
  dtcSource?: "person" | "scan_tool";
  /** Symptom ids the workflow understands (for example "rough_idle"). */
  symptoms?: string[];
  capabilities: Capabilities;
};

/** Where a reading or answer came from. */
export type InputSource = "person" | "instrument" | "scan_tool";

/** Why a step was done but did not decide anything. */
export const INCONCLUSIVE_REASONS = ["unclear_result", "intermittent", "reading_unstable", "conditions_not_met"] as const;
export type InconclusiveReason = (typeof INCONCLUSIVE_REASONS)[number];

/** The answer to one verification criterion. */
export type VerificationEntry =
  /** symptom_absent / codes_absent: did it hold? */
  | { criterion: string; result: "met" | "not_met" | "inconclusive" }
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
    | "code"
    | "symptom"
    | "specification"
    | "prerequisite"
    | "answer"
    | "observation"
    | "measurement"
    | "check"
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
  /** Why a step could not be done, when it could not. */
  unsupportedReason?:
    | "level"
    | "tools"
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
