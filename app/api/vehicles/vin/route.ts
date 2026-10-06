import { NextResponse } from "next/server";

function clean(v: unknown) {
  const s = String(v ?? "").trim();
  if (!s || s === "0" || s.toLowerCase() === "not applicable") return "";
  return s;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const vin = clean(searchParams.get("vin")).toUpperCase();

  // decode only when VIN is reasonably complete
  if (vin.length < 11) {
    return NextResponse.json({ ok: false, decoded: null, suggestions: [], error: "VIN too short" });
  }

  try {
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(
      vin
    )}?format=json`;

    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return NextResponse.json({ ok: false, decoded: null, suggestions: [], error: "Upstream error" });

    const data = await r.json();
    const row = data?.Results?.[0] || {};

    const year = clean(row.ModelYear);
    const make = clean(row.Make);
    const model = clean(row.Model);
    const trim = clean(row.Trim);

    // NHTSA returns values like "2.998832712": show one decimal ("3.0").
    const dispNum = Number(clean(row.DisplacementL));
    const dispL = Number.isFinite(dispNum) && dispNum > 0 ? dispNum.toFixed(1) : "";
    const cyl = clean(row.EngineCylinders);      // "4"
    const fuel = clean(row.FuelTypePrimary);     // "Gasoline"

    const engine = [dispL ? `${dispL}L` : "", cyl ? `${cyl}-cyl` : "", fuel].filter(Boolean).join(" • ");
    const suggestions = engine ? [engine] : [];

    return NextResponse.json({
      ok: true,
      decoded: { year, make, model, trim },
      suggestions,
    });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, decoded: null, suggestions: [], error: e instanceof Error ? e.message : "Error" });
  }
}
