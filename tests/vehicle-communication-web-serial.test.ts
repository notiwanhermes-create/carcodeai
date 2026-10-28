/**
 * S11b: the Web Serial transport, against deterministic doubles of the
 * browser API (WebSerialEnvironment). The port double uses real WHATWG
 * streams (Node's ReadableStream / WritableStream), so stream locking and
 * cancellation behave as the Streams standard defines; the serial port itself
 * is SCRIPTED. No real browser, operating system, Bluetooth stack, Vgate or
 * other adapter, or vehicle is involved, and no hardware compatibility is
 * shown.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToText, textToBytes } from "../app/lib/vehicle-communication/bytes";
import { ElmCommandExecutor } from "../app/lib/vehicle-communication/elm/executor";
import { initialiseAdapter } from "../app/lib/vehicle-communication/elm/initialise";
import { ScannerController, type ScannerRefusal } from "../app/lib/vehicle-communication/scanner/controller";
import type { DiscoveryReport, LiveReport, ScanReport } from "../app/lib/vehicle-communication/scanner/report";
import { ScriptedElmAdapter, type ScriptedElmOptions, type SimulatedTransport } from "../app/lib/vehicle-communication/transport/simulated";
import { TransportError, type TransportCloseReason } from "../app/lib/vehicle-communication/transport/types";
import {
  DEFAULT_SERIAL_SETTINGS,
  detectWebSerial,
  requestSerialPort,
  resolveSerialSettings,
  WEB_SERIAL_LIMITATIONS,
  WebSerialTransport,
  type SelectedSerialPort,
  type WebSerialTransportOptions,
} from "../app/lib/vehicle-communication/transport/web-serial";
import { browserWebSerialEnvironment, type SerialOpenOptions, type WebSerialEnvironment, type WebSerialPort } from "../app/lib/vehicle-communication/transport/web-serial-api";

const domError = (name: string) => Object.assign(new Error(name), { name });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Deferred = { resolve: () => void; reject: (error: unknown) => void };

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A scripted serial port (WICG Web Serial `SerialPort`). `open()` creates a
 * real ReadableStream / WritableStream pair; `close()` refuses while either
 * is locked, as the draft requires.
 */
class FakePort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  private source: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  opened = false;
  opening = false;
  openCalls = 0;
  closeCalls = 0;
  lastOptions: SerialOpenOptions | null = null;
  openError: string | null = null;
  holdOpen = false;
  heldOpen: Deferred | null = null;
  /** The opened port exposes no streams (a broken implementation). */
  noStreams = false;
  readerCancels = 0;
  writerAborts = 0;
  /** reader.cancel() never settles. */
  hangCancel = false;
  /** Every chunk the writer handed to the port. */
  readonly writes: number[][] = [];
  holdWrites = false;
  readonly held: Deferred[] = [];
  failNextWrite: string | null = null;
  onWrite: ((bytes: Uint8Array) => void) | null = null;

  constructor(private readonly info: unknown = { usbVendorId: 0x1a86, usbProductId: 0x7523 }) {}

  getInfo(): never {
    if (this.info instanceof Error) throw this.info;
    return this.info as never;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  open(options: SerialOpenOptions): Promise<void> {
    this.openCalls++;
    this.lastOptions = options;
    if (this.opened || this.opening) return Promise.reject(domError("InvalidStateError"));
    if (this.openError) return Promise.reject(domError(this.openError));
    if (!this.holdOpen) {
      this.finishOpen();
      return Promise.resolve();
    }
    this.opening = true;
    return new Promise<void>((resolve, reject) => {
      this.heldOpen = {
        resolve: () => {
          this.opening = false;
          this.finishOpen();
          resolve();
        },
        reject: (error) => {
          this.opening = false;
          reject(error);
        },
      };
    });
  }

  close(): Promise<void> {
    this.closeCalls++;
    if (!this.opened) return Promise.reject(domError("InvalidStateError"));
    if (this.readable?.locked || this.writable?.locked) return Promise.reject(domError("TypeError"));
    this.opened = false;
    this.readable = null;
    this.writable = null;
    this.source = null;
    return Promise.resolve();
  }

  get locked(): boolean {
    return Boolean(this.readable?.locked || this.writable?.locked);
  }

  /** The adapter sends bytes; they reach the reader as one chunk (a view into a larger buffer). */
  emit(data: string | number[]): void {
    const bytes = typeof data === "string" ? textToBytes(data) : Uint8Array.from(data);
    const buffer = new Uint8Array(bytes.length + 4);
    buffer.set(bytes, 2);
    this.source!.enqueue(new Uint8Array(buffer.buffer, 2, bytes.length));
  }

  /** A read error such as ParityError (non-fatal in the draft) or NetworkError (fatal). */
  failRead(name: string): void {
    this.source!.error(domError(name));
  }

  /** The readable stream ends without the reader cancelling it. */
  endRead(): void {
    this.source!.close();
  }

  /** The device goes away: the read fails with NetworkError and `disconnect` fires. */
  dropLink(): void {
    this.source?.error(domError("NetworkError"));
    this.readable = null;
    this.writable = null;
    for (const listener of [...(this.listeners.get("disconnect") ?? [])]) listener({ type: "disconnect", target: this } as unknown as Event);
  }

  get written(): string {
    return this.writes.map((w) => bytesToText(w)).join("");
  }

  private finishOpen(): void {
    this.opened = true;
    if (this.noStreams) return;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.source = controller;
      },
      cancel: () => {
        this.readerCancels++;
        if (this.hangCancel) return new Promise<void>(() => undefined);
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (this.failNextWrite) {
          const name = this.failNextWrite;
          this.failNextWrite = null;
          return Promise.reject(domError(name));
        }
        this.writes.push([...chunk]);
        this.onWrite?.(Uint8Array.from(chunk));
        if (!this.holdWrites) return;
        return new Promise<void>((resolve, reject) => this.held.push({ resolve, reject }));
      },
      abort: () => {
        this.writerAborts++;
      },
    });
  }
}

