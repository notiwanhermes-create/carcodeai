/**
 * Diagnostic trouble codes: parsing, classification and lookup.
 *
 * Core rule: a missing answer is better than a wrong one.
 *  - An exact definition is only ever returned from data on file. Nothing here
 *    generates or guesses a definition.
 *  - A manufacturer-specific definition is tied to a make and is never returned
 *    for any other make.
 *  - `verified` is true only for data checked against a reliable, recorded source.
 *
 * This module is pure (no network, no database) and safe to import anywhere.
 */
import genericData from "../data/dtc/generic.json";
import manufacturerData from "../data/dtc/manufacturer.json";

/* ───────────────────────────── classification ───────────────────────────── */

export type CodeSystem = "Powertrain" | "Body" | "Chassis" | "Network";
export type CodeScope = "generic" | "manufacturer";

export type CodeClass =
  | { valid: true; code: string; format: "obd2"; scope: CodeScope; system: CodeSystem }
  | { valid: true; code: string; format: "oem"; scope: "manufacturer"; system: null }
  | { valid: false; code: string };

const SYSTEMS: Record<string, CodeSystem> = { P: "Powertrain", B: "Body", C: "Chassis", U: "Network" };

/** OBD-II layout: a system letter, a digit 0-3, then three hexadecimal characters (P0A80 is valid). */
const OBD2_RE = /^([PBCU])([0-3])([0-9A-F]{3})$/;
/** Maker's own numbering as shown by make-specific scan tools, e.g. BMW "480A12". */
const OEM_RE = /^[0-9A-F]{4,6}$/;

/**
 * Who defines an OBD-II code is fixed by SAE J2012 / ISO 15031-6, by code range.
 * It is NOT simply "P0 vs P1":
 *
 *   Standardized (same meaning on every make):
 *     P0xxx, P2xxx, P3400-P3FFF      B0xxx, C0xxx, U0xxx, U3xxx
 *     B3xxx and C3xxx are reserved by the standard (treated as standardized:
 *     no maker may define them).
 *   Manufacturer-controlled (meaning differs by make):
 *     P1xxx, P3000-P33FF             B1xxx, B2xxx, C1xxx, C2xxx, U1xxx, U2xxx
 *
 * The last three characters are hexadecimal, so hybrid/EV codes such as P0A80
 * fall in the P0 block and are standardized.
 */
function obd2Scope(letter: string, group: string, rest: string): CodeScope {
  if (group === "0") return "generic";
  if (letter === "P") {
    if (group === "1") return "manufacturer";
    if (group === "2") return "generic";
    // P3xxx is split: P3000-P33FF manufacturer, P3400-P3FFF standardized.
    return parseInt(rest[0], 16) >= 4 ? "generic" : "manufacturer";
  }
  // B, C, U
  if (group === "1" || group === "2") return "manufacturer";
  return "generic"; // group 3: standardized (U3) or reserved by the standard (B3, C3)
}

/** Classify one already-normalised code (uppercase, no separators). */
export function classifyCode(code: string): CodeClass {
  const obd2 = OBD2_RE.exec(code);
  if (obd2) {
    return { valid: true, code, format: "obd2", scope: obd2Scope(obd2[1], obd2[2], obd2[3]), system: SYSTEMS[obd2[1]] };
  }
  if (OEM_RE.test(code)) return { valid: true, code, format: "oem", scope: "manufacturer", system: null };
  return { valid: false, code };
}

/* ──────────────────────────────── parsing ───────────────────────────────── */

/**
 * Split whatever the user pasted into individual codes.
 * Separators: spaces, commas, semicolons and new lines, in any mix.
 * Each code is upper-cased, inner dashes/dots are dropped ("P-0300"), a lone
 * system letter is joined to the number after it ("P 0300"), and duplicates
 * are removed (first occurrence wins). Nothing is discarded for being unknown:
 * invalid entries are returned too, so they can be reported to the user.
 */
