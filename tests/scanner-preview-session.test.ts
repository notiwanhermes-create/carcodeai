/**
 * S12: the `/scanner` session over both real transports, the real controller
 * and the real evidence mapper, driven through SCRIPTED doubles of
 * `navigator.bluetooth` and `navigator.serial`. Passing shows the page's
 * lifecycle behaves as designed against simulated browser objects, not that any
 * browser, adapter or vehicle does.
 */
import { describe, expect, it, vi } from "vitest";
import { ScannerSession, type BleChoice, type ScannerSnapshot } from "../app/scanner/scanner-session";
import { deferred, domError, fakeBle18f0, FakeBleLink, FakeSerialLink, scriptedVehicle, type Replies } from "./helpers/scanner-browser-fakes";

const choice = (over: Partial<BleChoice> = {}): BleChoice => ({ profile: "documented", showAllDevices: false, manual: { service: "", notify: "", write: "" }, ...over });

const noBluetooth = { bluetooth: undefined, isSecureContext: true };
const noSerial = { serial: undefined, isSecureContext: true };

function bleSession(link: FakeBleLink) {
  return new ScannerSession({ bluetooth: () => link.environment(), serial: () => noSerial, newScanId: () => "scan-1" });
}

function serialSession(link: FakeSerialLink) {
  return new ScannerSession({ bluetooth: () => noBluetooth, serial: () => link.environment(), newScanId: () => "scan-1" });
}

async function until(session: ScannerSession, condition: (view: ScannerSnapshot) => boolean): Promise<ScannerSnapshot> {
  await vi.waitFor(() => expect(condition(session.getSnapshot()), JSON.stringify({ link: session.getSnapshot().link, phase: session.getSnapshot().phase, notice: session.getSnapshot().notice })).toBe(true), { timeout: 3000 });
  return session.getSnapshot();
}

const POLL = { selection: [{ module: "obd-can11-7e8", pid: 0x0c }], cycles: 200, intervalMs: 20 };

describe("both transports reach attributed evidence", () => {
  it("Web Bluetooth: connect, scan, evidence, raw bytes and log", async () => {
    const link = fakeBle18f0();
    const session = bleSession(link);
    await session.connectBluetooth(choice());
    const view = session.getSnapshot();
    expect(view).toMatchObject({ link: "open", transport: "web_bluetooth", lifecycle: "ready", vehicleFound: true });
    expect(view.linkInfo).toMatchObject({ kind: "web_bluetooth", deviceName: "Scripted BLE adapter", profile: { id: "ble_18f0", provenance: "community_unverified", validation: "pending" } });
    await session.scan();
    const scan = session.getSnapshot().scan!.evidence;
    expect(scan.dtcs.modules[0]).toMatchObject({ module: "obd-can11-7e8", responseId: expect.any(String), codes: [{ code: "P0133" }] });
    expect(scan.dtcs.absence).toBe("not_established");
    expect(scan.completeness).toBe("partial");
    expect(scan.currentData.filter((m) => m.reading).every((m) => m.verification?.status === "unverified" && m.verification.primarySourceCheck === "pending")).toBe(true);
    expect(scan.currentData.find((m) => m.pid === 0x0c)?.rawLines.length).toBeGreaterThan(0);
    expect(session.getSnapshot().log.some((step) => step.command === "0100" && step.perEcu.length > 0)).toBe(true);
    await session.teardown();
  });

  it("Web Serial: connect, scan and evidence, with the chosen settings", async () => {
    const link = new FakeSerialLink();
    const session = serialSession(link);
    await session.connectSerial({ baudRate: 115200 });
    expect(session.getSnapshot()).toMatchObject({ link: "open", transport: "web_serial", linkInfo: { kind: "web_serial", settings: { baudRate: 115200 } } });
    expect(link.opens).toEqual([expect.objectContaining({ baudRate: 115200, dataBits: 8, parity: "none" })]);
    await session.scan();
    expect(session.getSnapshot().scan!.evidence.dtcs.modules[0].codes[0].code).toBe("P0133");
    await session.teardown();
    expect(link.isOpen).toBe(false);
    expect(link.listening).toBe(0);
  });

  it("only allowlisted read commands reach the adapter", async () => {
    const link = fakeBle18f0();
    const session = bleSession(link);
    await session.connectBluetooth(choice());
    await session.scan();
    await session.teardown();
    const obd = link.backend.commands.filter((command) => /^[0-9A-F]{2,6}$/.test(command));
    expect(obd.length).toBeGreaterThan(5);
    expect(obd.every((command) => /^(01|02|03|07|09|0A)/.test(command))).toBe(true);
    expect(link.backend.commands).not.toContain("04");
  });
});

