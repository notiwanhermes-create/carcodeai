/**
 * Unified deterministic code lookup: OBD2 from dataset, OEM from DB.
 * Never returns AI-generated meaning.
 */

import { parseCode, type CodeType } from "./code-parse";
import { getDtcDefinition } from "./dtc-definition";
import { getOemFault } from "./oem-fault-codes";

export type CodeDefinitionResult = {
  codeType: "obd2" | "oem";
  code: string;
  title: string;
  description: string;
  source: string | null;
  /** Set only for OEM */
  make?: string;
};

export type CodeLookupResult =
  | { found: true; definition: CodeDefinitionResult; parseType: CodeType }
  | { found: false; parseType: CodeType; needsMake?: boolean };

/**
 * Get a verified definition for a code. For obd2 uses static dataset; for oem_hex
 * requires make and uses oem_fault_codes table. Returns null when definition is missing
 * (unknown code or OEM code not in DB).
 */
export async function getCodeDefinition(
  inputCode: string,
  make?: string | null
): Promise<CodeLookupResult> {
  const { normalized, type } = parseCode(inputCode);

  if (type === "obd2") {
    const def = getDtcDefinition(normalized);
    if (def) {
      return {
        found: true,
        parseType: "obd2",
        definition: {
          codeType: "obd2",
          code: def.code,
          title: def.title,
          description: def.description,
          source: def.source,
        },
      };
    }
    return { found: false, parseType: "obd2" };
  }

  if (type === "oem_hex") {
    const makeTrim = (make ?? "").trim();
    if (!makeTrim) {
      return { found: false, parseType: "oem_hex", needsMake: true };
    }
    const oem = await getOemFault(makeTrim, normalized);
    if (oem) {
      return {
        found: true,
        parseType: "oem_hex",
        definition: {
          codeType: "oem",
          code: oem.code,
          title: oem.title,
          description: oem.description ?? oem.title,
          source: oem.source ?? null,
          make: oem.make,
        },
      };
    }
    return { found: false, parseType: "oem_hex", needsMake: false };
  }

  return { found: false, parseType: "unknown" };
}

/** Sync-only: get parse result for UI (badge, make picker). */
export function getCodeParseOnly(inputCode: string): { normalized: string; type: CodeType } {
  return parseCode(inputCode);
}
