import { NextResponse } from "next/server";

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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const make = (searchParams.get("make") ?? "").trim();
  const year = (searchParams.get("year") ?? "").trim();
  const qRaw = searchParams.get("q") ?? "";
  const q = normalize(qRaw);

  if (!make) return NextResponse.json({ models: [] });

  try {
    // If year provided, use Make+Year endpoint (more accurate)
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
      .map((x: any) => String(x?.Model_Name ?? x?.ModelName ?? "").trim())
      .filter(Boolean);

    const unique = Array.from(new Set(all)).sort((a, b) => a.localeCompare(b));
    
    // If q empty, just return all models
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
