/**
 * S11a: the Web Bluetooth transport, against deterministic doubles of the
 * browser API (WebBluetoothEnvironment). These show the transport behaves as
 * designed against SCRIPTED browser objects only: no real browser, BLE stack,
 * Vgate or other adapter, or vehicle is involved, and no hardware
 * compatibility is shown.
 */
import { describe, expect, it, vi } from "vitest";
import { bytesToText, textToBytes } from "../app/lib/vehicle-communication/bytes";
import { ElmCommandExecutor } from "../app/lib/vehicle-communication/elm/executor";
import { initialiseAdapter } from "../app/lib/vehicle-communication/elm/initialise";
import { createManualBleProfile, DOCUMENTED_BLE_PROFILES, parseBleUuid, type BleProfile } from "../app/lib/vehicle-communication/transport/ble-profiles";
import { ScriptedElmAdapter, type ScriptedElmOptions, type SimulatedTransport } from "../app/lib/vehicle-communication/transport/simulated";
import { TransportError, type TransportCloseReason } from "../app/lib/vehicle-communication/transport/types";
import {
  detectWebBluetooth,
  requestBleAdapter,
  WEB_BLUETOOTH_LIMITATIONS,
  WebBluetoothTransport,
  type SelectedBleAdapter,
} from "../app/lib/vehicle-communication/transport/web-bluetooth";
import type { BleRequestDeviceOptions, BluetoothApi, WebBluetoothEnvironment } from "../app/lib/vehicle-communication/transport/web-bluetooth-api";

const uuid = (hex4: string) => `0000${hex4}-0000-1000-8000-00805f9b34fb`;
const domError = (name: string) => Object.assign(new Error(name), { name });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Deferred = { resolve: () => void; reject: (error: unknown) => void };

class Listeners {
  private readonly map = new Map<string, Set<(event: Event) => void>>();
  addEventListener(type: string, listener: (event: Event) => void): void {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.map.get(type)?.delete(listener);
  }
  count(type: string): number {
    return this.map.get(type)?.size ?? 0;
  }
  dispatch(type: string, target: unknown): void {
    for (const listener of [...(this.map.get(type) ?? [])]) listener({ type, target } as unknown as Event);
  }
}

type Props = Partial<{ notify: boolean; indicate: boolean; write: boolean; writeWithoutResponse: boolean }>;

class FakeCharacteristic extends Listeners {
  readonly properties: { notify: boolean; indicate: boolean; write: boolean; writeWithoutResponse: boolean };
  value: DataView | null = null;
  /** Every chunk handed to a write method, with the method used. */
  readonly writes: { mode: "with" | "without"; bytes: number[] }[] = [];
  startCalls = 0;
  stopCalls = 0;
  failStart = false;
  notifying = false;
  holdStart = false;
  heldStart: Deferred | null = null;
  /** When set, writes stay pending until released through `held`. */
  holdWrites = false;
  readonly held: Deferred[] = [];
  failNextWrite: string | null = null;
  onWrite: ((bytes: Uint8Array) => void) | null = null;

  constructor(
    readonly uuid: string,
    props: Props,
  ) {
    super();
    this.properties = { notify: false, indicate: false, write: false, writeWithoutResponse: false, ...props };
  }

  startNotifications(): Promise<unknown> {
    this.startCalls++;
    if (this.failStart) return Promise.reject(domError("NetworkError"));
    if (this.holdStart) {
      return new Promise((resolve, reject) => {
        this.heldStart = {
          resolve: () => {
            this.notifying = true;
            resolve(this);
          },
          reject,
        };
      });
    }
    this.notifying = true;
    return Promise.resolve(this);
  }

  stopNotifications(): Promise<unknown> {
    this.stopCalls++;
    this.notifying = false;
    return Promise.resolve(this);
  }

  writeValueWithResponse(value: Uint8Array): Promise<void> {
    return this.record("with", value);
  }

  writeValueWithoutResponse(value: Uint8Array): Promise<void> {
    return this.record("without", value);
  }

  /** The adapter sends one notification. */
  emit(data: string | number[]): void {
    const bytes = typeof data === "string" ? textToBytes(data) : Uint8Array.from(data);
    // Offset view into a larger buffer, as a browser may hand over.
    const buffer = new Uint8Array(bytes.length + 4);
    buffer.set(bytes, 2);
    this.value = new DataView(buffer.buffer, 2, bytes.length);
    this.dispatch("characteristicvaluechanged", this);
  }

  get written(): string {
    return this.writes.map((w) => bytesToText(w.bytes)).join("");
  }

  private record(mode: "with" | "without", value: Uint8Array): Promise<void> {
    if (this.failNextWrite) {
      const name = this.failNextWrite;
      this.failNextWrite = null;
      return Promise.reject(domError(name));
    }
    this.writes.push({ mode, bytes: [...value] });
    this.onWrite?.(Uint8Array.from(value));
    if (!this.holdWrites) return Promise.resolve();
    return new Promise<void>((resolve, reject) => this.held.push({ resolve, reject }));
  }
}

