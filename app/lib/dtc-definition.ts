/**
 * Deterministic DTC (Diagnostic Trouble Code) lookup.
 * Uses canonical definitions first, then fallback dataset. Never AI-generated.
 */

import canonicalDefinitions from "../data/dtc/definitions.json";
import dtcDatabase from "../data/dtc-database.json";

const db = dtcDatabase as Record<string, string>;
const canonical = canonicalDefinitions as Record<string, DtcDefinition>;

export type DtcDefinition = {
  code: string;
  system: string;
  standard: string;
  title: string;
  description: string;
  notes: string | null;
  source: string;
};

const SYSTEM_BY_PREFIX: Record<string, string> = {
  P: "Powertrain",
  B: "Body",
  C: "Chassis",
  U: "Network/Communication",
};

/**
 * Returns the standardized definition for a DTC, or null if not found.
 * Lookup is by uppercase code; prefer canonical definitions, then dtc-database.
 */
export function getDtcDefinition(code: string): DtcDefinition | null {
  const normalized = (code || "").trim().toUpperCase();
  if (!normalized) return null;

  const match = /^([PBCU])(\d{4})$/.exec(normalized);
  if (!match) return null;

  if (canonical[normalized]) {
    return { ...canonical[normalized] } as DtcDefinition;
  }

  const title = db[normalized];
  if (!title) return null;

  const system = SYSTEM_BY_PREFIX[normalized[0]] ?? "Unknown";
  const standard = normalized[1] === "0" ? "OBD2" : "Manufacturer";

  return {
    code: normalized,
    system,
    standard,
    title,
    description: title,
    notes: null,
    source: "SAE J2012 / ISO 15031-6",
  };
}
