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
import { fakeBle18f0, FakeSerialLink, scriptedVehicle, type FakeBleLink } from "./helpers/scanner-browser-fakes";

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
    // One same-origin HEAD to the route, however many links, carrying nothing.
    expect(route).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledWith("/scanner", expect.objectContaining({ method: "HEAD", credentials: "omit" }));
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
    expect(document.querySelector("[data-vehicle-context]")?.textContent).toContain("No vehicle chosen");
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
    fireEvent.click(screen.getByLabelText(/Show all nearby devices/));
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
    expect(document.querySelector("[data-ecu]")?.textContent).toContain("reported VIN 1HGCM82633A004352");

    fireEvent.click(document.querySelector("[data-scan]")!);
    const code = await waitFor(() => {
      const found = document.querySelector('[data-code="P0133"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(code.textContent).toContain("stored: reported");
    expect(code.textContent).toContain("pending: not listed");
    expect(code.closest("[data-dtc-module]")?.getAttribute("data-dtc-module")).toBe("obd-can11-7e8");

    const text = document.body.textContent ?? "";
    expect(text).toContain("Partial: absence not established");
    expect(text).toContain("Current-data readings (OBD $01)");
    expect(text).toContain("That is a monitor status, not a fault");
    expect(text).toContain("not current values");
    expect(text).toContain("Nothing here is sent to Guided Diagnostics");
    expect(text).not.toMatch(/no codes found|all clear|safe to drive|passed|healthy/i);
    expect(text).not.toMatch(/live data/i);

    const rpm = [...document.querySelectorAll('[data-reading="0C"]')].at(-1)!;
    expect(within(rpm as HTMLElement).getByText("750 rpm")).toBeTruthy();
    expect(rpm.querySelector("[data-module]")?.textContent).toContain("obd-can11-7e8");
    expect(rpm.querySelector("[data-raw]")?.textContent).toContain("41 0C 0B B8");
    const badges = document.querySelectorAll("[data-unverified]");
    expect(badges.length).toBeGreaterThanOrEqual(4);
    for (const badge of badges) expect(badge.textContent).toBe("Pending / unverified");
    // Each decoded section says why it is pending, beside its badge.
    const notes = [...document.querySelectorAll("[data-unverified-note]")].map((note) => note.textContent);
    expect(notes).toHaveLength(badges.length);
    for (const note of notes) expect(note).toMatch(/^Decoded with public secondary (formulas|bit table)\. The check against the licensed SAE J1979 standard is pending, so this is not SAE-verified\./);
    expect(notes.some((note) => note?.includes("bit table"))).toBe(true);

    const log = document.querySelector("[data-adapter-log]")!;
    expect(log.textContent).toContain("ATZ");
    expect(log.querySelector('[data-log-step="0902"]')?.textContent).toContain("7E8 10 14 49 02");
    expect(log.textContent).toContain("stays on this device");
    expect(fetch).not.toHaveBeenCalled();
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

  it("outcome wording never turns a missing answer into a clean result", () => {
    expect(outcomeText("no_response")).toContain("does not mean no codes");
    expect(outcomeText("unsupported")).toContain("not requested");
    expect(outcomeText("bus_error")).toBe("bus error");
  });
});