class FakeService {
  constructor(
    readonly uuid: string,
    readonly characteristics: FakeCharacteristic[],
  ) {}
  getCharacteristics(): Promise<FakeCharacteristic[]> {
    return this.characteristics.length ? Promise.resolve([...this.characteristics]) : Promise.reject(domError("NotFoundError"));
  }
}

class FakeServer {
  connected = false;
  connectCalls = 0;
  disconnectCalls = 0;
  lookups: string[] = [];
  connectError: string | null = null;
  lookupError: string | null = null;
  heldConnect: Deferred | null = null;
  holdConnect = false;
  heldLookup: Deferred | null = null;
  holdLookup = false;

  constructor(
    readonly services: FakeService[],
    private readonly device: () => FakeDevice,
  ) {}

  connect(): Promise<FakeServer> {
    this.connectCalls++;
    if (this.connectError) return Promise.reject(domError(this.connectError));
    if (this.holdConnect) {
      return new Promise((resolve, reject) => {
        this.heldConnect = {
          resolve: () => {
            this.connected = true;
            resolve(this);
          },
          reject,
        };
      });
    }
    this.connected = true;
    return Promise.resolve(this);
  }

  disconnect(): void {
    this.disconnectCalls++;
    this.connected = false;
    // A real browser fires gattserverdisconnected after disconnect().
    this.device().dispatch("gattserverdisconnected", this.device());
  }

  getPrimaryServices(service: string): Promise<FakeService[]> {
    this.lookups.push(service);
    if (this.lookupError) return Promise.reject(domError(this.lookupError));
    const found = this.services.filter((s) => s.uuid === service);
    if (this.holdLookup) {
      return new Promise((resolve, reject) => (this.heldLookup = { resolve: () => resolve(found), reject }));
    }
    return found.length ? Promise.resolve(found) : Promise.reject(domError("NotFoundError"));
  }
}

class FakeDevice extends Listeners {
  readonly id = "fake-device";
  readonly name = "Scripted BLE double";
  gatt: FakeServer | null;
  constructor(services: FakeService[]) {
    super();
    this.gatt = new FakeServer(services, () => this);
  }
  /** The link drops (adapter unplugged, out of range). */
  dropLink(): void {
    if (this.gatt) this.gatt.connected = false;
    this.dispatch("gattserverdisconnected", this);
  }
}

/** Service 18F0 as reported: 2AF0 notify + indicate, 2AF1 write + write without response. */
function device18f0() {
  const notify = new FakeCharacteristic(uuid("2af0"), { notify: true, indicate: true });
  const write = new FakeCharacteristic(uuid("2af1"), { write: true, writeWithoutResponse: true });
  return { device: new FakeDevice([new FakeService(uuid("18f0"), [notify, write])]), notify, write };
}

/** Service FFF0: FFF1 notify, FFF2 write without response only. */
function deviceFff0() {
  const notify = new FakeCharacteristic(uuid("fff1"), { notify: true });
  const write = new FakeCharacteristic(uuid("fff2"), { writeWithoutResponse: true });
  return { device: new FakeDevice([new FakeService(uuid("fff0"), [notify, write])]), notify, write };
}

function environment(device: FakeDevice | null, extra: Partial<BluetoothApi> = {}, secure = true) {
  const requestDevice = vi.fn(async (options: BleRequestDeviceOptions) => {
    void options;
    if (!device) throw domError("NotFoundError");
    return device;
  });
  const env: WebBluetoothEnvironment = { bluetooth: { requestDevice, ...extra }, isSecureContext: secure };
  return { env, requestDevice };
}

function selected(device: FakeDevice, profiles: readonly BleProfile[] = DOCUMENTED_BLE_PROFILES): SelectedBleAdapter {
  return { device, profiles };
}

async function openTransport(device: FakeDevice, options: ConstructorParameters<typeof WebBluetoothTransport>[1] = {}, profiles?: readonly BleProfile[]) {
  const transport = new WebBluetoothTransport(selected(device, profiles), options);
  const closes: TransportCloseReason[] = [];
  transport.onClose((reason) => closes.push(reason));
  await transport.open();
  return { transport, closes };
}

async function openFailure(device: FakeDevice, profiles?: readonly BleProfile[]) {
  const transport = new WebBluetoothTransport(selected(device, profiles));
  const closes: TransportCloseReason[] = [];
  transport.onClose((reason) => closes.push(reason));
  const error = await transport.open().then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TransportError);
  return { transport, closes, error: error as TransportError };
}

