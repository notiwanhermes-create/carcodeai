/**
 * ============================================================================
 *   SYNTHETIC EXAMPLE WORKFLOW
 *   NOT BMW DATA. NOT ISTA DATA. NOT ANY MANUFACTURER'S DATA.
 * ============================================================================
 *
 * A generic engine-misfire troubleshooting flow, written for CarCode from
 * general troubleshooting practice to exercise the engine. It is not a repair
 * procedure for any vehicle and is not shown to users.
 *
 * It contains no vehicle values at all. Its two vehicle-dependent limits
 * (minimum compression, fuel supply pressure) are requested BY ID from a
 * SpecificationProvider ("synthetic.cylinder_compression_min",
 * "synthetic.fuel_supply_pressure_idle"); the matching SYNTHETIC / TEST ONLY
 * values live in ./synthetic-specifications.ts. A specification that cannot
 * be resolved sends the step to a professional. Only a VERIFIED specification
 * judges a reading; anything else leaves it unjudged (inconclusive route).
 *
 * Trouble codes appear only as identifiers to branch on (the generic random /
 * per-cylinder misfire codes). No code definitions are written here.
 *
 * The plausible ranges on its two measurements are generic physical limits
 * meant only to catch typos. They are not specifications or pass limits.
 *
 * Version 2 (V2A): states its single-primary-fault assumption, names the
 * "engine off and cool" condition, routes inconclusive results, and verifies a
 * repair against named criteria (the fuel route re-tests the fuel pressure).
 * Version 3 (V2B): measurements name specifications instead of carrying spec
 * bounds.
 * Version 4 (V2C): applies only to synthetic gasoline/hybrid engines with 2-8
 * cylinders (unknown facts block the start); steps state capability needs
 * (skill, scan access, instruments); and a SYNTHETIC fuel-pump actuator test
 * (modelling only, run by an external tool) is offered only with
 * bidirectional scan access. Without it, the workflow goes straight on to
 * the pressure test: being unable is never evidence about a cause.
 * Version 5 (V2D): codes are structured scan evidence matched declaratively
 * (no text matching). When the misfire is not happening now, a CONFIRMED
 * misfire code leads to an explicit check of its freeze-frame coolant
 * temperature against a SYNTHETIC verified specification; a pending-only code
 * does not. Repair verification needs a complete post-repair scan for
 * "codes gone". No code status changes a cause on its own.
 * Version 6 (V2E): a person who does not know the pattern can choose "help me
 * test". After securing the vehicle they reach ONE explicit reorderable region
 * ("misfire_primary_tests") of six SYNTHETIC tests that differ in risk,
 * separation, invasiveness, setup and capability; the engine recommends the
 * best eligible one each time. The coil swap is marked not repeatable after a
 * repair. All other routes are unchanged.
 */
import type { WorkflowDefinition } from "../types";

const CYLINDER_MISFIRE_CODES = ["P0301", "P0302", "P0303", "P0304", "P0305", "P0306", "P0307", "P0308"];
const ALL_MISFIRE_CODES = ["P0300", ...CYLINDER_MISFIRE_CODES];

