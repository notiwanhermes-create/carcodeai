/**
 * Diagnostic trouble codes: parsing, classification and lookup.
 *
 * Core rule: a missing answer is better than a wrong one.
 *  - An exact definition is only ever returned from data on file. Nothing here
 *    generates or guesses a definition.
 *  - A manufacturer-specific definition is tied to a make and is never returned
 *    for any other make.
 *  - `verified` is true only for data checked against a reliable, recorded source.
 *  - A code with no definition on file is reported as such. It is never handed to
 *    the AI model as something to explain.
 *
 * This module is pure (no network, no database) and safe to import anywhere.
 * Where the data comes from is declared in `app/data/dtc/sources.ts`.
 */
import { DTC_SOURCES } from "../data/dtc/sources";

/* ───────────────────────────── classification ───────────────────────────── */

export type CodeSystem = "Powertrain" | "Body" | "Chassis" | "Network";

/**
 * Who defines what a code means.
 *  - "generic": the block is controlled by ISO/SAE, so a code in it has one
 *    meaning on every make.
 *  - "manufacturer": the block is left to each vehicle maker.
 *  - "uncertain": this could not be established safely. Treated as unknown.
 */
export type CodeScope = "generic" | "manufacturer" | "uncertain";

export type CodeClass =
  | { valid: true; code: string; format: "obd2"; scope: CodeScope; system: CodeSystem }
  | { valid: true; code: string; format: "oem"; scope: "manufacturer"; system: null }
  | { valid: false; code: string };

const SYSTEMS: Record<string, CodeSystem> = { P: "Powertrain", B: "Body", C: "Chassis", U: "Network" };

/** OBD-II layout: a system letter, a digit 0-3, then three hexadecimal characters (P0A80 is valid). */
const OBD2_RE = /^([PBCU])([0-3])([0-9A-F]{3})$/;
/** Maker's own numbering as shown by make-specific scan tools, e.g. BMW "480A12". */
const OEM_RE = /^[0-9A-F]{4,6}$/;

/** One classification rule: an inclusive range of the four characters after the letter, read as hexadecimal. */
export type ScopeRule = { letter: "P" | "B" | "C" | "U"; from: number; to: number; scope: CodeScope };

/**
 * PROVENANCE AND LIMITS OF THESE RULES. Read before relying on them.
 *
 * These rules are an implementation assumption, NOT verified data. They were
 * not taken from SAE J2012 or its Digital Annex (J2012-DA; the revision current
 * when this was written was J2012DA_202607). Those are paid, licensed documents
 * that this project does not hold, and nothing here is copied from them.
 *
 * The table restates only the block-level layout that freely available
 * descriptions of the standard agree on:
 *
 *   second character 0   ISO/SAE controlled        P0, B0, C0, U0
 *   second character 1   manufacturer controlled   P1, B1, C1, U1
 *   second character 2   P2 ISO/SAE controlled; B2, C2, U2 manufacturer controlled
 *   second character 3   mixed or reserved         P3, B3, C3, U3
 *
 * Group 3 is where public information stops being safe to build on:
 *   - P3 and U3 are described as partly manufacturer controlled and partly
 *     reserved for ISO/SAE. Public summaries either do not give the exact
 *     sub-ranges or disagree about them (for example whether the P3 split falls
 *     at P3400, and how it extends to hexadecimal values).
 *   - B3 and C3 are described as reserved by the standard.
 * Every group-3 code is therefore classified "uncertain" rather than declared
 * standardized or manufacturer-specific.
 *
 * Assumptions that remain, to be checked against licensed J2012 data:
 *   - no sub-range inside P0, P2, B0, C0 or U0 is manufacturer controlled, and
 *     none inside P1, B1, B2, C1, C2, U1 or U2 is standardized;
 *   - the last three characters are hexadecimal, which is what makes hybrid/EV
 *     codes such as P0A80 ordinary P0 codes.
 * "ISO/SAE controlled" means the standard owns the number. It does not mean
 * every number in the block has been given a definition.
 *
 * Replacing these rules: a registry can carry its own rule table (see
 * `buildRegistry`), and ranges may be as fine as needed, so licensed data can
 * later refine or replace this table without changes to the lookup code.
 * Independently of the rules, a verified record from a licensed source settles
 * a code that the rules leave uncertain.
 */
