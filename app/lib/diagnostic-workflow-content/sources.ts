/**
 * Public sources cited by CarCode's generic diagnostic content (V2H).
 *
 * Citations and limitations only. No passages are copied; claims in the
 * workflows' metadata restate facts in CarCode's own words and point here.
 * A catalogue page is recorded as a catalogue page: it is not the standard.
 */
import type { ContentSource } from "./types";

/** California Air Resources Board OBD II regulation: a regulator's public text. */
export const CARB_OBD2_1968_2: ContentSource = {
  id: "carb-13ccr-1968.2-fro",
  title:
    "Final Regulation Order, Title 13 California Code of Regulations section 1968.2: Malfunction and Diagnostic System Requirements for 2004 and Subsequent Model-Year Passenger Cars, Light-Duty Trucks, and Medium-Duty Vehicles and Engines (OBD II)",
  publisher: "California Air Resources Board (CARB)",
  type: "regulation",
  url: "https://arb.ca.gov/regact/obd02/fro1968-2.pdf",
  edition: "Final regulation order of the 2002 OBD II rulemaking (arb.ca.gov/regact/obd02). The text states no edition date.",
  accessed: "2026-10-16",
  consulted: "partial_text",
  limitations:
    "An older edition of the regulation; later amendments were not consulted. It states what an OBD II system must detect, record and indicate, not how to diagnose or repair a vehicle. It is a California regulation; other markets' rules were not checked. It does not define the standardized code identifiers, and the edition read does not describe permanent fault codes.",
};

/** SAE J2012 catalogue entry. Only the public catalogue page was consulted. */
export const SAE_J2012_CATALOGUE: ContentSource = {
  id: "sae-j2012-catalogue",
  title: "SAE J2012: Diagnostic Trouble Code Definitions (catalogue entry)",
  publisher: "SAE International",
  type: "standard_summary",
  url: "https://saemobilus.sae.org/content/J2012_201612",
  reference: "SAE J2012_201612 (technically equivalent to ISO 15031-6); definitions in the J2012-DA digital annex",
  edition: "J2012_201612 catalogue page; the digital annex revision current in 2026 is J2012DA_202607 (per app/data/dtc/ATTRIBUTION.md)",
  accessed: "2026-10-16",
  consulted: "catalogue_only",
  limitations:
    "The normative text and the digital annex with the code definitions are paywalled and were NOT consulted. This source supports only that standardized OBD trouble-code definitions exist in J2012; it does not verify any individual code identifier or meaning.",
};

/** ASE certification task list for engine performance. */
export const ASE_A8_TASK_LIST: ContentSource = {
  id: "ase-a8-task-list-2025",
  title: "The Official ASE Study Guide: ASE Automobile Tests. Engine Performance (Test A8) Test Specifications and Task List",
  publisher: "National Institute for Automotive Service Excellence (ASE)",
  type: "technical_education",
  url: "https://www.ase.com/uploads/ASE_Automobile_Study_Guide_2025_250109_210800.pdf",
  edition: "2025 study guide",
  accessed: "2026-10-16",
  consulted: "partial_text",
  limitations:
    "A list of competencies a technician is tested on, not a procedure: it gives no sequence, decision logic, values or safety instructions. Only section A (General Diagnosis) of the A8 task list was read; sections B to E (ignition, fuel and air induction, emissions, computerized controls) were not.",
};
