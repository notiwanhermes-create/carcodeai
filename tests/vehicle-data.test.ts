import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalMakeName, completeMakeName, searchMakes, VEHICLE_MAKES } from "../app/data/vehicle-makes";
import { buildEngineDescription, isValidVinFormat, normalizeVin, vinCheckDigitValid } from "../app/lib/vin";

describe("makes", () => {
  it("offers real car makes only, best match first", () => {
    expect(searchMakes("for")).toEqual(["Ford"]);
    expect(searchMakes("toy")[0]).toBe("Toyota");
    expect(searchMakes("m").slice(0, 3).every((n) => n.toLowerCase().startsWith("m"))).toBe(true);
    expect(searchMakes("rover")).toContain("Land Rover");
    expect(searchMakes("chevy")).toContain("Chevrolet");
    expect(searchMakes("zzzz")).toEqual([]);
    expect(VEHICLE_MAKES.length).toBeLessThan(100);
  });

  it("lists popular makes first when nothing is typed", () => {
    const all = searchMakes("");
    expect(all).toHaveLength(VEHICLE_MAKES.length);
    expect(VEHICLE_MAKES.find((m) => m.name === all[0])?.popular).toBe(true);
  });

  it("uses the listed spelling but keeps unlisted makes as typed", () => {
    expect(canonicalMakeName("TOYOTA")).toBe("Toyota");
    expect(canonicalMakeName(" honda ")).toBe("Honda");
    expect(canonicalMakeName("MERCEDES-BENZ")).toBe("Mercedes-Benz");
    expect(canonicalMakeName("land  rover")).toBe("Land Rover");
    expect(canonicalMakeName("chevy")).toBe("Chevrolet");
    expect(canonicalMakeName("Koenigsegg")).toBe("Koenigsegg");
    expect(canonicalMakeName("")).toBe("");
  });
});

describe("leaving the Make field", () => {
  it("completes an unmistakable start, and otherwise keeps what was typed", () => {
    expect(completeMakeName("chev")).toBe("Chevrolet");
    expect(completeMakeName("toyota")).toBe("Toyota");
    expect(completeMakeName("vw")).toBe("Volkswagen");
    expect(completeMakeName("m")).toBe("m"); // too short, and many makes start with m
    expect(completeMakeName("mer")).toBe("mer"); // Mercedes-Benz or Mercury: ambiguous
    expect(completeMakeName("Koenigsegg")).toBe("Koenigsegg");
  });
});

describe("VIN validation", () => {
  it("normalises spacing, dashes and case", () => {
    expect(normalizeVin(" 1hgcm826-33a004352 ")).toBe("1HGCM82633A004352");
  });

  it("accepts only 17 valid characters", () => {
    expect(isValidVinFormat("1HGCM82633A004352")).toBe(true);
    expect(isValidVinFormat("1HGCM82633A00435")).toBe(false); // 16
    expect(isValidVinFormat("1HGCM82633A")).toBe(false); // partial
    expect(isValidVinFormat("1HGCM82633A00435O")).toBe(false); // letter O
    expect(isValidVinFormat("1HGCM82633A00435I")).toBe(false);
    expect(isValidVinFormat("1HGCM82633A00435Q")).toBe(false);
  });

  it("verifies the check digit", () => {
    expect(vinCheckDigitValid("1HGCM82633A004352")).toBe(true);
    expect(vinCheckDigitValid("1HGCM82633A004353")).toBe(false); // last digit mistyped
    expect(vinCheckDigitValid("11111111111111111")).toBe(true);
    expect(vinCheckDigitValid("1M8GDM9AXKP042788")).toBe(true); // check digit X
  });
});