describe("the choosers", () => {
  it("are called synchronously from the click, before anything is awaited", () => {
    const api = { requestDevice: vi.fn(() => new Promise<never>(() => undefined)) };
    const session = new ScannerSession({ bluetooth: () => ({ bluetooth: api, isSecureContext: true }), serial: () => noSerial });
    void session.connectBluetooth(choice());
    expect(api.requestDevice).toHaveBeenCalledTimes(1);
    const requestPort = vi.fn(() => new Promise<never>(() => undefined));
    const serial = new ScannerSession({ bluetooth: () => noBluetooth, serial: () => ({ serial: { requestPort }, isSecureContext: true }) });
    void serial.connectSerial({});
    expect(requestPort).toHaveBeenCalledTimes(1);
  });

  it("a BLE profile, the all-devices chooser and a manual override each shape the request", async () => {
    const link = fakeBle18f0();
    const session = bleSession(link);
    await session.connectBluetooth(choice({ profile: "ble_18f0", showAllDevices: true }));
    expect(link.requests[0]).toMatchObject({ acceptAllDevices: true, optionalServices: [link.serviceUuid] });
    await session.disconnect();

    const manual = new FakeBleLink("0000abcd-0000-1000-8000-00805f9b34fb", "0000abce-0000-1000-8000-00805f9b34fb", "0000abcf-0000-1000-8000-00805f9b34fb");
    const custom = bleSession(manual);
    await custom.connectBluetooth(choice({ profile: "manual", manual: { service: "ABCD", notify: "abce", write: "abcf" } }));
    expect(manual.requests[0]).toMatchObject({ filters: [{ services: [manual.serviceUuid] }] });
    expect(custom.getSnapshot()).toMatchObject({ link: "open", linkInfo: { profile: { provenance: "user_supplied", validation: "pending" } } });
    await custom.teardown();
    await session.teardown();
  });

  it("an invalid UUID or baud rate opens no chooser and names the problem", async () => {
    const ble = fakeBle18f0();
    const session = bleSession(ble);
    await session.connectBluetooth(choice({ profile: "manual", manual: { service: "nope", notify: "abce", write: "abcf" } }));
    expect(ble.requests).toEqual([]);
    expect(session.getSnapshot()).toMatchObject({ link: "none", notice: { tone: "error", text: expect.stringContaining("service UUID") } });
    const serial = new FakeSerialLink();
    const other = serialSession(serial);
    await other.connectSerial({ baudRate: 0 });
    expect(serial.requests).toBe(0);
    expect(other.getSnapshot().notice?.text).toContain("baudRate");
  });

  it("a dismissed chooser leaves the page idle with a plain note, and a blocked one is an error", async () => {
    const link = fakeBle18f0();
    link.chooser = deferred();
    link.chooser.reject(domError("NotFoundError"));
    const session = bleSession(link);
    await session.connectBluetooth(choice());
    expect(session.getSnapshot()).toMatchObject({ link: "none", notice: { tone: "info" } });
    link.chooser = deferred();
    link.chooser.reject(domError("SecurityError"));
    await session.connectBluetooth(choice());
    expect(session.getSnapshot()).toMatchObject({ link: "none", notice: { tone: "error" } });
  });

  it("a second click while a chooser is open is ignored", async () => {
    const link = fakeBle18f0();
    link.chooser = deferred();
    const session = bleSession(link);
    const first = session.connectBluetooth(choice());
    await session.connectBluetooth(choice());
    expect(link.requests).toHaveLength(1);
    link.chooser.resolve(link);
    await first;
    expect(session.getSnapshot().link).toBe("open");
    await session.teardown();
  });

  it("detection offers only what the browser has, and an insecure context is explained", async () => {
    const link = new FakeSerialLink();
    const session = new ScannerSession({ bluetooth: () => noBluetooth, serial: () => link.environment(false) });
    await session.detect();
    expect(session.getSnapshot().offers).toEqual({
      bluetooth: { status: "unavailable", detail: expect.stringContaining("does not provide Web Bluetooth") },
      serial: { status: "unavailable", detail: expect.stringContaining("secure context") },
    });
  });
});

