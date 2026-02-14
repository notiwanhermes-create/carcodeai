import { NextResponse } from "next/server";

const CACHE_TTL_MS = 10 * 60 * 1000;
const modelsCache = new Map<string, { list: string[]; time: number }>();

function normalize(s: string) {
  return s.trim().toLowerCase();
}

function makeKey(s: string) {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function scoreModel(name: string, q: string) {
  const n = normalize(name);
  if (n === q) return 1000;
  if (n.startsWith(q)) return 700;
  if (n.includes(` ${q}`) || n.includes(`-${q}`)) return 500;
  if (n.includes(q)) return 200;
  return 0;
}

const CAR_VEHICLE_TYPE_IDS = new Set([2, 7, 10]);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const makeRaw = (searchParams.get("make") ?? "").trim();
  const make = makeRaw;
  const makeIdRaw = (searchParams.get("makeId") ?? "").trim();
  const makeId = makeIdRaw ? Number(makeIdRaw) : undefined;
  const year = (searchParams.get("year") ?? "").trim();
  const qRaw = (searchParams.get("q") ?? "").trim();
  const q = normalize(qRaw);

  if (!make && !makeId) return NextResponse.json({ models: [] });

  const cacheKey = makeId ? `makeId:${makeId}|${year}` : `${makeKey(make)}|${year}`;

  try {
    let unique: string[];

    const cached = modelsCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.time < CACHE_TTL_MS) {
      unique = cached.list;
    } else {
      let url: string;
      if (makeId) {
        url = year
          ? `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeIdYear/makeId/${encodeURIComponent(
              String(makeId)
            )}/modelyear/${encodeURIComponent(year)}?format=json`
          : `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeId/makeId/${encodeURIComponent(
              String(makeId)
            )}?format=json`;
      } else {
        url = year
          ? `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(
              make
            )}/modelyear/${encodeURIComponent(year)}/vehicletype/passenger%20car?format=json`
          : `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(
              make
            )}/vehicletype/passenger%20car?format=json`;
      }

      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return NextResponse.json({ models: [] });

      const data = await r.json();
      const results: any[] = data?.Results ?? [];

      const all: string[] = results
        .filter((x: any) => {
          if (year) return true;
          const vtId = x?.VehicleTypeId;
          if (!vtId) return true;
          return CAR_VEHICLE_TYPE_IDS.has(vtId);
        })
        .map((x: { Model_Name?: string; ModelName?: string }) =>
          String(x?.Model_Name ?? x?.ModelName ?? "").trim()
        )
        .filter(Boolean);
      unique = Array.from(new Set(all)).sort((a, b) => a.localeCompare(b));
      modelsCache.set(cacheKey, { list: unique, time: now });
    }

    if (!q) {
      return NextResponse.json({ models: unique });
    }

    const filtered = unique.filter((name) => normalize(name).includes(q));
    const ranked = filtered
      .map((name) => ({ name, s: scoreModel(name, q) }))
      .sort((a, b) => b.s - a.s || a.name.localeCompare(b.name))
      .map((x) => x.name);

    return NextResponse.json({ models: ranked });
  } catch {
    return NextResponse.json({ models: [] });
  }
}
