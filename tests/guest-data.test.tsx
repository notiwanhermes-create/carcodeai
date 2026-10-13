// @vitest-environment jsdom
/**
 * Guest data must survive signing in. Copying it into the account must be
 * explicit: the user sees what will be copied first, duplicates are reported
 * and never merged, and anything not copied stays on the device.
 *
 * Once signed in, history lives in the account: nothing new is kept on the
 * device for a signed-in user.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor, fireEvent, within } from "@testing-library/react";

const { sessionState } = vi.hoisted(() => ({
  sessionState: { value: { data: null as null | { user: { id: string; email: string } }, status: "unauthenticated" } },
}));

vi.mock("next-auth/react", () => ({
  useSession: () => sessionState.value,
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

import Home from "../app/page";
import { sameVehicle } from "../app/lib/garage-import";
import { isSameVehicle, useGarageVehicles, type GarageVehicle } from "../app/lib/useGarageVehicles";

const ANON_KEY = "carcode_garage_v1:anon";
const MAINT_KEY = "carcode_maintenance_v1";
const GUEST_SESSIONS_KEY = "carcode_diagnosis_sessions_v1:anon";
const USER_SESSIONS_KEY = "carcode_diagnosis_sessions_v1:user:user-1";

const camry: GarageVehicle = { id: "local-camry", year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4" };
const civic: GarageVehicle = { id: "local-civic", year: "2018", make: "Honda", model: "Civic" };
const focus: GarageVehicle = { id: "local-focus", year: "2012", make: "Ford", model: "Focus" };

const oilChange = (vehicleId: string) => ({ id: `m-${vehicleId}`, vehicleId, type: "Oil Change", date: "2026-01-01", mileageValue: 130250, mileageUnit: "km", notes: "" });
const savedDiagnosis = (vehicleId: string) => ({
  id: `d-${vehicleId}`,
  vehicleId,
  timestamp: "2026-01-02T00:00:00Z",
  issueText: "Code: P0300",
  code: "P0300",
  vehicle: camry,
  followUpAnswers: {},
  finalRankedCauses: [{ id: "c1", title: "Worn spark plugs", whyLikely: ["Misfire code"], confirm: ["Inspect the plugs"], fix: ["Replace the plugs"] }],
});

function seedGuestGarage(vehicles: GarageVehicle[]) {
  localStorage.setItem(ANON_KEY, JSON.stringify({ garage: vehicles, activeId: vehicles[0]?.id ?? null }));
}
const stored = (key: string) => JSON.parse(localStorage.getItem(key) || "{}");
const guestGarage = () => stored(ANON_KEY).garage as GarageVehicle[] | undefined;

type ImportRequest = { vehicles: Array<{ clientId: string; existingVehicleId?: string; year: string; make: string; model: string; engine: string; maintenance: unknown[]; diagnoses: Array<{ key: string }> }> };

/**
 * A stand-in for the account: /api/garage, /api/garage/import, /api/maintenance
 * and /api/diagnose, backed by in-memory lists. The import follows the server's
 * rule: a vehicle already in the account is a duplicate and nothing is copied.
 */