describe("feature detection and adapter selection", () => {
  it("reports precise unavailability and never treats a missing getAvailability as unavailable", async () => {
    expect(await detectWebBluetooth({ bluetooth: undefined, isSecureContext: true })).toMatchObject({ available: false, reason: "api_missing" });
    expect(await detectWebBluetooth({ bluetooth: environment(null).env.bluetooth, isSecureContext: false })).toMatchObject({ available: false, reason: "insecure_context" });
    expect(await detectWebBluetooth(environment(null, { getAvailability: async () => false }).env)).toMatchObject({ available: false, reason: "bluetooth_unavailable" });
    expect(await detectWebBluetooth(environment(null, { getAvailability: async () => true }).env)).toEqual({ available: true, radio: "available" });
    expect(await detectWebBluetooth(environment(null).env)).toEqual({ available: true, radio: "unknown" });
    expect(await detectWebBluetooth(environment(null, { getAvailability: () => Promise.reject(domError("SecurityError")) }).env)).toEqual({ available: true, radio: "unknown" });
  });

  it("names both documented profile services in the chooser and returns them for open()", async () => {
    const { device } = device18f0();
    const { env, requestDevice } = environment(device);
    const result = await requestBleAdapter(env);
    expect(result).toEqual({ ok: true, adapter: { device, profiles: DOCUMENTED_BLE_PROFILES } });
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ services: [uuid("18f0")] }, { services: [uuid("fff0")] }],
      optionalServices: [uuid("18f0"), uuid("fff0")],
    });
    await requestBleAdapter(env, { chooser: "all_devices" });
    expect(requestDevice).toHaveBeenLastCalledWith({ acceptAllDevices: true, optionalServices: [uuid("18f0"), uuid("fff0")] });
  });

  it("uses only the override's service when an override is given", async () => {
    const override = createManualBleProfile({ service: "FFE0", notify: "ffe1", write: "FFE1" });
    if (!override.ok) throw new Error("override refused");
    const { env, requestDevice } = environment(new FakeDevice([]));
    const result = await requestBleAdapter(env, { override: override.profile });
    expect(result.ok && result.adapter.profiles).toEqual([override.profile]);
    expect(requestDevice).toHaveBeenCalledWith({ filters: [{ services: [uuid("ffe0")] }], optionalServices: [uuid("ffe0")] });
  });

  it("maps every chooser failure to a distinct reason, and never opens the chooser without the API or a secure context", async () => {
    const cases: [string, string][] = [
      ["NotFoundError", "no_device_chosen"],
      ["SecurityError", "not_allowed"],
      ["NotAllowedError", "not_allowed"],
      ["TypeError", "request_invalid"],
      ["NetworkError", "request_failed"],
    ];
    for (const [name, reason] of cases) {
      const env: WebBluetoothEnvironment = { bluetooth: { requestDevice: () => Promise.reject(domError(name)) }, isSecureContext: true };
      expect(await requestBleAdapter(env)).toMatchObject({ ok: false, reason });
    }
    const insecure = environment(device18f0().device, {}, false);
    expect(await requestBleAdapter(insecure.env)).toMatchObject({ ok: false, reason: "insecure_context" });
    expect(insecure.requestDevice).not.toHaveBeenCalled();
    expect(await requestBleAdapter({ bluetooth: undefined, isSecureContext: true })).toMatchObject({ ok: false, reason: "api_missing" });
  });

  it("labels profiles unverified, with recorded sources, and states its limitations without claiming compatibility", () => {
    for (const profile of DOCUMENTED_BLE_PROFILES) {
      expect(profile.provenance).toBe("community_unverified");
      expect(profile.validation).toBe("pending");
      expect(profile.sources.length).toBeGreaterThan(0);
      for (const source of profile.sources) {
        expect(source.url).toMatch(/^https:\/\//);
        expect(source.location).not.toBe("");
        expect(source.dateRead).toBe("2026-10-26");
      }
    }
    const text = [...WEB_BLUETOOTH_LIMITATIONS, ...DOCUMENTED_BLE_PROFILES.map((p) => `${p.label} ${p.reportedFor}`)].join(" ");
    expect(text).not.toMatch(/\b(is|are) (supported|compatible)\b|\bworks with\b/i);
    expect(WEB_BLUETOOTH_LIMITATIONS.join(" ")).toMatch(/no adapter has been tested/i);
  });
});

