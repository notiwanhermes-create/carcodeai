import { NextResponse } from "next/server";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const modelsCache = new Map<string, { list: string[]; time: number }>();

/** Normalize for display/comparison: trim, lowercase */
function normalize(s: string) {
  return s.trim().toLowerCase();
}

/** Key for matching makes: "Land Rover" / "LAND ROVER" / "Landrover" → "landrover" */
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const makeRaw = (searchParams.get("make") ?? "").trim();
  const make = makeRaw;
  const year = (searchParams.get("year") ?? "").trim();
  const qRaw = (searchParams.get("q") ?? "").trim();
  const q = normalize(qRaw);

  if (!make) return NextResponse.json({ models: [] });

  const cacheKey = `${makeKey(make)}|${year}`;

  try {
    let unique: string[];

    const cached = modelsCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.time < CACHE_TTL_MS) {
      unique = cached.list;
    } else {
      const url = year
        ? `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(
            make
          )}/modelyear/${encodeURIComponent(year)}?format=json`
        : `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMake/${encodeURIComponent(
            make
          )}?format=json`;

      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return NextResponse.json({ models: [] });

      const data = await r.json();
      const all: string[] = (data?.Results ?? [])
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
