/**
 * The scanner preview gate and the vehicle context carried to `/scanner`
 * (carcode-scanner-architecture.md, "Preview acceptance criteria" 1-3).
 *
 * The route decides at request time (`scannerPreviewEnabled`): open under
 * development or test, or with CARCODE_SCANNER_PREVIEW=1; closed for anything
 * else, a missing NODE_ENV included. The home page is static, so its entry is
 * on at once only when the build is development or test (`scannerEntryBuilt`);
 * a built site asks the route (`scanner-entry.ts`).
 *
 * The vehicle context is a label for the page and a way back. It comes from
 * the URL, so it is length-checked and never trusted: no database read, no
 * VIN, and nothing checks it against the car that answers.
 */

export function scannerPreviewEnabled(env: { NODE_ENV?: string; CARCODE_SCANNER_PREVIEW?: string } = process.env): boolean {
  return env.NODE_ENV === "development" || env.NODE_ENV === "test" || env.CARCODE_SCANNER_PREVIEW === "1";
}

/** Whether this build's gate is open whatever the flag says. Literal `process.env` reads: Next inlines them. */
export function scannerEntryBuilt(): boolean {
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
}

export type ScannerVehicle = { id: string; year: string; make: string; model: string; engine?: string };

/** `vehicle`: back to the signed-in vehicle page. `garage`: back to the home garage (guests). */
export type ScannerReturn = "vehicle" | "garage";

export type ScannerVehicleContext = ScannerVehicle & { returnTo: ScannerReturn };

const MAX_TEXT = 80;
const VEHICLE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export function scannerHref(vehicle: ScannerVehicle | null, returnTo: ScannerReturn = "garage"): string {
  if (!vehicle) return "/scanner";
  const query = new URLSearchParams({ vehicle: vehicle.id, year: vehicle.year, make: vehicle.make, model: vehicle.model, from: returnTo });
  if (vehicle.engine) query.set("engine", vehicle.engine);
  return `/scanner?${query.toString()}`;
}

function text(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_TEXT && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}

/** The context in a `/scanner` URL, or null when any required part is missing or does not fit. */
export function parseScannerVehicle(params: Record<string, string | string[] | undefined>): ScannerVehicleContext | null {
  const id = typeof params.vehicle === "string" && VEHICLE_ID.test(params.vehicle) ? params.vehicle : null;
  const year = text(params.year);
  const make = text(params.make);
  const model = text(params.model);
  if (!id || !year || !make || !model) return null;
  const engine = text(params.engine);
  return { id, year, make, model, ...(engine ? { engine } : {}), returnTo: params.from === "vehicle" ? "vehicle" : "garage" };
}

export function scannerBackLink(vehicle: ScannerVehicleContext | null): { href: string; label: string } {
  if (vehicle?.returnTo === "vehicle") return { href: `/garage/${encodeURIComponent(vehicle.id)}`, label: "Back to vehicle" };
  return { href: "/", label: "Back to garage" };
}