describe("manual UUID overrides", () => {
  it("accepts 16-bit, 32-bit and canonical 128-bit forms and nothing else", () => {
    expect(parseBleUuid(" FFE0 ")).toBe(uuid("ffe0"));
    expect(parseBleUuid("0000FFE0")).toBe(uuid("ffe0"));
    expect(parseBleUuid("6E400001-B5A3-F393-E0A9-E50E24DCCA9E")).toBe("6e400001-b5a3-f393-e0a9-e50e24dcca9e");
    for (const bad of ["", "0xFFE0", "FFE", "FFE0F", "GGGG", "{6e400001-b5a3-f393-e0a9-e50e24dcca9e}", "6e400001b5a3f393e0a9e50e24dcca9e", "ff e0", "heart_rate"]) {
      expect(parseBleUuid(bad), bad).toBeNull();
    }
  });

  it("refuses invalid fields and characteristics equal to the service, naming the field", () => {
    expect(createManualBleProfile({ service: "ffe0", notify: "nope", write: "ffe1" })).toEqual({ ok: false, field: "notify", reason: "invalid_uuid" });
    expect(createManualBleProfile({ service: "ffe0", notify: "ffe1", write: "" })).toEqual({ ok: false, field: "write", reason: "invalid_uuid" });
    expect(createManualBleProfile({ service: "ffe0", notify: "ffe0", write: "ffe1" })).toEqual({ ok: false, field: "notify", reason: "same_as_service" });
    expect(createManualBleProfile({ service: "ffe0", notify: "ffe1", write: "0000ffe0" })).toEqual({ ok: false, field: "write", reason: "same_as_service" });
    const ok = createManualBleProfile({ service: "ffe0", notify: "ffe1", write: "ffe2" });
    expect(ok.ok && ok.profile).toMatchObject({ provenance: "user_supplied", validation: "pending", service: uuid("ffe0"), notify: uuid("ffe1"), write: uuid("ffe2") });
  });

  it("opens with one characteristic that both notifies and writes, looking for no documented profile", async () => {
    const both = new FakeCharacteristic(uuid("ffe1"), { notify: true, writeWithoutResponse: true });
    const device = new FakeDevice([new FakeService(uuid("ffe0"), [both]), new FakeService(uuid("18f0"), [])]);
    const override = createManualBleProfile({ service: "ffe0", notify: "ffe1", write: "ffe1" });
    if (!override.ok) throw new Error("override refused");
    const { transport } = await openTransport(device, {}, [override.profile]);
    expect(device.gatt!.lookups).toEqual([uuid("ffe0")]);
    expect(transport.link).toMatchObject({ profile: { id: "manual_override" }, writeMode: "without_response" });
    await transport.write(textToBytes("ATZ\r"));
    expect(both.written).toBe("ATZ\r");
  });

  it("still fails closed when the override's characteristics are unsuitable", async () => {
    const readOnly = new FakeCharacteristic(uuid("ffe1"), { notify: true });
    const override = createManualBleProfile({ service: "ffe0", notify: "ffe1", write: "ffe1" });
    if (!override.ok) throw new Error("override refused");
    const { error } = await openFailure(new FakeDevice([new FakeService(uuid("ffe0"), [readOnly])]), [override.profile]);
    expect(error.code).toBe("unsupported_adapter");
    expect(error.message).toMatch(/not writable/);
  });
});

