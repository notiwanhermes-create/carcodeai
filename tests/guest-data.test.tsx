// @vitest-environment jsdom
/**
 * Guest data must survive signing in, and importing it must be explicit,
 * report duplicates, and leave anything not imported on the device.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor, fireEvent } from "@testing-library/react";

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
import { isSameVehicle, useGarageVehicles, type GarageVehicle } from "../app/lib/useGarageVehicles";

const ANON_KEY = "carcode_garage_v1:anon";
const camry: GarageVehicle = { id: "local-camry", year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4" };
const civic: GarageVehicle = { id: "local-civic", year: "2018", make: "Honda", model: "Civic" };

function seedGuestGarage(vehicles: GarageVehicle[]) {
  localStorage.setItem(ANON_KEY, JSON.stringify({ garage: vehicles, activeId: vehicles[0]?.id ?? null }));
}
const guestGarage = () => JSON.parse(localStorage.getItem(ANON_KEY) || "{}").garage as GarageVehicle[] | undefined;

/** Fake /api/garage backed by an in-memory list. */
function mockGarageApi(initial: GarageVehicle[] = [], opts: { failMakes?: string[] } = {}) {
  const account = [...initial];
  let nextId = 1;
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.includes("/api/garage")) {
        if ((init?.method || "GET") === "POST") {
          const body = JSON.parse(String(init?.body)) as Omit<GarageVehicle, "id">;
          posts.push(body);
          if (opts.failMakes?.includes(body.make)) return json({ error: "Server said no." }, 500);
          const created = { ...body, id: `srv-${nextId++}` };
          account.unshift(created);
          return json({ vehicle: created });
        }
        return json({ vehicles: account });
      }
      return json({});
    }),
  );
  return { account, posts };
}

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
    mockGarageApi([]);

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
    mockGarageApi([]);
    const { result } = renderHook(() => useGarageVehicles({ userId: undefined, ready: false }));
    expect(result.current.hydrated).toBe(false);
    expect(result.current.vehicles).toHaveLength(0);
    expect(guestGarage()).toEqual([camry]);
  });

  it("imports only when asked, reports duplicates, and leaves the rest on the device", async () => {
    seedGuestGarage([camry, civic]);
    const accountCamry = { ...camry, id: "srv-existing" };
    const api = mockGarageApi([accountCamry]);

    const { result } = renderHook(() => useGarageVehicles({ userId: "user-1", ready: true }));
    await waitFor(() => expect(result.current.guestVehicles).toHaveLength(2));
    expect(api.posts).toHaveLength(0); // nothing imported automatically

    let outcome: Awaited<ReturnType<typeof result.current.importGuestVehicles>> | undefined;
    await act(async () => {
      outcome = await result.current.importGuestVehicles();
    });

    expect(outcome?.imported.map((x) => x.from.id)).toEqual(["local-civic"]);
    expect(outcome?.duplicates.map((x) => x.from.id)).toEqual(["local-camry"]);
    expect(outcome?.duplicates[0].existing.id).toBe("srv-existing");
    expect(api.posts).toHaveLength(1); // the duplicate was NOT created again
    expect(api.account).toHaveLength(2);

    // The imported vehicle left the device copy; the duplicate is still there.
    expect(guestGarage()?.map((v) => v.id)).toEqual(["local-camry"]);
    // And it is no longer offered again.
    expect(result.current.guestVehicles).toHaveLength(0);
    expect(result.current.vehicles.map((v) => v.id).sort()).toEqual(["srv-1", "srv-existing"]);
  });

  it("keeps a vehicle on the device when saving it to the account fails", async () => {
    seedGuestGarage([camry, civic]);
    mockGarageApi([], { failMakes: ["Honda"] });

    const { result } = renderHook(() => useGarageVehicles({ userId: "user-1", ready: true }));
    await waitFor(() => expect(result.current.guestVehicles).toHaveLength(2));

    let outcome: Awaited<ReturnType<typeof result.current.importGuestVehicles>> | undefined;
    await act(async () => {
      outcome = await result.current.importGuestVehicles();
    });

    expect(outcome?.imported).toHaveLength(1);
    expect(outcome?.failed.map((x) => x.from.id)).toEqual(["local-civic"]);
    expect(guestGarage()?.map((v) => v.id)).toEqual(["local-civic"]);
    expect(result.current.guestVehicles.map((v) => v.id)).toEqual(["local-civic"]); // can be retried
  });

  it("'Not now' hides the offer but keeps the vehicles on the device", async () => {
    seedGuestGarage([camry]);
    mockGarageApi([]);
    const { result } = renderHook(() => useGarageVehicles({ userId: "user-1", ready: true }));
    await waitFor(() => expect(result.current.guestVehicles).toHaveLength(1));

    act(() => result.current.dismissGuestVehicles());
    expect(result.current.guestVehicles).toHaveLength(0);
    expect(guestGarage()).toEqual([camry]);
  });
});

