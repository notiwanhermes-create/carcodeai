import { NextResponse } from "next/server";

const VEHICLE_TYPES = [
  "passenger%20car",
  "multipurpose%20passenger%20vehicle%20(MPV)",
  "truck",
] as const;

const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: { items: { id: number; name: string }[]; time: number } | null = null;

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

async function fetchMakesForType(type: string) {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/GetMakesForVehicleType/${type}?format=json`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return [];
  const data = await r.json();

  // NHTSA commonly returns MakeId/MakeName (sometimes Make_ID/Make_Name)
  const items: { id: number; name: string }[] = (data?.Results ?? [])
    .map((x: any) => ({
      id: Number(x?.MakeId ?? x?.Make_ID ?? 0),
      name: String(x?.MakeName ?? x?.Make_Name ?? "").trim(),
    }))
    .filter((x: any) => x.id > 0 && x.name);

  return items;
}

async function getAllMakes() {
  const now = Date.now();
  if (cache && now - cache.time < CACHE_TTL_MS) return cache.items;

  const lists = await Promise.all(VEHICLE_TYPES.map((t) => fetchMakesForType(t)));
  const merged = lists.flat();

  // de-dupe by id (best) fallback by normalized name
  const byId = new Map<number, { id: number; name: string }>();
  const byName = new Map<string, { id: number; name: string }>();

  for (const m of merged) {
    if (m.id && !byId.has(m.id)) byId.set(m.id, m);
    else if (!m.id) {
      const key = normalize(m.name);
      if (!byName.has(key)) byName.set(key, m);
    }
  }

  const unique = Array.from(byId.values())
    .concat(Array.from(byName.values()))
    .sort((a, b) => a.name.localeCompare(b.name));

  cache = { items: unique, time: now };
  return unique;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const qRaw = searchParams.get("q") ?? "";
  const q = normalize(qRaw);

  try {
    const all = await getAllMakes();

    if (!q) {
      // keep response backwards compatible if UI expects strings:
      // return NextResponse.json({ makes: all.map(m => m.name) });
      return NextResponse.json({ makes: all }); // [{id,name}]
    }

    const ranked = all
      .map((m) => ({ m, s: scoreMake(m.name, q) }))
      .filter((x) => x.s > 0 || normalize(x.m.name).includes(q))
      .sort((a, b) => b.s - a.s || a.m.name.localeCompare(b.m.name))
      .map((x) => x.m);

    return NextResponse.json({ makes: ranked });
  } catch (e) {
    return NextResponse.json({ makes: [] }, { status: 200 });
  }
}
