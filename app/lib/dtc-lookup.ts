import { getDtcDefinition } from "./dtc-definition";

const DTC_REGEX = /\b([PBCU]\d{4})\b/gi;

export interface DtcLookupResult {
  code: string;
  title: string;
  found: boolean;
}

export function extractDtcCodes(input: string): string[] {
  const matches = input.match(DTC_REGEX);
  if (!matches) return [];
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const m of matches) {
    const normalized = m.toUpperCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      codes.push(normalized);
    }
  }
  return codes;
}

const SYSTEM_LABELS: Record<string, string> = {
  P: "Powertrain",
  B: "Body",
  C: "Chassis",
  U: "Network/Communication",
};

export function lookupDtc(code: string): DtcLookupResult {
  const normalized = (code || "").toUpperCase().trim();
  const def = getDtcDefinition(normalized);
  if (def) {
    return { code: def.code, title: def.title, found: true };
  }
  const prefix = normalized[0];
  const category = SYSTEM_LABELS[prefix] || "Unknown";
  const isManufacturer = normalized.length === 5 && ["1", "2", "3"].includes(normalized[1]);
  const fallbackTitle = isManufacturer
    ? `Manufacturer-Specific ${category} Code`
    : `Unknown ${category} Code`;
  return { code: normalized, title: fallbackTitle, found: false };
}

export function lookupMultipleDtc(codes: string[]): DtcLookupResult[] {
  return codes.map(lookupDtc);
}
