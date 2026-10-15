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
 * It contains no manufacturer values. The two vehicle-dependent limits
 * (minimum compression, fuel pressure range) are NAMED SPECIFICATIONS that a
 * session must supply; without them those steps are not evaluated and the
 * workflow refers the vehicle to a professional instead.
 *
 * Trouble codes appear only as identifiers to branch on (the generic random /
 * per-cylinder misfire codes). No code definitions are written here.
 */
import type { WorkflowDefinition } from "../types";

const CYLINDER_MISFIRE_CODES = ["P0301", "P0302", "P0303", "P0304", "P0305", "P0306", "P0307", "P0308"];

export const SYNTHETIC_MISFIRE_WORKFLOW: WorkflowDefinition = {
  id: "synthetic.engine-misfire",
  version: 1,
  title: "Engine misfire (synthetic example)",
  provenance: "SYNTHETIC: written for CarCode's engine tests from general troubleshooting practice. Not BMW data, not ISTA data, not any manufacturer's data.",
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
        { when: "no", to: "concl_intermittent" },
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
        { if: { dtcAny: CYLINDER_MISFIRE_CODES }, to: "single_prereq", rulesOut: ["fuel_supply"] },
        { if: { dtcAny: ["P0300"] }, to: "multi_vacuum" },
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
      ],
      outcomes: [
        { when: "one", to: "single_prereq", rulesOut: ["fuel_supply"] },
        { when: "several", to: "multi_vacuum" },
        { when: "unknown", to: "concl_read_codes" },
      ],
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
      ifUnsupported: "concl_professional",
    },
    {
      id: "wait_cool",
      type: "action",
      title: "Let the engine cool",
      prompt: "Wait until the engine has cooled, then continue.",
      next: "coil_swap",
    },
    {
      id: "coil_swap",
      type: "question",
      answer: "yes_no",
      title: "Swap test: does the misfire follow the coil?",
      prompt: "Swap the ignition coil of the misfiring cylinder with a neighbouring one, clear the codes, and run the engine until the misfire is reported again. Did it move to the other cylinder?",
      requires: { level: "diy", tools: ["hand_tools", "scan_tool"], hazards: ["Moving engine parts while running"] },
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
      requires: { level: "diy", tools: ["hand_tools"], hazards: ["Hot engine parts"] },
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
    },
    {
      id: "injector_check",
      type: "check",
      title: "Injector test",
      prompt: "Test the injector of the misfiring cylinder (for example a balance test or an injector swap).",
      requires: { level: "professional", tools: ["scan_tool"] },
      outcomes: [
        { when: "fail", to: "concl_injector", supports: ["injector"] },
        { when: "pass", to: "compression_test", rulesOut: ["injector"] },
      ],
      ifUnsupported: "concl_professional",
    },
    {
      id: "compression_test",
      type: "measurement",
      title: "Compression on the misfiring cylinder",
      measurement: { quantity: "Cylinder compression", unit: "kPa" },
      requires: { level: "professional", tools: ["compression_tester"], hazards: ["Disable fuel and ignition before cranking"] },
      outcomes: [
        { when: { max: { spec: "compression_min" }, maxInclusive: false }, to: "concl_mechanical", supports: ["low_compression"] },
        { when: { min: { spec: "compression_min" } }, to: "concl_wiring", rulesOut: ["low_compression"] },
      ],
      otherwise: "concl_professional",
      ifUnsupported: "concl_professional",
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
        { when: "nothing_found", to: "fuel_pressure" },
      ],
    },
    {
      id: "fuel_pressure",
      type: "measurement",
      title: "Fuel pressure",
      measurement: { quantity: "Fuel rail pressure", unit: "kPa" },
      requires: { level: "professional", tools: ["pressure_gauge"], hazards: ["Pressurised fuel"] },
      outcomes: [
        { when: { max: { spec: "fuel_pressure_min" }, maxInclusive: false }, to: "concl_fuel_supply", supports: ["fuel_supply"] },
        { when: { min: { spec: "fuel_pressure_min" }, max: { spec: "fuel_pressure_max" } }, to: "concl_professional", rulesOut: ["fuel_supply"] },
      ],
      otherwise: "concl_professional",
      ifUnsupported: "concl_professional",
    },

    /* ── conclusions ── */
    { id: "concl_coil", type: "conclusion", title: "Ignition coil", cause: "ignition_coil", recommendation: "Replace the ignition coil that the misfire followed.", next: "verify_repair" },
    { id: "concl_plug", type: "conclusion", title: "Spark plug", cause: "spark_plug", recommendation: "Replace the spark plug (usually as a set).", next: "verify_repair" },
    { id: "concl_injector", type: "conclusion", title: "Fuel injector", cause: "injector", recommendation: "Have the injector replaced.", next: "verify_repair" },
    { id: "concl_mechanical", type: "conclusion", title: "Low compression", cause: "low_compression", recommendation: "Have the engine's mechanical condition checked (for example a leak-down test).", next: "end_referred" },
    { id: "concl_wiring", type: "conclusion", title: "Wiring or engine control", cause: "wiring_or_control", recommendation: "Have the ignition and injector circuits and the engine control checked.", next: "end_referred" },
    { id: "concl_vacuum", type: "conclusion", title: "Air leak", cause: "vacuum_leak", recommendation: "Repair or replace the leaking hose or seal.", next: "verify_repair" },
    { id: "concl_fuel_supply", type: "conclusion", title: "Low fuel pressure", cause: "fuel_supply", recommendation: "Have the fuel supply (pump, filter, regulator) checked.", next: "verify_repair" },
    { id: "concl_professional", type: "conclusion", title: "Needs a professional", recommendation: "This next step needs a workshop. Take the vehicle in and share what was found so far.", next: "end_referred" },
    { id: "concl_stop_driving", type: "conclusion", title: "Severe misfire", recommendation: "Avoid driving: a flashing light means a severe misfire that can damage the exhaust catalyst. Have it checked.", next: "end_referred" },
    { id: "concl_read_codes", type: "conclusion", title: "Read the codes first", recommendation: "Have the trouble codes read: they usually show which cylinder misfires.", next: "end_referred" },
    { id: "concl_intermittent", type: "conclusion", title: "Not happening now", recommendation: "Note when it happens (cold, warm, load, speed) and have the codes read.", next: "end_not_reproducible" },
    { id: "concl_not_fixed", type: "conclusion", title: "Repair did not fix it", recommendation: "Keep the record of what was tried and have a professional continue from here.", next: "end_referred" },

    /* ── after the repair ── */
    {
      id: "verify_repair",
      type: "repair_verification",
      title: "Did the repair fix it?",
      prompt: "After the repair, clear the codes and drive in the conditions where the misfire happened. Is the engine smooth, with no misfire code coming back?",
      ifVerified: "end_resolved",
      ifNotVerified: "concl_not_fixed",
    },

    { id: "end_resolved", type: "end", title: "Resolved", result: "resolved" },
    { id: "end_referred", type: "end", title: "Referred", result: "referred" },
    { id: "end_not_reproducible", type: "end", title: "Not reproducible now", result: "not_reproducible" },
  ],
};