describe("engine description from a decoded VIN", () => {
  it("uses displacement, layout, engine code and fuel", () => {
    expect(
      buildEngineDescription({
        DisplacementL: "2.998832712",
        EngineCylinders: "6",
        EngineConfiguration: "V-Shaped",
        EngineModel: "J30A4",
        FuelTypePrimary: "Gasoline",
        Turbo: "",
      }),
    ).toBe("3.0L V6 (J30A4) Gasoline");
  });

  it("handles inline, boxer and turbo engines", () => {
    expect(buildEngineDescription({ DisplacementL: "2.0", EngineCylinders: "4", EngineConfiguration: "In-Line", Turbo: "Yes", FuelTypePrimary: "Gasoline" })).toBe(
      "2.0L I4 Turbo Gasoline",
    );
    expect(buildEngineDescription({ DisplacementL: "2.5", EngineCylinders: "4", EngineConfiguration: "Horizontally opposed (boxer)", FuelTypePrimary: "Gasoline" })).toBe(
      "2.5L H4 Gasoline",
    );
  });

  it("does not guess the layout when NHTSA does not give one", () => {
    expect(buildEngineDescription({ DisplacementL: "5.7", EngineCylinders: "8", FuelTypePrimary: "Gasoline" })).toBe("5.7L 8-cyl Gasoline");
  });

  it("labels hybrids and electric vehicles", () => {
    expect(
      buildEngineDescription({ DisplacementL: "2.5", EngineCylinders: "4", EngineConfiguration: "In-Line", FuelTypePrimary: "Gasoline", ElectrificationLevel: "Strong HEV (Hybrid Electric Vehicle)" }),
    ).toBe("2.5L I4 Hybrid");
    expect(buildEngineDescription({ FuelTypePrimary: "Electric", ElectrificationLevel: "BEV (Battery Electric Vehicle)" })).toBe("Electric");
  });

  it("returns nothing when NHTSA returned nothing useful", () => {
    expect(buildEngineDescription({ DisplacementL: "0", EngineCylinders: "Not Applicable" })).toBe("");
  });
});

describe("GET /api/vehicles/models", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubNhtsa(byType: Record<string, Array<{ Make_Name: string; Model_Name: string }> | "fail">) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = decodeURIComponent(String(input));
        const type = Object.keys(byType).find((t) => url.includes(`/vehicletype/${t}`));
        const rows = type ? byType[type] : [];
        if (rows === "fail") throw new Error("network down");
        return new Response(JSON.stringify({ Results: rows }), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
  }

  it("merges cars, SUVs and trucks and drops other manufacturers", async () => {
    stubNhtsa({
      "passenger car": [
        { Make_Name: "FORD", Model_Name: "Mustang" },
        { Make_Name: "FORDS TRAILER SALES", Model_Name: "Cordova Sedan" },
      ],
      "multipurpose passenger vehicle (mpv)": [
        { Make_Name: "FORD", Model_Name: "Explorer" },
        { Make_Name: "FORD", Model_Name: "Transit" },
      ],
      truck: [
        { Make_Name: "FORD", Model_Name: "F-150" },
        { Make_Name: "FORD", Model_Name: "Transit" },
      ],
    });
    const { GET } = await import("../app/api/vehicles/models/route");
    const res = await GET(new Request("http://localhost/api/vehicles/models?make=Ford&year=2020"));
    const { models } = (await res.json()) as { models: string[] };
    expect(models).toEqual(["Explorer", "F-150", "Mustang", "Transit"]);
  });

  it("filters and ranks by what was typed", async () => {
    stubNhtsa({
      "passenger car": [{ Make_Name: "HONDA", Model_Name: "Civic" }, { Make_Name: "HONDA", Model_Name: "Accord" }],
      "multipurpose passenger vehicle (mpv)": [{ Make_Name: "HONDA", Model_Name: "CR-V" }],
      truck: [],
    });
    const { GET } = await import("../app/api/vehicles/models/route");
    const res = await GET(new Request("http://localhost/api/vehicles/models?make=Honda&year=2021&q=c"));
    const { models } = (await res.json()) as { models: string[] };
    expect(models.slice(0, 2).sort()).toEqual(["CR-V", "Civic"]);
    expect(models).toContain("Accord"); // contains "c", ranked after the ones starting with it
  });

  it("reports an outage instead of failing, so the model can be typed", async () => {
    stubNhtsa({ "passenger car": "fail", "multipurpose passenger vehicle (mpv)": "fail", truck: "fail" });
    const { GET } = await import("../app/api/vehicles/models/route");
    const res = await GET(new Request("http://localhost/api/vehicles/models?make=Subaru&year=2019"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [], unavailable: true });
  });
});