function environment(port: FakePort | null, secure = true) {
  const requestPort = vi.fn(async () => {
    if (!port) throw domError("NotFoundError");
    return port as unknown as WebSerialPort;
  });
  const env: WebSerialEnvironment = { serial: { requestPort }, isSecureContext: secure };
  return { env, requestPort };
}

function selected(port: FakePort): SelectedSerialPort {
  return { port: port as unknown as WebSerialPort, info: {} };
}

function track(transport: WebSerialTransport) {
  const closes: TransportCloseReason[] = [];
  const data: string[] = [];
  transport.onClose((reason) => closes.push(reason));
  transport.onData((chunk) => data.push(bytesToText(chunk)));
  return { closes, data };
}

async function openTransport(port = new FakePort(), options: WebSerialTransportOptions = {}) {
  const transport = new WebSerialTransport(selected(port), options);
  const tracked = track(transport);
  await transport.open();
  return { port, transport, ...tracked };
}

async function failure(promise: Promise<unknown>): Promise<TransportError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TransportError);
  return error as TransportError;
}

/** Everything is released: no listener, no stream lock, port closed. */
function expectReleased(port: FakePort) {
  expect(port.count("disconnect")).toBe(0);
  expect(port.locked).toBe(false);
  expect(port.opened).toBe(false);
}

describe("feature detection, server-side safety and port selection", () => {
  it("reports precise unavailability without reading a user-agent string", () => {
    expect(detectWebSerial({ serial: undefined, isSecureContext: true })).toMatchObject({ available: false, reason: "api_missing" });
    expect(detectWebSerial({ serial: environment(null).env.serial, isSecureContext: false })).toMatchObject({ available: false, reason: "insecure_context" });
    expect(detectWebSerial({ serial: {} as never, isSecureContext: true })).toMatchObject({ available: false, reason: "api_missing" });
    expect(detectWebSerial(environment(null).env)).toEqual({ available: true });
  });

  it("is safe to evaluate without a browser and reads navigator only when asked", async () => {
    // This file runs in Node: the modules above were evaluated with no `navigator.serial`.
    expect(browserWebSerialEnvironment()).toEqual({ serial: undefined, isSecureContext: false });
    expect(detectWebSerial(browserWebSerialEnvironment())).toMatchObject({ available: false });
    expect(await requestSerialPort(browserWebSerialEnvironment())).toMatchObject({ ok: false, reason: "insecure_context" });
    const serial = environment(null).env.serial;
    vi.stubGlobal("navigator", { serial });
    vi.stubGlobal("isSecureContext", true);
    expect(browserWebSerialEnvironment()).toEqual({ serial, isSecureContext: true });
  });

  it("returns the chosen port with only the browser-reported identifiers", async () => {
    const port = new FakePort({ usbVendorId: 0x0403, usbProductId: "x", bluetoothServiceClassId: "00001101-0000-1000-8000-00805f9b34fb", extra: 1 });
    const { env, requestPort } = environment(port);
    const result = await requestSerialPort(env);
    expect(requestPort).toHaveBeenCalledWith();
    expect(result).toEqual({ ok: true, selection: { port, info: { usbVendorId: 0x0403, bluetoothServiceClassId: "00001101-0000-1000-8000-00805f9b34fb" } } });
    // A Windows Bluetooth COM port may report nothing; a throwing getInfo() is tolerated.
    expect(await requestSerialPort(environment(new FakePort({})).env)).toMatchObject({ ok: true, selection: { info: {} } });
    expect(await requestSerialPort(environment(new FakePort(domError("InvalidStateError"))).env)).toMatchObject({ ok: true, selection: { info: {} } });
  });

  it("maps chooser cancellation and refusal to distinct reasons, and never opens the chooser without the API or a secure context", async () => {
    const cases: [string, string][] = [
      ["NotFoundError", "no_port_chosen"],
      ["SecurityError", "not_allowed"],
      ["NotAllowedError", "not_allowed"],
      ["NetworkError", "request_failed"],
    ];
    for (const [name, reason] of cases) {
      const env: WebSerialEnvironment = { serial: { requestPort: () => Promise.reject(domError(name)) }, isSecureContext: true };
      expect(await requestSerialPort(env)).toMatchObject({ ok: false, reason });
    }
    expect(await requestSerialPort({ serial: { requestPort: async () => null as never }, isSecureContext: true })).toMatchObject({ ok: false, reason: "request_failed" });
    const insecure = environment(new FakePort(), false);
    expect(await requestSerialPort(insecure.env)).toMatchObject({ ok: false, reason: "insecure_context" });
    expect(insecure.requestPort).not.toHaveBeenCalled();
    expect(await requestSerialPort({ serial: undefined, isSecureContext: true })).toMatchObject({ ok: false, reason: "api_missing" });
  });

  it("states its limitations without claiming that any adapter, or the Vgate at hand, works", () => {
    const text = WEB_SERIAL_LIMITATIONS.join(" ");
    expect(text).not.toMatch(/\b(is|are) (supported|compatible)\b|\bworks with\b/i);
    expect(text).toMatch(/no adapter has been tested/i);
    expect(text).toMatch(/Vgate adapter at hand is unknown/);
    expect(text).toMatch(/paired in Windows Bluetooth settings/);
    expect(text).toMatch(/no automatic reconnect/);
  });
});

