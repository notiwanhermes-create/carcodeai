import { describe, expect, it } from "vitest";
import { parseCost, parseModelYear, parseOdometer, parseServiceDate } from "../app/lib/maintenance-values";

/**
 * The typed copies of what users type into the garage. The rule throughout:
 * convert only when the text is unambiguous, otherwise leave the typed value
 * empty. The text itself is always kept as typed, elsewhere.
 */
describe("vehicle year", () => {
  it("converts a four-digit year", () => {
    expect(parseModelYear("2015")).toBe(2015);
    expect(parseModelYear(" 2003 ")).toBe(2003);
    expect(parseModelYear("1900")).toBe(1900);
    expect(parseModelYear("2099")).toBe(2099);
  });

  it("leaves anything else empty", () => {
    for (const text of ["", "  ", "1899", "2100", "20155", "15", "two thousand", "2015.0", "2015 Camry", null, undefined]) {
      expect(parseModelYear(text), JSON.stringify(text)).toBeNull();
    }
  });
});

describe("service date", () => {
  const iso = (text: string) => parseServiceDate(text)?.toISOString() ?? null;

  it("converts a real calendar day written year-month-day", () => {
    expect(iso("2026-01-15")).toBe("2026-01-15T00:00:00.000Z");
    expect(iso(" 2026-03-01 ")).toBe("2026-03-01T00:00:00.000Z");
    expect(iso("2024-02-29")).toBe("2024-02-29T00:00:00.000Z"); // leap day
    expect(iso("1999-12-31")).toBe("1999-12-31T00:00:00.000Z");
  });

  it("does not roll an impossible day over into the next month", () => {
    expect(iso("2026-02-31")).toBeNull();
    expect(iso("2023-02-29")).toBeNull();
    expect(iso("2026-13-01")).toBeNull();
    expect(iso("2026-00-10")).toBeNull();
    expect(iso("2026-04-31")).toBeNull();
  });

  it("does not guess at other ways of writing a date", () => {
    for (const text of ["15/01/2026", "01/15/2026", "2026-1-5", "Jan 15 2026", "last tuesday", "20260115", "2026-01-15T10:00:00Z", "", "0000-01-01"]) {
      expect(iso(text), text).toBeNull();
    }
    expect(parseServiceDate(null)).toBeNull();
    expect(parseServiceDate(undefined)).toBeNull();
  });
});

describe("odometer reading", () => {
  it("converts whole numbers, with or without thousands commas", () => {
    expect(parseOdometer("120000")).toEqual({ value: 120000, unit: null });
    expect(parseOdometer("120,000")).toEqual({ value: 120000, unit: null });
    expect(parseOdometer("1,234,567")).toEqual({ value: 1234567, unit: null });
    expect(parseOdometer(" 5000 ")).toEqual({ value: 5000, unit: null });
    expect(parseOdometer("0")).toEqual({ value: 0, unit: null });
  });

  it("keeps the unit when the user gave one, and assumes none when they did not", () => {
    expect(parseOdometer("120000 km")).toEqual({ value: 120000, unit: "km" });
    expect(parseOdometer("120000km")).toEqual({ value: 120000, unit: "km" });
    expect(parseOdometer("5000 kilometres")).toEqual({ value: 5000, unit: "km" });
    expect(parseOdometer("5000 Kilometers")).toEqual({ value: 5000, unit: "km" });
    expect(parseOdometer("75,500 miles")).toEqual({ value: 75500, unit: "mi" });
    expect(parseOdometer("90 MI")).toEqual({ value: 90, unit: "mi" });
    expect(parseOdometer("1 mile")).toEqual({ value: 1, unit: "mi" });
  });

  it("leaves unclear readings empty instead of guessing", () => {
    // "120.000" is 120 thousand in some countries and 120 in others.
    for (const text of ["120.000", "about 90k", "90k", "12,34", "1,2345", "12345678", "1,234,567,890", "-5", "km", "", "120000 kmh", "120 000", "12e3", null, undefined]) {
      expect(parseOdometer(text), JSON.stringify(text)).toBeNull();
    }
  });
});

describe("cost", () => {
  it("converts plain amounts to two decimal places", () => {
    expect(parseCost("120")).toBe("120.00");
    expect(parseCost("120.5")).toBe("120.50");
    expect(parseCost("120.50")).toBe("120.50");
    expect(parseCost("0")).toBe("0.00");
    expect(parseCost("007")).toBe("7.00");
    expect(parseCost("999999999.99")).toBe("999999999.99");
  });

  it("accepts a leading dollar sign and thousands commas", () => {
    expect(parseCost("$120")).toBe("120.00");
    expect(parseCost("$ 120")).toBe("120.00");
    expect(parseCost(" $1,250.50 ")).toBe("1250.50");
    expect(parseCost("1,250")).toBe("1250.00");
    expect(parseCost("12,345,678.9")).toBe("12345678.90");
  });

  it("leaves unclear amounts empty instead of guessing", () => {
    // "120,50" may be 120.50 or a mistyped 12,050.
    for (const text of ["120,50", "free", "-5", "12.345", "1234567890", "1,23", "120 USD", "€120", "$", "", "1.2.3", "1e3", null, undefined]) {
      expect(parseCost(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("never returns a number type, so no amount is rounded on the way to the database", () => {
    expect(typeof parseCost("0.1")).toBe("string");
    expect(parseCost("0.1")).toBe("0.10");
    expect(parseCost("0.07")).toBe("0.07");
  });
});