export const PUBLIC_SCOPE_RULES: ScopeRule[] = [
  { letter: "P", from: 0x0000, to: 0x0fff, scope: "generic" },
  { letter: "P", from: 0x1000, to: 0x1fff, scope: "manufacturer" },
  { letter: "P", from: 0x2000, to: 0x2fff, scope: "generic" },
  { letter: "P", from: 0x3000, to: 0x3fff, scope: "uncertain" },
  { letter: "B", from: 0x0000, to: 0x0fff, scope: "generic" },
  { letter: "B", from: 0x1000, to: 0x2fff, scope: "manufacturer" },
  { letter: "B", from: 0x3000, to: 0x3fff, scope: "uncertain" },
  { letter: "C", from: 0x0000, to: 0x0fff, scope: "generic" },
  { letter: "C", from: 0x1000, to: 0x2fff, scope: "manufacturer" },
  { letter: "C", from: 0x3000, to: 0x3fff, scope: "uncertain" },
  { letter: "U", from: 0x0000, to: 0x0fff, scope: "generic" },
  { letter: "U", from: 0x1000, to: 0x2fff, scope: "manufacturer" },
  { letter: "U", from: 0x3000, to: 0x3fff, scope: "uncertain" },
];

/**
 * Classify one already-normalised code (uppercase, no separators).
 * A code that no rule covers is "uncertain", never assumed to be either kind.
 */
