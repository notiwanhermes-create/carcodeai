/**
 * The garage's rules that need no database: how mileage is shown and when it
 * may change, how a vehicle's timeline is ordered, what an analytics event may
 * carry, and what an import request must look like.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_EVENTS, countRange, sanitizeEvent, track } from "../app/lib/analytics";
import { IMPORT_LIMITS, parseImportPayload, sameVehicle, splitIssueText } from "../app/lib/garage-import";
import { buildTimeline, issueTitle, splitCodes } from "../app/lib/garage-types";
import { decideMileageUpdate, formatOdometer, parseOdometerValue, shouldRaiseAutomatically } from "../app/lib/odometer";

describe("odometer readings", () => {
  it("shows a reading with the unit it was recorded in, and never invents one", () => {
    expect(formatOdometer(130250, "km")).toBe("130,250 km");
    expect(formatOdometer(81000, "mi")).toBe("81,000 mi");
    // The bug this replaces printed "130,250 km miles".
    expect(formatOdometer(130250, "km", "130,250 km")).not.toMatch(/miles/);
    // No unit on file: the number alone.
    expect(formatOdometer(130250, null)).toBe("130,250");
    expect(formatOdometer(130250, "furlongs")).toBe("130,250");
    // Old free text that could not be read as a number is kept exactly as typed.
    expect(formatOdometer(null, null, "about 90k")).toBe("about 90k");
    expect(formatOdometer(null, null, null)).toBe("");
    expect(formatOdometer(0, "km")).toBe("0 km");
  });

  it("accepts whole numbers only", () => {
    expect(parseOdometerValue("138000")).toBe(138000);
    expect(parseOdometerValue("138,000")).toBe(138000);
    expect(parseOdometerValue(42)).toBe(42);
    expect(parseOdometerValue("138000.5")).toBeNull();
    expect(parseOdometerValue("138k")).toBeNull();
    expect(parseOdometerValue("-5")).toBeNull();
    expect(parseOdometerValue(-5)).toBeNull();
    expect(parseOdometerValue("99999999")).toBeNull();
    expect(parseOdometerValue("")).toBeNull();
    expect(parseOdometerValue(null)).toBeNull();
  });

  it("stores a higher reading, and asks before lowering one or changing its unit", () => {
    const onFile = { value: 138000, unit: "km" as const };
    expect(decideMileageUpdate(null, { value: 5, unit: "km" })).toEqual({ action: "set" });
    expect(decideMileageUpdate(onFile, { value: 138500, unit: "km" })).toEqual({ action: "set" });
    expect(decideMileageUpdate(onFile, { value: 138000, unit: "km" })).toEqual({ action: "keep" });

    // Lower: never silently.
    expect(decideMileageUpdate(onFile, { value: 13800, unit: "km" })).toEqual({ action: "confirm", reason: "lower" });
    expect(decideMileageUpdate(onFile, { value: 13800, unit: "km" }, true)).toEqual({ action: "set" });

    // Other unit: the two cannot be compared without guessing, so even a bigger number asks.
    expect(decideMileageUpdate(onFile, { value: 200000, unit: "mi" })).toEqual({ action: "confirm", reason: "unit_change" });
    expect(decideMileageUpdate(onFile, { value: 85000, unit: "mi" }, true)).toEqual({ action: "set" });

    // A reading that only adds the missing unit is stored.
    expect(decideMileageUpdate({ value: 138000, unit: null }, { value: 138000, unit: "km" })).toEqual({ action: "set" });
  });

  it("raises a vehicle's mileage from a diagnosis or service record only when that needs no confirmation", () => {
    const onFile = { value: 138000, unit: "km" as const };
    expect(shouldRaiseAutomatically(null, { value: 100, unit: "km" })).toBe(true);
    expect(shouldRaiseAutomatically(onFile, { value: 139000, unit: "km" })).toBe(true);
    expect(shouldRaiseAutomatically(onFile, { value: 139000, unit: null })).toBe(true);
    expect(shouldRaiseAutomatically(onFile, { value: 120000, unit: "km" })).toBe(false); // an older record entered late
    expect(shouldRaiseAutomatically(onFile, { value: 139000, unit: "mi" })).toBe(false); // conflicting unit
    expect(shouldRaiseAutomatically(onFile, { value: 138000, unit: "km" })).toBe(false);
  });
});

describe("a vehicle's timeline", () => {
  const day = (iso: string) => new Date(iso);

  it("labels a diagnosis from what the user entered, never from the AI's answer", () => {
    expect(issueTitle("  Rough idle\n when cold ", "P0300")).toBe("Rough idle when cold");
    expect(issueTitle("", "p0300, P0171")).toBe("P0300, P0171");
    expect(issueTitle("", "")).toBe("Diagnosis");
    const long = issueTitle("x".repeat(200), "");
    expect(long.length).toBe(90);
    expect(long.endsWith("…")).toBe(true);
    expect(splitCodes("p0300, P0171;p0300  u0100")).toEqual(["P0300", "P0171", "U0100"]);
  });

  it("puts diagnoses, confirmed repairs and service records in one list, newest first", () => {
    const timeline = buildTimeline({
      diagnoses: [
        { id: "d-old", diagnosedAt: day("2026-03-01T10:00:00Z"), symptoms: "Rough idle", codeInput: "P0300", status: "resolved" },
        { id: "d-new", diagnosedAt: day("2026-09-20T08:00:00Z"), symptoms: "", codeInput: "P0171", status: "open" },
      ],
      fixes: [{ id: "f1", diagnosisId: "d-old", fixedOn: day("2026-03-05T00:00:00Z"), createdAt: day("2026-03-06T09:00:00Z"), description: "Ignition coil", outcome: "fixed", odometerValue: 138200, odometerUnit: "km" }],
      maintenance: [
        { id: "m1", serviceType: "Oil Change", date: "2026-06-15", serviceDate: day("2026-06-15T00:00:00Z"), createdAt: day("2026-06-15T12:00:00Z"), odometer: "140000", odometerValue: 140000, odometerUnit: "km", cost: "60", notes: null },
      ],
    });

    expect(timeline.map((t) => `${t.kind}:${t.id}`)).toEqual(["diagnosis:d-new", "maintenance:m1", "fix:f1", "diagnosis:d-old"]);
    expect(timeline[0]).toMatchObject({ kind: "diagnosis", title: "P0171", codes: ["P0171"], status: "open" });
    expect(timeline[2]).toMatchObject({ kind: "fix", diagnosisId: "d-old", description: "Ignition coil", outcome: "fixed", odometerValue: 138200, odometerUnit: "km" });
    // Each record appears once: the timeline is a view, not a copy.
    expect(new Set(timeline.map((t) => t.id)).size).toBe(timeline.length);
  });

  it("orders records of the same day by when they were entered, and places undated ones by entry time", () => {
    const timeline = buildTimeline({
      diagnoses: [{ id: "d1", diagnosedAt: day("2026-10-12T09:00:00Z"), symptoms: "Noise", codeInput: "", status: "weird" }],
      fixes: [{ id: "f1", diagnosisId: "d1", fixedOn: day("2026-10-12T00:00:00Z"), createdAt: day("2026-10-12T15:00:00Z"), description: "Belt", outcome: "did_not_hold", odometerValue: null, odometerUnit: "leagues" }],
      maintenance: [
        { id: "m-same-day", serviceType: "Inspection", date: "2026-10-12", serviceDate: day("2026-10-12T00:00:00Z"), createdAt: day("2026-10-12T18:00:00Z"), odometer: null, odometerValue: null, odometerUnit: null, cost: null, notes: null },
        { id: "m-free-text", serviceType: "Other", date: "last spring", serviceDate: null, createdAt: day("2026-10-01T10:00:00Z"), odometer: "about 90k", odometerValue: null, odometerUnit: null, cost: null, notes: null },
      ],
    });
    // Same calendar day: the service record (18:00), then the repair (15:00), then the diagnosis (09:00).
    expect(timeline.map((t) => t.id)).toEqual(["m-same-day", "f1", "d1", "m-free-text"]);
    // An unknown status reads as open; an unknown unit as no unit. Old text is kept.
    expect(timeline[2]).toMatchObject({ status: "open" });
    expect(timeline[1]).toMatchObject({ odometerUnit: null, outcome: "did_not_hold" });
    expect(timeline[3]).toMatchObject({ dateText: "last spring", odometer: "about 90k" });
  });
});

describe("analytics events", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has exactly the events the product asked for", () => {
    expect([...ANALYTICS_EVENTS].sort()).toEqual(
      ["confirmed_fix_added", "diagnosis_completed", "diagnosis_reopened", "diagnosis_resolved", "diagnosis_started", "guest_data_imported", "maintenance_added", "vehicle_added", "vehicle_opened"].sort(),
    );
  });

  it("drops anything a person typed, and anything that could identify them or their vehicle", () => {
    const event = sanitizeEvent("diagnosis_completed", {
      signed_in: true,
      has_code: true,
      source: "home",
      // None of these may ever leave the browser:
      vin: "4T1BF1FK5FU000000",
      symptoms: "rough idle when cold",
      code: "P0300",
      diagnosis: "Worn spark plugs",
      email: "me@example.test",
      user_id: "user-1",
      vehicle_id: "veh-1",
      make: "Toyota",
      model: "Camry",
      description: "Replaced the coil",
      mileage: 138000,
    });
    expect(event).toEqual({ name: "diagnosis_completed", params: { signed_in: true, has_code: true, source: "home" } });

    // A value of the wrong kind is dropped even under an allowed name.
    expect(sanitizeEvent("vehicle_added", { signed_in: "yes", source: "4T1BF1FK5FU000000", outcome: "P0300" })?.params).toEqual({});
    // Every value that can be sent is a yes/no or one of a few fixed words.
    const all = sanitizeEvent("guest_data_imported", { signed_in: true, imported_vehicles: 2, imported_records: 37, imported_diagnoses: 0, source: "dashboard", outcome: "fixed" });
    expect(all?.params).toEqual({ signed_in: true, imported_vehicles: "2", imported_records: "5+", imported_diagnoses: "0", source: "dashboard", outcome: "fixed" });
  });

  it("sends counts as coarse ranges and refuses event names that are not on the list", () => {
    expect([0, 1, 4, 5, 250, -3, NaN].map(countRange)).toEqual(["0", "1", "4", "5+", "5+", "0", "0"]);
    expect(sanitizeEvent("user_typed_P0300", { signed_in: true })).toBeNull();
  });

  it("sends through gtag when it is loaded, and never throws when it is not or when it fails", () => {
    const gtag = vi.fn();
    vi.stubGlobal("window", { gtag });
    track("vehicle_opened", { signed_in: true, source: "vehicle_page" });
    expect(gtag).toHaveBeenCalledWith("event", "vehicle_opened", { signed_in: true, source: "vehicle_page" });

    vi.stubGlobal("window", {});
    expect(() => track("vehicle_opened")).not.toThrow();
    vi.stubGlobal("window", { gtag: () => { throw new Error("blocked"); } });
    expect(() => track("vehicle_opened")).not.toThrow();
  });
});

describe("an import request", () => {
  const vehicle = { clientId: "g1", year: "2012", make: "Ford", model: "Focus" };
  const diagnosis = { key: "d1", at: "2026-07-01T10:00:00Z", code: "P0171", symptoms: "Hesitation", issueText: "Code: P0171 | Symptoms: Hesitation", vehicle: { year: "2012", make: "Ford", model: "Focus" }, causes: [{ title: "Vacuum leak", why: ["Lean"], checks: [], fix: ["Replace the hose"] }] };

  it("accepts a well-formed device export and reads every field", () => {
    const parsed = parseImportPayload({
      vehicles: [{ ...vehicle, engine: "2.0L", maintenance: [{ type: "Oil Change", date: "2026-01-01", odometerValue: 88000.4, odometerUnit: "mi", notes: "Synthetic" }], diagnoses: [{ ...diagnosis, followUps: [{ question: "Any hissing?", answer: "Yes" }], confirmedFix: { title: "Vacuum leak", fix: "Replace the hose" } }] }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [v] = parsed.value;
    expect(v).toMatchObject({ clientId: "g1", existingVehicleId: null, year: "2012", engine: "2.0L" });
    expect(v.maintenance).toEqual([{ type: "Oil Change", date: "2026-01-01", odometerValue: 88000, odometerUnit: "mi", notes: "Synthetic" }]);
    expect(v.diagnoses[0]).toMatchObject({ key: "d1", codeInput: "P0171", symptoms: "Hesitation", followUps: [{ question: "Any hissing?", answer: "Yes" }], confirmedFix: { title: "Vacuum leak", fix: "Replace the hose", causeIndex: 0 } });
    expect(v.diagnoses[0].at.toISOString()).toBe("2026-07-01T10:00:00.000Z");
  });

  it("does not claim a repair matched a listed cause when it did not", () => {
    const parsed = parseImportPayload({ vehicles: [{ ...vehicle, diagnoses: [{ ...diagnosis, confirmedFix: { title: "Something the list never mentioned", fix: "New fuel pump" } }] }] });
    expect(parsed.ok && parsed.value[0].diagnoses[0].confirmedFix).toEqual({ title: "Something the list never mentioned", fix: "New fuel pump", causeIndex: null });
  });

  it("recovers the code and symptoms from the one-line label older versions kept", () => {
    expect(splitIssueText("Code: P0300 | Symptoms: rough idle | worse when cold")).toEqual({ code: "P0300", symptoms: "rough idle | worse when cold" });
    expect(splitIssueText("Code: P0300, P0171")).toEqual({ code: "P0300, P0171", symptoms: "" });
    expect(splitIssueText("Symptoms: grinding noise")).toEqual({ code: "", symptoms: "grinding noise" });
    // Not this app's format: it is what the user described, so it is kept whole.
    expect(splitIssueText("Car shakes at 60")).toEqual({ code: "", symptoms: "Car shakes at 60" });
    expect(splitIssueText("Diagnosis")).toEqual({ code: "", symptoms: "" });

    const parsed = parseImportPayload({ vehicles: [{ ...vehicle, diagnoses: [{ key: "old", issueText: "Code: P0420 | Symptoms: smell of sulphur", causes: diagnosis.causes }] }] });
    expect(parsed.ok && parsed.value[0].diagnoses[0]).toMatchObject({ codeInput: "P0420", symptoms: "smell of sulphur" });
  });

  it("uses the import time when a saved date is missing, unreadable or in the future", () => {
    const before = Date.now();
    for (const at of [undefined, "not a date", "2999-01-01T00:00:00Z", "1999-01-01T00:00:00Z"]) {
      const parsed = parseImportPayload({ vehicles: [{ ...vehicle, diagnoses: [{ ...diagnosis, at }] }] });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value[0].diagnoses[0].at.getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it("refuses a request with one bad field instead of half-understanding it", () => {
    const bad: unknown[] = [
      null,
      { vehicles: [] },
      { vehicles: "all of them" },
      { vehicles: Array.from({ length: IMPORT_LIMITS.vehicles + 1 }, (_, i) => ({ ...vehicle, clientId: `g${i}` })) },
      { vehicles: [vehicle, vehicle] }, // the same vehicle twice
      { vehicles: [{ ...vehicle, clientId: "" }] },
      { vehicles: [{ ...vehicle, year: "12" }] },
      { vehicles: [{ ...vehicle, make: "" }] },
      { vehicles: [{ ...vehicle, model: "x".repeat(61) }] },
      { vehicles: [{ ...vehicle, vin: { $ne: null } }] },
      { vehicles: [{ ...vehicle, maintenance: [{ type: "Oil Change" }] }] }, // no date
      { vehicles: [{ ...vehicle, maintenance: [{ type: "Oil Change", date: "2026-01-01", odometerValue: "lots" }] }] },
      { vehicles: [{ ...vehicle, maintenance: [{ type: "Oil Change", date: "2026-01-01", notes: "x".repeat(IMPORT_LIMITS.notes + 1) }] }] },
      { vehicles: [{ ...vehicle, maintenance: Array.from({ length: IMPORT_LIMITS.maintenancePerVehicle + 1 }, () => ({ type: "Oil Change", date: "2026-01-01" })) }] },
      { vehicles: [{ ...vehicle, diagnoses: [{ ...diagnosis, key: "" }] }] },
      { vehicles: [{ ...vehicle, diagnoses: [{ ...diagnosis, causes: [] }] }] },
      { vehicles: [{ ...vehicle, diagnoses: [{ ...diagnosis, causes: [{ title: "x".repeat(201) }] }] }] },
      { vehicles: [{ ...vehicle, diagnoses: [{ ...diagnosis, symptoms: "x".repeat(IMPORT_LIMITS.symptoms + 1) }] }] },
    ];
    for (const body of bad) expect(parseImportPayload(body).ok, JSON.stringify(body)?.slice(0, 80)).toBe(false);
  });

  it("needs no year, make or model for history that belongs to a vehicle already in the account", () => {
    const parsed = parseImportPayload({ vehicles: [{ clientId: "account:v1", existingVehicleId: "v1", maintenance: [{ type: "Oil Change", date: "2026-01-01" }] }] });
    expect(parsed.ok && parsed.value[0]).toMatchObject({ existingVehicleId: "v1", maintenance: [{ type: "Oil Change", odometerValue: null, odometerUnit: null }] });
  });

  it("treats two entries as one vehicle by VIN, else by year, make, model and engine", () => {
    const camry = { year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4" };
    expect(sameVehicle({ ...camry, vin: "4T1BF1FK5FU000000" }, { year: "2016", make: "x", model: "y", vin: " 4t1bf1fk5fu000000 " })).toBe(true);
    expect(sameVehicle(camry, { ...camry, make: " TOYOTA " })).toBe(true);
    expect(sameVehicle(camry, { ...camry, engine: "3.5L V6" })).toBe(false);
    expect(sameVehicle({ ...camry, vin: "AAA" }, { ...camry, vin: null })).toBe(true); // one VIN missing: fall back to the description
  });
});