describe("profile and characteristic discovery", () => {
  it("opens the 18F0 profile, preferring acknowledged writes", async () => {
    const { device, notify } = device18f0();
    const { transport } = await openTransport(device);
    expect(transport.state).toBe("open");
    expect(transport.link).toEqual({
      profile: DOCUMENTED_BLE_PROFILES[0],
      notify: uuid("2af0"),
      write: uuid("2af1"),
      writeMode: "with_response",
      writeChunkBytes: 20,
    });
    expect(notify.startCalls).toBe(1);
    expect(notify.count("characteristicvaluechanged")).toBe(1);
  });

  it("opens the FFF0 profile with write-without-response when that is all it offers", async () => {
    const { device, write } = deviceFff0();
    const { transport } = await openTransport(device);
    expect(transport.link).toMatchObject({ profile: { id: "ble_fff0" }, writeMode: "without_response" });
    await transport.write(textToBytes("ATI\r"));
    expect(write.writes).toEqual([{ mode: "without", bytes: [...textToBytes("ATI\r")] }]);
  });

  it("accepts an indicate-only receive characteristic", async () => {
    const notify = new FakeCharacteristic(uuid("2af0"), { indicate: true });
    const write = new FakeCharacteristic(uuid("2af1"), { write: true });
    const { transport } = await openTransport(new FakeDevice([new FakeService(uuid("18f0"), [notify, write])]));
    expect(transport.state).toBe("open");
  });

  const unsupported: [string, () => FakeDevice, RegExp][] = [
    ["both documented services present", () => new FakeDevice([...device18f0().device.gatt!.services, ...deviceFff0().device.gatt!.services]), /ambiguous: services of more than one profile/],
    ["two instances of the profile service", () => new FakeDevice([...device18f0().device.gatt!.services, ...device18f0().device.gatt!.services]), /ambiguous: 2 instances/],
    [
      "two notify characteristics with the profile UUID",
      () =>
        new FakeDevice([
          new FakeService(uuid("18f0"), [
            new FakeCharacteristic(uuid("2af0"), { notify: true }),
            new FakeCharacteristic(uuid("2af0"), { notify: true }),
            new FakeCharacteristic(uuid("2af1"), { write: true }),
          ]),
        ]),
      /ambiguous: 2 notify/,
    ],
    ["no profile service (HM-10 style FFE0 only)", () => new FakeDevice([new FakeService(uuid("ffe0"), [new FakeCharacteristic(uuid("ffe1"), { notify: true, write: true })])]), /none of the profile services/],
    ["missing write characteristic", () => new FakeDevice([new FakeService(uuid("fff0"), [new FakeCharacteristic(uuid("fff1"), { notify: true })])]), /write characteristic .* is missing/],
    ["service with no characteristics", () => new FakeDevice([new FakeService(uuid("fff0"), [])]), /notify characteristic .* is missing/],
    [
      "receive characteristic that cannot notify",
      () => new FakeDevice([new FakeService(uuid("fff0"), [new FakeCharacteristic(uuid("fff1"), { write: true }), new FakeCharacteristic(uuid("fff2"), { write: true })])]),
      /neither notify nor indicate/,
    ],
    [
      "send characteristic that cannot be written",
      () => new FakeDevice([new FakeService(uuid("fff0"), [new FakeCharacteristic(uuid("fff1"), { notify: true }), new FakeCharacteristic(uuid("fff2"), { notify: true })])]),
      /not writable/,
    ],
  ];

  it.each(unsupported)("fails closed (unsupported_adapter) on %s, releasing the link", async (_name, build, message) => {
    const device = build();
    const { transport, closes, error } = await openFailure(device);
    expect(error.code).toBe("unsupported_adapter");
    expect(error.message).toMatch(message);
    expect(transport.state).toBe("failed");
    expect(closes).toEqual(["error"]);
    expect(device.gatt!.disconnectCalls).toBe(1);
    expect(device.count("gattserverdisconnected")).toBe(0);
    for (const service of device.gatt!.services) for (const c of service.characteristics) expect(c.count("characteristicvaluechanged")).toBe(0);
    await expect(transport.write(textToBytes("ATZ\r"))).rejects.toMatchObject({ code: "not_open" });
    await transport.close();
    expect(transport.state).toBe("closed");
    expect(closes).toEqual(["error"]);
    await expect(transport.open()).rejects.toMatchObject({ code: "closed" });
  });

  it("fails connect_failed on browser errors, with no GATT server, or without a write method", async () => {
    const noGatt = device18f0().device;
    noGatt.gatt = null;
    expect((await openFailure(noGatt)).error.message).toMatch(/no GATT server/);

    const refused = device18f0().device;
    refused.gatt!.connectError = "NetworkError";
    expect((await openFailure(refused)).error).toMatchObject({ code: "connect_failed", message: "GATT connect failed (NetworkError)" });

    const blocked = device18f0().device;
    blocked.gatt!.lookupError = "SecurityError";
    expect((await openFailure(blocked)).error).toMatchObject({ code: "connect_failed", message: expect.stringMatching(/lookup failed \(SecurityError\)/) });

    const noStart = device18f0();
    noStart.notify.failStart = true;
    const failed = await openFailure(noStart.device);
    expect(failed.error).toMatchObject({ code: "connect_failed", message: "notification start failed (NetworkError)" });
    expect(noStart.notify.count("characteristicvaluechanged")).toBe(0);
    expect(noStart.notify.stopCalls).toBe(1);

    const oldBrowser = deviceFff0();
    (oldBrowser.write as { writeValueWithoutResponse?: unknown }).writeValueWithoutResponse = undefined;
    expect((await openFailure(oldBrowser.device)).error).toMatchObject({ code: "connect_failed", message: expect.stringMatching(/no write method/) });
  });

  it("refuses a second open and an invalid chunk size", async () => {
    const { transport } = await openTransport(device18f0().device);
    await expect(transport.open()).rejects.toMatchObject({ code: "already_open" });
    for (const bad of [0, -1, 1.5, 513, Number.NaN]) {
      expect(() => new WebBluetoothTransport(selected(device18f0().device), { writeChunkBytes: bad })).toThrow(RangeError);
    }
    expect(() => new WebBluetoothTransport(selected(device18f0().device, []))).toThrow(RangeError);
  });
});

