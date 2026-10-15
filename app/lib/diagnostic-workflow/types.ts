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

/* ───────────────────────── measurements ───────────────────────── */

export const UNITS = ["V", "mV", "ohm", "kohm", "A", "kPa", "bar", "psi", "ms", "Hz", "rpm", "percent", "degC"] as const;
export type Unit = (typeof UNITS)[number];

/**
 * A bound is either a number written into the workflow (for generic checks)
 * or the name of a specification supplied with the session (for anything that
 * depends on the vehicle). A workflow never carries manufacturer values: a
 * vehicle-specific limit is always a named specification, and when the
 * session has no value for it the step cannot be evaluated.
 */
export type Bound = number | { spec: string };

/** Inclusive by default on both ends. An open end is left out. */
export type NumericRange = { min?: Bound; max?: Bound; minInclusive?: boolean; maxInclusive?: boolean };

export type MeasurementDefinition = {
  /** What is measured, in plain words. */
  quantity: string;
  unit: Unit;
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
  /**
   * Where to go when the person cannot do this step (level or tools missing,
   * or they say they cannot). Required for any step above owner level or
   * needing a tool.
   */
  ifUnsupported?: NodeId;
};

export type Outcome<W> = { when: W; to: NodeId } & CauseEffect;

export type StartNode = NodeBase & { type: "start"; next: NodeId };

/** Something that must be true before going on. */
export type PrerequisiteNode = NodeBase & { type: "prerequisite"; ifMet: NodeId; ifNotMet: NodeId };

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

export type MeasurementNode = NodeBase & {
  type: "measurement";
  measurement: MeasurementDefinition;
  /** First matching range wins. */
  outcomes: Outcome<NumericRange>[];
  /** For a value that matches no range. Required. */
  otherwise: NodeId;
};

/** A test with a pass or fail result (a component test, a swap test, an actuator test). */
export type CheckNode = NodeBase & { type: "check"; outcomes: Outcome<"pass" | "fail">[] };

/** Something to do before going on (an instruction, an actuator run, clearing codes). */
export type ActionNode = NodeBase & { type: "action"; next: NodeId };

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

/** After a repair: did it actually fix the problem? */
export type RepairVerificationNode = NodeBase & {
  type: "repair_verification";
  ifVerified: NodeId;
  ifNotVerified: NodeId;
};

/** The end of a workflow. `result` says how it ended. */
export type EndNode = NodeBase & { type: "end"; result: "resolved" | "concluded" | "referred" | "not_reproducible" };

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
  /** The candidate causes this workflow separates. */
  causes: Array<{ id: CauseId; title: string }>;
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
  /** Symptom ids the workflow understands (for example "rough_idle"). */
  symptoms?: string[];
  capabilities: Capabilities;
  /** Values for the named specifications the workflow refers to, in the unit of the step that uses them. */
  specs?: Record<string, number>;
};

/** What the person enters for the current step. */
export type StepInput =
  | { nodeId: NodeId; kind: "prerequisite"; met: boolean }
  | { nodeId: NodeId; kind: "yes_no"; answer: YesNo }
  | { nodeId: NodeId; kind: "choice"; choice: string }
  | { nodeId: NodeId; kind: "observation"; choice: string }
  | { nodeId: NodeId; kind: "measurement"; value: number; unit: Unit }
  | { nodeId: NodeId; kind: "check"; result: "pass" | "fail" }
  | { nodeId: NodeId; kind: "done" }
  | { nodeId: NodeId; kind: "verification"; verified: boolean }
  /** The person cannot do this step. */
  | { nodeId: NodeId; kind: "unable"; reason: "no_tool" | "not_comfortable" | "not_possible" };

/** One recorded fact. Never changed once recorded. */
export type Evidence = {
  /** 1, 2, 3 ... in the order recorded. */
  seq: number;
  nodeId: NodeId;
  kind: "start_fact" | "prerequisite" | "answer" | "observation" | "measurement" | "check" | "action" | "verification" | "unsupported" | "branch";
  /** What was recorded, in a stable plain form ("yes", "fail", "412 kPa", a rule index ...). */
  value: string;
  /** For a measurement: the value converted into the step's unit. */
  measured?: { value: number; unit: Unit };
  /** Why a step could not be done, when it could not. */
  unsupportedReason?: "level" | "tools" | "missing_spec" | "no_tool" | "not_comfortable" | "not_possible";
  /** Where the evidence sent the workflow. */
  to: NodeId;
  /** Supplied by the caller. The engine never reads the clock, so replays are exact. */
  at?: string;
};

export type SessionStatus = "in_progress" | "completed";

export type DiagnosticSession = {
  workflowId: string;
  workflowVersion: number;
  facts: SessionStartFacts;
  status: SessionStatus;
  /** The step waiting for input. Null once completed. */
  currentNodeId: NodeId | null;
  evidence: readonly Evidence[];
  /** Everything entered, in order. Replaying these against the same workflow and facts rebuilds the session exactly. */
  inputs: readonly (StepInput & { at?: string })[];
  /** Candidate causes still in play, in the workflow's order. */
  remainingCauses: readonly CauseId[];
  /** Causes some evidence pointed to. */
  supportedCauses: readonly CauseId[];
  /** The conclusion reached, if any (kept when a verification follows it). */
  conclusionNodeId: NodeId | null;
  /** How it ended, once completed. */
  endResult: EndNode["result"] | null;
  /** Null until a repair verification is answered. */
  repairVerified: boolean | null;
};

export type StepResult = { ok: true; session: DiagnosticSession } | { ok: false; error: string };
