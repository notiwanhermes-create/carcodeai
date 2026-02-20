import { NextResponse } from "next/server";

const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: { items: { id: number; name: string }[]; time: number } | null = null;

/** Popular makes to pin at top when no search query (case-insensitive match). */
const POPULAR_MAKES = [
  "Toyota", "Honda", "Ford", "Chevrolet", "Nissan", "BMW", "Mercedes-Benz",
  "Volkswagen", "Hyundai", "Kia", "Jeep", "GMC", "Ram", "Subaru", "Mazda",
  "Audi", "Lexus", "Dodge", "Cadillac", "Tesla",
].map((n) => n.toLowerCase());

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

async function fetchAllMakesFromNHTSA(): Promise<{ id: number; name: string }[]> {
  const url = "https://vpic.nhtsa.dot.gov/api/vehicles/GetAllMakes?format=json";
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return [];
  const data = await r.json();
  const results: any[] = data?.Results ?? [];
  return results
    .map((x: any) => ({
      id: Number(x?.MakeId ?? x?.Make_ID ?? 0),
      name: String(x?.MakeName ?? x?.Make_Name ?? "").trim(),
    }))
    .filter((x) => x.id > 0 && x.name);
}

async function getAllMakes(): Promise<{ id: number; name: string }[]> {
  const now = Date.now();
  if (cache && now - cache.time < CACHE_TTL_MS) return cache.items;

  const all = await fetchAllMakesFromNHTSA();
  const byId = new Map<number, { id: number; name: string }>();
  for (const m of all) {
    if (m.id && !byId.has(m.id)) byId.set(m.id, m);
  }
  const unique = Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  cache = { items: unique, time: now };
  return unique;
}

function pinPopularAtTop(items: { id: number; name: string }[]): { id: number; name: string }[] {
  const popular: { id: number; name: string }[] = [];
  const rest: { id: number; name: string }[] = [];
  const seen = new Set<string>();
  for (const m of items) {
    const key = normalize(m.name);
    if (POPULAR_MAKES.includes(key) && !seen.has(key)) {
      popular.push(m);
      seen.add(key);
    } else {
      rest.push(m);
    }
  }
  popular.sort((a, b) => a.name.localeCompare(b.name));
  return [...popular, ...rest];
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const qRaw = searchParams.get("q") ?? "";
  const q = normalize(qRaw);

  try {
    const all = await getAllMakes();

    if (!q) {
      const withPopularFirst = pinPopularAtTop(all);
      return NextResponse.json({ makes: withPopularFirst });
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