describe("notifications", () => {
  it("delivers each notification as one copied chunk, in order, only while open", async () => {
    const { device, notify } = device18f0();
    const transport = new WebBluetoothTransport(selected(device));
    const chunks: string[] = [];
    const raw: Uint8Array[] = [];
    transport.onData((chunk) => {
      chunks.push(bytesToText(chunk));
      raw.push(chunk);
    });
    notify.emit("before open"); // no listener is attached yet
    await transport.open();
    notify.emit("41 00 BE 3F");
    notify.emit("\r\r");
    notify.emit(">");
    notify.emit([]); // an empty notification carries no bytes
    notify.emit([0x00, 0xff, 0x0d]);
    expect(chunks).toEqual(["41 00 BE 3F", "\r\r", ">", "\x00\xff\r"]);
    // The chunk is a copy: later notifications reusing the buffer do not change it.
    notify.value!.setUint8(0, 0x41);
    expect(raw[3][0]).toBe(0x00);
    await transport.close();
    notify.emit("after close");
    expect(chunks).toHaveLength(4);
  });

  it("unsubscribes data listeners", async () => {
    const { device, notify } = device18f0();
    const { transport } = await openTransport(device);
    const seen: string[] = [];
    const off = transport.onData((chunk) => seen.push(bytesToText(chunk)));
    notify.emit("A");
    off();
    notify.emit("B");
    expect(seen).toEqual(["A"]);
  });
});

