import { NextResponse } from "next/server";

const PASSENGER_CAR_URL =
  "https://vpic.nhtsa.dot.gov/api/vehicles/GetMakesForVehicleType/passenger%20car?format=json";
const ALL_MAKES_URL = "https://vpic.nhtsa.dot.gov/api/vehicles/GetAllMakes?format=json";

function normalize(s: string) {
  return s.trim().toLowerCase();
}

/** Diagnostic: returns raw makes from NHTSA (passenger car + full list) and match hits for q.
 *  Proves whether a make (e.g. Land Rover) is missing from passenger car list. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const qRaw = (searchParams.get("q") ?? "").trim();
  const q = normalize(qRaw);

  try {
    const [passengerRes, allRes] = await Promise.all([
      fetch(PASSENGER_CAR_URL, { cache: "no-store" }),
      fetch(ALL_MAKES_URL, { cache: "no-store" }),
    ]);

    const passengerData = passengerRes.ok ? await passengerRes.json() : { Results: [] };
    const allData = allRes.ok ? await allRes.json() : { Results: [] };

    const passengerMakes: string[] = (passengerData?.Results ?? [])
      .map((x: { MakeName?: string; Make_Name?: string }) =>
        String(x?.MakeName ?? x?.Make_Name ?? "").trim()
      )
      .filter(Boolean);
    const allMakes: string[] = (allData?.Results ?? [])
      .map((x: { Make_Name?: string }) => String(x?.Make_Name ?? "").trim())
      .filter(Boolean);

    const first200Passenger = passengerMakes.slice(0, 200);
    const first200All = allMakes.slice(0, 200);

    const matchPassenger = q ? passengerMakes.filter((m) => normalize(m).includes(q)) : [];
    const matchAll = q ? allMakes.filter((m) => normalize(m).includes(q)) : [];

    return NextResponse.json({
      source: "NHTSA vPIC",
      passengerCarCount: passengerMakes.length,
      allMakesCount: allMakes.length,
      first200Passenger,
      first200All,
      query: q || null,
      matchInPassengerCar: matchPassenger,
      matchInAllMakes: matchAll,
    });
  } catch (e) {
    return NextResponse.json(
      { error: String(e), message: "Diagnostic fetch failed" },
      { status: 500 }
    );
  }
}