export const SYNTHETIC_MISFIRE_WORKFLOW: WorkflowDefinition = {
  id: "synthetic.engine-misfire",
  version: 6,
  title: "Engine misfire (synthetic example)",
  provenance: "SYNTHETIC: written for CarCode's engine tests from general troubleshooting practice. Not BMW data, not ISTA data, not any manufacturer's data.",
  faultModel: "single_primary_fault",
  applicability: { fuel: ["gasoline", "hybrid"], cylinders: { min: 2, max: 8 } },
  conditions: [
    { id: "engine_off_cool", title: "Engine off, key out, and cool enough to touch" },
    { id: "vehicle_secured", title: "Parked on level ground, in park or neutral, parking brake on" },
  ],
  causes: [
    { id: "ignition_coil", title: "Ignition coil" },
    { id: "spark_plug", title: "Spark plug" },
    { id: "injector", title: "Fuel injector" },
    { id: "low_compression", title: "Low compression (mechanical)" },
    { id: "wiring_or_control", title: "Wiring or engine control" },
    { id: "vacuum_leak", title: "Vacuum (intake air) leak" },
    { id: "fuel_supply", title: "Fuel supply pressure" },
  ],
  nodes: [
    { id: "start", type: "start", title: "Start", next: "confirm_symptom" },

    {
      id: "confirm_symptom",
      type: "question",
      answer: "yes_no",
      title: "Confirm the symptom",
      prompt: "Is the engine running rough, shaking or stumbling right now?",
      outcomes: [
        { when: "yes", to: "flashing_light" },
        { when: "no", to: "intermittent_codes" },
      ],
    },
    {
      id: "flashing_light",
      type: "question",
      answer: "yes_no",
      title: "Check engine light flashing?",
      prompt: "Is the check engine light flashing while it runs rough?",
      outcomes: [
        { when: "yes", to: "concl_stop_driving" },
        { when: "no", to: "pattern" },
      ],
    },

    // Which pattern: one cylinder or several. Read from the codes when they say it; otherwise ask.
    {
      id: "pattern",
      type: "branch",
      title: "Single or multiple cylinders (from codes)",
      rules: [
        { if: { dtc: { code: CYLINDER_MISFIRE_CODES } }, to: "single_prereq", rulesOut: ["fuel_supply"] },
        { if: { dtc: { code: "P0300" } }, to: "multi_vacuum" },
      ],
      otherwise: "ask_pattern",
    },
    {
      id: "ask_pattern",
      type: "question",
      answer: "choice",
      title: "Single or multiple cylinders (asked)",
      prompt: "Do you know whether the misfire is on one cylinder or on several?",
      options: [
        { id: "one", label: "One cylinder" },
        { id: "several", label: "Several, or random" },
        { id: "unknown", label: "I don't know" },
        { id: "help_me_test", label: "I don't know: help me test" },
      ],
      outcomes: [
        { when: "one", to: "single_prereq", rulesOut: ["fuel_supply"] },
        { when: "several", to: "multi_vacuum" },
        { when: "unknown", to: "concl_read_codes" },
        { when: "help_me_test", to: "region_secure" },
      ],
    },

    /* ── V2E: one explicit reorderable region (SYNTHETIC / TEST ONLY) ── */
    {
      id: "region_secure",
      type: "prerequisite",
      title: "Vehicle secured",
      prompt: "Is the vehicle on level ground, in park or neutral, with the parking brake on?",
      ifMet: "primary_tests",
      ifNotMet: "concl_secure_first",
      establishes: ["vehicle_secured"],
    },
    {
      id: "primary_tests",
      type: "test_selection",
      title: "Choose the next test",
      prompt: "These tests can be done in any order. The recommended one is first.",
      group: "misfire_primary_tests",
      candidates: [
        { step: "listen_intake_leak" },
        { step: "coil_connector_check" },
        { step: "misfire_counters" },
        { step: "ignition_scope" },
        { step: "fuel_pump_command" },
        { step: "compression_check" },
        // Only for a synthetic engine family: unknown engine means "potentially available", never "not applicable".
        { step: "injector_balance", when: { vehicle: "engine", equals: "synthetic-i4-a" } },
      ],
      next: "concl_professional",
    },
    {
      id: "listen_intake_leak",
      type: "observation",
      title: "Listen for an intake air leak",
      prompt: "With the engine idling, listen around the intake for a hiss and look for cracked or loose hoses.",
      requires: { level: "owner", hazards: ["Keep hands clear of belts and the fan"] },
      testProfile: { risk: "low", invasiveness: "observe", setup: "none" },
      needsConditions: ["vehicle_secured"],
      options: [
        { id: "hiss_or_damage", label: "A hiss, or a cracked or loose hose" },
        { id: "nothing_found", label: "Nothing found" },
      ],
      outcomes: [
        { when: "hiss_or_damage", to: "concl_vacuum", supports: ["vacuum_leak"] },
        { when: "nothing_found", to: "primary_tests" },
      ],
      ifInconclusive: "primary_tests",
    },
    {
      id: "coil_connector_check",
      type: "observation",
      title: "Ignition coil connectors",
      prompt: "Engine off: unplug and inspect each ignition coil connector.",
      requires: { level: "diy", instruments: ["hand_tools"], hazards: ["Engine off before unplugging anything"] },
      testProfile: { risk: "low", invasiveness: "disconnect", setup: "minor" },
      needsConditions: ["vehicle_secured"],
      options: [
        { id: "loose_or_corroded", label: "Loose or corroded" },
        { id: "ok", label: "All look fine" },
      ],
      outcomes: [
        { when: "loose_or_corroded", to: "concl_wiring", supports: ["wiring_or_control"] },
        { when: "ok", to: "primary_tests" },
      ],
      ifUnsupported: "primary_tests",
      ifInconclusive: "primary_tests",
    },
    {
      id: "misfire_counters",
      type: "observation",
      title: "Per-cylinder misfire counters (live data)",
      prompt: "With the engine idling, read the per-cylinder misfire counters on the scan tool.",
      requires: { level: "diy", scan: "live_data", hazards: ["Engine running: keep clear of moving parts"] },
      testProfile: { risk: "low", invasiveness: "read_data", setup: "minor" },
      needsConditions: ["vehicle_secured"],
      options: [
        { id: "one_cylinder", label: "Counts on one cylinder" },
        { id: "several", label: "Counts on several cylinders" },
      ],
      outcomes: [
        { when: "one_cylinder", to: "primary_tests", rulesOut: ["vacuum_leak", "fuel_supply"] },
        { when: "several", to: "primary_tests", rulesOut: ["ignition_coil", "spark_plug", "injector", "low_compression"] },
      ],
      ifUnsupported: "primary_tests",
      ifInconclusive: "primary_tests",
    },
    {
      id: "ignition_scope",
      type: "check",
      title: "Ignition waveform (oscilloscope)",
      prompt: "Compare the ignition waveform of the suspect cylinder with a good one.",
      requires: { level: "professional", instruments: ["oscilloscope"], hazards: ["Ignition system high voltage"] },
      testProfile: { risk: "moderate", invasiveness: "read_data", setup: "significant" },
      needsConditions: ["vehicle_secured"],
      outcomes: [
        { when: "pass", to: "primary_tests", rulesOut: ["ignition_coil", "spark_plug"] },
        { when: "fail", to: "concl_coil", supports: ["ignition_coil"], rulesOut: ["injector", "low_compression"] },
      ],
      ifUnsupported: "primary_tests",
      ifInconclusive: "primary_tests",
    },
    {
      id: "fuel_pump_command",
      type: "actuator_test",
      title: "Command the fuel pump (external tool)",
      prompt: "Use the scan tool's actuator test to run the fuel pump, and listen near the tank.",
      actuator: "fuel_pump",
      requires: { level: "diy", scan: "bidirectional", hazards: ["Ignition on and the fuel pump running: no open flames, fuel system closed"] },
      testProfile: { risk: "moderate", invasiveness: "command", setup: "minor" },
      needsConditions: ["vehicle_secured"],
      results: [
        { id: "runs", label: "The pump runs" },
        { id: "no_response", label: "No sound from the pump" },
      ],
      outcomes: [
        { when: "runs", to: "primary_tests" },
        { when: "no_response", to: "concl_fuel_supply", supports: ["fuel_supply"] },
      ],
      ifUnsupported: "primary_tests",
      ifInconclusive: "primary_tests",
    },
    {
      id: "compression_check",
      type: "check",
      title: "Compression on every cylinder",
      prompt: "Disable fuel and ignition, remove the spark plugs and test compression on each cylinder.",
      requires: { level: "professional", instruments: ["compression_tester"], hazards: ["Disable fuel and ignition before cranking", "Hot engine parts"] },
      testProfile: { risk: "high", invasiveness: "disassemble", setup: "significant" },
      needsConditions: ["vehicle_secured", "engine_off_cool"],
      outcomes: [
        { when: "pass", to: "primary_tests", rulesOut: ["low_compression"] },
        { when: "fail", to: "concl_mechanical", supports: ["low_compression"] },
      ],
      ifUnsupported: "primary_tests",
    },
    {
      id: "injector_balance",
      type: "observation",
      title: "Injector balance (live data, synthetic engine family only)",
      prompt: "Read the injector balance values on the scan tool.",
      requires: { level: "diy", scan: "live_data", hazards: ["Engine running: keep clear of moving parts"] },
      testProfile: { risk: "low", invasiveness: "read_data", setup: "minor" },
      needsConditions: ["vehicle_secured"],
      options: [
        { id: "imbalance", label: "One injector out of balance" },
        { id: "balanced", label: "Balanced" },
      ],
      outcomes: [
        { when: "imbalance", to: "concl_injector", supports: ["injector"], rulesOut: ["ignition_coil", "spark_plug", "low_compression", "vacuum_leak", "fuel_supply"] },
        { when: "balanced", to: "primary_tests", rulesOut: ["injector"] },
      ],
      ifUnsupported: "primary_tests",
      ifInconclusive: "primary_tests",
    },

    /* ── one cylinder: ignition first (cheapest to separate), then fuel, then mechanical ── */
    {
      id: "single_prereq",
      type: "prerequisite",
      title: "Engine off and cool",
      prompt: "Engine off, key out, and the engine cool enough to touch?",
      requires: { level: "diy", hazards: ["Hot engine parts", "Ignition system high voltage when running"] },
      ifMet: "coil_swap",
      ifNotMet: "wait_cool",
      establishes: ["engine_off_cool"],
      ifUnsupported: "concl_professional",
    },
    {
      id: "wait_cool",
      type: "action",
      title: "Let the engine cool",
      prompt: "Wait until the engine has cooled, then continue.",
      next: "coil_swap",
      establishes: ["engine_off_cool"],
    },
    {
      id: "coil_swap",
      type: "question",
      answer: "yes_no",
      title: "Swap test: does the misfire follow the coil?",
      // Moving the misfire again after the coil is replaced proves nothing: never repeated as a recheck.
      repeatableAfterRepair: false,
      prompt: "Swap the ignition coil of the misfiring cylinder with a neighbouring one, clear the codes, and run the engine until the misfire is reported again. Did it move to the other cylinder?",
      requires: { level: "diy", scan: "codes", instruments: ["hand_tools"], hazards: ["Moving engine parts while running"] },
      outcomes: [
        { when: "yes", to: "concl_coil", supports: ["ignition_coil"], rulesOut: ["spark_plug", "injector", "low_compression"] },
        { when: "no", to: "plug_inspection", rulesOut: ["ignition_coil"] },
      ],
      ifUnsupported: "concl_professional",
    },
    {
      id: "plug_inspection",
      type: "observation",
      title: "Spark plug condition",
      prompt: "Remove the spark plug from the misfiring cylinder. How does it look?",
      requires: { level: "diy", instruments: ["hand_tools"], hazards: ["Hot engine parts"] },
      needsConditions: ["engine_off_cool"],
      options: [
        { id: "worn_or_damaged", label: "Worn electrode or cracked insulator" },
        { id: "fouled", label: "Wet or heavily fouled" },
        { id: "normal", label: "Looks normal" },
      ],
      outcomes: [
        { when: "worn_or_damaged", to: "concl_plug", supports: ["spark_plug"] },
        { when: "fouled", to: "injector_check", supports: ["injector"] },
        { when: "normal", to: "injector_check", rulesOut: ["spark_plug"] },
      ],
      ifUnsupported: "concl_professional",
      // Cannot tell from the plug: rule nothing out and test the injector.
      ifInconclusive: "injector_check",
    },
    {
      id: "injector_check",
      type: "check",
      title: "Injector test",
      prompt: "Test the injector of the misfiring cylinder (for example a balance test or an injector swap).",
      requires: { level: "professional", scan: "live_data" },
      outcomes: [
        { when: "fail", to: "concl_injector", supports: ["injector"] },
        { when: "pass", to: "compression_test", rulesOut: ["injector"] },
      ],
      ifUnsupported: "concl_professional",
      ifInconclusive: "concl_professional",
    },
    {
      id: "compression_test",
      type: "measurement",
      title: "Compression on the misfiring cylinder",
      measurement: { quantity: "Cylinder compression", unit: "kPa", plausible: { min: 0, max: 3500 } },
      requires: { level: "professional", instruments: ["compression_tester"], hazards: ["Disable fuel and ignition before cranking"] },
      needsConditions: ["engine_off_cool"],
      specification: "synthetic.cylinder_compression_min",
      outcomes: [
        { id: "below_min", when: { relativeToSpec: "below" }, to: "concl_mechanical", supports: ["low_compression"] },
        { id: "at_or_above_min", when: { relativeToSpec: "within" }, to: "concl_wiring", rulesOut: ["low_compression"] },
      ],
      otherwise: "concl_professional",
      ifUnsupported: "concl_professional",
      ifInconclusive: "concl_professional",
    },

    /* ── several cylinders: things all cylinders share ── */
    {
      id: "multi_vacuum",
      type: "observation",
      title: "Listen and look for an air leak",
      prompt: "With the engine idling, listen around the intake for a hissing sound and look for cracked or loose hoses. What do you find?",
      requires: { level: "owner", hazards: ["Keep hands clear of belts and the fan"] },
      options: [
        { id: "hiss_or_damage", label: "A hiss, or a cracked or loose hose" },
        { id: "nothing_found", label: "Nothing found" },
      ],
      outcomes: [
        { when: "hiss_or_damage", to: "concl_vacuum", supports: ["vacuum_leak"] },
        { when: "nothing_found", to: "fuel_pump_actuator" },
      ],
      // Not sure (a noisy engine bay): rule nothing out and measure.
      ifInconclusive: "fuel_pressure",
    },
    {
      // SYNTHETIC / TEST ONLY. Modelling only: an external scan tool with bidirectional control runs the
      // pump; the person reports what they hear. No commands, no manufacturer data. Without that access
      // the step is skipped (not evidence of anything) and the workflow measures the pressure instead.
      id: "fuel_pump_actuator",
      type: "actuator_test",
      title: "Fuel pump actuator test (external tool)",
      prompt: "Use the scan tool's actuator test to run the fuel pump, and listen near the tank. What happens?",
      actuator: "fuel_pump",
      requires: { level: "diy", scan: "bidirectional", hazards: ["Ignition on and the fuel pump running: no open flames, fuel system closed"] },
      results: [
        { id: "runs", label: "The pump runs (an audible hum)" },
        { id: "no_response", label: "No sound from the pump" },
      ],
      outcomes: [
        { when: "runs", to: "fuel_pressure" },
        { when: "no_response", to: "concl_fuel_supply", supports: ["fuel_supply"] },
      ],
      ifUnsupported: "fuel_pressure",
      ifInconclusive: "fuel_pressure",
    },
    {
      id: "fuel_pressure",
      type: "measurement",
      title: "Fuel pressure",
      measurement: { quantity: "Fuel supply pressure (low-pressure side)", unit: "kPa", plausible: { min: 0, max: 1000 } },
      requires: { level: "professional", instruments: ["pressure_gauge"], hazards: ["Pressurised fuel"] },
      specification: "synthetic.fuel_supply_pressure_idle",
      outcomes: [
        { id: "below_min", when: { relativeToSpec: "below" }, to: "concl_fuel_supply", supports: ["fuel_supply"] },
        { id: "within", when: { relativeToSpec: "within" }, to: "concl_professional", rulesOut: ["fuel_supply"] },
      ],
      otherwise: "concl_professional",
      ifUnsupported: "concl_professional",
      ifInconclusive: "concl_professional",
    },

    /* ── conclusions ── */
    { id: "concl_coil", type: "conclusion", title: "Ignition coil", cause: "ignition_coil", recommendation: "Replace the ignition coil that the misfire followed.", next: "verify_repair" },
    { id: "concl_plug", type: "conclusion", title: "Spark plug", cause: "spark_plug", recommendation: "Replace the spark plug (usually as a set).", next: "verify_repair" },
    { id: "concl_injector", type: "conclusion", title: "Fuel injector", cause: "injector", recommendation: "Have the injector replaced.", next: "verify_repair" },
    { id: "concl_mechanical", type: "conclusion", title: "Low compression", cause: "low_compression", recommendation: "Have the engine's mechanical condition checked (for example a leak-down test).", next: "end_referred" },
    { id: "concl_wiring", type: "conclusion", title: "Wiring or engine control", cause: "wiring_or_control", recommendation: "Have the ignition and injector circuits and the engine control checked.", next: "end_referred" },
    { id: "concl_vacuum", type: "conclusion", title: "Air leak", cause: "vacuum_leak", recommendation: "Repair or replace the leaking hose or seal.", next: "verify_repair" },
    { id: "concl_fuel_supply", type: "conclusion", title: "Low fuel pressure", cause: "fuel_supply", recommendation: "Have the fuel supply (pump, filter, regulator) checked.", next: "verify_fuel_repair" },
    { id: "concl_professional", type: "conclusion", title: "Needs a professional", recommendation: "This next step needs a workshop. Take the vehicle in and share what was found so far.", next: "end_referred" },
    { id: "concl_stop_driving", type: "conclusion", title: "Severe misfire", recommendation: "Avoid driving: a flashing light means a severe misfire that can damage the exhaust catalyst. Have it checked.", next: "end_referred" },
    { id: "concl_read_codes", type: "conclusion", title: "Read the codes first", recommendation: "Have the trouble codes read: they usually show which cylinder misfires.", next: "end_referred" },
    // Not happening now: only a CONFIRMED misfire code (reported status, not a verdict) leads to its freeze frame.
    {
      id: "intermittent_codes",
      type: "branch",
      title: "A confirmed misfire code with a freeze frame?",
      rules: [{ if: { dtc: { code: ALL_MISFIRE_CODES, status: "confirmed" } }, to: "misfire_snapshot" }],
      otherwise: "concl_intermittent",
    },
    {
      // SYNTHETIC / TEST ONLY. Reads the coolant temperature recorded with the misfire code, and judges it
      // only against a VERIFIED synthetic specification. No cause effects: it only shapes the advice.
      id: "misfire_snapshot",
      type: "snapshot_check",
      title: "Engine temperature when the misfire was recorded",
      from: { dtc: { code: ALL_MISFIRE_CODES } },
      parameter: "coolant_temperature",
      measurement: { quantity: "Coolant temperature in the freeze frame", unit: "degC", plausible: { min: -40, max: 150 } },
      specification: "synthetic.engine_warm_coolant_temp",
      outcomes: [
        { id: "cold", when: { relativeToSpec: "below" }, to: "concl_intermittent_cold" },
        { id: "warm", when: { relativeToSpec: "within" }, to: "concl_intermittent_warm" },
      ],
      otherwise: "concl_intermittent",
      ifUnavailable: "concl_intermittent",
      ifInconclusive: "concl_intermittent",
    },
    { id: "concl_intermittent_cold", type: "conclusion", title: "Recorded with a cold engine", recommendation: "The misfire was recorded with a cold engine: note whether it happens on cold starts and have it checked.", next: "end_not_reproducible" },
    { id: "concl_intermittent_warm", type: "conclusion", title: "Recorded with a warm engine", recommendation: "The misfire was recorded with a warm engine: note the load and speed when it happens and have it checked.", next: "end_not_reproducible" },
    { id: "concl_intermittent", type: "conclusion", title: "Not happening now", recommendation: "Note when it happens (cold, warm, load, speed) and have the codes read.", next: "end_not_reproducible" },
    { id: "concl_secure_first", type: "conclusion", title: "Secure the vehicle first", recommendation: "Do not test until the vehicle is parked safely with the parking brake on.", next: "end_referred" },
    { id: "concl_not_fixed", type: "conclusion", title: "Repair did not fix it", recommendation: "Keep the record of what was tried and have a professional continue from here.", next: "end_referred" },
    { id: "concl_verify_inconclusive", type: "conclusion", title: "Repair not confirmed yet", recommendation: "It is too early to tell whether the repair worked. Drive again in the conditions where the misfire happened, then check again.", next: "end_inconclusive" },

    /* ── after the repair ── */
    {
      id: "verify_repair",
      type: "repair_verification",
      title: "Did the repair fix it?",
      prompt: "After the repair, clear the codes and drive in the conditions where the misfire happened.",
      criteria: [
        { id: "smooth", kind: "symptom_absent", prompt: "Is the engine smooth in the conditions where it misfired?" },
        { id: "codes_gone", kind: "codes_absent", codes: "reported" },
      ],
      ifVerified: "end_resolved",
      ifNotVerified: "concl_not_fixed",
      ifInconclusive: "concl_verify_inconclusive",
    },
    {
      id: "verify_fuel_repair",
      type: "repair_verification",
      title: "Did the fuel supply repair fix it?",
      prompt: "After the repair, measure the fuel pressure again the same way, then drive in the conditions where the misfire happened.",
      criteria: [
        { id: "pressure_ok", kind: "retest", step: "fuel_pressure", passWhen: ["within"] },
        { id: "smooth", kind: "symptom_absent", prompt: "Is the engine smooth in the conditions where it misfired?" },
      ],
      ifVerified: "end_resolved",
      ifNotVerified: "concl_not_fixed",
      ifInconclusive: "concl_verify_inconclusive",
    },

    { id: "end_resolved", type: "end", title: "Resolved", result: "resolved" },
    { id: "end_referred", type: "end", title: "Referred", result: "referred" },
    { id: "end_not_reproducible", type: "end", title: "Not reproducible now", result: "not_reproducible" },
    { id: "end_inconclusive", type: "end", title: "Not confirmed yet", result: "inconclusive" },
  ],
};
