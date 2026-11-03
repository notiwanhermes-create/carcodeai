// @vitest-environment jsdom
/**
 * S12: the gate, the Connect Scanner entries, and what `/scanner` shows. The
 * browser APIs here are SCRIPTED doubles of `navigator.bluetooth` and
 * `navigator.serial`; nothing here touched a real browser API, adapter or
 * vehicle.
 */
import React from "react";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { notFound, push } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  push: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ notFound, useRouter: () => ({ push }) }));

import VehicleClient from "../app/garage/[id]/VehicleClient";
import { parseScannerVehicle, scannerBackLink, scannerEntryBuilt, scannerHref, scannerPreviewEnabled } from "../app/lib/scanner-preview";
import ScannerClient, { PREVIEW_BANNER } from "../app/scanner/ScannerClient";
import ScannerPage, { metadata } from "../app/scanner/page";
import { outcomeText } from "../components/scanner/ScannerPanels";
import { deferred, fakeBle18f0, FakeBleLink, FakeSerialLink, scriptedVehicle } from "./helpers/scanner-browser-fakes";

const CONTEXT = { id: "veh-1", year: "2015", make: "Toyota", model: "Camry", returnTo: "garage" as const };

function browser(apis: { bluetooth?: FakeBleLink; serial?: FakeSerialLink; secure?: boolean }) {
  vi.stubGlobal("isSecureContext", apis.secure ?? true);
  for (const [name, value] of [["bluetooth", apis.bluetooth?.api], ["serial", apis.serial?.api]] as const) {
    Object.defineProperty(navigator, name, { value, configurable: true });
  }
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in the preview"))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (navigator as { bluetooth?: unknown }).bluetooth;
  delete (navigator as { serial?: unknown }).serial;
});

