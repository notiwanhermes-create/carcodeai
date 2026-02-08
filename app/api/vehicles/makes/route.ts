import { NextResponse } from "next/server";

function normalize(s: string) {
  return s.trim().toLowerCase();
}

function scoreMake(name: string, q: string) {
  const n = normalize(name);

  if (n === q) return 1000;        // exact
  if (n.startsWith(q)) return 700; // prefix
  if (n.includes(` ${q}`) || n.includes(`-${q}`)) return 500; // word-ish
  if (n.includes(q)) return 200;   // contains
  return 0;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const qRaw = searchParams.get("q") ?? "";
  const q = normalize(qRaw);

  // optional: when empty, return common makes (fast)
  if (!q) {
    return NextResponse.json({
      makes: [
        "HONDA",
        "TOYOTA",
        "FORD",
        "CHEVROLET",
        "NISSAN",
        "BMW",
        "MERCEDES-BENZ",
        "VOLKSWAGEN",
        "HYUNDAI",
        "KIA",
      ],
    });
  }

  try {
    // Cars only (passenger car vehicle type)
    const r = await fetch(
      "https://vpic.nhtsa.dot.gov/api/vehicles/GetMakesForVehicleType/passenger%20car?format=json",
      { cache: "no-store" }
    );

    if (!r.ok) return NextResponse.json({ makes: [] });

    const data = await r.json();

    // vPIC Results commonly: [{ MakeId, MakeName }, ...]
    const all: string[] = (data?.Results ?? [])
      .map((x: any) => String(x?.MakeName ?? x?.Make_Name ?? "").trim())
      .filter(Boolean);

    const filtered = all.filter((name) => normalize(name).includes(q));

    const ranked = filtered
      .map((name) => ({ name, s: scoreMake(name, q) }))
      .sort((a, b) => b.s - a.s || a.name.localeCompare(b.name))
      .map((x) => x.name);

    // de-dupe + limit
    const unique: string[] = [];
    for (const m of ranked) {
      if (!unique.includes(m)) unique.push(m);
      if (unique.length >= 50) break;
    }

    return NextResponse.json({ makes: unique });
  } catch {
    return NextResponse.json({ makes: [] });
  }
}