describe("Home page: import offer, service records and saved diagnoses", () => {
  it("moves on-device history to the imported vehicle and never wipes stored data on load", async () => {
    seedGuestGarage([camry]);
    localStorage.setItem(
      "carcode_maintenance_v1",
      JSON.stringify({ "local-camry": [{ id: "m1", vehicleId: "local-camry", type: "Oil Change", date: "2026-01-01", notes: "" }] }),
    );
    localStorage.setItem(
      "carcode_diagnosis_sessions_v1:anon",
      JSON.stringify({
        "local-camry": [
          { id: "d1", vehicleId: "local-camry", timestamp: "2026-01-02T00:00:00Z", issueText: "Code: P0300", vehicle: camry, followUpAnswers: {}, finalRankedCauses: [] },
        ],
      }),
    );
    mockGarageApi([]);

    // 1) As a guest: loading the page must not overwrite what is stored. StrictMode
    //    runs effects twice (as `next dev` does), which is where an early write would bite.
    const guestView = render(
      <React.StrictMode>
        <Home />
      </React.StrictMode>,
    );
    await screen.findByRole("button", { name: "Diagnose" });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("carcode_maintenance_v1") || "{}")["local-camry"]).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem("carcode_diagnosis_sessions_v1:anon") || "{}")["local-camry"]).toHaveLength(1);
    guestView.unmount();

    // 2) Signed in: the guest's data is still there and an import is offered.
    sessionState.value = { data: { user: { id: "user-1", email: "me@example.test" } }, status: "authenticated" };
    render(<Home />);
    const importButton = await screen.findByRole("button", { name: "Import vehicles from this device" });
    expect(guestGarage()).toEqual([camry]);
    expect(JSON.parse(localStorage.getItem("carcode_diagnosis_sessions_v1:anon") || "{}")["local-camry"]).toHaveLength(1);

    // 3) Import: the vehicle joins the account and its history follows it.
    fireEvent.click(importButton);
    await screen.findByText(/1 imported to your account/);

    expect(guestGarage()).toEqual([]);
    await waitFor(() => {
      const maintenance = JSON.parse(localStorage.getItem("carcode_maintenance_v1") || "{}");
      expect(maintenance["srv-1"]).toHaveLength(1);
      expect(maintenance["srv-1"][0].vehicleId).toBe("srv-1");
      expect(maintenance["local-camry"]).toBeUndefined();
    });
    await waitFor(() => {
      const userSessions = JSON.parse(localStorage.getItem("carcode_diagnosis_sessions_v1:user:user-1") || "{}");
      expect(userSessions["srv-1"]).toHaveLength(1);
      expect(userSessions["srv-1"][0].vehicleId).toBe("srv-1");
    });
    expect(JSON.parse(localStorage.getItem("carcode_diagnosis_sessions_v1:anon") || "{}")["local-camry"]).toBeUndefined();
  });
});
