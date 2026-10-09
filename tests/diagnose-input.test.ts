import { describe, expect, it } from "vitest";
import { DIAGNOSE_LIMITS, parseDiagnoseBody } from "../app/lib/diagnose-input";

const NOW = new Date("2026-10-05T12:00:00Z");
const base = { year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4", code: "P0300", symptoms: "", lang: "en" };

function parse(overrides: Record<string, unknown>) {
  return parseDiagnoseBody({ ...base, ...overrides }, NOW);
}

describe("parseDiagnoseBody", () => {
  it("accepts a normal request and normalises it", () => {
    const r = parse({ make: "  Toyota ", code: "p0300;P0171\nC0035", lang: "ES" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.make).toBe("Toyota");
    expect(r.value.code).toBe("P0300, P0171, C0035");
    expect(r.value.lang).toBe("es");
  });

  it("rejects non-object bodies", () => {
    for (const bad of [null, undefined, "x", 5, [], true]) {
      expect(parseDiagnoseBody(bad, NOW).ok).toBe(false);
    }
  });

  it("rejects fields that are not text", () => {
    expect(parse({ make: { $ne: "" } }).ok).toBe(false);
    expect(parse({ symptoms: ["a"] }).ok).toBe(false);
    expect(parse({ code: true }).ok).toBe(false);
  });

  it("requires year, make and model", () => {
    expect(parse({ year: "" }).ok).toBe(false);
    expect(parse({ make: "   " }).ok).toBe(false);
    expect(parse({ model: undefined }).ok).toBe(false);
  });

  it("validates the year format and range", () => {
    expect(parse({ year: "15" }).ok).toBe(false);
    expect(parse({ year: "20155" }).ok).toBe(false);
    expect(parse({ year: "1850" }).ok).toBe(false);
    expect(parse({ year: "2030" }).ok).toBe(false);
    expect(parse({ year: "2028" }).ok).toBe(true); // next model years are allowed
    expect(parse({ year: 2015 }).ok).toBe(true); // numeric year is tolerated
  });

  it("enforces a hard length limit on every field", () => {
    expect(parse({ make: "a".repeat(DIAGNOSE_LIMITS.make + 1) }).ok).toBe(false);
    expect(parse({ model: "a".repeat(DIAGNOSE_LIMITS.model + 1) }).ok).toBe(false);
    expect(parse({ engine: "a".repeat(DIAGNOSE_LIMITS.engine + 1) }).ok).toBe(false);
    expect(parse({ code: "P0300, ".repeat(40) }).ok).toBe(false);
    expect(parse({ symptoms: "a".repeat(DIAGNOSE_LIMITS.symptoms + 1) }).ok).toBe(false);
    expect(parse({ symptoms: "a".repeat(DIAGNOSE_LIMITS.symptoms) }).ok).toBe(true);
  });

  it("limits how many codes can be sent at once", () => {
    const many = Array.from({ length: DIAGNOSE_LIMITS.maxCodes + 1 }, (_, i) => `P030${i}`).join(",");
    expect(parse({ code: many }).ok).toBe(false);
  });

  it("rejects codes containing anything but letters, digits and separators", () => {
    expect(parse({ code: "P0300'; DROP TABLE users;--" }).ok).toBe(false);
    expect(parse({ code: "P0300 <script>" }).ok).toBe(false);
    expect(parse({ code: "480A-12" }).ok).toBe(true);
  });

  it("requires a code or symptoms", () => {
    expect(parse({ code: "", symptoms: "" }).ok).toBe(false);
    expect(parse({ code: "", symptoms: "shakes at idle" }).ok).toBe(true);
  });

  it("strips control and structural characters from vehicle fields", () => {
    const r = parse({ make: 'Toy"ota\n{x}', engine: "2.5L `I4`\u0000" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.make).toBe("Toy ota x");
    expect(r.value.engine).toBe("2.5L I4");
  });

  it("keeps free-text symptoms but flattens new lines", () => {
    const r = parse({ code: "", symptoms: 'It says "check engine"\nand shakes' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.symptoms).toBe('It says "check engine" and shakes');
  });

  it("falls back to English for unknown languages", () => {
    const r = parse({ lang: "xx" });
    expect(r.ok && r.value.lang).toBe("en");
  });
});

describe("optional diagnosis context", () => {
  it("defaults to nothing extra", () => {
    const r = parse({});
    expect(r.ok && r.value).toMatchObject({ vin: "", mileage: null, followUps: [] });
  });

  it("accepts a well-formed VIN and quietly ignores a malformed one", () => {
    const good = parse({ vin: "1hgcm82633a004352" });
    expect(good.ok && good.value.vin).toBe("1HGCM82633A004352");
    for (const vin of ["", "SHORT", "1HGCM82633A00435O", "x".repeat(400)]) {
      const r = parse({ vin });
      expect(r.ok && r.value.vin, vin.slice(0, 20)).toBe("");
    }
    expect(parse({ vin: { a: 1 } }).ok).toBe(false);
  });

  it("accepts mileage as a number or digits, with a unit", () => {
    const km = parse({ mileage: "128,000" });
    expect(km.ok && km.value.mileage).toEqual({ value: 128000, unit: "km" });
    const mi = parse({ mileage: 80500, mileageUnit: "mi" });
    expect(mi.ok && mi.value.mileage).toEqual({ value: 80500, unit: "mi" });
    expect(parse({ mileage: "" }).ok).toBe(true);
  });

  it("rejects mileage that is not a sensible whole number", () => {
    for (const mileage of ["lots", "-5", "0", "12.5", "99999999", "1e5", { a: 1 }, true]) {
      const r = parse({ mileage });
      expect(r.ok, String(mileage)).toBe(false);
      if (!r.ok) expect(r.field).toBe("mileage");
    }
  });

  it("accepts follow-up answers as plain question and answer text", () => {
    const r = parse({ followUps: [{ question: "Is the light\nflashing?", answer: "  Yes " }, { question: "Skipped?", answer: "   " }] });
    expect(r.ok && r.value.followUps).toEqual([{ question: "Is the light flashing?", answer: "Yes" }]);
  });

  it("rejects follow-up answers that are malformed, too many or too long", () => {
    const item = { question: "q", answer: "a" };
    const bad: unknown[] = [
      "yes",
      { question: "q", answer: "a" },
      [item, "text"],
      [{ question: "q" }],
      [{ question: 1, answer: 2 }],
      Array.from({ length: DIAGNOSE_LIMITS.followUps + 1 }, () => item),
      [{ question: "q".repeat(DIAGNOSE_LIMITS.followUpQuestion + 1), answer: "a" }],
      [{ question: "q", answer: "a".repeat(DIAGNOSE_LIMITS.followUpAnswer + 1) }],
    ];
    for (const followUps of bad) {
      const r = parse({ followUps });
      expect(r.ok, JSON.stringify(followUps).slice(0, 60)).toBe(false);
      if (!r.ok) expect(r.field).toBe("followUps");
    }
  });
});