describe("lifecycle races", () => {
  it("a chooser answered after teardown opens nothing", async () => {
    const link = fakeBle18f0();
    link.chooser = deferred();
    const session = bleSession(link);
    const pending = session.connectBluetooth(choice());
    await session.teardown();
    link.chooser.resolve(link);
    await pending;
    expect(session.getSnapshot().link).toBe("none");
    expect(link.connected).toBe(false);
    expect(link.backend.opened).toHaveLength(0);
  });

  it("a serial chooser answered after teardown opens nothing", async () => {
    const link = new FakeSerialLink();
    link.chooser = deferred();
    const session = serialSession(link);
    const pending = session.connectSerial({});
    await session.teardown();
    link.chooser.resolve(link);
    await pending;
    expect(link.opens).toHaveLength(0);
  });

  it("hiding the page during the Bluetooth chooser discards its answer: nothing opens, it is not kept, and only a new click connects", async () => {
    const link = fakeBle18f0();
    link.chooser = deferred();
    const session = bleSession(link);
    const pending = session.connectBluetooth(choice());
    session.pageHidden();
    link.chooser.resolve(link);
    await pending;
    expect(session.getSnapshot()).toMatchObject({ link: "none", canReconnect: false, notice: { tone: "info" } });
    expect(session.getSnapshot().notice?.text).toMatch(/nothing was opened/);
    expect(link.connected).toBe(false);
    expect(link.backend.opened).toHaveLength(0);
    await session.reconnect();
    expect(link.backend.opened).toHaveLength(0);

    link.chooser = null;
    await session.connectBluetooth(choice());
    expect(session.getSnapshot()).toMatchObject({ link: "open", vehicleFound: true, notice: null });
    await session.teardown();
  });

  it("hiding the page during the serial chooser discards its answer: nothing opens, it is not kept, and only a new click connects", async () => {
    const link = new FakeSerialLink();
    link.chooser = deferred();
    const session = serialSession(link);
    const pending = session.connectSerial({});
    session.pageHidden();
    link.chooser.resolve(link);
    await pending;
    expect(session.getSnapshot()).toMatchObject({ link: "none", canReconnect: false, notice: { tone: "info" } });
    expect(link.opens).toHaveLength(0);
    await session.reconnect();
    expect(link.opens).toHaveLength(0);

    link.chooser = null;
    await session.connectSerial({});
    expect(session.getSnapshot()).toMatchObject({ link: "open", vehicleFound: true });
    await session.teardown();
  });

  it("hiding the page while a reconnect waits for the previous link to close opens nothing, and the page does not stay connecting", async () => {
    const link = new FakeSerialLink();
    const session = serialSession(link);
    await session.connectSerial({});
    const holdClose = deferred<void>();
    link.holdClose = holdClose;
    link.drop();
    await until(session, (view) => view.link === "ended");
    const pending = session.reconnect();
    expect(session.getSnapshot().link).toBe("connecting");
    session.pageHidden();
    expect(session.getSnapshot()).toMatchObject({ link: "none", canReconnect: true, notice: { tone: "info" } });
    holdClose.resolve();
    await pending;
    expect(link.opens).toHaveLength(1);
    await session.teardown();
  });

  it("teardown during the GATT connect undoes it and publishes nothing", async () => {
    const link = fakeBle18f0();
    link.holdConnect = deferred();
    const session = bleSession(link);
    const pending = session.connectBluetooth(choice());
    await until(session, (view) => view.lifecycle === "connecting");
    const seen: ScannerSnapshot[] = [];
    await session.teardown();
    session.subscribe(() => seen.push(session.getSnapshot()));
    link.holdConnect.resolve();
    await pending;
    await vi.waitFor(() => expect(link.connected).toBe(false));
    expect(seen).toEqual([]);
    expect(session.getSnapshot().link).toBe("none");
  });

  it("cancel during connection ends the attempt and offers Connect again", async () => {
    const link = fakeBle18f0();
    link.holdConnect = deferred();
    const session = bleSession(link);
    const pending = session.connectBluetooth(choice());
    await until(session, (view) => view.activity === "discovery");
    session.cancel();
    expect(session.getSnapshot().stopping).toBe(true);
    await pending;
    expect(session.getSnapshot()).toMatchObject({ link: "ended", canReconnect: true, stopping: false, notice: { text: expect.stringContaining("cancelled") } });
  });

  it("disconnect during a scan keeps the partial scan and closes the link", async () => {
    const link = new FakeSerialLink(() => ({ ...scriptedVehicle(), "03": { lines: ["7E8 04 43 01 01 33"], delayMs: 200 } }));
    const session = serialSession(link);
    await session.connectSerial({});
    const scanning = session.scan();
    await until(session, (view) => view.phase === "dtcs");
    await session.disconnect();
    await scanning;
    const view = session.getSnapshot();
    expect(view).toMatchObject({ link: "none", canReconnect: true });
    expect(view.scan!.evidence.ended).toBe("cancelled");
    expect(view.scan!.evidence.sections).toMatchObject({ readiness: "done", dtcs: "interrupted", current_data: "not_run" });
    expect(link.isOpen).toBe(false);
  });

  it("a lost link during a scan keeps what was read, never reconnects, and Connect again uses a new link", async () => {
    const link = fakeBle18f0(() => ({ ...scriptedVehicle(), "07": { lines: ["7E8 02 47 00"], delayMs: 500 } }));
    const session = bleSession(link);
    await session.connectBluetooth(choice());
    const scanning = session.scan();
    await until(session, (view) => view.phase === "dtcs");
    link.drop();
    await scanning;
    const lost = await until(session, (view) => view.lifecycle === "closed");
    expect(lost).toMatchObject({ link: "ended", canReconnect: true, notice: { tone: "error", text: expect.stringContaining("lost") } });
    expect(lost.scan!.evidence.ended).toBe("transport_lost");
    expect(link.backend.opened).toHaveLength(1);

    await session.reconnect();
    expect(session.getSnapshot()).toMatchObject({ link: "open", connection: 2, vehicleFound: true });
    expect(link.requests).toHaveLength(1);
    expect(link.backend.opened).toHaveLength(2);
    expect(session.getSnapshot().scan!.connection).toBe(1);
    await session.teardown();
  });

  it("a disconnect while idle ends the link without a run", async () => {
    const link = new FakeSerialLink();
    const session = serialSession(link);
    await session.connectSerial({});
    link.drop();
    await until(session, (view) => view.link === "ended" && view.lifecycle === "closed");
    expect(session.getSnapshot().notice?.tone).toBe("error");
    await session.reconnect();
    expect(session.getSnapshot().link).toBe("open");
    expect(link.opens).toHaveLength(2);
    await session.teardown();
  });

  it("a failed open reports why and stays connectable", async () => {
    const link = new FakeBleLink("0000dead-0000-1000-8000-00805f9b34fb", "0000dea0-0000-1000-8000-00805f9b34fb", "0000dea1-0000-1000-8000-00805f9b34fb");
    const session = bleSession(link);
    await session.connectBluetooth(choice({ showAllDevices: true }));
    await until(session, (view) => view.lifecycle === "closed");
    expect(session.getSnapshot()).toMatchObject({ link: "ended", vehicleFound: false, notice: { tone: "error", text: expect.stringContaining("none of the profile services") } });
  });

  it("no vehicle leaves the adapter connected and says so; a scan is refused and a retry is not a connection", async () => {
    const replies: Replies = { ...scriptedVehicle(), "0100": [{ lines: ["NO DATA"] }, { lines: ["7E8 06 41 00 98 18 80 01"] }] };
    const link = new FakeSerialLink(() => replies);
    const session = serialSession(link);
    await session.connectSerial({});
    expect(session.getSnapshot()).toMatchObject({ link: "open", vehicleFound: false, notice: { text: expect.stringContaining("ignition") } });
    await session.scan();
    expect(session.getSnapshot()).toMatchObject({ scan: null, notice: { text: expect.stringContaining("Refused") } });
    await session.recover();
    expect(session.getSnapshot()).toMatchObject({ link: "open", connection: 1, vehicleFound: true, notice: null });
    await session.teardown();
  });

  it("cancel during a scan keeps the partial evidence and the link", async () => {
    const link = fakeBle18f0(() => ({ ...scriptedVehicle(), "07": { lines: ["7E8 02 47 00"], delayMs: 300 } }));
    const session = bleSession(link);
    await session.connectBluetooth(choice());
    const scanning = session.scan();
    await until(session, (view) => view.phase === "dtcs");
    session.cancel();
    await scanning;
    const view = session.getSnapshot();
    expect(view).toMatchObject({ link: "open", lifecycle: "ready", activity: null, stopping: false, notice: { tone: "info", text: expect.stringContaining("cancelled") } });
    expect(view.scan!.evidence).toMatchObject({ ended: "cancelled", sections: { dtcs: "interrupted" } });
    await session.teardown();
  });

  it("recovery on the same link rediscovers without a new connection", async () => {
    const link = fakeBle18f0();
    const session = bleSession(link);
    await session.connectBluetooth(choice());
    await session.recover();
    expect(session.getSnapshot()).toMatchObject({ link: "open", connection: 1, vehicleFound: true });
    expect(link.backend.opened).toHaveLength(1);
    await session.teardown();
  });

  it("a session survives the development remount: teardown before use, then a normal connect", async () => {
    const link = fakeBle18f0();
    const session = bleSession(link);
    void session.detect();
    await session.teardown();
    await session.detect();
    expect(session.getSnapshot().offers.bluetooth).toEqual({ status: "available" });
    await session.connectBluetooth(choice());
    expect(session.getSnapshot().link).toBe("open");
    await session.teardown();
  });
});

