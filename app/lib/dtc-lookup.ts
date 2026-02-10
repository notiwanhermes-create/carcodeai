import dtcDatabase from "../data/dtc-database.json";

const DTC_REGEX = /\b([PBCU]\d{4})\b/gi;

const db = dtcDatabase as Record<string, string>;

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

export function lookupDtc(code: string): DtcLookupResult {
  const normalized = code.toUpperCase().trim();
  const title = db[normalized];
  if (title) {
    return { code: normalized, title, found: true };
  }
  const prefix = normalized[0];
  const labels: Record<string, string> = {
    P: "Powertrain",
    B: "Body",
    C: "Chassis",
    U: "Network/Communication",
  };
  const category = labels[prefix] || "Unknown";
  const isManufacturer = normalized.length === 5 && ["1", "2", "3"].includes(normalized[1]);
  const fallbackTitle = isManufacturer
    ? `Manufacturer-Specific ${category} Code`
    : `Unknown ${category} Code`;
  return { code: normalized, title: fallbackTitle, found: false };
}

export function lookupMultipleDtc(codes: string[]): DtcLookupResult[] {
  return codes.map(lookupDtc);
}