describe("the gate", () => {
  it("is open under development or test, open with the flag on a built site, and closed otherwise, an unknown or missing NODE_ENV included", () => {
    expect(scannerPreviewEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(scannerPreviewEnabled({ NODE_ENV: "test" })).toBe(true);
    expect(scannerPreviewEnabled({ NODE_ENV: "production", CARCODE_SCANNER_PREVIEW: "1" })).toBe(true);
    expect(scannerPreviewEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(scannerPreviewEnabled({ NODE_ENV: "staging" })).toBe(false);
    expect(scannerPreviewEnabled({})).toBe(false);
    expect(scannerPreviewEnabled({ NODE_ENV: "production", CARCODE_SCANNER_PREVIEW: "true" })).toBe(false);
    expect(scannerPreviewEnabled({ NODE_ENV: "production", GUIDED_DIAGNOSTICS_PREVIEW: "1" } as { NODE_ENV: string })).toBe(false);
  });

  it("the route answers not found when closed and renders when open, and is never indexed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CARCODE_SCANNER_PREVIEW", "");
    await expect(ScannerPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
    vi.stubEnv("CARCODE_SCANNER_PREVIEW", "1");
    const page = await ScannerPage({ searchParams: Promise.resolve({ vehicle: "veh-1", year: "2015", make: "Toyota", model: "Camry" }) });
    expect((page as React.ReactElement<{ vehicle: unknown }>).props.vehicle).toMatchObject({ id: "veh-1", returnTo: "garage" });
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("the route, its client and its panels use no auth, database, API, AI or Guided Diagnostics, and persist nothing", () => {
    const root = path.resolve(__dirname, "..");
    const files = [
      ...readdirSync(path.join(root, "app/scanner")).map((name) => path.join(root, "app/scanner", name)),
      ...readdirSync(path.join(root, "components/scanner")).map((name) => path.join(root, "components/scanner", name)),
      path.join(root, "app/lib/scanner-preview.ts"),
    ];
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from "[^"]*(auth|prisma|diagnostic-workflow|openai|analytics|next-auth)[^"]*"/i);
      expect(source, file).not.toMatch(/\bfetch\(|localStorage|sessionStorage|indexedDB|use server/);
    }
  });
});

describe("Connect Scanner entries", () => {
  /** A fresh link module, so the once-per-page-load answer starts empty. */
  async function freshLink() {
    vi.resetModules();
    return (await import("../components/scanner/ConnectScannerLink")).ConnectScannerLink;
  }

  it("under development or test the home entry shows at once and asks nothing", async () => {
    const Link = await freshLink();
    render(<Link vehicle={CONTEXT} returnTo="vehicle" />);
    expect(screen.getByRole("link", { name: "Connect Scanner" }).getAttribute("href")).toContain("from=vehicle");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a built site with only the runtime flag shows the entry, because the route answers; no public build flag is involved", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(scannerEntryBuilt()).toBe(false);
    const route = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", route);
    const Link = await freshLink();
    const { container } = render(<><Link vehicle={CONTEXT} returnTo="garage" /><Link vehicle={null} returnTo="garage" /></>);
    expect(container.querySelector("[data-connect-scanner]")).toBeNull();
    await waitFor(() => expect(container.querySelectorAll("[data-connect-scanner]")).toHaveLength(2));
    // One same-origin HEAD to the route, however many links, with cookies so a login-protected preview answers it.
    expect(route).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledWith("/scanner", expect.objectContaining({ method: "HEAD", credentials: "same-origin" }));
  });

  it.each([
    ["not found", () => Promise.resolve(new Response(null, { status: 404 }))],
    ["a failed request", () => Promise.reject(new Error("offline"))],
  ])("a built site whose route gives %s keeps the entry hidden", async (_, answer) => {
    vi.stubEnv("NODE_ENV", "production");
    const route = vi.fn(answer);
    vi.stubGlobal("fetch", route);
    const Link = await freshLink();
    const { container } = render(<Link vehicle={CONTEXT} returnTo="garage" />);
    await waitFor(() => expect(route).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector("[data-connect-scanner]")).toBeNull();
  });

  it("the home page's Scan your car section starts a scan with no vehicle, so the car identifies itself, and follows the same gate", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const route = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", route);
    vi.resetModules();
    const { ScanCarCard } = await import("../components/scanner/ConnectScannerLink");
    const { container } = render(<ScanCarCard lang="ar" dark />);
    expect(container.querySelector("[data-scan-car]")).toBeNull();
    await waitFor(() => expect(container.querySelector("[data-scan-car-start]")).not.toBeNull());
    expect(container.querySelector("[data-scan-car-start]")?.getAttribute("href")).toBe("/scanner");
    expect(container.querySelector("h2")?.textContent).toBe("افحص سيارتك");
    expect(route).toHaveBeenCalledTimes(1);

    const home = readFileSync(path.resolve(__dirname, "../app/page.tsx"), "utf8");
    expect(home).toMatch(/<ScanCarCard lang=\{lang\} dark=\{theme === "dark"\}/);
  });

  it("the home garage offers the entry per vehicle and with an empty garage", () => {
    const home = readFileSync(path.resolve(__dirname, "../app/page.tsx"), "utf8");
    expect(home).toMatch(/<ConnectScannerLink vehicle=\{v\} returnTo=\{signedIn \? "vehicle" : "garage"\}/);
    expect(home).toMatch(/<ConnectScannerLink vehicle=\{null\} returnTo="garage"/);
  });

  it("the vehicle page links with its context only when the server says the gate is open", async () => {
    const detail = {
      vehicle: { id: "veh-1", year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4", trim: null, nickname: null, odometerValue: null, odometerUnit: null, odometerUpdatedAt: null, archivedAt: null, stats: { openIssues: 0, diagnoses: 0, lastDiagnosisAt: null, maintenanceRecords: 0, lastMaintenance: null, repairs: 0 } },
      openIssues: [],
      timeline: [],
      maintenance: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    const { unmount } = render(<VehicleClient vehicleId="veh-1" />);
    await screen.findByRole("link", { name: "Diagnose new problem" });
    expect(screen.queryByRole("link", { name: "Connect Scanner" })).toBeNull();
    unmount();
    render(<VehicleClient vehicleId="veh-1" scannerPreview />);
    const href = (await screen.findByRole("link", { name: "Connect Scanner" })).getAttribute("href")!;
    expect(parseScannerVehicle(Object.fromEntries(new URL(href, "http://x").searchParams))).toMatchObject({ id: "veh-1", make: "Toyota", engine: "2.5L I4", returnTo: "vehicle" });
  });
});

describe("vehicle context", () => {
  it("round-trips through the URL, without a VIN, and gives a safe way back", () => {
    const href = scannerHref({ ...CONTEXT, engine: "2.5L & more", vin: "1HGCM82633A004352" } as typeof CONTEXT, "garage");
    expect(href).not.toContain("1HGCM");
    const parsed = parseScannerVehicle(Object.fromEntries(new URL(href, "http://x").searchParams));
    expect(parsed).toMatchObject({ engine: "2.5L & more" });
    expect(scannerBackLink(parsed).href).toBe("/");
    expect(scannerBackLink({ ...CONTEXT, returnTo: "vehicle" }).href).toBe("/garage/veh-1");
    expect(scannerBackLink(null).href).toBe("/");
    expect(scannerHref(null)).toBe("/scanner");
  });

  it("refuses a missing, oversized, control-character or path-like value", () => {
    const good = { vehicle: "veh-1", year: "2015", make: "Toyota", model: "Camry" };
    expect(parseScannerVehicle(good)).not.toBeNull();
    expect(parseScannerVehicle({ ...good, vehicle: "../admin" })).toBeNull();
    expect(parseScannerVehicle({ ...good, make: "x".repeat(81) })).toBeNull();
    expect(parseScannerVehicle({ ...good, model: "a\nb" })).toBeNull();
    expect(parseScannerVehicle({ ...good, year: ["2015", "2016"] })).toBeNull();
    expect(parseScannerVehicle({ year: "2015" })).toBeNull();
  });
});

describe("the page", () => {
  it("states the preview limits and the vehicle, needs no session or network, and explains an unsupported browser", async () => {
    browser({});
    render(<ScannerClient vehicle={CONTEXT} />);
    expect(screen.getByRole("note").textContent).toBe(PREVIEW_BANNER);
    expect(PREVIEW_BANNER).toBe("Preview. Generic OBD-II only. Not all modules or codes are visible. Not tested with your adapter or vehicle.");
    expect(document.querySelector("[data-vehicle-context]")?.textContent).toBe("2015 Toyota Camry");
    expect(screen.getByRole("link", { name: "Back to garage" }).getAttribute("href")).toBe("/");
    await waitFor(() => expect(document.querySelectorAll("[data-unavailable]")).toHaveLength(2));
    expect(document.querySelector("[data-connect-ble]")).toBeNull();
    expect(document.querySelector("[data-connect-serial]")).toBeNull();
    expect(document.body.textContent).toContain("Classic Bluetooth (SPP) adapters");
    expect(document.body.textContent).toContain("only the outgoing port is expected to connect");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("works with no vehicle context", async () => {
    browser({ serial: new FakeSerialLink() });
    render(<ScannerClient vehicle={null} />);
    expect(document.querySelector("[data-vehicle-context]")).toBeNull();
    expect(document.querySelector("[data-identify-hint]")?.textContent).toContain("identifies the car from its VIN");
    await waitFor(() => expect(document.querySelector("[data-connect-serial]")).not.toBeNull());
  });

  it("offers profile choice, manual UUIDs and the all-devices chooser for Bluetooth", async () => {
    const ble = fakeBle18f0();
    browser({ bluetooth: ble });
    render(<ScannerClient vehicle={null} />);
    const select = (await screen.findByLabelText("Adapter profile")) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["documented", "ble_18f0", "ble_fff0", "manual"]);
    expect(select.textContent).toContain("unverified");
    expect(select.textContent).toContain("community-reported");
    fireEvent.change(select, { target: { value: "manual" } });
    fireEvent.change(screen.getByLabelText("service UUID"), { target: { value: "bad" } });
    fireEvent.click(document.querySelector("[data-connect-ble]")!);
    expect((await screen.findByRole("alert")).textContent).toContain("service UUID");
    expect(ble.requests).toEqual([]);
    fireEvent.change(select, { target: { value: "documented" } });
    fireEvent.click(screen.getByLabelText(/Show all Bluetooth devices/));
    fireEvent.click(document.querySelector("[data-connect-ble]")!);
    await waitFor(() => expect(ble.requests[0]).toMatchObject({ acceptAllDevices: true }));
    await waitFor(() => expect(document.querySelector("[data-link-info]")?.textContent).toContain("real-adapter validation pending"));
  });

  async function scanned(replies: ConstructorParameters<typeof FakeSerialLink>[0]) {
    browser({ serial: new FakeSerialLink(replies) });
    render(<ScannerClient vehicle={CONTEXT} />);
    await waitFor(() => expect(document.querySelector("[data-connect-serial]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-connect-serial]")!);
    await waitFor(() => expect((document.querySelector("[data-scan]") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(document.querySelector("[data-scan]")!);
    await waitFor(() => expect(document.querySelector("[data-freeze-frame]")).not.toBeNull());
  }

  it("conflicts built from pending decoding carry the badge and the explanation; others do not", async () => {
    await scanned(() => ({
      ...scriptedVehicle(),
      "0100": { lines: ["7E8 06 41 00 98 18 80 01", "7E9 06 41 00 98 18 80 00"] },
      "0101": { lines: ["7E8 06 41 01 81 07 65 04", "7E9 06 41 01 03 07 65 04"] },
      "03": { lines: ["7E8 04 43 01 01 33", "7E9 02 43 00"] },
      "010C": { lines: ["7E8 04 41 0C 0B B8", "7E9 04 41 0C 0C 00"] },
      "020200": { lines: ["7E8 05 42 02 00 02 44"] },
    }));
    const conflicts = document.querySelector("[data-conflicts]")!;
    for (const kind of ["dtc_count_mismatch", "mil_status_differs", "current_value_differs"]) {
      expect(conflicts.querySelector(`[data-conflict="${kind}"] [data-unverified]`), kind).not.toBeNull();
    }
    expect(conflicts.querySelector('[data-conflict="current_value_differs"]')?.textContent).toContain("750 rpm");
    expect(conflicts.querySelector('[data-conflict="freeze_frame_code_not_stored"] [data-unverified]')).toBeNull();
    const note = conflicts.parentElement!.querySelector("[data-unverified-note]");
    expect(note?.textContent).toMatch(/public secondary formulas and bit table\. The check against the licensed SAE J1979 standard is pending/);
  });

  it.each([
    ["no response", { lines: ["NO DATA"] }, "no response"],
    ["a malformed answer", { lines: ["7E8 04 42 02 00 01"] }, "malformed"],
  ])("freeze-frame support read but the stored code read gives %s: the page names that read and keeps its raw evidence", async (_, reply, expected) => {
    await scanned(() => ({ ...scriptedVehicle(), "020200": reply }));
    const frame = document.querySelector('[data-freeze-frame="obd-can11-7e8"]')!;
    expect(frame.textContent).toContain("Freeze-frame support was read, but the code it was stored for is not known:");
    expect(frame.textContent?.toLowerCase()).toContain(expected);
    expect(frame.textContent).not.toContain("Not known: Read");
    if (reply.lines[0] !== "NO DATA") expect(frame.querySelector("[data-raw]")?.textContent).toContain("7E8 04 42 02 00 01");
  });

  it("freeze-frame support read but PID 02 not listed: the page says the stored code read was not requested", async () => {
    await scanned(() => ({ ...scriptedVehicle(), "020000": { lines: ["7E8 07 42 00 00 18 18 00 00"] } }));
    const frame = document.querySelector('[data-freeze-frame="obd-can11-7e8"]')!;
    expect(frame.textContent).toContain("Freeze-frame support was read, but the code it was stored for is not known:");
    expect(frame.textContent).toContain("so not requested");
    expect(frame.textContent).not.toContain("Not known: Read");
  });

  it("connects a paired COM port, scans, and shows attributed, pending evidence with raw bytes and the log", async () => {
    const serial = new FakeSerialLink();
    browser({ serial });
    render(<ScannerClient vehicle={CONTEXT} />);
    await waitFor(() => expect(document.querySelector("[data-connect-serial]")).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Baud rate"), { target: { value: "9600" } });
    fireEvent.click(document.querySelector("[data-connect-serial]")!);
    await waitFor(() => expect((document.querySelector("[data-scan]") as HTMLButtonElement).disabled).toBe(false));
    expect(serial.opens[0]).toMatchObject({ baudRate: 9600 });
    expect(document.querySelector("[data-connect-serial]")).toBeNull();
    expect(document.querySelector("[data-link-info]")?.textContent).toContain("9600 baud");
    expect(document.querySelector("[data-vin]")?.textContent).toBe("1HGCM82633A004352");

    fireEvent.click(document.querySelector("[data-scan]")!);
    const code = await waitFor(() => {
      const found = document.querySelector('[data-code="P0133"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(code.textContent).toContain("Stored");
    expect(code.textContent).not.toContain("Pending");
    expect(code.closest("[data-dtc-module]")?.getAttribute("data-dtc-module")).toBe("obd-can11-7e8");
    const codeDetail = document.querySelector('[data-code-detail="P0133"]')!;
    expect(codeDetail.textContent).toContain("stored: reported");
    expect(codeDetail.textContent).toContain("pending: not listed");

    const text = document.body.textContent ?? "";
    expect(text).toContain("Partial scan");
    expect(text).toContain("Live Data");
    expect(text).toContain("That is a monitor status, not a fault");
    expect(text).toContain("not current values");
    expect(text).toContain("Nothing here is sent to Guided Diagnostics");
    expect(text).not.toMatch(/no codes found|all clear|safe to drive|passed|healthy/i);

    const rpm = [...document.querySelectorAll('[data-reading="0C"]')].at(-1)!;
    expect(within(rpm as HTMLElement).getByText("750 rpm")).toBeTruthy();
    expect(rpm.querySelector("[data-module]")?.getAttribute("data-module")).toBe("obd-can11-7e8");
    expect([...document.querySelectorAll('[data-raw-reading="0C"]')].at(-1)?.textContent).toContain("41 0C 0B B8");
    const badges = document.querySelectorAll("[data-unverified]");
    expect(badges).toHaveLength(3); // readiness, freeze frame, live data
    for (const badge of badges) expect(badge.textContent).toBe("Pending verification");
    // Each decoded section says why it is pending, beside its badge.
    const notes = [...document.querySelectorAll("[data-unverified-note]")].map((note) => note.textContent);
    expect(notes).toHaveLength(badges.length);
    for (const note of notes) expect(note).toMatch(/^Decoded with public secondary (formulas|bit table)\. The check against the licensed SAE J1979 standard is pending, so this is not SAE-verified\./);
    expect(notes.some((note) => note?.includes("bit table"))).toBe(true);

    const log = document.querySelector("[data-adapter-log]")!;
    expect(log.textContent).toContain("ATZ");
    expect(log.querySelector('[data-log-step="0902"]')?.textContent).toContain("7E8 10 14 49 02");
    expect(log.textContent).toContain("stays on this device");
    // The only request is the VIN lookup, carrying the VIN the car reported and nothing else.
    expect(fetch).toHaveBeenCalled();
    for (const [url] of vi.mocked(fetch).mock.calls) expect(url).toBe("/api/vehicles/vin?vin=1HGCM82633A004352");
  });

  it("polling needs an explicit selection and Start, shows pending current-data readings, and Stop ends it", async () => {
    const ble = fakeBle18f0();
    browser({ bluetooth: ble });
    render(<ScannerClient vehicle={null} />);
    await waitFor(() => expect(document.querySelector("[data-connect-ble]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-connect-ble]")!);
    await waitFor(() => expect(document.querySelector("[data-poll-start]")).not.toBeNull());
    const start = document.querySelector("[data-poll-start]") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    const sent = ble.backend.commands.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ble.backend.commands).toHaveLength(sent);

    fireEvent.click(document.querySelector('[data-poll-option="obd-can11-7e8:12"]')!);
    fireEvent.change(screen.getByLabelText("Cycles"), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText("Pause between cycles"), { target: { value: "20" } });
    fireEvent.click(start);
    await waitFor(() => expect(document.querySelector("[data-live] [data-value]")?.textContent).toBe("750 rpm"));
    expect(document.querySelector("[data-scan]")).toHaveProperty("disabled", true);
    fireEvent.click(document.querySelector("[data-poll-stop]")!);
    await waitFor(() => expect(document.querySelector("[data-live-status]")?.textContent).toContain("Stopped: cancelled"));
    expect(document.querySelector("[data-poll-stop]")).toBeNull();
  });

  it("a mid-scan disconnect shows why, keeps what was read and offers Connect again, not an automatic retry", async () => {
    const serial = new FakeSerialLink(() => ({ ...scriptedVehicle(), "07": { lines: ["7E8 02 47 00"], delayMs: 300 } }));
    browser({ serial });
    render(<ScannerClient vehicle={null} />);
    await waitFor(() => expect(document.querySelector("[data-connect-serial]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-connect-serial]")!);
    await waitFor(() => expect((document.querySelector("[data-scan]") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(document.querySelector("[data-scan]")!);
    await waitFor(() => expect(document.querySelector("[data-status]")?.textContent).toContain("codes"));
    serial.drop();
    await waitFor(() => expect(document.querySelector("[data-reconnect]")).not.toBeNull());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Everything already read is kept"));
    expect(document.querySelector('[data-section="current_data"]')?.textContent).toContain("Not run");
    expect(serial.opens).toHaveLength(1);
    expect(document.querySelector("[data-connect-serial]")).not.toBeNull();
  });

  it("unmounting (navigation) closes the link, and pagehide does too", async () => {
    const serial = new FakeSerialLink();
    browser({ serial });
    const { unmount } = render(<ScannerClient vehicle={null} />);
    await waitFor(() => expect(document.querySelector("[data-connect-serial]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-connect-serial]")!);
    await waitFor(() => expect(serial.isOpen).toBe(true));
    await waitFor(() => expect(document.querySelector("[data-scan]")).toHaveProperty("disabled", false));
    unmount();
    await waitFor(() => expect(serial.isOpen).toBe(false));
    expect(serial.listening).toBe(0);

    const second = new FakeSerialLink();
    browser({ serial: second });
    render(<ScannerClient vehicle={null} />);
    await waitFor(() => expect(document.querySelector("[data-connect-serial]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-connect-serial]")!);
    await waitFor(() => expect(document.querySelector("[data-scan]")).toHaveProperty("disabled", false));
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(second.isOpen).toBe(false));
    await waitFor(() => expect(document.querySelector("[data-status]")?.textContent).toBe("Not connected."));
  });

  it("the development remount (StrictMode) leaves the page usable", async () => {
    const serial = new FakeSerialLink();
    browser({ serial });
    render(
      <React.StrictMode>
        <ScannerClient vehicle={null} />
      </React.StrictMode>,
    );
    await waitFor(() => expect(document.querySelector("[data-connect-serial]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-connect-serial]")!);
    await waitFor(() => expect(document.querySelector("[data-scan]")).toHaveProperty("disabled", false));
  });

  it("a cancelled scan shows reads it never reached as not read, not as unlisted", async () => {
    const serial = new FakeSerialLink(() => ({ ...scriptedVehicle(), "010C": { lines: ["7E8 04 41 0C 0B B8"], delayMs: 300 } }));
    browser({ serial });
    render(<ScannerClient vehicle={null} />);
    await waitFor(() => expect(document.querySelector("[data-connect-serial]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-connect-serial]")!);
    await waitFor(() => expect(document.querySelector("[data-scan]")).toHaveProperty("disabled", false));
    fireEvent.click(document.querySelector("[data-scan]")!);
    await waitFor(() => expect(document.querySelector("[data-status]")?.textContent).toContain("Reading current data"));
    fireEvent.click(document.querySelector("[data-cancel]")!);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("cancelled"));
    expect(document.querySelector('[data-section="current_data"]')?.textContent).toContain("Stopped part-way");
    const unread = [...document.querySelectorAll('[data-reading="0D"]')].at(-1)!;
    expect(unread.querySelector("[data-value]")?.textContent).toBe("Not read in this run");
  });

  it("the first screen is the two choices: nothing technical is open, and manual options stay behind Advanced", async () => {
    browser({ bluetooth: fakeBle18f0(), serial: new FakeSerialLink() });
    render(<ScannerClient vehicle={null} />);
    await waitFor(() => expect(document.querySelector("[data-connect-ble]")).not.toBeNull());
    expect(document.querySelector("[data-stage]")?.getAttribute("data-stage")).toBe("disconnected");
    expect(screen.getByRole("heading", { name: "Connect your scanner" })).toBeTruthy();
    expect(document.querySelector("[data-connect-ble]")?.textContent).toBe("Connect Bluetooth");
    expect(document.querySelector("[data-connect-serial]")?.textContent).toBe("Connect COM Port");
    const advanced = document.querySelector("[data-advanced-connection]") as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    for (const label of ["Adapter profile", "Baud rate"]) expect(advanced.contains(screen.getByLabelText(label))).toBe(true);
    expect(advanced.contains(screen.getByLabelText(/Show all Bluetooth devices/))).toBe(true);
    expect(screen.queryByLabelText("service UUID")).toBeNull();
  });

  it("raw bytes and the adapter log stay collapsed; normal results show none of them", async () => {
    await scanned(() => scriptedVehicle());
    for (const raw of document.querySelectorAll("[data-raw], [data-raw-reading]")) expect((raw.closest("details") as HTMLDetailsElement).open, raw.textContent ?? "").toBe(false);
    const log = document.querySelector("[data-adapter-log]") as HTMLDetailsElement;
    expect(log.open).toBe(false);
    expect(log.closest("[data-advanced-diagnostics]")).not.toBeNull();
    expect((document.querySelector("[data-advanced-diagnostics]") as HTMLDetailsElement).open).toBe(false);
    expect(log.textContent).toContain("Adapter communication log");
  });

  it("a code shows a title only from CarCode's lookup, says when none is on file, and shows each reported status", async () => {
    await scanned(() => ({ ...scriptedVehicle(), "03": { lines: ["7E8 06 43 02 03 01 01 71"] }, "07": { lines: ["7E8 04 47 01 01 71"] } }));
    const lean = document.querySelector('[data-code="P0171"]')!;
    expect(lean.querySelector("[data-code-title]")?.textContent).toMatch(/System Too Lean/);
    expect([...lean.querySelectorAll("[data-kind]")].map((kind) => kind.textContent)).toEqual(["Stored", "Pending"]);
    const unknown = document.querySelector('[data-code="P0301"]')!;
    expect(unknown.querySelector("[data-code-title]")?.textContent).toBe("No definition on file yet");
    expect([...unknown.querySelectorAll("[data-kind]")].map((kind) => kind.textContent)).toEqual(["Stored"]);
    expect(document.body.textContent).toContain("not licensed SAE data");
  });

  it("a code read that failed is said out loud, never shown as no codes", async () => {
    await scanned(() => ({ ...scriptedVehicle(), "0A": { lines: ["NO DATA"] } }));
    expect(document.querySelector('[data-unread-service="0A"]')?.textContent).toContain("Permanent codes not read: No response. This does not mean no codes");
  });

  it("the steps follow the real read order while connecting, and the connected card shows only what was detected", async () => {
    const serial = new FakeSerialLink(() => ({ ...scriptedVehicle(), "0900": { lines: ["NO DATA"] } }));
    serial.chooser = deferred();
    browser({ serial });
    render(<ScannerClient vehicle={null} />);
    await waitFor(() => expect(document.querySelector("[data-connect-serial]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-connect-serial]")!);
    await waitFor(() => expect(document.querySelector("[data-stage]")?.getAttribute("data-stage")).toBe("choosing"));
    expect([...document.querySelectorAll("[data-step]")].map((step) => step.textContent)).toEqual(["Scanner selected", "COM port opened", "Adapter responding", "Detecting vehicle", "Checking modules", "Reading VIN"]);
    expect(document.querySelector('[data-step="selected"]')?.getAttribute("data-step-state")).toBe("active");
    serial.chooser.resolve(serial as never);
    await waitFor(() => expect(document.querySelector("[data-stage]")?.getAttribute("data-stage")).toBe("connected"));
    expect(screen.getByRole("heading", { name: "Connected" })).toBeTruthy();
    expect(document.querySelector("[data-scan]")?.textContent).toBe("Scan Vehicle");
    expect(document.querySelector("[data-vin]")).toBeNull(); // the car reported no VIN, so no VIN row
    expect(document.querySelector("[data-vehicle-context]")).toBeNull();
    // What was left out up front is still there under Advanced diagnostics.
    const details = document.querySelector("[data-advanced-diagnostics]")!;
    expect(details.textContent).toContain("ELM327 v1.5");
    expect(details.querySelector('[data-module-detail="obd-can11-7e8"]')?.textContent).toContain("VIN: Support unknown, so not requested");
  });

  it("UNABLE TO CONNECT reads as a silent vehicle, in plain words, with Try Again", async () => {
    const replies = { ...scriptedVehicle(), "0100": [{ lines: ["UNABLE TO CONNECT"] }, { lines: ["7E8 06 41 00 98 18 80 01"] }] };
    const serial = new FakeSerialLink(() => replies);
    browser({ serial });
    render(<ScannerClient vehicle={null} />);
    await waitFor(() => expect(document.querySelector("[data-connect-serial]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-connect-serial]")!);
    await waitFor(() => expect(document.querySelector("[data-stage]")?.getAttribute("data-stage")).toBe("no_vehicle"));
    expect(screen.getByRole("alert").textContent).toContain("Scanner connected, but the vehicle did not respond. Make sure the ignition is on and try again.");
    expect(document.querySelector("[data-stage]")?.textContent).not.toContain("no_vehicle_protocol");
    expect(document.querySelector("[data-advanced-diagnostics]")?.textContent).toContain("ELM327 v1.5"); // the adapter's identity is still available
    expect(document.querySelector("[data-connector]")?.getAttribute("data-bus")).toBe("silent");
    const retry = document.querySelector("[data-recover]") as HTMLButtonElement;
    expect(retry.textContent).toBe("Try Again");
    fireEvent.click(retry);
    await waitFor(() => expect(document.querySelector("[data-stage]")?.getAttribute("data-stage")).toBe("connected"));
    expect(serial.opens).toHaveLength(1);
  });

  it("an adapter with no recognized profile gets the plain message, with the original wording under Technical details", async () => {
    const unknown = new FakeBleLink("0000dead-0000-1000-8000-00805f9b34fb", "0000dea0-0000-1000-8000-00805f9b34fb", "0000dea1-0000-1000-8000-00805f9b34fb");
    browser({ bluetooth: unknown });
    render(<ScannerClient vehicle={null} />);
    await waitFor(() => expect(document.querySelector("[data-connect-ble]")).not.toBeNull());
    fireEvent.click(screen.getByLabelText(/Show all Bluetooth devices/));
    fireEvent.click(document.querySelector("[data-connect-ble]")!);
    await waitFor(() => expect(document.querySelector("[data-stage]")?.getAttribute("data-stage")).toBe("failed"));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("CarCode connected to the Bluetooth device, but it doesn't use a scanner profile we currently recognize.");
    const technical = alert.querySelector("[data-notice-technical]")!;
    expect(technical.textContent).toContain("none of the profile services");
    expect((technical.closest("details") as HTMLDetailsElement).open).toBe(false);
    // Connecting to the same device again cannot help, so the other ways to connect come first.
    expect(document.querySelector("[data-reconnect]")).toBeNull();
    expect(document.querySelector("[data-connect-ble]")?.closest("details")).toBeNull();
  });

  it("after a lost link, Connect again is the one main action, other adapters are tucked away, and live updates are gone", async () => {
    const serial = new FakeSerialLink();
    browser({ serial });
    render(<ScannerClient vehicle={null} />);
    await waitFor(() => expect(document.querySelector("[data-connect-serial]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-connect-serial]")!);
    await waitFor(() => expect(document.querySelector("[data-poll-start]")).not.toBeNull());
    serial.drop();
    await waitFor(() => expect(document.querySelector("[data-reconnect]")).not.toBeNull());
    expect((document.querySelector("[data-connect-serial]")?.closest("details") as HTMLDetailsElement).open).toBe(false);
    expect(document.querySelector("[data-poll-start]")).toBeNull();
  });

  it("Disconnect stays available while connecting and while scanning, and closes the link", async () => {
    const connecting = new FakeSerialLink(() => ({ ...scriptedVehicle(), "0100": { lines: ["7E8 06 41 00 98 18 80 01"], delayMs: 300 } }));
    browser({ serial: connecting });
    const { unmount } = render(<ScannerClient vehicle={null} />);
    await waitFor(() => expect(document.querySelector("[data-connect-serial]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-connect-serial]")!);
    await waitFor(() => expect(document.querySelector('[data-step="vehicle"]')?.getAttribute("data-step-state")).toBe("active"));
    expect(document.querySelector("[data-cancel]")).not.toBeNull();
    fireEvent.click(document.querySelector("[data-disconnect]")!);
    await waitFor(() => expect(connecting.isOpen).toBe(false));
    await waitFor(() => expect(document.querySelector("[data-stage]")?.getAttribute("data-stage")).not.toBe("connecting"));
    unmount();

    const scanning = new FakeSerialLink(() => ({ ...scriptedVehicle(), "07": { lines: ["7E8 02 47 00"], delayMs: 300 } }));
    browser({ serial: scanning });
    render(<ScannerClient vehicle={null} />);
    await waitFor(() => expect(document.querySelector("[data-connect-serial]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-connect-serial]")!);
    await waitFor(() => expect((document.querySelector("[data-scan]") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(document.querySelector("[data-scan]")!);
    await waitFor(() => expect(document.querySelector("[data-stage]")?.getAttribute("data-stage")).toBe("scanning"));
    expect(document.querySelector("[data-cancel]")).not.toBeNull();
    fireEvent.click(document.querySelector("[data-disconnect]")!);
    await waitFor(() => expect(scanning.isOpen).toBe(false));
  });

  it("a scan keeps its own vehicle after a reconnect; the connected card shows the new one, and results stay on screen throughout", async () => {
    const vin = (last: string) => ["7E8 10 14 49 02 01 31 48 47", "7E8 21 43 4D 38 32 36 33 33", `7E8 22 41 30 30 34 33 35 ${last}`];
    let lastByte = "32";
    const serial = new FakeSerialLink(() => ({ ...scriptedVehicle(), "0902": { lines: vin(lastByte) } }));
    browser({ serial });
    render(<ScannerClient vehicle={null} />);
    await waitFor(() => expect(document.querySelector("[data-connect-serial]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-connect-serial]")!);
    await waitFor(() => expect((document.querySelector("[data-scan]") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(document.querySelector("[data-scan]")!);
    await waitFor(() => expect(document.querySelector("[data-scan-vin]")?.textContent).toBe("1HGCM82633A004352"));

    serial.drop();
    await waitFor(() => expect(document.querySelector("[data-reconnect]")).not.toBeNull());
    lastByte = "33";
    fireEvent.click(document.querySelector("[data-reconnect]")!);
    await waitFor(() => expect(document.querySelector("[data-stage]")?.getAttribute("data-stage")).toBe("connecting"));
    expect(document.querySelector("[data-scan-vin]")?.textContent).toBe("1HGCM82633A004352");
    await waitFor(() => expect(document.querySelector("[data-vin]")?.textContent).toBe("1HGCM82633A004353"));
    expect(document.querySelector("[data-scan-vin]")?.textContent).toBe("1HGCM82633A004352");
    expect(document.querySelector("[data-earlier-link]")).not.toBeNull();
  });

  it("after a disconnect the retained Vehicle section still says the name was chosen, not detected", async () => {
    await scanned(() => scriptedVehicle());
    fireEvent.click(document.querySelector("[data-disconnect]")!);
    await waitFor(() => expect(document.querySelector("[data-stage]")?.getAttribute("data-stage")).toBe("disconnected"));
    const card = document.querySelector("[data-vehicle-card]")!;
    expect(card.textContent).toContain("2015 Toyota Camry");
    expect(card.textContent).toContain("Chosen in your garage, not confirmed by the car.");
    expect(card.querySelector("[data-scan-vin]")?.textContent).toBe("1HGCM82633A004352");
  });

  it("a mistake in the manual options stays a form message; nothing failed", async () => {
    browser({ bluetooth: fakeBle18f0() });
    render(<ScannerClient vehicle={null} />);
    fireEvent.change(await screen.findByLabelText("Adapter profile"), { target: { value: "manual" } });
    fireEvent.change(screen.getByLabelText("service UUID"), { target: { value: "bad" } });
    fireEvent.click(document.querySelector("[data-connect-ble]")!);
    await screen.findByRole("alert");
    expect(document.querySelector("[data-stage]")?.getAttribute("data-stage")).toBe("disconnected");
    expect(screen.getByRole("heading", { name: "Connect your scanner" })).toBeTruthy();
  });

  /** The scripted vehicle, reporting a VIN whose last character is `last`, so each test's lookup starts fresh. */
  const withVin = (last: string) => () => ({ ...scriptedVehicle(), "0902": { lines: ["7E8 10 14 49 02 01 31 48 47", "7E8 21 43 4D 38 32 36 33 33", `7E8 22 41 30 30 34 33 35 ${last}`] } });
  const decoder = (body: object, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("identifies the car from the VIN it reported, like a scan tool's automatic VIN detection, and says when the garage vehicle differs", async () => {
    vi.stubGlobal("fetch", decoder({ ok: true, decoded: { year: "2003", make: "Honda", model: "Accord", trim: "EX" }, suggestions: ["2.4L I4"] }));
    await scanned(withVin("36"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/vehicles/vin?vin=1HGCM82633A004356");
    await waitFor(() => expect(document.querySelectorAll("[data-identified-vehicle]")).toHaveLength(2));
    for (const name of document.querySelectorAll("[data-identified-vehicle]")) expect(name.textContent).toBe("2003 Honda Accord EX");
    expect(document.body.textContent).toContain("2.4L I4");
    expect(document.body.textContent).toContain("Identified from the VIN the car reported");
    expect(document.querySelector("[data-garage-differs]")?.textContent).toBe("Your garage has 2015 Toyota Camry. That does not match this car.");
    expect(document.body.textContent).not.toContain("Chosen in your garage, not confirmed by the car.");
  });

  it("a VIN that names the garage vehicle shows no mismatch", async () => {
    vi.stubGlobal("fetch", decoder({ ok: true, decoded: { year: "2015", make: "Toyota", model: "Camry", trim: "" }, suggestions: [] }));
    await scanned(withVin("37"));
    await waitFor(() => expect(document.querySelector("[data-identified-vehicle]")?.textContent).toBe("2015 Toyota Camry"));
    expect(document.querySelector("[data-garage-differs]")).toBeNull();
  });

  it("a VIN the lookup does not recognise identifies nothing and falls back to the garage vehicle, marked as not confirmed", async () => {
    vi.stubGlobal("fetch", decoder({ ok: false, decoded: null, suggestions: [], code: "not_recognized" }));
    await scanned(withVin("38"));
    await waitFor(() => expect(document.querySelector('[data-vehicle-identity="not_identified"]')).not.toBeNull());
    expect(document.querySelector("[data-identified-vehicle]")).toBeNull();
    expect(document.body.textContent).toContain("This VIN could not be matched to a vehicle.");
    expect(document.querySelector("[data-vehicle-card]")?.textContent).toContain("Chosen in your garage, not confirmed by the car.");
  });

  it("modules that disagree on the VIN identify nothing and ask nothing", async () => {
    await scanned(() => ({ ...scriptedVehicle(), "0100": { lines: ["7E8 06 41 00 98 18 80 01", "7E9 06 41 00 98 18 80 00"] }, "0900": { lines: ["7E8 06 49 00 40 00 00 00", "7E9 06 49 00 40 00 00 00"] }, "0902": { lines: ["7E8 10 14 49 02 01 31 48 47", "7E8 21 43 4D 38 32 36 33 33", "7E8 22 41 30 30 34 33 35 32", "7E9 10 14 49 02 01 31 48 47", "7E9 21 43 4D 38 32 36 33 33", "7E9 22 41 30 30 34 33 35 39"] } }));
    expect(document.body.textContent).toContain("Modules reported different VINs");
    expect(fetch).not.toHaveBeenCalled();
    expect(document.querySelector("[data-identified-vehicle]")).toBeNull();
  });

  it("the VIN lookup module asks only CarCode's own VIN route", () => {
    const source = readFileSync(path.resolve(__dirname, "../app/lib/scanner-vin.ts"), "utf8");
    expect(source.match(/\bfetch\(/g)).toHaveLength(1);
    expect(source).toContain("fetch(`/api/vehicles/vin?vin=${encodeURIComponent(vin)}`");
  });

  it("outcome wording never turns a missing answer into a clean result", () => {
    expect(outcomeText("no_response")).toContain("does not mean no codes");
    expect(outcomeText("unsupported")).toContain("not requested");
    expect(outcomeText("bus_error")).toBe("bus error");
  });
});
