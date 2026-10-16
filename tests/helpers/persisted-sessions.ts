/**
 * Shared fixtures for the V2G persistence tests: the synthetic misfire
 * workflow driven through save → reload → advance cycles.
 *
 * Everything here is SYNTHETIC / TEST ONLY / NOT OEM DATA.
 */
import { expect } from "vitest";
import { startSession, submitStep, type DiagnosticScanInput, type DiagnosticSession, type EngineOptions, type SessionStartFacts, type StepInput, type VehicleContext } from "../../app/lib/diagnostic-workflow";
import { SYNTHETIC_MISFIRE_WORKFLOW } from "../../app/lib/diagnostic-workflow/examples/synthetic-misfire";
import { SYNTHETIC_SPECIFICATIONS } from "../../app/lib/diagnostic-workflow/examples/synthetic-specifications";
import { createInMemorySpecificationProvider } from "../../app/lib/diagnostic-workflow/examples/in-memory-specification-provider";
import { capabilityPreset } from "../../app/lib/diagnostic-workflow/examples/capability-presets";
import type { SessionOwner, SessionStore } from "../../app/lib/diagnostic-workflow-persistence";
import { afterScan } from "./workflow-scans";

export const W = SYNTHETIC_MISFIRE_WORKFLOW;
export const SPECS: EngineOptions = { specifications: createInMemorySpecificationProvider(SYNTHETIC_SPECIFICATIONS) };
export const WORKSHOP = capabilityPreset("workshop");
export const CAR: VehicleContext = { fuel: "gasoline", cylinders: 4 };
export const T0 = "2026-10-16T10:00:00Z";
export const at = (minute: number) => `2026-10-16T10:${String(minute).padStart(2, "0")}:00Z`;

const yes = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "yes" });
const no = (nodeId: string): StepInput => ({ nodeId, kind: "yes_no", answer: "no" });
const pick = (test: string): StepInput => ({ nodeId: "primary_tests", kind: "select_test", test });
const seen = (nodeId: string, choice: string): StepInput => ({ nodeId, kind: "observation", choice });

/** A complete before-repair scan from a tool: one confirmed P0300 with a freeze-frame snapshot. */
export const START_SCAN: DiagnosticScanInput = {
  id: "start",
  source: "scan_tool",
  completeness: "complete",
  reportsStatus: ["pending", "confirmed", "permanent"],
  codes: [{ code: "P0300", status: ["confirmed"], snapshot: "ff1" }],
  snapshots: [{ id: "ff1", parameters: [{ id: "coolant_temperature", value: 88, unit: "degC" }, { id: "engine_speed", value: 780, unit: "rpm" }] }],
};

/** Several cylinders → fuel pump runs → fuel pressure LOW against the pinned synthetic spec → fuel supply → verification. */
export const FUEL_FACTS: SessionStartFacts = { capabilities: WORKSHOP, vehicle: { ...CAR, make: "Synthetic", model: "Test Car", engine: "synthetic-i4-a" }, scans: [START_SCAN], symptoms: [] };
export const FUEL_ROUTE: StepInput[] = [
  yes("confirm_symptom"),
  no("flashing_light"),
  seen("multi_vacuum", "nothing_found"),
  { nodeId: "fuel_pump_actuator", kind: "actuator_result", result: "runs" },
  { nodeId: "fuel_pressure", kind: "measurement", value: 200, unit: "kPa" },
];
/** After the repair: pressure re-measured in range, engine smooth. */
export const FUEL_VERIFIED: StepInput = { nodeId: "verify_fuel_repair", kind: "verification", results: [{ criterion: "pressure_ok", value: 380, unit: "kPa" }, { criterion: "smooth", result: "met" }] };

/** No codes; "help me test"; into the V2E region of seven synthetic tests. */
export const REGION_FACTS: SessionStartFacts = { capabilities: WORKSHOP, vehicle: CAR };
export const TO_REGION: StepInput[] = [yes("confirm_symptom"), no("flashing_light"), { nodeId: "ask_pattern", kind: "choice", choice: "help_me_test" }, { nodeId: "region_secure", kind: "prerequisite", met: true }];
/** Counters → connectors → scope finds the coil → verification with a complete, clean post-repair scan. */
export const REGION_ROUTE: StepInput[] = [
  ...TO_REGION,
  pick("misfire_counters"),
  seen("misfire_counters", "one_cylinder"),
  pick("coil_connector_check"),
  seen("coil_connector_check", "ok"),
  pick("ignition_scope"),
  { nodeId: "ignition_scope", kind: "check", result: "fail" },
];
export const REGION_VERIFIED: StepInput = { nodeId: "verify_repair", kind: "verification", results: [{ criterion: "smooth", result: "met" }, { criterion: "codes_gone", scan: afterScan() }] };

/** Contradictory evidence inside the region: ends inconclusive with a recorded conflict. */
export const CONFLICT_FACTS: SessionStartFacts = { capabilities: WORKSHOP, vehicle: { ...CAR, engine: "synthetic-i4-a" } };
export const CONFLICT_ROUTE: StepInput[] = [...TO_REGION, pick("misfire_counters"), seen("misfire_counters", "several"), pick("injector_balance"), seen("injector_balance", "imbalance")];

export function started(facts: SessionStartFacts): DiagnosticSession {
  const r = startSession(W, facts, T0, SPECS);
  if (!r.ok) throw new Error(r.error);
  return r.session;
}

export function step(session: DiagnosticSession, input: StepInput, minute = session.inputs.length + 1): DiagnosticSession {
  const r = submitStep(W, session, input, at(minute), SPECS);
  if (!r.ok) throw new Error(`${input.nodeId}: ${r.error}`);
  return r.session;
}

/** Run the inputs straight through the engine, with no persistence: the reference result. */
export function direct(facts: SessionStartFacts, inputs: StepInput[]): DiagnosticSession {
  return inputs.reduce((s, input) => step(s, input), started(facts));
}

/** Start and persist, then for every input: RELOAD from storage, run the engine, save with the expected revision. */
export async function persistThrough(store: SessionStore, owner: SessionOwner, vehicleId: string, facts: SessionStartFacts, inputs: StepInput[]) {
  const first = await store.start(owner, { vehicleId, session: started(facts) });
  expect(first, JSON.stringify(first)).toMatchObject({ status: "saved", duplicate: false, meta: { revision: 1 } });
  if (first.status !== "saved") throw new Error("start failed");
  const id = first.meta.id;
  for (const input of inputs) {
    const loaded = await store.load(owner, id);
    expect(loaded.status, JSON.stringify(loaded)).toBe("loaded");
    if (loaded.status !== "loaded") throw new Error("load failed");
    const saved = await store.advance(owner, { sessionId: id, expectedRevision: loaded.meta.revision, session: step(loaded.session, input) });
    expect(saved, JSON.stringify(saved)).toMatchObject({ status: "saved", duplicate: false, meta: { revision: loaded.meta.revision + 1 } });
  }
  const final = await store.load(owner, id);
  if (final.status !== "loaded") throw new Error(`final load: ${JSON.stringify(final)}`);
  return { id, final };
}
