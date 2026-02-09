import { NextResponse } from "next/server";

type EngineOption = {
  id: string;
  label: string;               // short label for dropdown
  details: string;             // richer secondary line
  displacementL?: number;
  cylinders?: number;
  engineType?: string;         // "V", "in-line", etc (CarQuery field varies)
  aspiration?: "NA" | "Turbo" | "Supercharged";
  fuel?: string;               // keep raw-ish (Gasoline - unleaded 95, etc.)
  powerPS?: number;
  powerRPM?: number;
  torqueNm?: number;
  torqueRPM?: number;
  valvesPerCyl?: number;
  compression?: string;
  transmissionType?: string;   // Auto/Manual
  drive?: string;              // FWD/RWD/AWD/4WD
  source: "carquery";
};

type EngineVariant = {
  engineId: string;
  trimLabel: string;           // trim name / body style
  year?: string;
  doors?: number;
  seats?: number;
  weightKg?: number;
  topSpeedKph?: number;
  zeroTo100Kph?: number;
  transmissionType?: string;
  drive?: string;
  modelId?: string;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function parseMaybeNumber(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseCarQueryJSON(text: string) {
  const t = text.trim();
  const isJsonp = t.startsWith("callback(") && t.endsWith(");");
  const jsonText = isJsonp ? t.replace(/^callback\(|\);\s*$/g, "") : t;
  return JSON.parse(jsonText);
}

function normalizeAspiration(raw: string): EngineOption["aspiration"] | undefined {
  const v = (raw || "").toLowerCase();
  if (!v) return undefined;
  // CarQuery often uses engine_type for "V / in-line", and may not explicitly say turbo.
  // But sometimes fields contain "turbo" in trim/keyword.
  if (v.includes("turbo")) return "Turbo";
  if (v.includes("super")) return "Supercharged";
  return "NA";
}

function cylLabel(cyl?: number) {
  if (!cyl) return undefined;
  if (cyl === 3) return "I3";
  if (cyl === 4) return "I4";
  if (cyl === 5) return "I5";
  if (cyl === 6) return "6-cyl";
  if (cyl === 8) return "V8";
  if (cyl === 10) return "V10";
  if (cyl === 12) return "V12";
  return `${cyl}-cyl`;
}

function toLitersFromCC(cc?: number) {
  if (!cc) return undefined;
  return Math.round((cc / 1000) * 10) / 10; // 1 decimal
}

function buildEngineLabel(e: Partial<EngineOption>) {
  const parts = [
    e.displacementL ? `${e.displacementL}L` : undefined,
    e.cylinders ? cylLabel(e.cylinders) : undefined,
    e.aspiration && e.aspiration !== "NA" ? e.aspiration : undefined,
  ].filter(Boolean);

  return parts.length ? parts.join(" ") : "Engine";
}

function buildEngineDetails(e: Partial<EngineOption>) {
  const parts = [
    e.powerPS ? `${e.powerPS} PS` : undefined,
    e.torqueNm ? `${e.torqueNm} Nm` : undefined,
    e.fuel ? e.fuel : undefined,
    e.drive ? e.drive : undefined,
    e.transmissionType ? e.transmissionType : undefined,
  ].filter(Boolean);

  return parts.join(" • ");
}

function safeTrimLabel(t: any) {
  const body = (t?.model_body || "").trim();
  const trim = (t?.model_trim || "").trim();
  const name = (t?.model_name || "").trim();

  // Example output: "4dr Sedan • Competition" or "Coupe • (base)"
  const a = [body || undefined, trim || undefined].filter(Boolean).join(" • ");
  return a || name || "Trim";
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const year = (searchParams.get("year") || "").trim();
  const make = (searchParams.get("make") || "").trim();
  const model = (searchParams.get("model") || "").trim();

  if (!year || !make || !model) return jsonError("year, make, model are required");

  try {
    const makeLower = make.toLowerCase();

    function generateModelVariations(m: string): string[] {
      const variations: string[] = [m];

      variations.push(m.split(" ")[0]);
      variations.push(m.replace(/\s+/g, ""));
      variations.push(m.toLowerCase());
      variations.push(m.replace(/-/g, " "));
      variations.push(m.replace(/\s+/g, "-"));

      const seriesMatch = m.match(/^(\d+)/);
      if (seriesMatch) {
        variations.push(`${seriesMatch[1]} Series`);
        if (seriesMatch[1].length > 1) {
          variations.push(`${seriesMatch[1][0]} Series`);
        }
      }

      const alphaOnly = m.replace(/[^a-zA-Z\s-]/g, "").trim();
      if (alphaOnly && alphaOnly !== m) {
        variations.push(alphaOnly);
      }

      const lettersStripped = m.replace(/[a-zA-Z]+$/i, "").trim();
      if (lettersStripped && lettersStripped !== m) {
        variations.push(lettersStripped);
      }

      if (makeLower === "mercedes-benz" || makeLower === "mercedes") {
        const mbMatch = m.match(/^([A-Za-z]+)/);
        if (mbMatch) {
          variations.push(`${mbMatch[1]}-Class`);
          variations.push(`${mbMatch[1]} Class`);
        }
      }

      return variations.filter((v, i, a) => v.trim() !== "" && a.indexOf(v) === i);
    }

    const modelsToTry = generateModelVariations(model);

    let trims: any[] = [];
    for (const m of modelsToTry) {
      const url =
        `https://www.carqueryapi.com/api/0.3/?cmd=getTrims&full_results=1` +
        `&year=${encodeURIComponent(year)}` +
        `&make=${encodeURIComponent(make)}` +
        `&model=${encodeURIComponent(m)}`;
      
      const r = await fetch(url, {
        cache: "no-store",
        headers: { "User-Agent": "CarCodeAI/1.0" },
      });
      if (r.ok) {
        const text = await r.text();
        const data = parseCarQueryJSON(text);
        if (Array.isArray(data?.Trims) && data.Trims.length > 0) {
          trims = data.Trims;
          break; 
        }
      }
    }

    // Build unique engines + variants grouped under them
    const enginesMap = new Map<string, EngineOption>();
    const variants: EngineVariant[] = [];

    for (const t of trims) {
      const cc = parseMaybeNumber(t?.model_engine_cc);
      const displacementL = toLitersFromCC(cc);

      const cylinders = parseMaybeNumber(t?.model_engine_cyl);
      const engineType = (t?.model_engine_type || "").toString().trim() || undefined; // "V", "in-line", etc.
      const valvesPerCyl = parseMaybeNumber(t?.model_engine_valves_per_cyl);

      const powerPS = parseMaybeNumber(t?.model_engine_power_ps);
      const powerRPM = parseMaybeNumber(t?.model_engine_power_rpm);

      const torqueNm = parseMaybeNumber(t?.model_engine_torque_nm);
      const torqueRPM = parseMaybeNumber(t?.model_engine_torque_rpm);

      const compression = (t?.model_engine_compression || "").toString().trim() || undefined;
      const fuel = (t?.model_engine_fuel || t?.model_fuel_type || "").toString().trim() || undefined;

      const drive = (t?.model_drive || "").toString().trim() || undefined;
      const transmissionType = (t?.model_transmission_type || "").toString().trim() || undefined;

      // Best-effort aspiration guess: sometimes appears in trim/body strings or engine_type
      const aspHint = [
        t?.model_engine_type,
        t?.model_trim,
        t?.model_name,
        t?.model_body
      ].filter(Boolean).join(" ");
      const aspiration = normalizeAspiration(String(aspHint));

      // Stronger dedupe signature
      const signature = [
        displacementL ?? "",
        cylinders ?? "",
        engineType ?? "",
        aspiration ?? "",
        fuel ?? "",
        powerPS ?? "",
        torqueNm ?? "",
      ].filter(Boolean).join("|");

      const existing = enginesMap.get(signature);
      if (!existing) {
        const base: Partial<EngineOption> = {
          displacementL,
          cylinders,
          engineType,
          aspiration,
          fuel,
          powerPS,
          powerRPM,
          torqueNm,
          torqueRPM,
          valvesPerCyl,
          compression,
          transmissionType,
          drive
        };

        const engine: EngineOption = {
          id: signature,
          label: buildEngineLabel(base),     // short
          details: buildEngineDetails(base), // rich
          ...base,
          source: "carquery"
        };

        enginesMap.set(signature, engine);
      }

      variants.push({
        engineId: signature,
        trimLabel: safeTrimLabel(t),
        year: t?.model_year?.toString?.() || year,
        doors: parseMaybeNumber(t?.model_doors),
        seats: parseMaybeNumber(t?.model_seats),
        weightKg: parseMaybeNumber(t?.model_weight_kg),
        topSpeedKph: parseMaybeNumber(t?.model_top_speed_kph),
        zeroTo100Kph: parseMaybeNumber(t?.model_0_to_100_kph),
        transmissionType,
        drive,
        modelId: (t?.model_id || "").toString() || undefined
      });
    }

    const engines = Array.from(enginesMap.values())
      .sort((a, b) => (a.displacementL ?? 0) - (b.displacementL ?? 0) || a.label.localeCompare(b.label));

    // Group variants per engine (optional convenience)
    const variantsByEngine: Record<string, EngineVariant[]> = {};
    for (const v of variants) {
      (variantsByEngine[v.engineId] ||= []).push(v);
    }

    return NextResponse.json({
      engines,
      count: engines.length,
      variantsByEngine,
      meta: {
        year,
        make,
        model,
        source: "carquery",
        note:
          engines.length === 0
            ? "No results. Usually make/model mismatch or a CarQuery coverage gap."
            : undefined
      }
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: "Failed to fetch engines", detail: String(e?.message || e) },
      { status: 502 }
    );
  }
}