export function parseCodeInput(raw: string | null | undefined): string[] {
  const tokens = (raw || "")
    .toUpperCase()
    .split(/[\s,;]+/)
    .map((t) => t.replace(/[-.]/g, ""))
    .filter(Boolean);

  const merged: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (/^[PBCU]$/.test(t) && next && /^[0-3][0-9A-F]{3}$/.test(next)) {
      merged.push(t + next);
      i++;
    } else if (t.length >= 10 && t.length % 5 === 0 && /^([PBCU][0-9A-F]{4})+$/.test(t)) {
      // Codes run together, e.g. "P0300P0171". Browsers remove line breaks when
      // several lines are pasted into a one-line field, which produces exactly this.
      for (let j = 0; j < t.length; j += 5) merged.push(t.slice(j, j + 5));
    } else {
      merged.push(t);
    }
  }
  return Array.from(new Set(merged));
}

/* ───────────────────────────────── data ─────────────────────────────────── */

/**
 * "verified": checked against a reliable, recorded source (for example licensed
 *   SAE J2012-DA data, or the maker's own service information).
 * "curated": a standardized title entered by hand for a small set of very common
 *   codes. Shown as a standard definition, but NOT reported as verified.
 */
export type Verification = "verified" | "curated";

export type GenericDtc = { code: string; title: string; description?: string; source: string; verification: Verification };

export type ManufacturerDtc = {
  code: string;
  /** The make this definition belongs to. It is never served for another make. */
  make: string;
  definition: string;
  description?: string;
  /** Where the definition comes from, e.g. the document or dataset name. */
  source: string;
  sourceType: "oem_service_information" | "licensed_dataset" | "regulatory_filing" | "other";
  /** Only "verified" records are ever served; anything else is ignored. */
  verification: "verified" | "unverified";
  // Optional narrowing, not required yet.
  model?: string;
  yearFrom?: number;
  yearTo?: number;
  chassis?: string;
  engine?: string;
  module?: string;
};

export type DtcRegistry = { generic: GenericDtc[]; manufacturer: ManufacturerDtc[] };

export const DEFAULT_REGISTRY: DtcRegistry = {
  generic: genericData as GenericDtc[],
  manufacturer: manufacturerData as ManufacturerDtc[],
};

const normMake = (make: string | null | undefined) => (make || "").trim().toLowerCase().replace(/[\s-]+/g, " ");

/* ──────────────────────────────── lookup ────────────────────────────────── */

export type DtcStatus =
  /** Standardized code with a definition on file. */
  | "generic_definition"
  /** Standardized code, but no definition on file: "Definition not verified". */
  | "generic_unverified"
  /** Manufacturer-specific code with a verified definition for this make. */
  | "manufacturer_definition"
  /** Manufacturer-specific code with no verified definition for this make. */
  | "manufacturer_unavailable"
  /** Not a valid trouble code. */
  | "invalid";

export type DtcResult = {
  code: string;
  status: DtcStatus;
  scope: CodeScope | null;
  system: CodeSystem | null;
  /** Exact definition from data on file, or null. Never generated. */
  definition: string | null;
  /** The make a manufacturer definition belongs to, or the make that was asked about. */
  make: string | null;
  source: string | null;
  /** True only when the definition was checked against a reliable, recorded source. */
  verified: boolean;
  /** Plain-language explanation for the user. */
  message: string;
};

