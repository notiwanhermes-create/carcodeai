import { NextResponse } from "next/server";

const NHTSA = "https://vpic.nhtsa.dot.gov/api/vehicles";
/** Cars, SUVs/minivans and pickups. Motorcycles, trailers, buses etc. are left out. */
const VEHICLE_TYPES = ["passenger car", "multipurpose passenger vehicle (mpv)", "truck"];

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const UPSTREAM_TIMEOUT_MS = 8000;
const modelsCache = new Map<string, { list: string[]; time: number }>();

function normalize(s: string) {
  return s.trim().toLowerCase();
}

function scoreModel(name: string, q: string) {
  const n = normalize(name);
  if (n === q) return 1000;
  if (n.startsWith(q)) return 700;
  if (n.includes(` ${q}`) || n.includes(`-${q}`)) return 500;
  if (n.includes(q)) return 200;
  return 0;
}

type NhtsaModelRow = { Make_Name?: unknown; Model_Name?: unknown };

/**
 * Models for one make (and optional year) across the three vehicle types.
 * NHTSA matches make names loosely ("ford" also returns other manufacturers
 * with "ford" in their name), so rows are kept only when the make matches exactly.
 * Returns null when NHTSA could not be reached at all.
 */
async function fetchModels(make: string, year: string): Promise<string[] | null> {
  const wantedMake = make.trim().toUpperCase();
  const base = `${NHTSA}/GetModelsForMakeYear/make/${encodeURIComponent(make)}`;
  const urls = VEHICLE_TYPES.map((type) =>
    year
      ? `${base}/modelyear/${encodeURIComponent(year)}/vehicletype/${encodeURIComponent(type)}?format=json`
      : `${base}/vehicletype/${encodeURIComponent(type)}?format=json`,
  );

  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      const r = await fetch(url, { next: { revalidate: 86400 }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`NHTSA responded ${r.status}`);
      const data = (await r.json()) as { Results?: NhtsaModelRow[] };
      return data.Results ?? [];
    }),
  );

  if (settled.every((s) => s.status === "rejected")) return null;

  const names = new Set<string>();
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const row of s.value) {
      if (String(row.Make_Name ?? "").trim().toUpperCase() !== wantedMake) continue;
      const name = String(row.Model_Name ?? "").trim();
      if (name) names.add(name);
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const make = (searchParams.get("make") ?? "").trim().slice(0, 60);
  const yearRaw = (searchParams.get("year") ?? "").trim();
  const year = /^\d{4}$/.test(yearRaw) ? yearRaw : "";
  const q = normalize((searchParams.get("q") ?? "").slice(0, 60));

  if (!make) return NextResponse.json({ models: [] });

  const cacheKey = `${make.toUpperCase()}|${year}`;
  const now = Date.now();
  const cached = modelsCache.get(cacheKey);

  let list: string[];
  if (cached && now - cached.time < CACHE_TTL_MS) {
    list = cached.list;
  } else {
    let fetched: string[] | null = null;
    try {
      fetched = await fetchModels(make, year);
    } catch {
      fetched = null;
    }
    if (fetched === null) {
      // The form lets people type a model, so an outage degrades to "no suggestions".
      return NextResponse.json({ models: [], unavailable: true });
    }
    list = fetched;
    if (modelsCache.size >= CACHE_MAX_ENTRIES) modelsCache.clear();
    modelsCache.set(cacheKey, { list, time: now });
  }

  if (!q) return NextResponse.json({ models: list });

  const ranked = list
    .map((name) => ({ name, s: scoreModel(name, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((x) => x.name);

  return NextResponse.json({ models: ranked });
}
