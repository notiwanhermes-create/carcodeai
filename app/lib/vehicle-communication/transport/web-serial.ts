/**
 * The Web Serial transport (vci-transport.md, "Candidate browser transports",
 * "Proposed transport interface"; S11b).
 *
 * RESEARCH PROTOTYPE. Browser-only, reached through the injectable
 * `WebSerialEnvironment`; the automated tests use deterministic doubles of
 * it, so passing tests show the code behaves as designed against SCRIPTED
 * browser objects, not that any real adapter, browser, operating system or
 * vehicle does. No adapter has been tested.
 *
 * Rules:
 * - Port selection (`requestSerialPort`) must be called directly from a user
 *   gesture, with nothing awaited before it; it opens the browser chooser.
 * - `open()` opens the port with explicit settings (`resolveSerialSettings`),
 *   then takes the port's reader and writer. Exactly one transport on the page
 *   holds a port at a time; a new transport on the same port waits until the
 *   previous one has released it, so reconnecting means a new transport.
 * - Writes are serialised in call order; each is handed to the port's writer
 *   whole. A write rejects `aborted` only while it has not been handed over.
 *   A failed write ends the link (a stream error is permanent).
 * - Each chunk the reader yields is delivered copied, in order. Any read error
 *   (including parity, framing, overrun and break errors, after which bytes
 *   are lost) ends the link; reading never silently resumes.
 * - A disconnect, close or failed open cancels the reader, aborts the writer,
 *   releases both stream locks and closes the port; each step is bounded by
 *   `releaseTimeoutMs`, so `close()` always settles. There is no automatic
 *   reconnect. Payload bytes are never logged.
 * - An abort, close or disconnect ends `open()` at once, even while the
 *   browser's `open()` is pending; a port that finishes opening afterwards is
 *   closed again.
 */
import { TransportError, type ByteTransport, type TransportCloseReason, type TransportState } from "./types";
import { errorName } from "./web-bluetooth-api";
import type {
  SerialFlowControl,
  SerialOpenOptions,
  SerialParity,
  SerialPortInfo,
  SerialStreamReader,
  SerialStreamWriter,
  WebSerialEnvironment,
  WebSerialPort,
} from "./web-serial-api";

/** Plain statements of what this transport cannot do or has not shown. Shown to users as-is. */
export const WEB_SERIAL_LIMITATIONS = [
  "Web Serial reaches only serial ports the operating system exposes: USB-serial adapters, and on Windows a Bluetooth Classic adapter paired in Windows Bluetooth settings, which Windows presents as a COM port. Pairing happens in the operating system, not in this page.",
  "Windows often creates two COM ports for one paired Bluetooth adapter (outgoing and incoming); only the outgoing port is expected to connect. The chooser shows the names the browser gives, and this page cannot tell the two apart.",
  "Web Serial needs a secure context (HTTPS or localhost) and a user gesture to open the port chooser.",
  "Browser support differs by browser and platform (last known: desktop Chrome and Edge offer it; Firefox, Safari and every browser on iOS or iPadOS do not; Android is uncertain; not re-verified). Only feature detection decides what is offered.",
  "No adapter has been tested with this transport, and no adapter is known to be compatible. The model of the Vgate adapter at hand is unknown, so nothing here shows that it works.",
  "The serial settings must match the adapter. 38400 baud is the ELM327 datasheet default, but clones differ; a Bluetooth COM port is not expected to use the baud rate on the radio link (unverified).",
  "Only one program can hold a COM port at a time: if another application or browser tab has it open, opening fails.",
  "A read error (parity, framing, buffer overrun or break) or a disconnect ends the session; there is no automatic reconnect.",
  "An open port shows only that bytes can move; the adapter must still answer an ELM-style handshake.",
] as const;

export type SerialSettings = Readonly<Pick<SerialOpenOptions, "baudRate" | "dataBits" | "stopBits" | "parity" | "flowControl">>;

