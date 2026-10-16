/**
 * ============================================================================
 *   GENERIC SOURCE-BACKED WORKFLOW CANDIDATE: DRAFT, NOT HUMAN-REVIEWED
 *   Not manufacturer data. Not a repair procedure for any specific vehicle.
 * ============================================================================
 *
 * Triage of a reported misfire on a GASOLINE (spark-ignition) engine,
 * organized into five coarse cause categories. CarCode's own diagnostic
 * structure; every technical claim it rests on is listed in GENERIC_MISFIRE
 * content metadata below, with its public source or marked as author
 * judgement for a reviewer to check.
 *
 * It contains NO vehicle values. The one vehicle-specific limit it needs
 * (fuel supply pressure) is requested by id ("fuel_supply_pressure_expected")
 * from a SpecificationProvider; until a VERIFIED value exists for the vehicle,
 * the reading is not judged. The only numbers written here are the
 * measurement's generic plausibility guard (it catches typos, it is not a
 * pass limit) and the version.
 *
 * Trouble codes are used only to route by pattern (one cylinder or several),
 * and only when reported pending, confirmed or active: a code's presence
 * never rules a cause in or out.
 */
import type { WorkflowDefinition } from "../../diagnostic-workflow";
import { ASE_A8_TASK_LIST, CARB_OBD2_1968_2, SAE_J2012_CATALOGUE } from "../sources";
import type { WorkflowContent } from "../types";

/** Standardized identifiers (SAE J2012 numbering; NOT verified against the paywalled annex, see the claims). */
const CYLINDER_CODES = ["P0301", "P0302", "P0303", "P0304", "P0305", "P0306", "P0307", "P0308", "P0309", "P0310", "P0311", "P0312"];
const MULTIPLE_CODE = "P0300";
/** A code counts for routing only when reported as current. Permanent or history alone is not a current fault. */
const current = (code: string | string[]) => ({ any: (["pending", "confirmed", "active"] as const).map((status) => ({ dtc: { code, status } })) });

const ALL_CAUSES = ["ignition", "fuel_delivery", "mechanical", "air_intake", "electrical_connection"];
const others = (keep: string) => ALL_CAUSES.filter((c) => c !== keep);

const SMOOTH = { id: "symptom_gone", kind: "symptom_absent", prompt: "Drive in the conditions where the misfire happened. Is the engine running smoothly now?" } as const;
const NO_CODES = { id: "codes_not_returned", kind: "codes_absent", codes: "reported" } as const;
const verification = (id: string, title: string, retest?: { step: string; passWhen: string[] }): WorkflowDefinition["nodes"][number] => ({
  id,
  type: "repair_verification",
  title,
  prompt: "After the repair: re-check what found the fault, drive in the conditions where the misfire happened, and read the codes with a scan tool.",
  criteria: [...(retest ? [{ id: "detecting_check_passes", kind: "retest" as const, ...retest }] : []), SMOOTH, NO_CODES],
  ifVerified: "end_resolved",
  ifNotVerified: "concl_not_fixed",
  ifInconclusive: "concl_verify_inconclusive",
});

