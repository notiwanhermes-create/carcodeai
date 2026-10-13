/**
 * What a device holds, and what happens to it when it is copied into an
 * account. The rule throughout: nothing on the device is changed or dropped to
 * make it fit, and nothing leaves the device unless the account took it.
 */
import { describe, expect, it } from "vitest";
import {
  applyImportOutcomes,
  batchForUpload,
  canImportMaintenance,
  canImportSession,
  deviceReading,
  planDeviceImport,
  summarizeOutcomes,
  toImportVehicle,
  type DeviceMaintenance,
  type DeviceSession,
  type DeviceStores,
  type DeviceVehicle,
} from "../app/lib/device-data";
import { IMPORT_LIMITS, parseImportPayload } from "../app/lib/garage-import";

const camry: DeviceVehicle = { id: "g-camry", year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4" };
const civic: DeviceVehicle = { id: "g-civic", year: "2018", make: "Honda", model: "Civic" };
const accountFocus: DeviceVehicle = { id: "srv-focus", year: "2012", make: "Ford", model: "Focus" };

const record = (id: string, extra: Partial<DeviceMaintenance> = {}): DeviceMaintenance => ({ id, type: "Oil Change", date: "2026-01-01", notes: "", ...extra });
const session = (id: string, extra: Partial<DeviceSession> = {}): DeviceSession => ({
  id,
  timestamp: "2026-02-01T00:00:00Z",
  issueText: "Code: P0300",
  code: "P0300",
  vehicle: { year: "2015", make: "Toyota", model: "Camry" },
  followUpAnswers: { "Any smoke?": "No" },
  finalRankedCauses: [{ id: "c1", title: "Worn spark plugs", whyLikely: ["Misfire"], confirm: ["Inspect"], fix: ["Replace"] }],
  ...extra,
});

const empty: DeviceStores = { maintenance: {}, guestSessions: {}, accountSessions: {} };

describe("reading what a device holds", () => {
  it("reads a service record's mileage with its unit, and never guesses a missing one", () => {
    expect(deviceReading(record("a", { mileageValue: 130250, mileageUnit: "km" }))).toEqual({ value: 130250, unit: "km" });
    expect(deviceReading(record("a", { mileageValue: 81000.6, mileageUnit: "mi" }))).toEqual({ value: 81001, unit: "mi" });
    // Older versions kept one number with no unit.
    expect(deviceReading(record("a", { mileage: "98,000" }))).toEqual({ value: 98000, unit: null });
    expect(deviceReading(record("a", { mileage: 98000 }))).toEqual({ value: 98000, unit: null });
    expect(deviceReading(record("a"))).toBeNull();
    expect(deviceReading(record("a", { mileage: "a lot" }))).toBeNull();
  });

  it("only offers items the account can take exactly as they are", () => {
    expect(canImportMaintenance(record("ok"))).toBe(true);
    expect(canImportMaintenance(record("no-date", { date: "" }))).toBe(false);
    expect(canImportMaintenance(record("long", { notes: "x".repeat(IMPORT_LIMITS.notes + 1) }))).toBe(false);
    expect(canImportMaintenance(record("huge", { mileageValue: 99_999_999, mileageUnit: "km" }))).toBe(false);
    expect(canImportMaintenance(null)).toBe(false);

    expect(canImportSession(session("ok"))).toBe(true);
    expect(canImportSession(session("no-causes", { finalRankedCauses: [] }))).toBe(false);
    expect(canImportSession(session("long", { symptoms: "x".repeat(IMPORT_LIMITS.symptoms + 1) }))).toBe(false);
    expect(canImportSession(session("bad-cause", { finalRankedCauses: [{ title: "x".repeat(201) }] }))).toBe(false);
    expect(canImportSession({ id: "nothing" })).toBe(false);
  });
});

describe("planning an import", () => {
  const stores: DeviceStores = {
    maintenance: { "g-camry": [record("m1"), record("m-bad", { date: "" })], "srv-focus": [record("m2")], "g-unknown": [record("m3")] },
    guestSessions: { "g-camry": [session("d1"), session("d-bad", { finalRankedCauses: [] })] },
    accountSessions: { "srv-focus": [session("d2")] },
  };

  it("lists each guest vehicle with its history, and history kept here for the account's own vehicles", () => {
    const plan = planDeviceImport([camry, civic], [accountFocus], stores);
    expect(plan.map((e) => [e.clientId, e.kind, e.existingVehicleId, e.maintenance.map((m) => m.id), e.diagnoses.map((d) => d.id)])).toEqual([
      ["g-camry", "new_vehicle", null, ["m1"], ["d1"]],
      ["g-civic", "new_vehicle", null, [], []],
      ["account:srv-focus", "history_only", "srv-focus", ["m2"], ["d2"]],
    ]);
  });

  it("flags a guest vehicle that looks like one already in the account", () => {
    const plan = planDeviceImport([camry], [{ ...camry, id: "srv-camry" }], empty);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ clientId: "g-camry", kind: "likely_duplicate", existingVehicleId: null });
  });

  it("offers nothing when the device holds nothing the account lacks", () => {
    expect(planDeviceImport([], [accountFocus], empty)).toEqual([]);
    // A guest vehicle the account could not create (no year) is left alone, not offered.
    expect(planDeviceImport([{ id: "g-x", year: "", make: "Kia", model: "Rio" }], [], empty)).toEqual([]);
  });

  it("builds a request the server accepts, field for field", () => {
    const plan = planDeviceImport([camry], [accountFocus], {
      ...stores,
      maintenance: { ...stores.maintenance, "g-camry": [record("m1", { mileageValue: 130250, mileageUnit: "km", notes: "Synthetic" }), record("m-old", { mileage: "98,000" })] },
      guestSessions: { "g-camry": [session("d1", { confirmedFix: { causeId: "c1", causeTitle: "Worn spark plugs", fix: "Replaced all four" } })] },
    });
    const body = { vehicles: plan.map(toImportVehicle) };
    expect(body.vehicles[0].maintenance).toEqual([
      { type: "Oil Change", date: "2026-01-01", odometerValue: 130250, odometerUnit: "km", notes: "Synthetic" },
      { type: "Oil Change", date: "2026-01-01", odometerValue: 98000, odometerUnit: null, notes: "" },
    ]);

    const parsed = parseImportPayload(JSON.parse(JSON.stringify(body)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.map((v) => [v.clientId, v.existingVehicleId, v.maintenance.length, v.diagnoses.length])).toEqual([
      ["g-camry", null, 2, 1],
      ["account:srv-focus", "srv-focus", 1, 1],
    ]);
    expect(parsed.value[0].diagnoses[0]).toMatchObject({
      key: "d1",
      codeInput: "P0300",
      followUps: [{ question: "Any smoke?", answer: "No" }],
      causes: [{ title: "Worn spark plugs", why: ["Misfire"], checks: ["Inspect"], fix: ["Replace"] }],
      confirmedFix: { title: "Worn spark plugs", fix: "Replaced all four", causeIndex: 0 },
    });
  });

  it("splits a large device into several requests, each under the size limit, losing nothing", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...civic, id: `g-${i}` }));
    const big: DeviceStores = { ...empty, maintenance: Object.fromEntries(many.map((v) => [v.id, Array.from({ length: 40 }, (_, j) => record(`${v.id}-m${j}`, { notes: "n".repeat(400) }))])) };
    const plan = planDeviceImport(many, [], big);
    const batches = batchForUpload(plan, 40_000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((v) => v.clientId)).toEqual(many.map((v) => v.id));
    for (const batch of batches) expect(batch.length === 1 || JSON.stringify(batch).length <= 41_000).toBe(true);
    expect(batchForUpload(plan)).toHaveLength(1);
  });
});