/** 8 data bits, no parity, 1 stop bit, no flow control, 38400 baud (the ELM327 datasheet default; clones vary). */
export const DEFAULT_SERIAL_SETTINGS: SerialSettings = { baudRate: 38400, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" };
/** A sanity bound on the configured rate, not a claim about any adapter. */
export const MAX_SERIAL_BAUD_RATE = 4_000_000;
export const DEFAULT_SERIAL_RELEASE_TIMEOUT_MS = 2000;
export const MAX_SERIAL_RELEASE_TIMEOUT_MS = 60_000;

export type SerialSettingsResult = { ok: true; settings: SerialSettings } | { ok: false; field: keyof SerialSettings; detail: string };

/** Completes and validates serial settings; an invalid field is named, never corrected. */
export function resolveSerialSettings(input: Partial<SerialSettings> = {}): SerialSettingsResult {
  const settings = { ...DEFAULT_SERIAL_SETTINGS, ...definedOnly(input) };
  if (!Number.isInteger(settings.baudRate) || settings.baudRate < 1 || settings.baudRate > MAX_SERIAL_BAUD_RATE) {
    return { ok: false, field: "baudRate", detail: `baudRate must be an integer from 1 to ${MAX_SERIAL_BAUD_RATE}` };
  }
  if (settings.dataBits !== 7 && settings.dataBits !== 8) return { ok: false, field: "dataBits", detail: "dataBits must be 7 or 8" };
  if (settings.stopBits !== 1 && settings.stopBits !== 2) return { ok: false, field: "stopBits", detail: "stopBits must be 1 or 2" };
  if (!(["none", "even", "odd"] as SerialParity[]).includes(settings.parity)) return { ok: false, field: "parity", detail: "parity must be none, even or odd" };
  if (!(["none", "hardware"] as SerialFlowControl[]).includes(settings.flowControl)) {
    return { ok: false, field: "flowControl", detail: "flowControl must be none or hardware" };
  }
  return { ok: true, settings: Object.freeze(settings) };
}

function definedOnly<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export type WebSerialAvailability = { available: true } | { available: false; reason: "insecure_context" | "api_missing"; detail: string };

/** Feature detection: decides whether to offer Web Serial. Never reads a user-agent string. */
export function detectWebSerial(env: WebSerialEnvironment): WebSerialAvailability {
  if (!env.isSecureContext) return { available: false, reason: "insecure_context", detail: "Web Serial needs a secure context (HTTPS or localhost)" };
  if (!env.serial || typeof env.serial.requestPort !== "function") {
    return { available: false, reason: "api_missing", detail: "this browser does not provide Web Serial" };
  }
  return { available: true };
}

/** The port a person chose. `info` is what the browser reports; it does not identify the adapter model. */
export type SelectedSerialPort = {
  readonly port: WebSerialPort;
  readonly info: SerialPortInfo;
};

export type SerialPortRequestFailure = "insecure_context" | "api_missing" | "no_port_chosen" | "not_allowed" | "request_failed";

export type SerialPortRequest = { ok: true; selection: SelectedSerialPort } | { ok: false; reason: SerialPortRequestFailure; detail: string };

/**
 * Opens the browser's port chooser. Call it directly from a click (or other
 * user gesture) handler with nothing awaited first: the chooser needs the
 * gesture's transient activation.
 */
export async function requestSerialPort(env: WebSerialEnvironment): Promise<SerialPortRequest> {
  const availability = detectWebSerial(env);
  if (!availability.available) return { ok: false, reason: availability.reason, detail: availability.detail };
  let port: WebSerialPort;
  try {
    port = await env.serial!.requestPort();
  } catch (error) {
    const name = errorName(error);
    if (name === "NotFoundError") return { ok: false, reason: "no_port_chosen", detail: "no port was chosen (the chooser was dismissed or listed no port)" };
    if (name === "SecurityError" || name === "NotAllowedError") {
      return { ok: false, reason: "not_allowed", detail: `the browser refused the chooser (${name}): it needs a user gesture and may be blocked by policy` };
    }
    return { ok: false, reason: "request_failed", detail: `the chooser failed (${name ?? "unknown error"})` };
  }
  if (typeof port !== "object" || port === null) return { ok: false, reason: "request_failed", detail: "the chooser returned no port" };
  return { ok: true, selection: { port, info: portInfo(port) } };
}

function portInfo(port: WebSerialPort): SerialPortInfo {
  let raw: SerialPortInfo | undefined;
  try {
    raw = typeof port.getInfo === "function" ? port.getInfo() : undefined;
  } catch {
    raw = undefined;
  }
  const info: { usbVendorId?: number; usbProductId?: number; bluetoothServiceClassId?: number | string } = {};
  if (typeof raw?.usbVendorId === "number") info.usbVendorId = raw.usbVendorId;
  if (typeof raw?.usbProductId === "number") info.usbProductId = raw.usbProductId;
  if (typeof raw?.bluetoothServiceClassId === "number" || typeof raw?.bluetoothServiceClassId === "string") info.bluetoothServiceClassId = raw.bluetoothServiceClassId;
  return info;
}

export type WebSerialTransportOptions = {
  /** Missing fields take `DEFAULT_SERIAL_SETTINGS`. Invalid ones throw RangeError. */
  settings?: Partial<SerialSettings>;
  /** Upper bound, per step, on cleanup waits (reader cancel, writer abort, port close). Default 2000 ms. */
  releaseTimeoutMs?: number;
};

/** The transport holding each port on this page, so two never open the same port. */
const portOwners = new WeakMap<WebSerialPort, WebSerialTransport>();

/** Runs a best-effort browser call whose failure changes nothing (cleanup). */
function quietly(run: () => unknown): void {
  try {
    const result = run();
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // cleanup only
  }
}

/** Calls every listener; one listener's failure never stops the others or the transport. */
function dispatch<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch {
      // A listener's failure never affects the link.
    }
  }
}