export const GENERIC_GASOLINE_MISFIRE_WORKFLOW: WorkflowDefinition = {
  id: "generic.gasoline-engine-misfire",
  version: 1,
  title: "Engine misfire triage (generic, gasoline engines)",
  provenance:
    "GENERIC SOURCE-BACKED CANDIDATE (draft, not human-reviewed): CarCode's own diagnostic structure. Claims and sources are listed in its content metadata. Not manufacturer data; not a repair procedure for any specific vehicle.",
  faultModel: "single_primary_fault",
  // Spark-ignition gasoline engines only. Hybrids are excluded on purpose (the engine may not run on demand).
  applicability: { fuel: ["gasoline"] },
  conditions: [
    { id: "vehicle_secured", title: "Parked on level ground, in park or neutral, parking brake applied" },
    { id: "engine_off_cool", title: "Engine switched off and cool enough to touch" },
  ],
  causes: [
    { id: "ignition", title: "Ignition (spark plug, coil or ignition lead)" },
    { id: "fuel_delivery", title: "Fuel delivery (supply pressure or injector)" },
    { id: "mechanical", title: "Mechanical (compression)" },
    { id: "air_intake", title: "Intake air leak" },
    { id: "electrical_connection", title: "Wiring or connector to an ignition or injection component" },
  ],
  nodes: [
    { id: "start", type: "start", title: "Start", next: "confirm_symptom" },

    {
      id: "confirm_symptom",
      type: "question",
      answer: "yes_no",
      title: "Can the misfire be reproduced now?",
      prompt: "Is the engine running rough, shaking or stumbling now (for example at idle), so that it can be checked?",
      outcomes: [
        { when: "yes", to: "mil_flashing" },
        { when: "no", to: "concl_not_present" },
      ],
    },
    {
      id: "mil_flashing",
      type: "question",
      answer: "yes_no",
      title: "Is the check-engine light flashing?",
      prompt: "While it runs rough, is the check-engine (malfunction indicator) light flashing?",
      outcomes: [
        { when: "yes", to: "concl_severe_misfire" },
        { when: "no", to: "pattern" },
      ],
    },

    // One cylinder or several: from current codes when they say so, otherwise asked. Routing only.
    {
      id: "pattern",
      type: "branch",
      title: "One cylinder or several (from current codes)",
      rules: [
        { if: current(MULTIPLE_CODE), to: "multi_secure" },
        { if: current(CYLINDER_CODES), to: "single_secure" },
      ],
      otherwise: "ask_pattern",
    },
    {
      id: "ask_pattern",
      type: "question",
      answer: "choice",
      title: "One cylinder or several (asked)",
      prompt: "Do you know whether the misfire is on one cylinder or on several (for example from codes read earlier)?",
      options: [
        { id: "one", label: "One cylinder" },
        { id: "several", label: "Several cylinders, or random" },
        { id: "unknown", label: "I don't know" },
      ],
      outcomes: [
        { when: "one", to: "single_secure" },
        { when: "several", to: "multi_secure" },
        { when: "unknown", to: "data_secure" },
      ],
    },
    {
      id: "data_secure",
      type: "prerequisite",
      title: "Vehicle secured",
      prompt: "Is the vehicle parked on level ground, in park or neutral, with the parking brake applied?",
      ifMet: "read_misfire_data",
      ifNotMet: "data_prepare",
      establishes: ["vehicle_secured"],
    },
    {
      id: "data_prepare",
      type: "action",
      title: "Secure the vehicle",
      prompt: "Park on level ground, select park or neutral and apply the parking brake, then continue.",
      next: "read_misfire_data",
      establishes: ["vehicle_secured"],
    },
    {
      id: "read_misfire_data",
      type: "observation",
      title: "Per-cylinder misfire data (scan tool)",
      prompt: "With the engine idling, look at the scan tool's live data. Does it show misfires on one cylinder, on several, or no per-cylinder misfire data at all?",
      requires: { level: "diy", scan: "live_data", hazards: ["Engine running: keep hands, hair and clothing clear of belts and the fan"] },
      needsConditions: ["vehicle_secured"],
      options: [
        { id: "one_cylinder", label: "Misfires on one cylinder" },
        { id: "several", label: "Misfires on several cylinders" },
        { id: "not_shown", label: "This vehicle or tool shows no per-cylinder misfire data" },
      ],
      outcomes: [
        { when: "one_cylinder", to: "single_secure" },
        { when: "several", to: "multi_secure" },
        { when: "not_shown", to: "concl_read_codes" },
      ],
      ifUnsupported: "concl_read_codes",
      ifInconclusive: "concl_read_codes",
    },

    /* ── one cylinder: an explicit reorderable region of cylinder-specific tests ── */
    {
      id: "single_secure",
      type: "prerequisite",
      title: "Vehicle secured, engine off and cool",
      prompt: "Is the vehicle parked on level ground, in park or neutral with the parking brake applied, and is the engine switched off and cool enough to touch?",
      ifMet: "single_tests",
      ifNotMet: "single_prepare",
      establishes: ["vehicle_secured", "engine_off_cool"],
    },
    {
      id: "single_prepare",
      type: "action",
      title: "Secure the vehicle and let the engine cool",
      prompt: "Park on level ground, select park or neutral, apply the parking brake, switch the engine off and wait until it is cool enough to touch.",
      next: "single_tests",
      establishes: ["vehicle_secured", "engine_off_cool"],
    },
    {
      id: "single_tests",
      type: "test_selection",
      title: "Choose the next check (one cylinder)",
      prompt: "These checks can be done in any order. The recommended one is first.",
      group: "single_cylinder_tests",
      candidates: [{ step: "connector_inspection" }, { step: "ignition_swap" }, { step: "plug_inspection" }, { step: "relative_compression" }],
      next: "concl_professional",
    },
    {
      id: "connector_inspection",
      type: "observation",
      title: "Look at that cylinder's wiring and connectors",
      prompt:
        "With the engine off, look at the wiring and connectors of the misfiring cylinder's ignition coil (or lead) and fuel injector, as far as you can see them without removing parts. Are any loose, damaged, burnt or corroded?",
      requires: { level: "owner", hazards: ["Engine off: look only, do not unplug anything"] },
      testProfile: { risk: "low", invasiveness: "observe", setup: "none" },
      needsConditions: ["vehicle_secured", "engine_off_cool"],
      options: [
        { id: "damaged_or_loose", label: "Loose, damaged, burnt or corroded" },
        { id: "look_ok", label: "They look fine" },
      ],
      outcomes: [
        { when: "damaged_or_loose", to: "concl_electrical", supports: ["electrical_connection"] },
        { when: "look_ok", to: "single_tests" },
      ],
      ifInconclusive: "single_tests",
    },
    {
      id: "ignition_swap",
      type: "observation",
      title: "Swap test: does the misfire follow the coil and plug?",
      // Swapping parts again after the repair proves nothing: never repeated as a recheck.
      repeatableAfterRepair: false,
      prompt:
        "Only where each cylinder has its own coil (or lead) and an accessible spark plug: with the engine off, swap the misfiring cylinder's coil and spark plug with those of a neighbouring cylinder. Clear the codes, run the engine until a misfire is reported again, and read the codes. Where is it reported now?",
      requires: {
        level: "diy",
        scan: "codes",
        instruments: ["hand_tools"],
        hazards: ["Swap parts only with the engine off", "Ignition system high voltage: never touch ignition parts with the engine running", "Engine running: keep clear of moving parts"],
      },
      testProfile: { risk: "low", invasiveness: "disconnect", setup: "minor" },
      needsConditions: ["vehicle_secured", "engine_off_cool"],
      options: [
        { id: "moved", label: "On the other cylinder: it moved with the parts" },
        { id: "stayed", label: "On the same cylinder as before" },
      ],
      outcomes: [
        { when: "moved", to: "concl_ignition", supports: ["ignition"], rulesOut: others("ignition") },
        { when: "stayed", to: "single_tests", rulesOut: ["ignition"] },
      ],
      ifUnsupported: "single_tests",
      ifInconclusive: "single_tests",
    },
    {
      id: "plug_inspection",
      type: "observation",
      title: "Compare that cylinder's spark plug",
      prompt: "Remove the spark plug of the misfiring cylinder and one from another cylinder, and compare them. What do you see?",
      requires: { level: "diy", instruments: ["hand_tools"], hazards: ["Remove spark plugs only from a cool engine"] },
      testProfile: { risk: "low", invasiveness: "disassemble", setup: "minor" },
      needsConditions: ["vehicle_secured", "engine_off_cool"],
      options: [
        { id: "damaged", label: "Cracked insulator, or a damaged or badly worn electrode" },
        { id: "no_difference", label: "No visible difference from the other plug" },
      ],
      outcomes: [
        { when: "damaged", to: "concl_ignition", supports: ["ignition"] },
        { when: "no_difference", to: "single_tests" },
      ],
      ifUnsupported: "single_tests",
      ifInconclusive: "single_tests",
    },
    {
      id: "relative_compression",
      type: "observation",
      title: "Compare compression between cylinders",
      prompt:
        "Do a cranking compression test on every cylinder in the same way and compare the misfiring cylinder with the others. This compares the cylinders with each other; it does not judge them against a specification.",
      requires: {
        level: "professional",
        instruments: ["compression_tester"],
        hazards: ["Disable ignition and fuel injection before cranking, as the vehicle's service information describes", "Hot engine parts", "Keep clear of the engine while it cranks"],
      },
      testProfile: { risk: "moderate", invasiveness: "disassemble", setup: "significant" },
      needsConditions: ["vehicle_secured", "engine_off_cool"],
      options: [
        { id: "clearly_lower", label: "Clearly lower than the other cylinders" },
        { id: "similar", label: "Similar to the other cylinders" },
      ],
      outcomes: [
        { when: "clearly_lower", to: "concl_mechanical", supports: ["mechanical"], rulesOut: others("mechanical") },
        { when: "similar", to: "single_tests" },
      ],
      ifUnsupported: "single_tests",
      ifInconclusive: "single_tests",
    },

    /* ── several cylinders: a second, small region of checks on what cylinders share ── */
    {
      id: "multi_secure",
      type: "prerequisite",
      title: "Vehicle secured",
      prompt: "Is the vehicle parked on level ground, in park or neutral, with the parking brake applied?",
      ifMet: "multi_tests",
      ifNotMet: "multi_prepare",
      establishes: ["vehicle_secured"],
    },
    {
      id: "multi_prepare",
      type: "action",
      title: "Secure the vehicle",
      prompt: "Park on level ground, select park or neutral and apply the parking brake, then continue.",
      next: "multi_tests",
      establishes: ["vehicle_secured"],
    },
    {
      id: "multi_tests",
      type: "test_selection",
      title: "Choose the next check (several cylinders)",
      prompt: "These checks can be done in any order. The recommended one is first.",
      group: "multiple_cylinder_tests",
      candidates: [{ step: "intake_leak_check" }, { step: "fuel_pressure" }],
      next: "concl_professional",
    },
    {
      id: "intake_leak_check",
      type: "observation",
      title: "Listen and look for an intake air leak",
      prompt: "With the engine idling, listen around the intake and its hoses for hissing, and look for disconnected, cracked or split hoses. What do you find?",
      requires: { level: "owner", hazards: ["Engine running: keep hands, hair and clothing clear of belts and the fan", "Hot engine and exhaust parts"] },
      testProfile: { risk: "low", invasiveness: "observe", setup: "none" },
      needsConditions: ["vehicle_secured"],
      options: [
        { id: "hiss_or_damage", label: "Hissing, or a disconnected, cracked or split hose" },
        { id: "nothing_found", label: "Nothing found" },
      ],
      outcomes: [
        { when: "hiss_or_damage", to: "concl_air", supports: ["air_intake"] },
        { when: "nothing_found", to: "multi_tests" },
      ],
      ifInconclusive: "multi_tests",
    },
    {
      id: "fuel_pressure",
      type: "measurement",
      title: "Fuel supply pressure",
      prompt: "Measure the fuel supply pressure at the test point and in the conditions the vehicle's service information gives.",
      // Generic plausibility guard for a low-pressure fuel supply, to catch typos only. NOT a specification or a pass limit.
      measurement: { quantity: "Fuel supply pressure (low-pressure side)", unit: "kPa", plausible: { min: 0, max: 1000 } },
      requires: {
        level: "professional",
        instruments: ["pressure_gauge"],
        hazards: ["Fuel under pressure: connect and disconnect the gauge only as the vehicle's service information describes", "No open flames or sparks near the fuel system"],
      },
      testProfile: { risk: "moderate", invasiveness: "disconnect", setup: "significant" },
      needsConditions: ["vehicle_secured"],
      specification: "fuel_supply_pressure_expected",
      outcomes: [
        { id: "below_spec", when: { relativeToSpec: "below" }, to: "concl_fuel", supports: ["fuel_delivery"] },
        { id: "within_spec", when: { relativeToSpec: "within" }, to: "multi_tests" },
        { id: "above_spec", when: { relativeToSpec: "above" }, to: "multi_tests" },
      ],
      otherwise: "multi_tests",
      ifUnsupported: "multi_tests",
      ifInconclusive: "multi_tests",
    },

    /* ── conclusions: categories, never a failed part the evidence did not reach ── */
    {
      id: "concl_ignition",
      type: "conclusion",
      title: "Ignition on this cylinder",
      cause: "ignition",
      recommendation: "The evidence points to the ignition parts of this cylinder (coil, lead or spark plug). Repair as the vehicle's service information describes, then verify the repair.",
      next: "verify_ignition",
    },
    {
      id: "concl_electrical",
      type: "conclusion",
      title: "Wiring or connector",
      cause: "electrical_connection",
      recommendation: "A damaged, loose or corroded connection was found at this cylinder's ignition or injection parts. Repair it as the vehicle's service information describes, then verify the repair.",
      next: "verify_electrical",
    },
    {
      id: "concl_mechanical",
      type: "conclusion",
      title: "Mechanical (compression)",
      cause: "mechanical",
      recommendation: "This cylinder's compression is clearly lower than the others. Finding the mechanical cause needs further professional diagnosis. Verify after any repair.",
      next: "verify_mechanical",
    },
    {
      id: "concl_air",
      type: "conclusion",
      title: "Intake air leak",
      cause: "air_intake",
      recommendation: "An intake air leak was found. Repair it, then verify the repair.",
      next: "verify_air",
    },
    {
      id: "concl_fuel",
      type: "conclusion",
      title: "Fuel supply pressure",
      cause: "fuel_delivery",
      recommendation: "The fuel supply pressure is below the vehicle's verified specification. Have the fuel supply diagnosed and repaired, then verify the repair.",
      next: "verify_fuel",
    },
    {
      id: "concl_professional",
      type: "conclusion",
      title: "Needs professional diagnosis",
      recommendation: "The checks available here did not separate the possible causes. A professional diagnosis is needed.",
      next: "end_referred",
    },
    {
      id: "concl_severe_misfire",
      type: "conclusion",
      title: "Flashing check-engine light",
      recommendation:
        "A flashing check-engine light means the vehicle's diagnostic system has detected misfire at a level it treats as able to damage the catalytic converter. Avoid driving further than necessary and have it diagnosed.",
      next: "end_referred",
    },
    {
      id: "concl_read_codes",
      type: "conclusion",
      title: "Read the codes first",
      recommendation: "Whether one cylinder or several misfire is not known. Have the trouble codes read with a scan tool, then start again.",
      next: "end_referred",
    },
    {
      id: "concl_not_present",
      type: "conclusion",
      title: "Not happening now",
      recommendation: "The misfire cannot be checked while it is not happening. Note when it occurs (cold or warm, at idle or under load), have the stored codes and freeze-frame data read, and start again when it can be reproduced.",
      next: "end_not_reproducible",
    },
    {
      id: "concl_not_fixed",
      type: "conclusion",
      title: "Not fixed",
      recommendation: "The repair did not resolve the misfire. Start a new diagnosis with the new evidence, or have it diagnosed professionally.",
      next: "end_referred",
    },
    {
      id: "concl_verify_inconclusive",
      type: "conclusion",
      title: "Repair not verified",
      recommendation: "The repair could not be verified with the evidence available (for example no complete post-repair code scan). Complete the checks, or have it verified professionally.",
      next: "end_referred",
    },

    /* ── repair verification: re-check what found it, the symptom, and a complete post-repair scan ── */
    verification("verify_ignition", "Did the ignition repair fix it?"),
    verification("verify_electrical", "Did the wiring repair fix it?", { step: "connector_inspection", passWhen: ["look_ok"] }),
    verification("verify_mechanical", "Did the mechanical repair fix it?", { step: "relative_compression", passWhen: ["similar"] }),
    verification("verify_air", "Did the intake leak repair fix it?", { step: "intake_leak_check", passWhen: ["nothing_found"] }),
    verification("verify_fuel", "Did the fuel supply repair fix it?", { step: "fuel_pressure", passWhen: ["within_spec"] }),

    { id: "end_resolved", type: "end", title: "Resolved", result: "resolved" },
    { id: "end_referred", type: "end", title: "Referred", result: "referred" },
    { id: "end_not_reproducible", type: "end", title: "Not reproducible now", result: "not_reproducible" },
  ],
};