function mockAccount(initial: GarageVehicle[] = [], opts: { importFails?: boolean; maintenance?: unknown[] } = {}) {
  const account = [...initial];
  let nextId = 1;
  const imports: ImportRequest[] = [];
  const diagnoses: Array<Record<string, unknown>> = [];
  const maintenancePosts: Array<Record<string, unknown>> = [];
  const maintenance = [...(opts.maintenance ?? [])];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method || "GET";
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

      if (url.includes("/api/garage/import")) {
        if (opts.importFails) return json({ error: "Server said no." }, 500);
        const body = JSON.parse(String(init?.body)) as ImportRequest;
        imports.push(body);
        return json({
          results: body.vehicles.map((v) => {
            if (v.existingVehicleId) return { clientId: v.clientId, outcome: "attached", vehicleId: v.existingVehicleId, maintenance: v.maintenance.length, diagnoses: v.diagnoses.length };
            const twin = account.find((a) => sameVehicle(a, v));
            if (twin) return { clientId: v.clientId, outcome: "duplicate", vehicleId: twin.id, maintenance: 0, diagnoses: 0 };
            const created = { id: `srv-${nextId++}`, year: v.year, make: v.make, model: v.model, engine: v.engine || undefined };
            account.unshift(created);
            return { clientId: v.clientId, outcome: "imported", vehicleId: created.id, maintenance: v.maintenance.length, diagnoses: v.diagnoses.length };
          }),
        });
      }
      if (url.includes("/api/garage")) return json({ vehicles: account });
      if (url.includes("/api/maintenance")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          maintenancePosts.push(body);
          const record = { id: `rec-${maintenancePosts.length}`, vehicleId: body.vehicleId, serviceType: body.serviceType, date: body.date, serviceDate: body.date, odometer: body.odometer, odometerValue: body.odometer ? Number(body.odometer) : null, odometerUnit: body.odometerUnit ?? null, notes: body.notes, createdAt: "2026-10-13T00:00:00Z" };
          maintenance.unshift(record);
          return json({ record });
        }
        return json({ records: maintenance });
      }
      if (url.includes("/api/diagnose")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        diagnoses.push(body);
        return json({
          diagnosis: {
            summary: "Most likely an ignition problem, but this is not confirmed.",
            drive_guidance: { level: "unknown", reason: "Not enough information to judge.", adjusted: null },
            causes: [{ id: "c1", rank: 1, title: "Worn spark plugs", explanation: "Old plugs misfire.", why_it_fits: ["Fits."], likelihood: "likely", urgency: "normal", checks: [{ instruction: "Inspect the plugs.", level: "owner" }], recommended_action: "Replace the plugs.", repair_level: "diy_easy" }],
            follow_up_questions: [],
            limitations: [],
          },
          codes: [],
          refined: false,
          followUp: { token: "ticket-1", remaining: 2 },
          saved: typeof body.vehicleId === "string" ? { id: "dx-1", vehicleId: body.vehicleId } : null,
        });
      }
      return json({});
    }),
  );
  return { account, imports, diagnoses, maintenancePosts };
}

