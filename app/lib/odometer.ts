/**
 * Odometer readings: how they are shown, and when a vehicle's current reading
 * may change. Pure functions: no database, no network.
 *
 * A reading is a whole number plus a unit, "km" or "mi". The unit can be
 * unknown (older records where the user typed only a number): it is then left
 * out, never guessed.
 */

export type OdometerUnit = "km" | "mi";
export type OdometerReading = { value: number; unit: OdometerUnit | null };

export function isOdometerUnit(value: unknown): value is OdometerUnit {
  return value === "km" || value === "mi";
}

/** The largest reading accepted anywhere in the app. */
export const MAX_ODOMETER = 9_999_999;

/** A whole number from 0 to MAX_ODOMETER, from a number or digits-only text. Anything else is null. */
export function parseOdometerValue(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 && raw <= MAX_ODOMETER ? raw : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/,/g, "");
  if (!/^[0-9]{1,7}$/.test(text)) return null;
  return Number(text);
}

/**
 * Text for a reading.
 *   value + unit      → "130,250 km"
 *   value, no unit    → "130,250"          (the unit is not guessed)
 *   no value, text    → the text as typed  (older free-text entries such as "about 90k")
 *   nothing           → ""
 */
export function formatOdometer(
  value: number | null | undefined,
  unit: string | null | undefined,
  originalText?: string | null,
): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const number = value.toLocaleString("en-US");
    return isOdometerUnit(unit) ? `${number} ${unit}` : number;
  }
  return (originalText ?? "").trim();
}

export type MileageDecision =
  /** Store the new reading. */
  | { action: "set" }
  /** Nothing to do: it is the reading already on file. */
  | { action: "keep" }
  /** Storing it needs the user to confirm, and why. */
  | { action: "confirm"; reason: "lower" | "unit_change" };

/**
 * Should `next` replace `current` as a vehicle's reading?
 *
 * A higher reading in the same unit is simply stored. A lower one, or one in
 * the other unit (which cannot be compared without guessing), is stored only
 * when the user has confirmed it, so a typing slip cannot silently wind a
 * vehicle's mileage back, and a real correction is still possible.
 */
export function decideMileageUpdate(
  current: OdometerReading | null,
  next: OdometerReading,
  confirmed = false,
): MileageDecision {
  if (!current) return { action: "set" };
  const unitsDiffer = current.unit !== null && next.unit !== null && current.unit !== next.unit;
  if (unitsDiffer) return confirmed ? { action: "set" } : { action: "confirm", reason: "unit_change" };
  if (next.value === current.value) {
    // Same number: only worth storing if it adds a unit that was missing.
    return current.unit === null && next.unit !== null ? { action: "set" } : { action: "keep" };
  }
  if (next.value > current.value) return { action: "set" };
  return confirmed ? { action: "set" } : { action: "confirm", reason: "lower" };
}

/**
 * For readings that arrive as part of something else (a diagnosis, a service
 * record): raise the vehicle's reading when that needs no confirmation, and
 * otherwise leave it exactly as it is.
 */
export function shouldRaiseAutomatically(current: OdometerReading | null, next: OdometerReading): boolean {
  return decideMileageUpdate(current, next, false).action === "set";
}