export function lookupCode(input: string, make?: string | null, registry: DtcRegistry = DEFAULT_REGISTRY): DtcResult {
  const [code = ""] = parseCodeInput(input);
  const cls = classifyCode(code);
  const makeLabel = (make || "").trim() || null;

  if (!cls.valid) {
    return {
      code: code || String(input || "").trim().toUpperCase(),
      status: "invalid",
      scope: null,
      system: null,
      definition: null,
      make: null,
      source: null,
      verified: false,
      message: "This isn't a valid trouble code. Codes look like P0300: a letter (P, B, C or U) followed by four characters.",
    };
  }

  if (cls.scope === "generic") {
    const hit = registry.generic.find((g) => g.code === code);
    if (hit) {
      return {
        code,
        status: "generic_definition",
        scope: "generic",
        system: cls.system,
        definition: hit.title,
        make: null,
        source: hit.source,
        verified: hit.verification === "verified",
        message: "Standard code: it means the same thing on every make.",
      };
    }
    return {
      code,
      status: "generic_unverified",
      scope: "generic",
      system: cls.system,
      definition: null,
      make: null,
      source: null,
      verified: false,
      message: "Standard code, but CarCode AI doesn't have a verified definition for it yet.",
    };
  }

  // Manufacturer-specific: only a verified record for THIS make counts.
  const wanted = normMake(makeLabel);
  const hit = wanted
    ? registry.manufacturer.find((m) => m.code === code && m.verification === "verified" && normMake(m.make) === wanted)
    : undefined;
  if (hit) {
    return {
      code,
      status: "manufacturer_definition",
      scope: "manufacturer",
      system: cls.system,
      definition: hit.definition,
      make: hit.make,
      source: hit.source,
      verified: true,
      message: `${hit.make}-specific code.`,
    };
  }
  return {
    code,
    status: "manufacturer_unavailable",
    scope: "manufacturer",
    system: cls.system,
    definition: null,
    make: makeLabel,
    source: null,
    verified: false,
    message: makeLabel
      ? `This code is manufacturer-specific, and CarCode AI doesn't have a verified definition for ${makeLabel} yet. Its meaning differs between makes, so we won't guess.`
      : "This code is manufacturer-specific, and CarCode AI doesn't have a verified definition for this vehicle yet.",
  };
}

/** Look up everything the user entered. One bad code never hides the others. */
export function lookupCodes(raw: string, make?: string | null, registry: DtcRegistry = DEFAULT_REGISTRY): DtcResult[] {
  return parseCodeInput(raw).map((code) => lookupCode(code, make, registry));
}

/** Codes the diagnosis can reason about (as opposed to ones to be reported only). */
export function isUsableForDiagnosis(r: DtcResult): boolean {
  return r.status === "generic_definition" || r.status === "generic_unverified" || r.status === "manufacturer_definition";
}

/* ─────────────────────────────── AI prompt ──────────────────────────────── */

/**
 * What the model is told about each code. The wording is deliberate: the model
 * is given an exact definition only when one is on file, and is told not to
 * supply one otherwise.
 */
export function describeCodesForPrompt(results: DtcResult[], make: string): string {
  const vehicleMake = make.trim() || "this vehicle";
  return results
    .map((r) => {
      switch (r.status) {
        case "generic_definition":
          return `- ${r.code}: standardized code (same meaning on every make). Definition on file: "${r.definition}". Use this definition exactly; do not reword or replace it.`;
        case "generic_unverified":
          return `- ${r.code}: standardized (generic) OBD-II code, but NO verified definition is on file. You may use your general knowledge of this standardized code to guide likely causes, but do not present any definition of it as verified or official.`;
        case "manufacturer_definition":
          return `- ${r.code}: ${r.make}-specific code. Verified definition for ${r.make}: "${r.definition}". This definition applies to ${r.make} only. Use it exactly.`;
        case "manufacturer_unavailable":
          return `- ${r.code}: manufacturer-specific code. Its exact meaning for ${vehicleMake} is NOT available. Do NOT state, guess or imply what this code means, and do not use the meaning it has on any other make. Base the diagnosis only on the reported symptoms and the vehicle, and recommend reading the code with a ${vehicleMake}-capable scan tool or ${vehicleMake} service information.`;
        case "invalid":
          return `- ${r.code}: not a valid trouble code. Ignore it.`;
      }
    })
    .join("\n");
}