/** Resolves when `run`'s result settles or after `ms`, whichever is first; never rejects. */
function settleWithin(run: () => unknown, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      Promise.resolve(run()).then(done, done);
    } catch {
      done();
    }
  });
}

function openFailure(error: unknown): TransportError {
  const name = errorName(error);
  if (name === "InvalidStateError") return new TransportError("connect_failed", "the port is already open (another tab or window may be using it)");
  if (name === "NetworkError") {
    return new TransportError("connect_failed", "the port could not be opened (NetworkError): another application may hold it, or the adapter is off, out of range or unplugged");
  }
  if (name === "TypeError") return new TransportError("connect_failed", "the browser rejected the serial settings (TypeError)");
  return new TransportError("connect_failed", `the port could not be opened (${name ?? "error"})`);
}

export class WebSerialTransport implements ByteTransport {
  readonly kind = "web_serial" as const;
  private currentState: TransportState = "idle";
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly closeListeners = new Set<(reason: TransportCloseReason) => void>();
  private readonly pendingWrites = new Set<(error: TransportError) => void>();
  private readonly serialSettings: SerialSettings;
  private readonly releaseTimeoutMs: number;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private reader: SerialStreamReader | null = null;
  private writer: SerialStreamWriter | null = null;
  /** Settles (never rejects) once the browser's `open()` has; null before it is called. */
  private portOpening: Promise<void> | null = null;
  private portOpened = false;
  /** The release in progress or done; null while the port has not been given up. */
  private releasing: Promise<void> | null = null;
  private released = false;
  private closeNotified = false;
  /** Ends an open in progress at once; null when no open is in progress. */
  private interruptOpen: ((error: TransportError) => void) | null = null;

