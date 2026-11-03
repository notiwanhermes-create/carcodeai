/**
 * Identifies the vehicle from the VIN the car itself reported, the way a scan
 * tool's automatic VIN detection does: the scanner reads the VIN, and the
 * app's existing decoder (`/api/vehicles/vin`, NHTSA vPIC, US-market data)
 * says what the car is. The VIN goes only to CarCode's own server, exactly as
 * when a VIN is entered in the garage. One request per VIN per page load; a
 * failure leaves the VIN shown on its own, never a guessed vehicle.
 */

export type VehicleIdentity =
  | { status: "identifying" }
  | { status: "identified"; year: string; make: string; model: string; trim: string; engine: string | null; checkDigitWarning: boolean }
  | { status: "not_identified"; reason: "not_recognized" | "unavailable" };

type VinResponse = {
  ok: boolean;
  decoded: { year: string; make: string; model: string; trim: string } | null;
  suggestions?: string[];
  code?: string;
};

const answers = new Map<string, Promise<VehicleIdentity>>();

export function identifyVehicle(vin: string): Promise<VehicleIdentity> {
  let answer = answers.get(vin);
  if (!answer) {
    answer = fetch(`/api/vehicles/vin?vin=${encodeURIComponent(vin)}`, { cache: "no-store" })
      .then(async (response): Promise<VehicleIdentity> => {
        if (!response.ok) return { status: "not_identified", reason: "unavailable" };
        const body = (await response.json()) as VinResponse;
        if (!body.ok || !body.decoded) return { status: "not_identified", reason: body.code === "unavailable" ? "unavailable" : "not_recognized" };
        const { year, make, model, trim } = body.decoded;
        return { status: "identified", year, make, model, trim, engine: body.suggestions?.[0] ?? null, checkDigitWarning: body.code === "check_digit" };
      })
      .catch((): VehicleIdentity => ({ status: "not_identified", reason: "unavailable" }))
      .then((identity) => {
        // A lookup that could not be reached is asked again on the next VIN read; an answer is kept.
        if (identity.status === "not_identified" && identity.reason === "unavailable") answers.delete(vin);
        return identity;
      });
    answers.set(vin, answer);
  }
  return answer;
}

export function identityName(identity: Extract<VehicleIdentity, { status: "identified" }>): string {
  return [identity.year, identity.make, identity.model, identity.trim].filter(Boolean).join(" ");
}