describe("after an import", () => {
  const stores: DeviceStores = {
    maintenance: { "g-camry": [record("m1"), record("m-bad", { date: "" })], "g-civic": [record("m4")], "srv-focus": [record("m2")] },
    guestSessions: { "g-camry": [session("d1"), session("d-bad", { finalRankedCauses: [] })], "g-civic": [session("d4")] },
    accountSessions: { "srv-focus": [session("d2")] },
  };
  const plan = planDeviceImport([camry, civic], [accountFocus], stores);

  it("removes from the device only what the account took", () => {
    const next = applyImportOutcomes(stores, plan, [
      { clientId: "g-camry", outcome: "imported", vehicleId: "srv-1", maintenance: 1, diagnoses: 1 },
      { clientId: "g-civic", outcome: "duplicate", vehicleId: "srv-civic", maintenance: 0, diagnoses: 0 },
      { clientId: "account:srv-focus", outcome: "attached", vehicleId: "srv-focus", maintenance: 1, diagnoses: 1 },
    ]);

    // The duplicate keeps everything on the device, untouched.
    expect(next.maintenance["g-civic"]).toEqual(stores.maintenance["g-civic"]);
    expect(next.guestSessions["g-civic"]).toEqual(stores.guestSessions["g-civic"]);

    // History the account took is gone, and is not kept a second time under the new id.
    expect(next.maintenance["srv-focus"]).toBeUndefined();
    expect(next.accountSessions["srv-focus"]).toBeUndefined();
    expect(next.maintenance["g-camry"]).toBeUndefined();
    expect(next.guestSessions["g-camry"]).toBeUndefined();

    // What could not be sent is still on the device, now under the account's vehicle.
    expect(next.maintenance["srv-1"]).toEqual([{ ...record("m-bad", { date: "" }), vehicleId: "srv-1" }]);
    expect(next.accountSessions["srv-1"]).toEqual([{ ...session("d-bad", { finalRankedCauses: [] }), vehicleId: "srv-1" }]);

    // The input was not modified.
    expect(stores.maintenance["g-camry"]).toHaveLength(2);
  });

  it("changes nothing for a vehicle that failed, or that got no answer", () => {
    const next = applyImportOutcomes(stores, plan, [{ clientId: "g-camry", outcome: "failed", vehicleId: null, maintenance: 0, diagnoses: 0 }]);
    expect(next).toEqual(stores);
  });

  it("totals what was copied for the note the user sees", () => {
    expect(
      summarizeOutcomes([
        { clientId: "a", outcome: "imported", vehicleId: "1", maintenance: 2, diagnoses: 1 },
        { clientId: "b", outcome: "attached", vehicleId: "2", maintenance: 1, diagnoses: 0 },
        { clientId: "c", outcome: "duplicate", vehicleId: "3", maintenance: 0, diagnoses: 0 },
        { clientId: "d", outcome: "failed", vehicleId: null, maintenance: 0, diagnoses: 0 },
      ]),
    ).toEqual({ imported: 1, attached: 1, duplicates: 1, failed: 1, records: 3, diagnoses: 1 });
  });
});