describe("bounded polling", () => {
  it("runs the requested cycles, labelled, and stops by itself", async () => {
    const link = fakeBle18f0();
    const session = bleSession(link);
    await session.connectBluetooth(choice());
    await session.startPolling({ ...POLL, cycles: 2, intervalMs: 0 });
    expect(session.getSnapshot().live).toMatchObject({ running: false, ended: "finished", cyclesRequested: 2 });
    const readings = session.getSnapshot().live!.cycles.flatMap((cycle) => cycle.readings);
    expect(readings).toHaveLength(2);
    expect(readings[0].value?.verification).toMatchObject({ status: "unverified", primarySourceCheck: "pending", diagnosticUse: "display_only" });
    await session.teardown();
  });

  it("Stop ends it, keeps the cycles, and the link stays open", async () => {
    const link = new FakeSerialLink();
    const session = serialSession(link);
    await session.connectSerial({});
    const polling = session.startPolling(POLL);
    await until(session, (view) => (view.live?.cycles.length ?? 0) >= 1);
    session.stopPolling();
    await polling;
    const view = session.getSnapshot();
    expect(view.live).toMatchObject({ running: false, ended: "cancelled" });
    expect(view.live!.cycles.length).toBeGreaterThanOrEqual(1);
    expect(view).toMatchObject({ link: "open", activity: null, stopping: false });
    await session.teardown();
  });

  it("hiding the page stops it and says why", async () => {
    const link = fakeBle18f0();
    const session = bleSession(link);
    await session.connectBluetooth(choice());
    const polling = session.startPolling(POLL);
    await until(session, (view) => (view.live?.cycles.length ?? 0) >= 1);
    session.pageHidden();
    await polling;
    expect(session.getSnapshot()).toMatchObject({ link: "open", notice: { text: expect.stringContaining("page was hidden") } });
    await session.teardown();
  });

  it("a lost link ends it and a refused request restores the previous view", async () => {
    const link = new FakeSerialLink();
    const session = serialSession(link);
    await session.connectSerial({});
    await session.startPolling({ ...POLL, selection: [{ module: "obd-can11-7e8", pid: 0x42 + 1 }], cycles: 1 });
    expect(session.getSnapshot()).toMatchObject({ live: null, notice: { text: expect.stringContaining("Refused") } });
    const polling = session.startPolling(POLL);
    await until(session, (view) => (view.live?.cycles.length ?? 0) >= 1);
    link.drop();
    await polling;
    expect(session.getSnapshot()).toMatchObject({ link: "ended", live: { running: false, ended: "transport_lost" } });
    await session.teardown();
  });

  it("teardown stops it: no further commands and no updates", async () => {
    const link = fakeBle18f0();
    const session = bleSession(link);
    await session.connectBluetooth(choice());
    const polling = session.startPolling(POLL);
    await until(session, (view) => (view.live?.cycles.length ?? 0) >= 1);
    await session.teardown();
    await polling;
    const sent = link.backend.commands.length;
    const updates: ScannerSnapshot[] = [];
    session.subscribe(() => updates.push(session.getSnapshot()));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(link.backend.commands).toHaveLength(sent);
    expect(updates).toEqual([]);
    expect(session.getSnapshot().live).toBeNull();
    expect(link.listening).toBe(0);
  });
});