export function classifyCode(code: string, rules: ScopeRule[] = PUBLIC_SCOPE_RULES): CodeClass {
  const obd2 = OBD2_RE.exec(code);
  if (obd2) {
    const value = parseInt(obd2[2] + obd2[3], 16);
    const rule = rules.find((r) => r.letter === obd2[1] && value >= r.from && value <= r.to);
    return { valid: true, code, format: "obd2", scope: rule ? rule.scope : "uncertain", system: SYSTEMS[obd2[1]] };
  }
  // Not in the OBD-II layout at all, so it cannot be a standardized code.
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
 * "verified": taken from, and checked against, a reliable recorded source that
 *   we are licensed to use (for example SAE J2012-DA, or a maker's own service
 *   information).
 * "curated": a title entered by hand for a very small set of common codes. It
 *   is shown as a standard definition, but is NOT reported as verified.
 */
export type Verification = "verified" | "curated";

export type GenericDtc = { code: string; title: string; description?: string; source: string; verification: Verification };

export type ManufacturerDtc = {
  code: string;
  /** The make this definition belongs to. It is never served for another make. */
  make: string;
  definition: string;
  description?: string;
  /** Where the definition comes from, e.g. the document or dataset name and version. */
  source: string;
  sourceType: "oem_service_information" | "licensed_dataset" | "regulatory_filing" | "other";
  /** Only "verified" records are ever served; anything else is ignored. */
  verification: "verified" | "unverified";
  // Optional narrowing. Not used to pick a record yet: see the note in lookupCode.
  model?: string;
  yearFrom?: number;
  yearTo?: number;
  chassis?: string;
  engine?: string;
  module?: string;
};

/**
 * A set of records from one provider. There are two roles, and a source has
 * exactly one of them:
 *  - "standardized": definitions of ISO/SAE controlled codes, the same for every
 *    make. The intended provider is licensed SAE J2012-DA data.
 *  - "manufacturer": definitions that belong to one make. The intended provider
 *    is a licensed OEM data supplier (for example MOTOR) or the makers' own
 *    service information.
 */
export type DtcDataSource =
  | { id: string; role: "standardized"; provider: string; licence: string; records: GenericDtc[] }
  | { id: string; role: "manufacturer"; provider: string; licence: string; records: ManufacturerDtc[] };

export type DtcRegistry = {
  generic: GenericDtc[];
  manufacturer: ManufacturerDtc[];
  /** Classification rules to use with this data. Defaults to PUBLIC_SCOPE_RULES. */
  scopeRules?: ScopeRule[];
};

export type RejectedRecord = { sourceId: string; code: string; reason: string };

const normMake = (make: string | null | undefined) => (make || "").trim().toLowerCase().replace(/[\s-]+/g, " ");
const hasText = (value: unknown) => typeof value === "string" && value.trim().length > 0;

/**
 * Combine data sources into the registry the lookup reads. This is the only
 * place new data enters, so adding a licensed source means adding a source
 * entry, not changing the lookup.
 *
 * Sources are listed in priority order: for a standardized code, the first
 * source that defines it wins. A record that fails a check is left out and
 * reported in `rejected`; it is never served.
 */
export function buildRegistry(
  sources: DtcDataSource[],
  scopeRules: ScopeRule[] = PUBLIC_SCOPE_RULES,
): { registry: DtcRegistry; rejected: RejectedRecord[] } {
  const generic: GenericDtc[] = [];
  const manufacturer: ManufacturerDtc[] = [];
  const rejected: RejectedRecord[] = [];
  const seenGeneric = new Set<string>();

  for (const src of sources) {
    for (const rec of src.records) {
      const code = String(rec.code ?? "").trim().toUpperCase();
      const cls = classifyCode(code, scopeRules);
      let problem: string | null = null;

      if (!cls.valid) problem = "not a valid code";
      else if (!hasText(rec.source)) problem = "no source recorded";
      else if (src.role === "standardized") {
        const r = rec as GenericDtc;
        if (cls.scope === "manufacturer") problem = "manufacturer-specific code in a standardized source";
        else if (r.verification !== "verified" && r.verification !== "curated") problem = "unknown verification status";
        // Only a licensed, verified record may settle a code the rules leave uncertain.
        else if (cls.scope === "uncertain" && r.verification !== "verified") problem = "range not established as standardized";
        else if (!hasText(r.title)) problem = "no definition";
        else if (seenGeneric.has(code)) problem = "already defined by a higher-priority source";
        else {
          seenGeneric.add(code);
          generic.push({ ...r, code });
        }
      } else {
        const r = rec as ManufacturerDtc;
        if (cls.scope === "generic") problem = "standardized code in a manufacturer source";
        else if (!hasText(r.make)) problem = "no make recorded";
        else if (!hasText(r.definition)) problem = "no definition";
        else if (r.verification !== "verified") problem = "not verified";
        else manufacturer.push({ ...r, code });
      }

      if (problem) rejected.push({ sourceId: src.id, code, reason: problem });
    }
  }
  return { registry: { generic, manufacturer, scopeRules }, rejected };
}

export const DEFAULT_REGISTRY: DtcRegistry = buildRegistry(DTC_SOURCES).registry;

/* ──────────────────────────────── lookup ────────────────────────────────── */

export type DtcStatus =
  /** Standardized code with a definition on file. */
  | "generic_definition"
  /** Appears to be a standardized code, but no definition is on file: "Definition not verified yet". */
  | "generic_unverified"
  /** Manufacturer-specific code with a verified definition for this make. */
  | "manufacturer_definition"
  /** Manufacturer-specific code with no verified definition for this make. */
  | "manufacturer_unavailable"
  /** No definition on file, and it is not known whether the code is standardized or manufacturer-specific. */
  | "uncertain_unavailable"
  /** Not a valid trouble code. */
  | "invalid";

export type DtcResult = {
  code: string;
  status: DtcStatus;
  /** How the code was classified. "generic" here is an assumption unless a definition is on file. */
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
  const cls = classifyCode(code, registry.scopeRules);
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

  // A standardized definition is never served for a manufacturer-specific code.
  // A hand-entered ("curated") title only counts inside a block the rules call
  // standardized; a verified record may also settle a code the rules leave uncertain.
  if (cls.scope !== "manufacturer") {
    const hit = registry.generic.find((g) => g.code === code && (cls.scope === "generic" || g.verification === "verified"));
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
  }

  if (cls.scope === "generic") {
    return {
      code,
      status: "generic_unverified",
      scope: "generic",
      system: cls.system,
      definition: null,
      make: null,
      source: null,
      verified: false,
      message: "Definition not verified yet. CarCode AI doesn't have a trusted definition for this code, so we won't guess what it means.",
    };
  }

  // Manufacturer-specific (or uncertain): only verified records for THIS make count.
  // Records can be narrowed by model, year, engine and so on, but the lookup does
  // not know the vehicle in that detail yet. So if this make has more than one
  // meaning on file for the code, none is served rather than picking one.
  const wanted = normMake(makeLabel);
  const hits = wanted
    ? registry.manufacturer.filter((m) => m.code === code && m.verification === "verified" && normMake(m.make) === wanted)
    : [];
  const hit = hits.length > 0 && hits.every((m) => m.definition === hits[0].definition) ? hits[0] : undefined;
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

  if (cls.scope === "uncertain") {
    return {
      code,
      status: "uncertain_unavailable",
      scope: "uncertain",
      system: cls.system,
      definition: null,
      make: makeLabel,
      source: null,
      verified: false,
      message:
        "Definition not verified yet. CarCode AI can't confirm whether this is a standard code or a manufacturer-specific one, and doesn't have a trusted definition for it, so we won't guess what it means.",
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

/**
 * True when the code has a definition on file. Only these codes give the
 * diagnosis something to reason from; every other code is reported to the
 * user but is not, on its own, a reason to call the AI model.
 */
export function hasDefinitionOnFile(r: DtcResult): boolean {
  return (r.status === "generic_definition" || r.status === "manufacturer_definition") && r.definition !== null;
}

/* ─────────────────────────────── AI prompt ──────────────────────────────── */

const DO_NOT_GUESS = "Do NOT state, guess, invent or imply what this code means, and do not treat any meaning you recall for it as fact.";

/**
 * What the model is told about each code. The wording is deliberate: the model
 * is given an exact definition only when one is on file. For every other code
 * it is told the definition is unavailable and that it must not supply one.
 */
export function describeCodesForPrompt(results: DtcResult[], make: string): string {
  const vehicleMake = make.trim() || "this vehicle";
  return results
    .map((r) => {
      switch (r.status) {
        case "generic_definition":
          return `- ${r.code}: standardized code (same meaning on every make). Definition on file: "${r.definition}". Use this definition exactly; do not reword or replace it.`;
        case "generic_unverified":
          return `- ${r.code}: the exact definition of this code is NOT available. ${DO_NOT_GUESS} Base the diagnosis only on the reported symptoms and the vehicle, and recommend confirming the code's definition with a scan tool or service information.`;
        case "manufacturer_definition":
          return `- ${r.code}: ${r.make}-specific code. Verified definition for ${r.make}: "${r.definition}". This definition applies to ${r.make} only. Use it exactly.`;
        case "manufacturer_unavailable":
          return `- ${r.code}: manufacturer-specific code. Its exact meaning for ${vehicleMake} is NOT available. ${DO_NOT_GUESS} Do not use the meaning it has on any other make. Base the diagnosis only on the reported symptoms and the vehicle, and recommend reading the code with a ${vehicleMake}-capable scan tool or ${vehicleMake} service information.`;
        case "uncertain_unavailable":
          return `- ${r.code}: the exact definition of this code is NOT available, and it is not known whether it is a standardized or a manufacturer-specific code. ${DO_NOT_GUESS} Base the diagnosis only on the reported symptoms and the vehicle, and recommend reading the code with a ${vehicleMake}-capable scan tool or ${vehicleMake} service information.`;
        case "invalid":
          return `- ${r.code}: not a valid trouble code. Ignore it.`;
      }
    })
    .join("\n");
}
