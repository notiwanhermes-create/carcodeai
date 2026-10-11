/**
 * Server-side VIN lookup against NHTSA vPIC (US-market data). Network code
 * lives here; the pure helpers are in `vin.ts`.
 */
import { canonicalMakeName } from "../data/vehicle-makes";
import { isValidVinFormat, vinAttributesFromRow, type VinAttributes } from "./vin";

export type VinRow = Record<string, unknown>;

/**
 * NHTSA's decoded fields for one full 17-character VIN, or null when the
 * service is unreachable, slow or answers with an error. Never throws.
 */
export async function fetchVinRow(vin: string, timeoutMs: number): Promise<VinRow | null> {
  if (!isValidVinFormat(vin)) return null;
  try {
    const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`, {
      // A VIN always decodes to the same vehicle.
      next: { revalidate: 60 * 60 * 24 * 30 },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { Results?: VinRow[] };
    return data.Results?.[0] ?? {};
  } catch {
    return null;
  }
}

const text = (v: unknown) => String(v ?? "").trim();

/**
 * Extra vehicle details for a diagnosis, decoded from the saved VIN.
 *
 * Best effort: any failure returns null and the diagnosis goes ahead without
 * them. The details are used only when the VIN decodes to the same year and
 * make the user is diagnosing, so a VIN left over from another car can never
 * attach the wrong facts to this one.
 */
export async function vinAttributesForVehicle(
  vin: string,
  vehicle: { year: string; make: string },
  timeoutMs = 2500,
): Promise<VinAttributes | null> {
  if (!vin) return null;
  const row = await fetchVinRow(vin, timeoutMs);
  if (!row) return null;

  const sameYear = text(row.ModelYear) === vehicle.year;
  const sameMake = canonicalMakeName(text(row.Make)).toLowerCase() === canonicalMakeName(vehicle.make).toLowerCase();
  if (!sameYear || !sameMake) return null;

  const attributes = vinAttributesFromRow(row);
  return Object.keys(attributes).length > 0 ? attributes : null;
}
