import { NextResponse } from "next/server";

const NHTSA_MAKES_URL =
  "https://vpic.nhtsa.dot.gov/api/vehicles/GetMakesForVehicleType/passenger%20car?format=json";

const KNOWN_CAR_MAKES = new Set([
  "ACURA", "ALFA ROMEO", "ASTON MARTIN", "AUDI",
  "BENTLEY", "BMW", "BUICK", "BYD",
  "CADILLAC", "CHEVROLET", "CHRYSLER", "CITRO\u00CBN",
  "DAEWOO", "DAIHATSU", "DODGE",
  "EAGLE",
  "FERRARI", "FIAT", "FISKER", "FORD",
  "GENESIS", "GEO", "GMC",
  "HONDA", "HUMMER", "HYUNDAI",
  "INFINITI", "ISUZU",
  "JAGUAR", "JEEP",
  "KIA", "KOENIGSEGG",
  "LAMBORGHINI", "LAND ROVER", "LEXUS", "LINCOLN", "LOTUS", "LUCID",
  "MASERATI", "MAYBACH", "MAZDA", "MCLAREN", "MERCEDES-BENZ",
  "MERCURY", "MINI", "MITSUBISHI",
  "NISSAN",
  "OLDSMOBILE", "OPEL",
  "PAGANI", "PEUGEOT", "PLYMOUTH", "POLESTAR", "PONTIAC", "PORSCHE",
  "RAM", "RENAULT", "RIVIAN", "ROLLS-ROYCE",
  "SAAB", "SATURN", "SCION", "SEAT", "SKODA", "SMART",
  "SUBARU", "SUZUKI",
  "TESLA", "TOYOTA",
  "VINFAST", "VOLKSWAGEN", "VOLVO",
]);

let allMakesCache: string[] | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 15 * 60 * 1000;

function normalize(s: string) {
  return s.trim().toLowerCase();
}

function scoreMake(name: string, q: string) {
  const n = normalize(name);
  if (n === q) return 1000;
  if (n.startsWith(q)) return 700;
  if (n.includes(` ${q}`) || n.includes(`-${q}`)) return 500;
  if (n.includes(q)) return 200;
  return 0;
}

async function fetchAllMakes(): Promise<string[]> {
  const r = await fetch(NHTSA_MAKES_URL, { cache: "no-store" });
  if (!r.ok) return Array.from(KNOWN_CAR_MAKES).sort();
  const data = await r.json();
  const all: string[] = (data?.Results ?? [])
    .map((x: { MakeName?: string; Make_Name?: string }) =>
      String(x?.MakeName ?? x?.Make_Name ?? "").trim().toUpperCase()
    )
    .filter((name: string) => name && KNOWN_CAR_MAKES.has(name));
  const unique = Array.from(new Set(all)).sort((a, b) => a.localeCompare(b));
  return unique.length > 0 ? unique : Array.from(KNOWN_CAR_MAKES).sort();
}

async function getAllMakes(): Promise<string[]> {
  const now = Date.now();
  if (allMakesCache && now - cacheTime < CACHE_TTL_MS) {
    return allMakesCache;
  }
  const makes = await fetchAllMakes();
  allMakesCache = makes;
  cacheTime = now;
  return makes;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const qRaw = searchParams.get("q") ?? "";
  const q = normalize(qRaw);

  try {
    const all = await getAllMakes();

    if (!q) {
      return NextResponse.json({ makes: all });
    }

    const filtered = all.filter((name) => normalize(name).includes(q));
    const ranked = filtered
      .map((name) => ({ name, s: scoreMake(name, q) }))
      .sort((a, b) => b.s - a.s || a.name.localeCompare(b.name))
      .map((x) => x.name);

    return NextResponse.json({ makes: ranked });
  } catch {
    return NextResponse.json({ makes: [] });
  }
}