describe("serial settings", () => {
  it("fills defaults, keeps explicit values and names an invalid field without correcting it", () => {
    expect(resolveSerialSettings()).toEqual({ ok: true, settings: DEFAULT_SERIAL_SETTINGS });
    expect(DEFAULT_SERIAL_SETTINGS).toEqual({ baudRate: 38400, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
    expect(resolveSerialSettings({ baudRate: 9600, parity: "even", baudRate2: 1 } as never)).toMatchObject({ ok: true, settings: { baudRate: 9600, parity: "even", dataBits: 8 } });
    expect(resolveSerialSettings({ baudRate: undefined })).toEqual({ ok: true, settings: DEFAULT_SERIAL_SETTINGS });
    const bad: [Record<string, unknown>, string][] = [
      [{ baudRate: 0 }, "baudRate"],
      [{ baudRate: 9600.5 }, "baudRate"],
      [{ baudRate: 5_000_000 }, "baudRate"],
      [{ dataBits: 6 }, "dataBits"],
      [{ stopBits: 1.5 }, "stopBits"],
      [{ parity: "mark" }, "parity"],
      [{ flowControl: "xon" }, "flowControl"],
    ];
    for (const [input, field] of bad) expect(resolveSerialSettings(input as never)).toMatchObject({ ok: false, field });
  });

  it("refuses invalid options at construction and opens with exactly the configured settings", async () => {
    const port = new FakePort();
    expect(() => new WebSerialTransport(selected(port), { settings: { baudRate: -1 } })).toThrow(RangeError);
    expect(() => new WebSerialTransport(selected(port), { releaseTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new WebSerialTransport({ port: null as never, info: {} })).toThrow(RangeError);
    const { transport } = await openTransport(port, { settings: { baudRate: 115200, flowControl: "hardware" } });
    expect(port.lastOptions).toEqual({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "hardware" });
    expect(transport.settings).toEqual(port.lastOptions);
    await transport.close();
  });
});

describe("communication", () => {
  it("opens, writes whole commands in order and delivers each read chunk copied, in order", async () => {
    const { port, transport, data, closes } = await openTransport();
    expect(transport.state).toBe("open");
    expect(transport.kind).toBe("web_serial");
    expect(port.count("disconnect")).toBe(1);
    expect(port.readable!.locked).toBe(true);
    expect(port.writable!.locked).toBe(true);

    const sent = textToBytes("0100\r");
    const first = transport.write(sent);
    sent.fill(0); // the transport copied the caller's bytes
    await Promise.all([first, transport.write(textToBytes("03\r")), transport.write(new Uint8Array(0))]);
    expect(port.writes.map((w) => bytesToText(w))).toEqual(["0100\r", "03\r"]);

    const received: Uint8Array[] = [];
    transport.onData((chunk) => received.push(chunk));
    port.emit("41 00 BE");
    port.emit([]); // an empty chunk carries no bytes
    port.emit(" 3F\r\r>");
    await tick();
    expect(data).toEqual(["41 00 BE", " 3F\r\r>"]);
    expect(received[0].byteOffset).toBe(0);
    expect(received[0].buffer.byteLength).toBe(8);
    expect(closes).toEqual([]);
    await transport.close();
  });

  it("unsubscribes data and close listeners", async () => {
    const { port, transport } = await openTransport();
    const seen: string[] = [];
    const closes: TransportCloseReason[] = [];
    const offData = transport.onData((chunk) => seen.push(bytesToText(chunk)));
    const offClose = transport.onClose((reason) => closes.push(reason));
    port.emit("A");
    await tick();
    offData();
    offClose();
    port.emit("B");
    await tick();
    await transport.close();
    expect(seen).toEqual(["A"]);
    expect(closes).toEqual([]);
  });

  it("a throwing data listener neither stops the reads nor keeps later listeners from the bytes", async () => {
    const port = new FakePort();
    const transport = new WebSerialTransport(selected(port));
    const thrown: string[] = [];
    transport.onData((chunk) => {
      thrown.push(bytesToText(chunk));
      throw new Error("subscriber bug");
    });
    const { data, closes } = track(transport);
    await transport.open();
    port.emit("41 00");
    await tick();
    port.emit(" BE\r>");
    await tick();
    expect(thrown).toEqual(["41 00", " BE\r>"]);
    expect(data).toEqual(["41 00", " BE\r>"]);
    expect(transport.state).toBe("open");
    await transport.write(textToBytes("03\r"));
    expect(port.written).toBe("03\r");
    await transport.close();
    expect(closes).toEqual(["closed_by_client"]);
    expectReleased(port);
  });

  it("a throwing close listener neither keeps later listeners from the close nor stops the release", async () => {
    const triggers: [string, (port: FakePort, transport: WebSerialTransport) => Promise<void>, TransportCloseReason][] = [
      ["close()", (_port, transport) => transport.close(), "closed_by_client"],
      ["disconnect", async (port) => port.dropLink(), "disconnected"],
      ["read error", async (port) => port.failRead("ParityError"), "error"],
    ];
    for (const [, trigger, reason] of triggers) {
      const port = new FakePort();
      const transport = new WebSerialTransport(selected(port), { releaseTimeoutMs: 20 });
      let thrown = 0;
      transport.onClose(() => {
        thrown++;
        throw new Error("subscriber bug");
      });
      const { closes } = track(transport);
      await transport.open();
      await trigger(port, transport);
      await tick();
      await transport.close();
      expect(thrown).toBe(1);
      expect(closes).toEqual([reason]);
      expect(transport.state).toBe("closed");
      expectReleased(port);
    }
  });

  it("a throwing close listener does not change how a failed open is reported or released", async () => {
    const port = new FakePort();
    port.openError = "NetworkError";
    const transport = new WebSerialTransport(selected(port));
    transport.onClose(() => {
      throw new Error("subscriber bug");
    });
    const { closes } = track(transport);
    expect((await failure(transport.open())).code).toBe("connect_failed");
    expect(closes).toEqual(["error"]);
    await transport.close();
    expectReleased(port);
  });

  it("serialises writes: a later write reaches the port only after the earlier one completes", async () => {
    const { port, transport } = await openTransport();
    port.holdWrites = true;
    const first = transport.write(textToBytes("ATZ\r"));
    const second = transport.write(textToBytes("ATE0\r"));
    await tick();
    expect(port.written).toBe("ATZ\r");
    port.held[0].resolve();
    await first;
    await tick();
    expect(port.written).toBe("ATZ\rATE0\r");
    port.held[1].resolve();
    await second;
    await transport.close();
  });

  it("rejects aborted while a write is queued or before it starts, and lets a write already handed over finish", async () => {
    const { port, transport } = await openTransport();
    const already = new AbortController();
    already.abort();
    expect((await failure(transport.write(textToBytes("X\r"), already.signal))).code).toBe("aborted");

    port.holdWrites = true;
    const first = transport.write(textToBytes("ATI\r"));
    const queuedAbort = new AbortController();
    const queued = transport.write(textToBytes("03\r"), queuedAbort.signal);
    const after = transport.write(textToBytes("07\r"));
    await tick();
    queuedAbort.abort();
    expect((await failure(queued)).code).toBe("aborted");

    const inFlightAbort = new AbortController();
    port.held[0].resolve();
    await first;
    await tick();
    expect(port.written).toBe("ATI\r07\r");
    const third = transport.write(textToBytes("0A\r"), inFlightAbort.signal);
    port.held[1].resolve();
    await after;
    await tick();
    expect(port.written).toBe("ATI\r07\r0A\r");
    inFlightAbort.abort(); // already handed to the port: the write finishes
    port.held[2].resolve();
    await expect(third).resolves.toBeUndefined();
    expect(transport.state).toBe("open");
    await transport.close();
  });

  it("a failed write rejects write_failed and ends the link, releasing the port", async () => {
    for (const [name, reason] of [
      ["UnknownError", "error"],
      ["NetworkError", "disconnected"],
    ] as const) {
      const { port, transport, closes } = await openTransport();
      port.failNextWrite = name;
      const error = await failure(transport.write(textToBytes("ATZ\r")));
      expect(error.code).toBe("write_failed");
      expect(error.message).toContain(name);
      expect(transport.state).toBe("closed");
      expect(closes).toEqual([reason]);
      await transport.close();
      expectReleased(port);
      expect((await failure(transport.write(textToBytes("ATZ\r")))).code).toBe("not_open");
    }
  });
});

describe("open failures", () => {
  it("maps permission and open errors to connect_failed with an accurate cause, and releases everything", async () => {
    const cases: [string, RegExp][] = [
      ["NetworkError", /another application may hold it, or the adapter is off, out of range or unplugged/],
      ["InvalidStateError", /already open/],
      ["TypeError", /serial settings/],
      ["SecurityError", /SecurityError/],
    ];
    for (const [name, message] of cases) {
      const port = new FakePort();
      port.openError = name;
      const transport = new WebSerialTransport(selected(port));
      const { closes } = track(transport);
      const error = await failure(transport.open());
      expect(error.code).toBe("connect_failed");
      expect(error.message).toMatch(message);
      expect(transport.state).toBe("failed");
      expect(closes).toEqual(["error"]);
      await transport.close();
      expect(transport.state).toBe("closed");
      expect(closes).toEqual(["error"]);
      expectReleased(port);
      expect(port.closeCalls).toBe(0);
      expect((await failure(transport.open())).code).toBe("closed");
    }
  });

  it("a port that opens without streams fails closed and is closed again", async () => {
    const port = new FakePort();
    port.noStreams = true;
    const transport = new WebSerialTransport(selected(port));
    const error = await failure(transport.open());
    expect(error).toMatchObject({ code: "connect_failed", message: expect.stringMatching(/no readable or writable stream/) });
    await transport.close();
    expect(port.closeCalls).toBe(1);
    expectReleased(port);
  });

  it("refuses a second open of the same transport and of a port another connection holds", async () => {
    const { port, transport } = await openTransport();
    expect((await failure(transport.open())).code).toBe("already_open");
    const rival = new WebSerialTransport(selected(port));
    const error = await failure(rival.open());
    expect(error).toMatchObject({ code: "connect_failed", message: expect.stringMatching(/already in use by another connection/) });
    expect(port.openCalls).toBe(1);
    expect(transport.state).toBe("open");
    await transport.write(textToBytes("ATI\r"));
    await transport.close();
    expectReleased(port);
  });
});

describe("read errors and disconnects", () => {
  it("ends the link on any read error or end of stream, never resuming with lost bytes", async () => {
    const cases: [(port: FakePort) => void, TransportCloseReason][] = [
      [(port) => port.failRead("ParityError"), "error"],
      [(port) => port.failRead("BufferOverrunError"), "error"],
      [(port) => port.failRead("NetworkError"), "disconnected"],
      [(port) => port.endRead(), "disconnected"],
    ];
    for (const [fail, reason] of cases) {
      const { port, transport, closes, data } = await openTransport();
      port.emit("OK");
      await tick();
      fail(port);
      await tick();
      expect(transport.state).toBe("closed");
      expect(closes).toEqual([reason]);
      expect(data).toEqual(["OK"]);
      await transport.close();
      expectReleased(port);
      expect(closes).toEqual([reason]);
    }
  });

  it("a disconnect fails the in-flight and queued writes, closes once, releases the port and never reconnects", async () => {
    const { port, transport, closes } = await openTransport(new FakePort(), { releaseTimeoutMs: 20 });
    port.holdWrites = true;
    const inFlight = transport.write(textToBytes("0100\r"));
    const queued = transport.write(textToBytes("03\r"));
    await tick();
    port.dropLink();
    expect((await failure(inFlight)).code).toBe("closed");
    expect((await failure(queued)).code).toBe("closed");
    expect(transport.state).toBe("closed");
    expect(closes).toEqual(["disconnected"]);
    port.dropLink();
    await transport.close();
    expect(closes).toEqual(["disconnected"]);
    expectReleased(port);
    expect((await failure(transport.write(textToBytes("ATZ\r")))).code).toBe("not_open");
    expect((await failure(transport.open())).code).toBe("closed");
    expect(port.openCalls).toBe(1);
    expect(port.written).toBe("0100\r");
  });
});

describe("close, cancellation and cleanup", () => {
  it("close() is idempotent, rejects a pending write, ends the pending read, releases both locks and closes the port", async () => {
    const { port, transport, closes } = await openTransport(new FakePort(), { releaseTimeoutMs: 20 });
    port.holdWrites = true;
    const pending = transport.write(textToBytes("ATZ\r"));
    await tick();
    const closing = transport.close();
    expect(transport.state).toBe("closed");
    expect((await failure(pending)).code).toBe("closed");
    await Promise.all([closing, transport.close()]);
    expect(closes).toEqual(["closed_by_client"]);
    expect(port.readerCancels).toBe(1);
    expect(port.closeCalls).toBe(1);
    expectReleased(port);
    // Bytes the adapter sends after close reach nobody (the port is gone).
    expect(port.readable).toBeNull();
  });

  it("close() settles within the bound even when the browser's cancel never does", async () => {
    const port = new FakePort();
    port.hangCancel = true;
    const { transport } = await openTransport(port, { releaseTimeoutMs: 15 });
    const started = Date.now();
    await transport.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(port.readerCancels).toBe(1);
    expectReleased(port);
  });

  /** Starts an open whose browser `open()` stays pending; resolves once it is pending. */
  async function heldOpen(signal?: AbortSignal) {
    const port = new FakePort();
    port.holdOpen = true;
    const transport = new WebSerialTransport(selected(port), { releaseTimeoutMs: 15 });
    const { closes } = track(transport);
    const outcome = transport.open(signal).then(
      () => null,
      (e: unknown) => e as TransportError,
    );
    await tick();
    expect(port.heldOpen).not.toBeNull();
    expect(transport.state).toBe("connecting");
    return { port, transport, closes, outcome };
  }

  it("cancelling an open rejects it at once while the browser call is pending, and closes a port that opens late", async () => {
    const abort = new AbortController();
    const { port, transport, closes, outcome } = await heldOpen(abort.signal);
    abort.abort();
    expect(await outcome).toMatchObject({ code: "aborted" });
    expect(transport.state).toBe("failed");
    expect(closes).toEqual(["closed_by_client"]);
    expect(port.count("disconnect")).toBe(0);

    port.heldOpen!.resolve();
    await transport.close();
    expect(port.closeCalls).toBe(1);
    expectReleased(port);
    expect(closes).toEqual(["closed_by_client"]);
  });

  it("a port that opens after the release gave up waiting is still closed", async () => {
    const abort = new AbortController();
    const { port, transport, outcome } = await heldOpen(abort.signal);
    abort.abort();
    await outcome;
    await transport.close(); // waits at most 15 ms for the held open
    expect(port.opening).toBe(true);
    port.heldOpen!.resolve();
    await tick();
    expect(port.closeCalls).toBe(1);
    expectReleased(port);
  });

  it("a held open that fails after cancellation changes nothing", async () => {
    const abort = new AbortController();
    const { port, transport, closes, outcome } = await heldOpen(abort.signal);
    abort.abort();
    await outcome;
    port.heldOpen!.reject(domError("NetworkError"));
    await transport.close();
    expect(closes).toEqual(["closed_by_client"]);
    expect(port.closeCalls).toBe(0);
    expectReleased(port);
  });

  it("close() or a disconnect during open rejects the open as closed and undoes a late open", async () => {
    for (const how of ["close", "disconnect"] as const) {
      const { port, transport, closes, outcome } = await heldOpen();
      if (how === "close") void transport.close();
      else port.dropLink();
      expect(await outcome).toMatchObject({ code: "closed" });
      expect(transport.state).toBe("closed");
      expect(closes).toEqual([how === "close" ? "closed_by_client" : "disconnected"]);
      port.heldOpen!.resolve();
      await transport.close();
      expect(port.closeCalls).toBe(1);
      expectReleased(port);
      expect(closes).toHaveLength(1);
    }
  });

  it("cancelling before open starts rejects without touching the port; a completed open removes its abort listener", async () => {
    const port = new FakePort();
    const already = new AbortController();
    already.abort();
    const fresh = new WebSerialTransport(selected(port));
    expect((await failure(fresh.open(already.signal))).code).toBe("aborted");
    expect(fresh.state).toBe("idle");
    expect(port.openCalls).toBe(0);

    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    await fresh.open(abort.signal);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    abort.abort();
    expect(fresh.state).toBe("open");
    await fresh.close();
  });

  it("close() or an abort right after open(), with no yield between, never lets that attempt call the browser's open; a replacement opens cleanly", async () => {
    for (const how of ["close", "abort"] as const) {
      const port = new FakePort();
      const abort = new AbortController();
      const stale = new WebSerialTransport(selected(port));
      const opening = failure(stale.open(abort.signal));
      // Synchronously, before open() resumes after claiming the port.
      if (how === "close") void stale.close();
      else abort.abort();
      expect((await opening).code).toBe(how === "close" ? "closed" : "aborted");
      await stale.close();
      expect(port.openCalls, how).toBe(0);

      // A replacement transport on the same port, started at once, opens without interference.
      const replacement = new WebSerialTransport(selected(port));
      await replacement.open();
      await tick();
      expect(replacement.state, how).toBe("open");
      expect(port.openCalls, how).toBe(1);
      await replacement.close();
      expectReleased(port);
    }
  });
});

describe("reconnecting with a new transport", () => {
  it("a new transport on the same port opens after the previous one released it, even if its close was not awaited", async () => {
    const port = new FakePort();
    const selection = selected(port);
    const first = new WebSerialTransport(selection, { releaseTimeoutMs: 20 });
    await first.open();
    port.holdWrites = true;
    const stuck = first.write(textToBytes("ATZ\r"));
    void first.close(); // the writer abort waits for the held write, up to the bound
    await failure(stuck);

    const second = new WebSerialTransport(selection);
    const { data } = track(second);
    await second.open();
    expect(port.openCalls).toBe(2);
    expect(port.closeCalls).toBe(1);
    port.holdWrites = false;
    await second.write(textToBytes("ATI\r"));
    port.emit("ELM327 v1.5\r\r>");
    await tick();
    expect(data).toEqual(["ELM327 v1.5\r\r>"]);
    await second.close();
    expectReleased(port);
  });

  it("after a disconnect, a new transport reopens the port", async () => {
    const { port, transport } = await openTransport();
    port.dropLink();
    await transport.close();
    const again = new WebSerialTransport(selected(port));
    await again.open();
    expect(again.state).toBe("open");
    expect(port.openCalls).toBe(2);
    await again.close();
    expectReleased(port);
  });

  it("a waiting open can be cancelled while the previous transport is still releasing", async () => {
    const port = new FakePort();
    port.hangCancel = true;
    const { transport } = await openTransport(port, { releaseTimeoutMs: 200 });
    void transport.close();
    const next = new WebSerialTransport(selected(port));
    const abort = new AbortController();
    const opening = next.open(abort.signal);
    await tick();
    abort.abort();
    expect((await failure(opening)).code).toBe("aborted");
    expect(port.openCalls).toBe(1);
    await transport.close();
    await next.close();
    expectReleased(port);
  });

  it("of two transports waiting on the same release, one takes the port; the other cannot drop its ownership", async () => {
    const port = new FakePort();
    port.hangCancel = true; // every release waits out its bound on the reader cancel
    const selection = selected(port);
    const { transport: first } = await openTransport(port, { releaseTimeoutMs: 30 });
    void first.close();
    const winner = new WebSerialTransport(selection, { releaseTimeoutMs: 30 });
    const loser = new WebSerialTransport(selection, { releaseTimeoutMs: 30 });
    const winning = winner.open();
    const losing = loser.open();
    await tick();
    expect(port.openCalls).toBe(1);

    await winning;
    const error = await failure(losing);
    expect(error).toMatchObject({ code: "connect_failed", message: expect.stringMatching(/already in use by another connection/) });
    expect(port.openCalls).toBe(2); // the losing transport never called open()
    await loser.close();

    // The winner still owns the port: a rival is refused rather than racing it.
    const rival = new WebSerialTransport(selection);
    expect((await failure(rival.open())).message).toMatch(/already in use by another connection/);
    expect(winner.state).toBe("open");
    expect(port.openCalls).toBe(2);

    // A reconnect waits for the winner's release instead of failing InvalidStateError.
    void winner.close();
    const again = new WebSerialTransport(selection);
    const reopening = again.open();
    await tick();
    expect(again.state).toBe("connecting");
    expect(port.openCalls).toBe(2);
    await reopening;
    expect(again.state).toBe("open");
    expect(port.openCalls).toBe(3);
    port.hangCancel = false;
    await again.close();
    expectReleased(port);
  });
});

describe("the executor and scanner over the Web Serial transport (scripted adapter)", () => {
  /** Bridges the scripted ELM model to a port double: writes feed it, replies come back as read chunks of at most `chunk` bytes. */
  function serialAdapter(options: ScriptedElmOptions = {}, chunk = 64, onCommand?: (command: string) => void) {
    const port = new FakePort();
    const elm = new ScriptedElmAdapter(options);
    const sink = {
      receive(text: string) {
        if (!port.readable) return;
        for (let i = 0; i < text.length; i += chunk) port.emit(text.slice(i, i + chunk));
      },
    };
    elm.connect(sink as unknown as SimulatedTransport);
    port.onWrite = (bytes) => {
      elm.receiveFromHost(bytes);
      onCommand?.(bytesToText(bytes).replace(/\r$/, ""));
    };
    return { port, elm };
  }

  /** One CAN 11-bit ECU (7E8), as in the scanner suite: $03 P0133, $07 none, live PIDs 0C 0D 05. */
  const vehicle: NonNullable<ScriptedElmOptions["replies"]> = {
    "0100": { lines: ["7E8 06 41 00 98 18 80 01"] },
    "0120": { lines: ["7E8 06 41 20 00 00 00 01"] },
    "0140": { lines: ["7E8 06 41 40 40 00 00 00"] },
    "0900": { lines: ["7E8 06 49 00 40 00 00 00"] },
    "0902": { lines: ["7E8 10 14 49 02 01 31 48 47", "7E8 21 43 4D 38 32 36 33 33", "7E8 22 41 30 30 34 33 35 32"] },
    "0101": { lines: ["7E8 06 41 01 81 07 65 04"] },
    "03": { lines: ["7E8 04 43 01 01 33"] },
    "07": { lines: ["7E8 02 47 00"] },
    "0A": { lines: ["7E8 02 4A 00"] },
    "020000": { lines: ["7E8 07 42 00 00 58 18 00 00"] },
    "020200": { lines: ["7E8 05 42 02 00 01 33"] },
    "020400": { lines: ["7E8 04 42 04 00 80"] },
    "020500": { lines: ["7E8 04 42 05 00 7B"] },
    "020C00": { lines: ["7E8 05 42 0C 00 1A F8"] },
    "020D00": { lines: ["7E8 04 42 0D 00 32"] },
    "010C": { lines: ["7E8 04 41 0C 0B B8"] },
    "010D": { lines: ["7E8 03 41 0D 00"] },
    "0105": { lines: ["7E8 03 41 05 5A"] },
    "0104": { lines: ["7E8 03 41 04 33"] },
    "0111": { lines: ["7E8 03 41 11 26"] },
    "0142": { lines: ["7E8 04 41 42 37 DC"] },
  };

  function ok<T>(result: T | ScannerRefusal): T {
    if (typeof result === "object" && result !== null && "status" in result && result.status === "refused") throw new Error(`refused: ${result.reason}`);
    return result as T;
  }

  /** A scanner over a Web Serial transport on a scripted port, connected (discovery done). */
  async function serialScanner(replies: NonNullable<ScriptedElmOptions["replies"]> = {}, chunk = 64, onCommand?: (command: string, port: FakePort) => void) {
    const { port } = serialAdapter({ replies: { ...vehicle, ...replies } }, chunk, (command) => onCommand?.(command, port));
    const transport = new WebSerialTransport(selected(port), { releaseTimeoutMs: 20 });
    const scanner = new ScannerController(transport);
    const discovery = ok<DiscoveryReport>(await scanner.connect());
    return { port, transport, scanner, discovery };
  }

  it("row 1: a full discovery and scan read one byte per serial chunk give the same result as whole replies", async () => {
    const whole = await serialScanner();
    const split = await serialScanner({}, 1);
    expect(split.discovery).toMatchObject({ ended: "finished", transport: "web_serial" });
    const [a, b] = [ok<ScanReport>(await whole.scanner.scan()), ok<ScanReport>(await split.scanner.scan())];
    expect(b.ended).toBe("finished");
    expect(b.dtcs.ecus[0]).toMatchObject({ outcomes: { "03": "ok", "07": "ok" }, codes: [{ code: "P0133" }] });
    expect(b.dtcs).toEqual(a.dtcs);
    for (const { scanner, port } of [whole, split]) {
      await scanner.close();
      expectReleased(port);
    }
  });

  it("row 28: cancel while waiting for > ends the scan cancelled and keeps the serial session usable", async () => {
    const late: { scanner?: ScannerController } = {};
    let cancelled = false;
    const rig = await serialScanner({ "07": [{ silent: true }, { lines: ["7E8 02 47 00"] }] }, 64, (command) => {
      if (command === "07" && !cancelled) {
        cancelled = true;
        setTimeout(() => late.scanner?.cancel(), 5);
      }
    });
    const scanner = (late.scanner = rig.scanner);
    const report = ok<ScanReport>(await scanner.scan());
    expect(report.ended).toBe("cancelled");
    expect(report.dtcs.ecus[0]).toMatchObject({ outcomes: { "03": "ok", "07": "interrupted" }, codes: [{ code: "P0133" }] });
    expect(rig.transport.state).toBe("open");
    expect(ok<ScanReport>(await scanner.scan()).ended).toBe("finished");
    await scanner.close();
    expectReleased(rig.port);
  });

  it("row 31: a serial disconnect during 07 ends the scan transport_lost, keeps the 03 results and never reopens the port", async () => {
    const rig = await serialScanner({ "07": { silent: true } }, 64, (command, port) => {
      if (command === "07") setTimeout(() => port.dropLink(), 5);
    });
    const report = ok<ScanReport>(await rig.scanner.scan());
    expect(report.ended).toBe("transport_lost");
    expect(report.dtcs.ecus[0]).toMatchObject({ outcomes: { "03": "ok", "07": "transport_lost", "0A": "not_read" }, codes: [{ code: "P0133", kinds: ["stored"] }] });
    expect(rig.transport.state).toBe("closed");
    expect(await rig.scanner.scan()).toMatchObject({ status: "refused", reason: "session_unavailable" });
    await rig.scanner.close();
    expectReleased(rig.port);
    expect(rig.port.openCalls).toBe(1);
  });

  it("row 33: close() during a held serial write rejects it, closes the transport and writes nothing more", async () => {
    const rig = await serialScanner({}, 64, (command, port) => {
      if (command === "03") port.holdWrites = true;
    });
    const pending = rig.scanner.scan();
    await vi.waitFor(() => expect(rig.port.held).toHaveLength(1));
    const writes = rig.port.writes.length;
    await rig.scanner.close();
    const report = ok<ScanReport>(await pending);
    expect(report.ended).not.toBe("finished");
    expect(rig.transport.state).toBe("closed");
    expect(rig.port.writes).toHaveLength(writes);
    expectReleased(rig.port);
  });

  it("row 55: a serial disconnect while polling stops it transport_lost, with no restart", async () => {
    let reads = 0;
    const rig = await serialScanner({}, 64, (command, port) => {
      if (command === "010C" && ++reads === 2) setTimeout(() => port.dropLink(), 0);
    });
    const selection = [
      { module: "obd-can11-7e8", pid: 0x0c },
      { module: "obd-can11-7e8", pid: 0x0d },
    ];
    const report = ok<LiveReport>(await rig.scanner.startLivePolling({ selection, cycles: 50, intervalMs: 1 }));
    expect(report.ended).toBe("transport_lost");
    expect(report.cycles.length).toBeLessThan(50);
    expect(rig.scanner.state).toBe("failed");
    expect(await rig.scanner.startLivePolling({ selection, cycles: 1 })).toMatchObject({ status: "refused", reason: "session_unavailable" });
    await rig.scanner.close();
    expectReleased(rig.port);
    expect(rig.port.openCalls).toBe(1);
  });

  it("initialises an adapter and reads 0100, with replies split across reads", async () => {
    const { port, elm } = serialAdapter({ identity: "ELM327 v1.5", replies: { "0100": { lines: ["7E8 06 41 00 BE 3F A8 13"] } } }, 3);
    const { transport } = await openTransport(port);
    const executor = new ElmCommandExecutor(transport);
    expect((await initialiseAdapter(executor)).ok).toBe(true);
    const result = await executor.run("0100");
    expect(result.outcome).toBe("ok");
    expect(result.lines).toEqual(["7E8 06 41 00 BE 3F A8 13"]);
    expect(elm.received).toEqual(["ATZ", "ATE0", "ATL0", "ATS1", "ATH1", "ATSP0", "0100"]);
    await executor.close();
    expect(transport.state).toBe("closed");
    expectReleased(port);
  });

  it("a disconnect while waiting for a reply ends the command transport_lost", async () => {
    const { port, elm } = serialAdapter({ replies: { "03": { silent: true } } });
    const { transport } = await openTransport(port);
    const executor = new ElmCommandExecutor(transport);
    expect((await initialiseAdapter(executor)).ok).toBe(true);
    const pending = executor.run("03");
    setTimeout(() => port.dropLink(), 5);
    const result = await pending;
    expect(result.outcome).toBe("transport_lost");
    expect(executor.status.failure).toBe("transport_lost");
    elm.stop();
    await executor.close();
    expectReleased(port);
  });

  it("a failed serial write ends the session transport_lost", async () => {
    const { port } = serialAdapter();
    const { transport } = await openTransport(port);
    const executor = new ElmCommandExecutor(transport);
    port.failNextWrite = "UnknownError";
    const result = await executor.run("ATZ");
    expect(result.outcome).toBe("transport_lost");
    await executor.close();
    expectReleased(port);
  });

  it("the scanner controller opens the transport itself and runs discovery over it", async () => {
    const { port } = serialAdapter({
      replies: {
        "0100": { lines: ["7E8 06 41 00 98 18 80 01"] },
        "0120": { lines: ["7E8 06 41 20 00 00 00 00"] },
        "0900": { lines: ["7E8 06 49 00 00 00 00 00"] },
      },
    });
    const transport = new WebSerialTransport(selected(port));
    const scanner = new ScannerController(transport);
    const discovery = await scanner.connect();
    expect(discovery).toMatchObject({ kind: "discovery", transport: "web_serial" });
    expect(transport.state).toBe("open");
    await scanner.close();
    expect(transport.state).toBe("closed");
    expectReleased(port);
  });
});