  constructor(
    private readonly selection: SelectedSerialPort,
    options: WebSerialTransportOptions = {},
  ) {
    const resolved = resolveSerialSettings(options.settings);
    if (!resolved.ok) throw new RangeError(resolved.detail);
    const timeout = options.releaseTimeoutMs ?? DEFAULT_SERIAL_RELEASE_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_SERIAL_RELEASE_TIMEOUT_MS) {
      throw new RangeError(`releaseTimeoutMs must be an integer from 1 to ${MAX_SERIAL_RELEASE_TIMEOUT_MS}`);
    }
    if (typeof selection?.port !== "object" || selection.port === null) throw new RangeError("no serial port selected");
    this.serialSettings = resolved.settings;
    this.releaseTimeoutMs = timeout;
  }

  get state(): TransportState {
    return this.currentState;
  }

  /** The settings the port is (or will be) opened with. */
  get settings(): SerialSettings {
    return this.serialSettings;
  }

  async open(signal?: AbortSignal): Promise<void> {
    if (this.currentState === "open") throw new TransportError("already_open", "already open");
    if (this.currentState !== "idle") throw new TransportError("closed", "a closed transport cannot be reopened");
    if (signal?.aborted) throw new TransportError("aborted", "aborted");
    this.currentState = "connecting";
    // Rejects as soon as an abort, close() or disconnect ends the open, without
    // waiting for the browser call in progress to settle.
    let interrupt!: (error: TransportError) => void;
    const interrupted = new Promise<never>((_, reject) => (interrupt = reject));
    interrupted.catch(() => undefined);
    this.interruptOpen = interrupt;
    const onAbort = () => interrupt(new TransportError("aborted", "aborted while opening"));
    signal?.addEventListener("abort", onAbort, { once: true });
    this.selection.port.addEventListener("disconnect", this.handleDisconnect);
    try {
      await this.claimPort(interrupted, signal);
      await this.openPort(interrupted, signal);
      this.checkpoint(signal);
      this.takeStreams();
    } catch (error) {
      const failure = error instanceof TransportError ? error : new TransportError("connect_failed", `the port did not open (${errorName(error) ?? "error"})`);
      this.abandonOpen(failure);
      throw failure;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.interruptOpen = null;
    }
    this.currentState = "open";
    void this.pump(this.reader!);
  }

  /**
   * Writes all bytes in order, after every earlier write. See the contract in
   * `ByteTransport.write`.
   */
  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (this.currentState !== "open") throw new TransportError("not_open", "not open");
    if (signal?.aborted) throw new TransportError("aborted", "aborted");
    const data = Uint8Array.from(bytes);
    const previous = this.writeQueue;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    // The next write starts only after this one AND every earlier one have ended.
    this.writeQueue = Promise.all([previous, mine]);
    try {
      await this.guard(previous, signal);
      if (signal?.aborted) throw new TransportError("aborted", "aborted before any byte was sent");
      const writer = this.writer;
      if (this.currentState !== "open" || !writer) throw new TransportError("closed", "closed during write");
      if (data.length === 0) return;
      // From here the bytes belong to the port: an abort no longer stops them.
      const outcome = new Promise<void>((resolve) => resolve(writer.write(data))).then(
        () => null,
        (error: unknown) => error ?? new Error("write failed"),
      );
      const failed = await this.guard(outcome);
      if (failed !== null) {
        const failure = new TransportError("write_failed", `serial write failed (${errorName(failed) ?? "error"}); part of it may have been sent`);
        this.end(errorName(failed) === "NetworkError" ? "disconnected" : "error");
        throw failure;
      }
    } finally {
      release();
    }
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onClose(listener: (reason: TransportCloseReason) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Idempotent. Resolves once the port is released (each cleanup step bounded by `releaseTimeoutMs`). */
  async close(): Promise<void> {
    if (this.currentState === "failed") this.currentState = "closed";
    else this.end("closed_by_client");
    await this.release();
  }

  /**
   * Takes the port for this transport, after any earlier transport on it has
   * released it. Ownership is re-read after every wait: when several transports
   * wait on the same release, the first to resume takes the port and the rest
   * find it in use.
   */
  private async claimPort(interrupted: Promise<never>, signal: AbortSignal | undefined): Promise<void> {
    const port = this.selection.port;
    for (let owner = portOwners.get(port); owner && owner !== this; owner = portOwners.get(port)) {
      if (owner.releasing === null) throw new TransportError("connect_failed", "the port is already in use by another connection on this page");
      await Promise.race([owner.releasing, interrupted]);
      this.checkpoint(signal);
    }
    this.checkpoint(signal);
    portOwners.set(port, this);
  }

  private async openPort(interrupted: Promise<never>, signal: AbortSignal | undefined): Promise<void> {
    const port = this.selection.port;
    // Re-checked synchronously right before the browser open: a close() or abort while open() was resuming from
    // claimPort() must stop this attempt, and a port this attempt no longer owns is never opened by it.
    this.checkpoint(signal);
    if (portOwners.get(port) !== this) throw new TransportError("closed", "closed while opening");
    const opening = new Promise<void>((resolve) => resolve(port.open({ ...this.serialSettings })));
    // Registered before the race below, so `portOpened` is set before open() continues.
    this.portOpening = opening.then(
      () => {
        this.portOpened = true;
        if (this.released) this.closePortLate(); // the release already ran and gave up waiting
      },
      () => undefined,
    );
    try {
      await Promise.race([opening, interrupted]);
    } catch (error) {
      throw error instanceof TransportError ? error : openFailure(error);
    }
  }

  private takeStreams(): void {
    const { readable, writable } = this.selection.port;
    if (!readable || !writable) throw new TransportError("connect_failed", "the opened port has no readable or writable stream");
    try {
      this.reader = readable.getReader();
      this.writer = writable.getWriter();
    } catch (error) {
      throw new TransportError("connect_failed", `the port's streams could not be taken (${errorName(error) ?? "error"})`);
    }
  }

  private closePortLate(): void {
    this.portOpened = false;
    quietly(() => this.selection.port.close());
  }

  private checkpoint(signal: AbortSignal | undefined): void {
    if (this.currentState !== "connecting") throw new TransportError("closed", "closed while opening");
    if (signal?.aborted) throw new TransportError("aborted", "aborted while opening");
  }

  /** A failed or aborted open: releases everything; reports the close once. */
  private abandonOpen(failure: TransportError): void {
    if (this.currentState !== "connecting") {
      void this.release(); // close() or a disconnect already ended it and reported the close
      return;
    }
    this.currentState = "failed";
    void this.release();
    this.notifyClose(failure.code === "aborted" ? "closed_by_client" : "error");
  }

  /** Reads until the link ends; every chunk goes to the listeners, copied. */
  private async pump(reader: SerialStreamReader): Promise<void> {
    for (;;) {
      let result: { done: boolean; value?: Uint8Array };
      try {
        result = await reader.read();
      } catch (error) {
        if (this.reader === reader && this.currentState === "open") this.end(errorName(error) === "NetworkError" ? "disconnected" : "error");
        return;
      }
      if (this.reader !== reader || this.currentState !== "open") return;
      if (result.done) {
        this.end("disconnected"); // the stream ended without this transport cancelling it
        return;
      }
      const chunk = copyChunk(result.value);
      if (chunk) dispatch(this.dataListeners, chunk);
    }
  }

  /** Settles with `work`, or rejects when the link ends (`closed`) or, if given, `signal` aborts (`aborted`). */
  private guard<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.currentState !== "open") return Promise.reject(new TransportError("closed", "closed during write"));
    return new Promise<T>((resolve, reject) => {
      const cancel = (error: TransportError) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => cancel(new TransportError("aborted", "aborted before any byte was sent"));
      const cleanup = () => {
        this.pendingWrites.delete(cancel);
        signal?.removeEventListener("abort", onAbort);
      };
      this.pendingWrites.add(cancel);
      signal?.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private readonly handleDisconnect = (): void => {
    if (this.currentState === "connecting" || this.currentState === "open") this.end("disconnected");
  };

  private end(reason: TransportCloseReason): void {
    if (this.currentState === "closed") return;
    this.currentState = "closed";
    void this.release();
    for (const cancel of [...this.pendingWrites]) cancel(new TransportError("closed", "closed during write"));
    this.pendingWrites.clear();
    this.interruptOpen?.(new TransportError("closed", "closed while opening"));
    this.notifyClose(reason);
  }

  private notifyClose(reason: TransportCloseReason): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    dispatch(this.closeListeners, reason);
  }

  /** Starts the release once; later calls share it. */
  private release(): Promise<void> {
    if (!this.releasing) this.releasing = this.releaseAll();
    return this.releasing;
  }

  /**
   * Cancels the reader (ending a pending read), aborts the writer, releases
   * both locks and closes the port, which the browser refuses while a stream
   * is locked. Each wait is bounded, so a stuck browser call cannot hold the
   * release forever.
   */
  private async releaseAll(): Promise<void> {
    const port = this.selection.port;
    port.removeEventListener("disconnect", this.handleDisconnect);
    const reader = this.reader;
    const writer = this.writer;
    this.reader = null;
    this.writer = null;
    const limit = this.releaseTimeoutMs;
    if (reader) {
      await settleWithin(() => reader.cancel(), limit);
      quietly(() => reader.releaseLock());
    }
    if (writer) {
      await settleWithin(() => writer.abort(), limit);
      quietly(() => writer.releaseLock());
    }
    const opening = this.portOpening;
    if (opening) await settleWithin(() => opening, limit);
    if (this.portOpened) {
      this.portOpened = false;
      await settleWithin(() => port.close(), limit);
    }
    this.released = true;
    if (portOwners.get(port) === this) portOwners.delete(port);
  }
}

/** A copy of a received chunk (the browser may reuse its buffer); null when it holds no bytes. */
function copyChunk(value: unknown): Uint8Array | null {
  if (!ArrayBuffer.isView(value) || value.byteLength === 0) return null;
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}