/** The workflow with its content metadata. Status: DRAFT. No human has reviewed it. */
export const GENERIC_GASOLINE_MISFIRE: WorkflowContent = {
  workflow: GENERIC_GASOLINE_MISFIRE_WORKFLOW,
  contentClass: "generic_source_backed",
  review: {
    status: "draft",
    contentRevision: 1,
    preparedBy: {
      kind: "ai_assisted",
      note: "Assembled by an AI assistant (Claude) for CarCode from the cited public sources and general diagnostic structure. Not reviewed by a qualified automotive technician.",
    },
    reviews: [],
  },
  sources: [CARB_OBD2_1968_2, SAE_J2012_CATALOGUE, ASE_A8_TASK_LIST],
  claims: [
    {
      id: "flashing-mil-catalyst-damage",
      statement:
        "An OBD II system must flash the malfunction indicator while misfire at a level that can damage the catalyst is occurring. Some vehicles that cut fuel to prevent over-fuelling may light it steadily instead, so a steady light does not exclude a severe misfire.",
      support: "supported",
      sources: [{ source: CARB_OBD2_1968_2.id, locator: "(e)(3.4.1)(A)(ii); (e)(3.4.1)(D)" }],
      covers: { nodes: ["mil_flashing", "concl_severe_misfire"] },
      note: "The advice to avoid further driving is CarCode's inference from the catalyst-damage meaning, not a statement of the regulation.",
    },
    {
      id: "cylinder-identification",
      statement: "OBD II misfire monitoring must identify the specific misfiring cylinder, and must indicate misfire on more than one cylinder with a separate code.",
      support: "supported",
      sources: [{ source: CARB_OBD2_1968_2.id, locator: "(e)(3.1.2); (e)(3.1.3)" }],
      covers: { nodes: ["pattern", "ask_pattern"] },
    },
    {
      id: "misfire-code-identifiers",
      statement: "The standardized identifiers used here are P0300 for random or multiple-cylinder misfire and P0301 to P0312 for a misfire detected on cylinder 1 to 12.",
      support: "partially_supported",
      sources: [{ source: SAE_J2012_CATALOGUE.id, locator: "catalogue entry only" }],
      covers: { codes: [MULTIPLE_CODE, ...CYLINDER_CODES], nodes: ["pattern"] },
      note: "Only the existence of standardized code definitions in SAE J2012 is supported. The individual identifiers and their meanings were NOT verified against J2012 or its digital annex (paywalled). A reviewer must confirm them.",
    },
    {
      id: "code-status-routing",
      statement:
        "A pending code is stored on first detection and erased if the fault is not detected again; a confirmed code is stored once the fault is confirmed and may stay stored for many warm-up cycles after it stops. So only codes reported as current (pending, confirmed or active) route the diagnosis, and a code's presence never rules a cause in or out.",
      support: "partially_supported",
      sources: [{ source: CARB_OBD2_1968_2.id, locator: "(c)(5); (c)(25); (d)(2.2.2); (d)(2.4)" }],
      covers: { nodes: ["pattern", "verify_ignition"] },
      note: "Pending and confirmed codes are supported by the regulation. 'Active' and 'history' are scan-tool status labels, and permanent codes are not described in the edition read; their handling follows the engine's V2D rules (author judgement).",
    },
    {
      id: "freeze-frame-stored",
      statement: "The OBD system stores freeze-frame conditions with pending or confirmed codes, and misfire freeze-frame data takes priority over most other faults.",
      support: "supported",
      sources: [{ source: CARB_OBD2_1968_2.id, locator: "(d)(2.2.4); (e)(3.4.3)(B)" }],
      covers: { nodes: ["concl_not_present"] },
    },
    {
      id: "diagnosis-test-types",
      statement:
        "Recognized engine-performance diagnosis includes verifying the complaint with a visual inspection, manifold vacuum or pressure tests, cylinder power balance, cranking and relative compression tests, leak-down tests, and diagnosing mechanical, electrical, fuel and ignition problems with an oscilloscope or scan tool.",
      support: "partially_supported",
      sources: [{ source: ASE_A8_TASK_LIST.id, locator: "A8 tasks A.1, A.6, A.7, A.8, A.9, A.10" }],
      covers: {
        causes: ["ignition", "fuel_delivery", "mechanical", "air_intake", "electrical_connection"],
        nodes: ["connector_inspection", "relative_compression", "intake_leak_check", "read_misfire_data"],
        regions: ["single_cylinder_tests", "multiple_cylinder_tests"],
      },
      note: "A competency list, not a procedure: it supports that these kinds of test belong to misfire diagnosis and that ignition, fuel, mechanical, air and electrical faults are its domains. The grouping into five categories, the order and every cause effect are author judgement.",
    },
    {
      id: "single-fault-elimination",
      statement:
        "Under one primary fault: a misfire that moves with a swapped coil and plug is in those parts (and nothing that stays with the cylinder); one that stays rules them out; a cylinder with clearly lower compression than the others explains the misfire on its own.",
      support: "author_judgement",
      sources: [],
      covers: { nodes: ["ignition_swap", "relative_compression"], causes: ["ignition", "mechanical"] },
      note: "Common diagnostic reasoning, not taken from a cited source. The reviewer must confirm each cause effect, and whether 'clearly lower' needs a stated basis.",
    },
    {
      id: "findings-support-only",
      statement:
        "A visible connector fault, a damaged spark plug, an audible intake leak or a low fuel supply pressure points to its category, but does not rule the others out.",
      support: "author_judgement",
      sources: [],
      covers: { nodes: ["connector_inspection", "plug_inspection", "intake_leak_check", "fuel_pressure"], causes: ["electrical_connection", "air_intake", "fuel_delivery"] },
    },
    {
      id: "fuel-pressure-specification",
      statement: "Fuel supply pressure is vehicle-specific: it is judged only against a verified specification for the vehicle, requested by id, never against a number written into the workflow.",
      support: "author_judgement",
      sources: [],
      covers: { specifications: ["fuel_supply_pressure_expected"], nodes: ["fuel_pressure", "verify_fuel"] },
      note: "The plausibility guard (0 to 1000 kPa) only catches typos for a low-pressure supply; it is not a pass limit. High-pressure direct-injection rails are outside this step.",
    },
    {
      id: "test-profiles-and-hazards",
      statement: "The risk, invasiveness and set-up of each check, and the hazard notes and conditions on each step, are CarCode's own assessment.",
      support: "author_judgement",
      sources: [],
      covers: { regions: ["single_cylinder_tests", "multiple_cylinder_tests"] },
      note: "To be checked by the reviewer for every step.",
    },
    {
      id: "verification-criteria",
      statement:
        "A repair is verified only when the check that found the fault passes again (where repeating it is meaningful), the symptom is gone in the conditions where it happened, and a complete post-repair scan does not list the earlier codes.",
      support: "partially_supported",
      sources: [{ source: CARB_OBD2_1968_2.id, locator: "(d)(2.2.2); (d)(2.4)" }],
      covers: { nodes: ["verify_ignition", "verify_electrical", "verify_mechanical", "verify_air", "verify_fuel"] },
      note: "The regulation supports that codes are erased by the OBD system's own rules, so their absence needs a fresh, complete scan. Requiring all three criteria is author judgement.",
    },
  ],
  excludes: [
    "Any numeric specification (compression, fuel pressure, resistance, voltage, timing values)",
    "Manufacturer procedures, command sequences, ECU addressing and service functions",
    "Manufacturer-specific code meanings",
    "Component locations, firing orders and cylinder numbering for any vehicle",
    "High-pressure direct-injection fuel system tests",
  ],
};