describe("writes", () => {
  it("splits writes into 20-byte chunks by default, in order", async () => {
    const { device, write } = device18f0();
    const { transport } = await openTransport(device);
    const text = "0123456789ABCDEFGHIJ0123456789abcdefghijXYZ\r"; // 44 bytes
    await transport.write(textToBytes(text));
    expect(write.writes.map((w) => w.bytes.length)).toEqual([20, 20, 4]);
    expect(write.writes.every((w) => w.mode === "with")).toBe(true);
    expect(write.written).toBe(text);
    await transport.write(new Uint8Array(0));
    expect(write.writes).toHaveLength(3);
  });

  it("honours a configured chunk size", async () => {
    const { device, write } = device18f0();
    const { transport } = await openTransport(device, { writeChunkBytes: 3 });
    await transport.write(textToBytes("0100\r"));
    expect(write.writes.map((w) => bytesToText(w.bytes))).toEqual(["010", "0\r"]);
  });

  it("copies the caller's bytes before writing", async () => {
    const { device, write } = device18f0();
    const { transport } = await openTransport(device);
    write.holdWrites = true;
    const bytes = textToBytes("ATI\r");
    const pending = transport.write(bytes);
    bytes[0] = 0x58;
    await tick();
    write.held.shift()!.resolve();
    await pending;
    expect(write.written).toBe("ATI\r");
  });

  it("serialises concurrent writes: a later write starts only after the earlier one ends", async () => {
    const { device, write } = device18f0();
    const { transport } = await openTransport(device, { writeChunkBytes: 4 });
    write.holdWrites = true;
    const first = transport.write(textToBytes("AAAAAAAA"));
    const second = transport.write(textToBytes("BBBB"));
    await tick();
    expect(write.written).toBe("AAAA");
    write.held.shift()!.resolve();
    await tick();
    expect(write.written).toBe("AAAAAAAA");
    write.held.shift()!.resolve();
    await first;
    await tick();
    expect(write.written).toBe("AAAAAAAABBBB");
    write.held.shift()!.resolve();
    await second;
  });

  it("rejects aborted while none of the write was sent, including while queued, without disturbing order", async () => {
    const { device, write } = device18f0();
    const { transport } = await openTransport(device, { writeChunkBytes: 4 });
    const already = new AbortController();
    already.abort();
    await expect(transport.write(textToBytes("ATZ\r"), already.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(write.writes).toHaveLength(0);

    write.holdWrites = true;
    const first = transport.write(textToBytes("11112222"));
    const queued = new AbortController();
    const second = transport.write(textToBytes("XXXX"), queued.signal);
    const third = transport.write(textToBytes("3333"));
    queued.abort(); // still waiting behind the first write: nothing of it was sent
    await expect(second).rejects.toMatchObject({ code: "aborted" });
    await tick();
    expect(write.written).toBe("1111"); // the third write still waits for the first

    write.held.shift()!.resolve();
    await tick();
    write.held.shift()!.resolve();
    await first;
    await tick();
    write.held.shift()!.resolve();
    await third;
    expect(write.written).toBe("111122223333");
  });

  it("an abort after the first chunk was handed over lets that write finish", async () => {
    const { device, write } = device18f0();
    const { transport } = await openTransport(device, { writeChunkBytes: 2 });
    write.holdWrites = true;
    const abort = new AbortController();
    const pending = transport.write(textToBytes("ATZ\r"), abort.signal);
    await tick();
    abort.abort();
    write.held.shift()!.resolve();
    await tick();
    write.held.shift()!.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(write.written).toBe("ATZ\r");
  });

  it("a failed GATT write rejects write_failed without closing the link", async () => {
    const { device, write } = device18f0();
    const { transport, closes } = await openTransport(device);
    write.failNextWrite = "NetworkError";
    await expect(transport.write(textToBytes("ATZ\r"))).rejects.toMatchObject({ code: "write_failed", message: "GATT write failed (NetworkError)" });
    expect(transport.state).toBe("open");
    expect(closes).toEqual([]);
    await transport.write(textToBytes("ATI\r"));
    expect(write.written).toBe("ATI\r");
  });
});

describe("lifecycle, disconnects and cleanup", () => {
  function expectReleased(device: FakeDevice, notify: FakeCharacteristic) {
    expect(device.count("gattserverdisconnected")).toBe(0);
    expect(notify.count("characteristicvaluechanged")).toBe(0);
  }

  it("a disconnect fails the in-flight and queued writes, closes once and never reconnects", async () => {
    const { device, notify, write } = device18f0();
    const { transport, closes } = await openTransport(device);
    write.holdWrites = true;
    const inFlight = transport.write(textToBytes("0100\r"));
    const queued = transport.write(textToBytes("03\r"));
    await tick();
    device.dropLink();
    await expect(inFlight).rejects.toMatchObject({ code: "closed" });
    await expect(queued).rejects.toMatchObject({ code: "closed" });
    expect(transport.state).toBe("closed");
    expect(closes).toEqual(["disconnected"]);
    expectReleased(device, notify);
    device.dropLink();
    await transport.close();
    expect(closes).toEqual(["disconnected"]);
    await expect(transport.write(textToBytes("ATZ\r"))).rejects.toMatchObject({ code: "not_open" });
    await expect(transport.open()).rejects.toMatchObject({ code: "closed" });
    expect(device.gatt!.connectCalls).toBe(1);
    expect(write.written).toBe("0100\r");
  });

  it("close() is idempotent, stops notifications, disconnects GATT and rejects a pending write", async () => {
    const { device, notify, write } = device18f0();
    const { transport, closes } = await openTransport(device);
    write.holdWrites = true;
    const pending = transport.write(textToBytes("ATZ\r"));
    await tick();
    await transport.close();
    await transport.close();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    expect(closes).toEqual(["closed_by_client"]);
    expect(notify.stopCalls).toBe(1);
    expect(device.gatt!.disconnectCalls).toBe(1);
    expect(transport.link).toBeNull();
    expectReleased(device, notify);
  });

  /** Starts an open whose browser call at `stage` stays pending; resolves once it is pending. */
  async function heldOpen(stage: "connect" | "lookup" | "start", signal?: AbortSignal) {
    const { device, notify } = device18f0();
    const gatt = device.gatt!;
    if (stage === "connect") gatt.holdConnect = true;
    if (stage === "lookup") gatt.holdLookup = true;
    if (stage === "start") notify.holdStart = true;
    const transport = new WebBluetoothTransport(selected(device));
    const closes: TransportCloseReason[] = [];
    transport.onClose((reason) => closes.push(reason));
    const opening = transport.open(signal);
    const outcome = opening.then(
      () => null,
      (e: unknown) => e as TransportError,
    );
    await tick();
    const release = stage === "connect" ? gatt.heldConnect : stage === "lookup" ? gatt.heldLookup : notify.heldStart;
    expect(release).not.toBeNull();
    expect(transport.state).toBe("connecting");
    return { device, notify, gatt, transport, closes, outcome, release: () => release!.resolve() };
  }

  it("cancelling an open rejects it and releases everything while the browser call is still pending", async () => {
    for (const stage of ["connect", "lookup", "start"] as const) {
      const abort = new AbortController();
      const { device, notify, gatt, transport, closes, outcome, release } = await heldOpen(stage, abort.signal);
      abort.abort();
      // The held browser call has not settled: the open must end anyway.
      expect(await outcome).toMatchObject({ code: "aborted" });
      expect(transport.state).toBe("failed");
      expect(closes).toEqual(["closed_by_client"]);
      expect(gatt.connected).toBe(false);
      expectReleased(device, notify);

      // The late completion is undone and reopens nothing.
      release();
      await tick();
      expect(gatt.connected).toBe(false);
      expect(notify.notifying).toBe(false);
      expect(transport.state).toBe("failed");
      expect(closes).toEqual(["closed_by_client"]);
      expect(gatt.connectCalls).toBe(1);
      expect(notify.startCalls).toBe(stage === "start" ? 1 : 0);
      // No discovery step runs after the cancelled one ("start" follows both service lookups).
      expect(gatt.lookups.length).toBe({ connect: 0, lookup: 1, start: 2 }[stage]);
      expectReleased(device, notify);
    }
  });

  it("a held browser call that fails after a cancelled open changes nothing", async () => {
    const abort = new AbortController();
    const { device, notify, gatt, transport, closes, outcome } = await heldOpen("connect", abort.signal);
    abort.abort();
    expect(await outcome).toMatchObject({ code: "aborted" });
    gatt.heldConnect!.reject(domError("NetworkError"));
    await tick();
    expect(transport.state).toBe("failed");
    expect(closes).toEqual(["closed_by_client"]);
    expect(gatt.connected).toBe(false);
    expectReleased(device, notify);
  });

  it("an open that is not cancelled, given the signal, removes its abort listener", async () => {
    const { device } = device18f0();
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const transport = new WebBluetoothTransport(selected(device));
    await transport.open(abort.signal);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    abort.abort();
    expect(transport.state).toBe("open");
  });

  it("cancelling before open starts rejects without touching the adapter", async () => {
    const already = new AbortController();
    already.abort();
    const fresh = new WebBluetoothTransport(selected(device18f0().device));
    await expect(fresh.open(already.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(fresh.state).toBe("idle");
  });

  it("close() or a disconnect during open rejects the open as closed before the held call settles, and undoes its late completion", async () => {
    for (const stage of ["connect", "start"] as const) {
      for (const how of ["close", "disconnect"] as const) {
        const { device, notify, gatt, transport, closes, outcome, release } = await heldOpen(stage);
        if (how === "close") await transport.close();
        else device.dropLink();
        expect(await outcome).toMatchObject({ code: "closed" });
        expect(transport.state).toBe("closed");
        expect(closes).toEqual([how === "close" ? "closed_by_client" : "disconnected"]);
        expectReleased(device, notify);

        release();
        await tick();
        expect(gatt.connected).toBe(false);
        expect(notify.notifying).toBe(false);
        expect(transport.state).toBe("closed");
        expect(closes).toHaveLength(1);
        expectReleased(device, notify);
      }
    }
  });
});

describe("the command executor over the Web Bluetooth transport (scripted adapter)", () => {
  /** Bridges the scripted ELM model to a BLE double: writes feed it, its replies come back as notifications of at most `mtuPayload` bytes. */
  function bleAdapter(options: ScriptedElmOptions = {}, mtuPayload = 20) {
    const ble = device18f0();
    const elm = new ScriptedElmAdapter(options);
    const notifications: string[] = [];
    const sink = {
      receive(text: string) {
        for (let i = 0; i < text.length; i += mtuPayload) {
          notifications.push(text.slice(i, i + mtuPayload));
          ble.notify.emit(text.slice(i, i + mtuPayload));
        }
      },
    };
    elm.connect(sink as unknown as SimulatedTransport);
    ble.write.onWrite = (bytes) => elm.receiveFromHost(bytes);
    return { ...ble, elm, notifications };
  }

  it("initialises an adapter whose replies arrive as 20-byte notifications, and reads 0100", async () => {
    const adapter = bleAdapter({
      identity: "ELM327 v1.5",
      replies: { "0100": { lines: ["7E8 06 41 00 BE 3F A8 13", "7E9 06 41 00 98 18 80 11"] } },
    });
    const { transport } = await openTransport(adapter.device);
    const executor = new ElmCommandExecutor(transport);
    const init = await initialiseAdapter(executor);
    expect(init.ok).toBe(true);
    const result = await executor.run("0100");
    expect(result.outcome).toBe("ok");
    expect(result.lines).toEqual(["7E8 06 41 00 BE 3F A8 13", "7E9 06 41 00 98 18 80 11"]);
    expect(adapter.notifications.some((n) => n.length === 20)).toBe(true);
    expect(adapter.elm.received).toEqual(["ATZ", "ATE0", "ATL0", "ATS1", "ATH1", "ATSP0", "0100"]);
    await executor.close();
    expect(transport.state).toBe("closed");
  });

  it("frames a reply delivered one byte per notification", async () => {
    const adapter = bleAdapter({ replies: { ATI: { lines: ["ELM327 v2.1"] } } }, 1);
    const { transport } = await openTransport(adapter.device);
    const executor = new ElmCommandExecutor(transport);
    const result = await executor.run("ATI");
    expect(result.outcome).toBe("ok");
    expect(result.lines).toEqual(["ELM327 v2.1"]);
    await executor.close();
  });

  it("a disconnect while waiting for a reply ends the command transport_lost", async () => {
    const adapter = bleAdapter({ replies: { "03": { silent: true } } });
    const { transport } = await openTransport(adapter.device);
    const executor = new ElmCommandExecutor(transport);
    expect((await initialiseAdapter(executor)).ok).toBe(true);
    const pending = executor.run("03");
    setTimeout(() => adapter.device.dropLink(), 5);
    const result = await pending;
    expect(result.outcome).toBe("transport_lost");
    expect(result.lines).toEqual([]);
    expect(transport.state).toBe("closed");
    expect(executor.status.failure).toBe("transport_lost");
    adapter.elm.stop();
  });

  it("a failed GATT write ends the session transport_lost", async () => {
    const adapter = bleAdapter();
    const { transport } = await openTransport(adapter.device);
    const executor = new ElmCommandExecutor(transport);
    adapter.write.failNextWrite = "NetworkError";
    const result = await executor.run("ATZ");
    expect(result.outcome).toBe("transport_lost");
    expect(executor.status.failure).toBe("transport_lost");
    await executor.close();
    expect(transport.state).toBe("closed");
  });
});