const signIn = () => {
  sessionState.value = { data: { user: { id: "user-1", email: "me@example.test" } }, status: "authenticated" };
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("carcode_onboarded_v1", "1");
  sessionState.value = { data: null, status: "unauthenticated" };
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("isSameVehicle", () => {
  it("matches on VIN when both have one, otherwise on year/make/model/engine", () => {
    expect(isSameVehicle({ ...camry, vin: "1HGCM82633A004352" }, { ...civic, vin: "1hgcm82633a004352" })).toBe(true);
    expect(isSameVehicle({ ...camry, vin: "AAA" }, { ...camry, vin: "BBB" })).toBe(false);
    expect(isSameVehicle(camry, { ...camry, make: " toyota ", model: "CAMRY" })).toBe(true);
    expect(isSameVehicle(camry, { ...camry, engine: "3.5L V6" })).toBe(false);
  });
});

describe("guest garage and signing in", () => {
  it("does not delete the guest garage when a user signs in", async () => {
    seedGuestGarage([camry, civic]);
    mockAccount([]);

    const { result, rerender } = renderHook(({ userId, ready }: { userId?: string; ready: boolean }) => useGarageVehicles({ userId, ready }), {
      initialProps: { userId: undefined as string | undefined, ready: true },
    });
    await waitFor(() => expect(result.current.vehicles).toHaveLength(2));

    rerender({ userId: "user-1", ready: true });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await waitFor(() => expect(result.current.guestVehicles).toHaveLength(2));

    // Still on the device, untouched; the account list is separate (empty).
    expect(guestGarage()).toEqual([camry, civic]);
    expect(result.current.vehicles).toHaveLength(0);

    // Signing out again shows the guest garage as it was.
    rerender({ userId: undefined, ready: true });
    await waitFor(() => expect(result.current.vehicles).toHaveLength(2));
    expect(guestGarage()).toEqual([camry, civic]);
  });

  it("loads nothing while the session is still being checked", async () => {
    seedGuestGarage([camry]);
    mockAccount([]);
    const { result } = renderHook(() => useGarageVehicles({ userId: undefined, ready: false }));
    expect(result.current.hydrated).toBe(false);
    expect(result.current.vehicles).toHaveLength(0);
    expect(guestGarage()).toEqual([camry]);
  });

  it("removes an account's cached vehicle list from the browser once signed out, and keeps the guest garage", async () => {
    seedGuestGarage([camry]);
    localStorage.setItem("carcode_garage_v1:user:user-1", JSON.stringify({ garage: [{ ...civic, id: "srv-1", vin: "2HGFC2F59JH000000" }], activeId: "srv-1" }));
    localStorage.setItem("carcode_garage_v1:user:user-2", JSON.stringify({ garage: [focus], activeId: focus.id }));
    mockAccount([]);

    // Opened signed out, as after a sign-out that reloaded the page.
    const { result } = renderHook(() => useGarageVehicles({ userId: undefined, ready: true }));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    expect(localStorage.getItem("carcode_garage_v1:user:user-1")).toBeNull();
    expect(localStorage.getItem("carcode_garage_v1:user:user-2")).toBeNull();
    // The guest garage is this browser's own data and is untouched.
    expect(guestGarage()).toEqual([camry]);
    expect(result.current.vehicles).toEqual([camry]);
  });

  it("signed in, keeps only that account's own cached list", async () => {
    localStorage.setItem("carcode_garage_v1:user:user-2", JSON.stringify({ garage: [focus], activeId: focus.id }));
    mockAccount([{ ...civic, id: "srv-1" }]);

    const { result } = renderHook(() => useGarageVehicles({ userId: "user-1", ready: true }));
    await waitFor(() => expect(result.current.vehicles.map((v) => v.id)).toEqual(["srv-1"]));

    expect(localStorage.getItem("carcode_garage_v1:user:user-2")).toBeNull();
    await waitFor(() => expect(stored("carcode_garage_v1:user:user-1").garage).toHaveLength(1));
  });

  it("after an import, takes only the imported vehicles off the device", async () => {
    seedGuestGarage([camry, civic, focus]);
    mockAccount([{ ...camry, id: "srv-existing" }, { ...civic, id: "srv-1" }]);

    const { result } = renderHook(() => useGarageVehicles({ userId: "user-1", ready: true }));
    await waitFor(() => expect(result.current.guestVehicles).toHaveLength(3));

    await act(async () => {
      await result.current.finishDeviceImport([
        { clientId: "local-civic", outcome: "imported" },
        { clientId: "local-camry", outcome: "duplicate" },
        { clientId: "local-focus", outcome: "failed" },
      ]);
    });

    // The imported vehicle left the device; the duplicate and the failure are still there.
    expect(guestGarage()?.map((v) => v.id)).toEqual(["local-camry", "local-focus"]);
    // The duplicate is not offered again; the failure can be retried.
    expect(result.current.guestVehicles.map((v) => v.id)).toEqual(["local-focus"]);
    // The account list was reloaded from the server.
    expect(result.current.vehicles.map((v) => v.id).sort()).toEqual(["srv-1", "srv-existing"]);
  });

  it("'Not now' hides the offer but keeps the vehicles on the device", async () => {
    seedGuestGarage([camry]);
    mockAccount([]);
    const { result } = renderHook(() => useGarageVehicles({ userId: "user-1", ready: true }));
    await waitFor(() => expect(result.current.guestVehicles).toHaveLength(1));

    act(() => result.current.dismissGuestVehicles());
    expect(result.current.guestVehicles).toHaveLength(0);
    expect(guestGarage()).toEqual([camry]);
  });
});

describe("Home page: copying what this device holds into the account", () => {
  function seedCamryHistory() {
    seedGuestGarage([camry]);
    localStorage.setItem(MAINT_KEY, JSON.stringify({ "local-camry": [oilChange("local-camry")] }));
    localStorage.setItem(GUEST_SESSIONS_KEY, JSON.stringify({ "local-camry": [savedDiagnosis("local-camry")] }));
  }

  it("never wipes stored data on load, shows what will be copied, and sends nothing until the user confirms", async () => {
    seedCamryHistory();
    const api = mockAccount([]);

    // 1) As a guest: loading the page must not overwrite what is stored. StrictMode
    //    runs effects twice (as `next dev` does), which is where an early write would bite.
    const guestView = render(
      <React.StrictMode>
        <Home />
      </React.StrictMode>,
    );
    await screen.findByRole("button", { name: "Diagnose" });
    await waitFor(() => expect(stored(MAINT_KEY)["local-camry"]).toHaveLength(1));
    expect(stored(GUEST_SESSIONS_KEY)["local-camry"]).toHaveLength(1);
    guestView.unmount();

    // 2) Signed in: the guest's data is still there and an import is offered, not done.
    signIn();
    render(<Home />);
    const importButton = await screen.findByRole("button", { name: "Import vehicles from this device" });
    expect(guestGarage()).toEqual([camry]);
    expect(api.imports).toHaveLength(0);

    // 3) The user is shown exactly what will be copied. Still nothing is sent.
    fireEvent.click(importButton);
    const preview = document.querySelector("[data-import-preview]") as HTMLElement;
    expect(within(preview).getByText(/2015 Toyota Camry/)).toBeTruthy();
    expect(within(preview).getByText("New vehicle")).toBeTruthy();
    expect(within(preview).getByText(/Service records: 1 · Saved diagnoses: 1/)).toBeTruthy();
    expect(api.imports).toHaveLength(0);

    // 4) Confirmed: the vehicle and its history go to the account in one request.
    fireEvent.click(screen.getByRole("button", { name: "Copy to my account" }));
    await screen.findByText(/1 imported to your account/);
    expect(api.imports).toHaveLength(1);
    const sent = api.imports[0].vehicles[0];
    expect(sent).toMatchObject({ clientId: "local-camry", year: "2015", make: "Toyota", model: "Camry" });
    expect(sent.maintenance).toEqual([{ type: "Oil Change", date: "2026-01-01", odometerValue: 130250, odometerUnit: "km", notes: "" }]);
    expect(sent.diagnoses).toHaveLength(1);
    expect(sent.diagnoses[0]).toMatchObject({ key: "d-local-camry", code: "P0300", causes: [{ title: "Worn spark plugs" }] });

    // 5) What the account took is gone from the device, and is NOT kept there a second time.
    expect(guestGarage()).toEqual([]);
    await waitFor(() => {
      expect(stored(MAINT_KEY)["local-camry"]).toBeUndefined();
      expect(stored(MAINT_KEY)["srv-1"]).toBeUndefined();
    });
    expect(stored(GUEST_SESSIONS_KEY)["local-camry"]).toBeUndefined();
    expect(stored(USER_SESSIONS_KEY)["srv-1"]).toBeUndefined();
  });

  it("can be cancelled from the preview without sending or changing anything", async () => {
    seedCamryHistory();
    const api = mockAccount([]);
    signIn();
    render(<Home />);

    fireEvent.click(await screen.findByRole("button", { name: "Import vehicles from this device" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(document.querySelector("[data-import-preview]")).toBeNull();
    expect(api.imports).toHaveLength(0);
    expect(guestGarage()).toEqual([camry]);
    expect(stored(MAINT_KEY)["local-camry"]).toHaveLength(1);
  });

  it("reports a vehicle that is already in the account and leaves it, with its history, on the device", async () => {
    seedCamryHistory();
    const api = mockAccount([{ ...camry, id: "srv-existing" }]);
    signIn();
    render(<Home />);

    fireEvent.click(await screen.findByRole("button", { name: "Import vehicles from this device" }));
    expect(document.querySelector('[data-import-kind="likely_duplicate"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy to my account" }));
    await screen.findByText(/1 skipped \(already in your account; still saved on this device\)/);

    // Nothing was merged into the account's vehicle, and nothing left the device.
    expect(api.account).toHaveLength(1);
    expect(guestGarage()).toEqual([camry]);
    expect(stored(MAINT_KEY)["local-camry"]).toHaveLength(1);
    expect(stored(GUEST_SESSIONS_KEY)["local-camry"]).toHaveLength(1);
  });

  it("offers history an earlier version kept on the device for a vehicle already in the account", async () => {
    const accountCamry = { ...camry, id: "srv-9" };
    localStorage.setItem(MAINT_KEY, JSON.stringify({ "srv-9": [oilChange("srv-9")] }));
    localStorage.setItem(USER_SESSIONS_KEY, JSON.stringify({ "srv-9": [savedDiagnosis("srv-9")] }));
    const api = mockAccount([accountCamry]);
    signIn();
    render(<Home />);

    fireEvent.click(await screen.findByRole("button", { name: "Import history from this device" }));
    expect(screen.getByText("Already in your account: only this history is added")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy to my account" }));
    await screen.findByText(/1 already in your account: history added/);

    expect(api.imports[0].vehicles[0]).toMatchObject({ existingVehicleId: "srv-9" });
    expect(api.imports[0].vehicles[0].maintenance).toHaveLength(1);
    expect(api.imports[0].vehicles[0].diagnoses).toHaveLength(1);
    expect(api.account).toHaveLength(1); // no second Camry
    await waitFor(() => expect(stored(MAINT_KEY)["srv-9"]).toBeUndefined());
    expect(stored(USER_SESSIONS_KEY)["srv-9"]).toBeUndefined();
  });

  it("leaves everything on the device when the import fails", async () => {
    seedCamryHistory();
    mockAccount([], { importFails: true });
    signIn();
    render(<Home />);

    fireEvent.click(await screen.findByRole("button", { name: "Import vehicles from this device" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy to my account" }));
    await screen.findByText(/Import failed\. Your vehicles are still saved on this device/);

    expect(guestGarage()).toEqual([camry]);
    expect(stored(MAINT_KEY)["local-camry"]).toHaveLength(1);
    expect(stored(GUEST_SESSIONS_KEY)["local-camry"]).toHaveLength(1);
  });
});

describe("Home page: where history is kept", () => {
  async function diagnose(code: string) {
    fireEvent.click(await screen.findByRole("button", { name: "Diagnose" }));
    await waitFor(() => expect(document.querySelector('input[name="code"]')).not.toBeNull());
    const input = document.querySelector('input[name="code"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: code } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await screen.findByText(/Most likely an ignition problem/);
  }

  it("signed in: the diagnosis is saved to the account, linked from the result, and not kept on the device", async () => {
    const api = mockAccount([{ ...camry, id: "srv-9" }]);
    signIn();
    render(<Home />);
    await waitFor(() => expect(screen.getAllByText(/2015 Toyota Camry/).length).toBeGreaterThan(0));

    await diagnose("P0300");

    // The request names the garage vehicle, so the server can save it there.
    expect(api.diagnoses[0]).toMatchObject({ code: "P0300", vehicleId: "srv-9" });
    const link = document.querySelector("[data-saved-diagnosis]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/garage/srv-9/diagnosis/dx-1");
    expect(link.textContent).toContain("Saved to this vehicle's history");

    // There is no second, on-device history for a signed-in user.
    expect(screen.queryByRole("button", { name: "Save to vehicle history" })).toBeNull();
    expect(stored(USER_SESSIONS_KEY)).toEqual({});
    expect(stored(GUEST_SESSIONS_KEY)).toEqual({});
  });

  it("guest: nothing is sent to an account, and the diagnosis can be saved on the device", async () => {
    seedGuestGarage([camry]);
    const api = mockAccount([]);
    render(<Home />);

    await diagnose("P0300");

    expect(api.diagnoses[0].vehicleId).toBeUndefined();
    expect(document.querySelector("[data-saved-diagnosis]")).toBeNull();
    expect(document.querySelector("[data-not-saved]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save to vehicle history" }));
    await waitFor(() => expect(stored(GUEST_SESSIONS_KEY)["local-camry"]).toHaveLength(1));
  });

  it("signed in: the Maintenance tab reads and writes the account, with the unit that was recorded", async () => {
    const onFile = { id: "rec-0", vehicleId: "srv-9", serviceType: "Brake Service", date: "2026-05-01", serviceDate: "2026-05-01", odometer: "130,250 km", odometerValue: 130250, odometerUnit: "km", createdAt: "2026-05-01T00:00:00Z" };
    const api = mockAccount([{ ...camry, id: "srv-9", odometerUnit: "km" }], { maintenance: [onFile] });
    signIn();
    render(<Home />);

    fireEvent.click(await screen.findByRole("button", { name: "Maintenance" }));
    await waitFor(() => expect(document.querySelector("[data-odometer]")).not.toBeNull());
    // The reading is shown with its own unit: never "km miles".
    expect((document.querySelector("[data-odometer]") as HTMLElement).textContent).toBe("130,250 km");
    expect(document.body.textContent).not.toMatch(/km miles/);

    const form = document.querySelector('select[name="maint_type"]')?.closest("form") as HTMLFormElement;
    fireEvent.change(form.querySelector('input[name="maint_mileage"]') as HTMLInputElement, { target: { value: "131000" } });
    fireEvent.submit(form);

    await waitFor(() => expect(api.maintenancePosts).toHaveLength(1));
    expect(api.maintenancePosts[0]).toMatchObject({ vehicleId: "srv-9", serviceType: "Oil Change", odometer: "131000", odometerUnit: "km" });
    await waitFor(() => expect(document.querySelectorAll("[data-odometer]")).toHaveLength(2));
    // Nothing was written to the device's own list.
    expect(stored(MAINT_KEY)).toEqual({});
  });

  it("guest: a service record stays on the device and a reading with no unit is shown without one", async () => {
    seedGuestGarage([camry]);
    localStorage.setItem(MAINT_KEY, JSON.stringify({ "local-camry": [{ id: "old", vehicleId: "local-camry", type: "Oil Change", date: "2025-01-01", mileage: "98,000", notes: "" }] }));
    const api = mockAccount([]);
    render(<Home />);

    fireEvent.click(await screen.findByRole("button", { name: "Maintenance" }));
    await waitFor(() => expect(document.querySelector("[data-odometer]")).not.toBeNull());
    // The old record never said km or mi, so neither is claimed.
    expect((document.querySelector("[data-odometer]") as HTMLElement).textContent).toBe("98,000");

    const form = document.querySelector('select[name="maint_type"]')?.closest("form") as HTMLFormElement;
    fireEvent.change(form.querySelector('input[name="maint_mileage"]') as HTMLInputElement, { target: { value: "99000" } });
    fireEvent.change(form.querySelector('select[name="maint_mileage_unit"]') as HTMLSelectElement, { target: { value: "mi" } });
    fireEvent.submit(form);

    await waitFor(() => expect(stored(MAINT_KEY)["local-camry"]).toHaveLength(2));
    expect(stored(MAINT_KEY)["local-camry"][0]).toMatchObject({ mileageValue: 99000, mileageUnit: "mi" });
    expect(api.maintenancePosts).toHaveLength(0);
  });
});
