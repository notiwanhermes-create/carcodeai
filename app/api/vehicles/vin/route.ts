import { NextResponse } from "next/server";
import { canonicalMakeName } from "@/app/data/vehicle-makes";
import { buildEngineDescription, isValidVinFormat, normalizeVin, vinCheckDigitValid } from "@/app/lib/vin";

const UPSTREAM_TIMEOUT_MS = 8000;

function clean(v: unknown) {
  const s = String(v ?? "").trim();
  if (!s || s === "0" || s.toLowerCase() === "not applicable") return "";
  return s;
}

type VinResponse = {
  ok: boolean;
  decoded: { year: string; make: string; model: string; trim: string } | null;
  /** Engine descriptions to offer in the Engine field (at most one today). */
  suggestions: string[];
  /** Machine-readable reason, so the page can show it in the user's language. */
  code?: "invalid_format" | "not_recognized" | "unavailable" | "check_digit";
};

function respond(body: VinResponse, status = 200) {
  return NextResponse.json(body, { status });
}

/**
 * Decode a full 17-character VIN with NHTSA vPIC (US-market data).
 * Partial VINs are not decoded: they produced guesses that looked authoritative.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const vin = normalizeVin(searchParams.get("vin"));

  if (!isValidVinFormat(vin)) {
    return respond({ ok: false, decoded: null, suggestions: [], code: "invalid_format" });
  }

  let row: Record<string, unknown>;
  try {
    const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`, {
      // A VIN always decodes to the same vehicle.
      next: { revalidate: 60 * 60 * 24 * 30 },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!r.ok) return respond({ ok: false, decoded: null, suggestions: [], code: "unavailable" });
    const data = (await r.json()) as { Results?: Array<Record<string, unknown>> };
    row = data.Results?.[0] ?? {};
  } catch {
    return respond({ ok: false, decoded: null, suggestions: [], code: "unavailable" });
  }

  const year = clean(row.ModelYear);
  const make = canonicalMakeName(clean(row.Make));
  const model = clean(row.Model);
  const trim = clean(row.Trim);

  if (!year || !make || !model) {
    return respond({ ok: false, decoded: null, suggestions: [], code: "not_recognized" });
  }

  const engine = buildEngineDescription(row);

  return respond({
    ok: true,
    decoded: { year, make, model, trim },
    suggestions: engine ? [engine] : [],
    // Decoded, but the 9th character does not match: usually a typo somewhere.
    ...(vinCheckDigitValid(vin) ? {} : { code: "check_digit" as const }),
  });
}
