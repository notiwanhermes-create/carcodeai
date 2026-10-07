/**
 * VIN helpers: format and check-digit validation, and turning NHTSA's decoded
 * fields into a short engine description. No network code here.
 */

/** 17 characters, letters and digits, never I, O or Q. */
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export function normalizeVin(raw: string | null | undefined): string {
  return (raw || "").toUpperCase().replace(/[\s-]/g, "");
}

export function isValidVinFormat(vin: string): boolean {
  return VIN_RE.test(vin);
}

const TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * North American check digit (9th character). Vehicles built for other
 * markets do not always use it, so a mismatch is a warning, not a rejection.
 */
export function vinCheckDigitValid(vin: string): boolean {
  if (!isValidVinFormat(vin)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const value = /\d/.test(ch) ? Number(ch) : TRANSLITERATION[ch];
    sum += value * WEIGHTS[i];
  }
  const remainder = sum % 11;
  return vin[8] === (remainder === 10 ? "X" : String(remainder));
}

type Row = Record<string, unknown>;

function field(row: Row, key: string): string {
  const s = String(row[key] ?? "").trim();
  if (!s || s === "0" || /^not applicable$/i.test(s)) return "";
  return s;
}

function layoutLetter(configuration: string): string {
  const c = configuration.toLowerCase();
  if (c.includes("in-line") || c.includes("inline")) return "I";
  if (c.startsWith("v")) return "V";
  if (c.includes("opposed") || c.includes("boxer") || c.includes("flat")) return "H";
  if (c.startsWith("w")) return "W";
  return "";
}

/**
 * A compact engine description from NHTSA's decoded VIN fields, for example
 * "3.0L V6 (J30A4) Gasoline", "2.0L I4 Turbo Gasoline", "2.5L I4 Hybrid" or
 * "Electric". Only uses what NHTSA actually returned.
 */
export function buildEngineDescription(row: Row): string {
  const electrification = field(row, "ElectrificationLevel").toLowerCase();
  const fuelPrimary = field(row, "FuelTypePrimary");

  if (electrification.includes("bev") || (/^electric$/i.test(fuelPrimary) && !field(row, "DisplacementL"))) {
    return "Electric";
  }

  const parts: string[] = [];

  const liters = Number(field(row, "DisplacementL"));
  if (Number.isFinite(liters) && liters > 0) parts.push(`${liters.toFixed(1)}L`);

  const cylinders = Number(field(row, "EngineCylinders"));
  const configuration = field(row, "EngineConfiguration");
  if (/rotary/i.test(configuration)) {
    parts.push("Rotary");
  } else if (Number.isFinite(cylinders) && cylinders > 0) {
    const letter = layoutLetter(configuration);
    parts.push(letter ? `${letter}${cylinders}` : `${cylinders}-cyl`);
  }

  if (/^yes$/i.test(field(row, "Turbo"))) parts.push("Turbo");

  const code = field(row, "EngineModel");
  if (code && code.length <= 24) parts.push(`(${code})`);

  if (electrification.includes("phev") || electrification.includes("plug-in")) parts.push("Plug-in Hybrid");
  else if (electrification.includes("hev") || electrification.includes("hybrid")) parts.push("Hybrid");
  else if (fuelPrimary) parts.push(fuelPrimary.replace(/\s*\(.*\)\s*$/, ""));

  return parts.join(" ").slice(0, 100);
}
