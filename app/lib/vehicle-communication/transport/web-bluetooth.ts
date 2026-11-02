/**
 * The Web Bluetooth transport (vci-transport.md, "Candidate BLE UUIDs",
 * "Proposed transport interface"; S11a).
 *
 * RESEARCH PROTOTYPE. Browser-only, reached through the injectable
 * `WebBluetoothEnvironment`; the automated tests use deterministic doubles of
 * it, so passing tests show the code behaves as designed against SCRIPTED
 * browser objects, not that any real adapter, browser or vehicle does. No
 * adapter has been tested.
 *
 * Rules:
 * - Adapter selection (`requestBleAdapter`) must be called directly from a
 *   user gesture, with nothing awaited before it; it opens the browser chooser.
 * - `open()` connects GATT, then requires exactly one profile service and,
 *   in it, exactly one notify (or indicate) characteristic and exactly one
 *   writable characteristic with the profile's UUIDs. Anything missing,
 *   duplicated or unsuitable fails closed with `unsupported_adapter`; another
 *   characteristic is never guessed.
 * - Writes are serialised in call order and sent in chunks (default 20 bytes:
 *   the payload of the default ATT MTU; the negotiated MTU is not exposed).
 *   A write rejects `aborted` only while none of its chunks was handed to the
 *   browser; after that an abort lets it finish.
 * - Each notification is delivered as one chunk, copied, in arrival order.
 * - A disconnect, close or failed open releases every listener and the GATT
 *   connection; there is no automatic reconnect. Payload bytes are never logged.
 * - An abort, close or disconnect ends `open()` at once, even while a browser
 *   call is pending; a GATT connect or notification start that completes
 *   afterwards is undone.
 */
import { DOCUMENTED_BLE_PROFILES, type BleProfile } from "./ble-profiles";
import { TransportError, type ByteTransport, type TransportCloseReason, type TransportState } from "./types";
import {
  errorName,
  type BleCharacteristic,
  type BleDevice,
  type BleGattServer,
  type BleRequestDeviceOptions,
  type BleService,
  type BleUuid,
  type WebBluetoothEnvironment,
} from "./web-bluetooth-api";

/** Plain statements of what this transport cannot do or has not shown. Shown to users as-is. */
export const WEB_BLUETOOTH_LIMITATIONS = [
  "Web Bluetooth reaches Bluetooth Low Energy (GATT) adapters only. Classic Bluetooth (SPP) adapters, as many low-cost ELM327 dongles are, cannot be reached from a web page.",
  "Web Bluetooth needs a secure context (HTTPS or localhost) and a user gesture to open the device chooser.",
  "Browser support differs by browser and platform (last known: no browser on iOS or iPadOS offers it; not re-verified). Only feature detection decides what is offered.",
  "The 18F0 and FFF0 service profiles come from community reports and are unverified. No adapter has been tested with this transport, and no adapter is known to be compatible.",
  "By default the chooser lists only devices advertising a profile service; an adapter that does not advertise it appears only with the all-devices chooser.",
  "The negotiated BLE MTU is not exposed to web pages, so writes are sent in 20-byte chunks unless configured otherwise.",
  "A matching profile shows only that bytes can move; the adapter must still answer an ELM-style handshake.",
  "There is no automatic reconnect: a disconnect ends the session.",
] as const;

export const DEFAULT_BLE_WRITE_CHUNK_BYTES = 20;
/** The largest attribute value ATT allows. */
export const MAX_BLE_WRITE_CHUNK_BYTES = 512;

export type WebBluetoothAvailability =
  | { available: true; radio: "available" | "unknown" }
  | { available: false; reason: "insecure_context" | "api_missing" | "bluetooth_unavailable"; detail: string };

/**
 * Feature detection: decides whether to offer Web Bluetooth. Never reads a
 * user-agent string. A missing or failing `getAvailability()` is "unknown",
 * not "unavailable".
 */
export async function detectWebBluetooth(env: WebBluetoothEnvironment): Promise<WebBluetoothAvailability> {
  const blocked = unavailableReason(env);
  if (blocked) return blocked;
  const getAvailability = env.bluetooth?.getAvailability;
  if (typeof getAvailability !== "function") return { available: true, radio: "unknown" };
  try {
    if ((await getAvailability.call(env.bluetooth)) === false) {
      return { available: false, reason: "bluetooth_unavailable", detail: "the browser reports no usable Bluetooth radio" };
    }
    return { available: true, radio: "available" };
  } catch {
    return { available: true, radio: "unknown" };
  }
}

function unavailableReason(env: WebBluetoothEnvironment): Extract<WebBluetoothAvailability, { available: false }> | null {
  if (!env.isSecureContext) return { available: false, reason: "insecure_context", detail: "Web Bluetooth needs a secure context (HTTPS or localhost)" };
  if (!env.bluetooth || typeof env.bluetooth.requestDevice !== "function") {
    return { available: false, reason: "api_missing", detail: "this browser does not provide Web Bluetooth" };
  }
  return null;
}

/** The device a person chose, and the profiles `open()` will look for on it. */
export type SelectedBleAdapter = {
  readonly device: BleDevice;
  readonly profiles: readonly BleProfile[];
};

export type BleAdapterRequestOptions = {
  /** A validated manual override (`createManualBleProfile`); replaces the documented profiles. */
  override?: BleProfile;
  /** `advertised_services` (default) filters the chooser by profile service; `all_devices` lists every device. */
  chooser?: "advertised_services" | "all_devices";
};

export type BleAdapterRequestFailure = "insecure_context" | "api_missing" | "no_device_chosen" | "not_allowed" | "request_invalid" | "request_failed";

export type BleAdapterRequest = { ok: true; adapter: SelectedBleAdapter } | { ok: false; reason: BleAdapterRequestFailure; detail: string };

/**
 * Opens the browser's device chooser. Call it directly from a click (or other
 * user gesture) handler with nothing awaited first: the chooser needs the
 * gesture's transient activation.
 */
export async function requestBleAdapter(env: WebBluetoothEnvironment, options: BleAdapterRequestOptions = {}): Promise<BleAdapterRequest> {
  const blocked = unavailableReason(env);
  if (blocked) return { ok: false, reason: blocked.reason === "insecure_context" ? "insecure_context" : "api_missing", detail: blocked.detail };
  const profiles = options.override ? [options.override] : DOCUMENTED_BLE_PROFILES;
  const services = [...new Set(profiles.map((profile) => profile.service))];
  const request: BleRequestDeviceOptions =
    options.chooser === "all_devices"
      ? { acceptAllDevices: true, optionalServices: services }
      : { filters: services.map((service) => ({ services: [service] })), optionalServices: services };
  let device: BleDevice;
  try {
    device = await env.bluetooth!.requestDevice(request);
  } catch (error) {
    const name = errorName(error);
    if (name === "NotFoundError") return { ok: false, reason: "no_device_chosen", detail: "no device was chosen (the chooser was dismissed or listed no matching device)" };
    if (name === "SecurityError" || name === "NotAllowedError") {
      return { ok: false, reason: "not_allowed", detail: `the browser refused the chooser (${name}): it needs a user gesture and may be blocked by policy` };
    }
    if (name === "TypeError") return { ok: false, reason: "request_invalid", detail: "the browser rejected the chooser options" };
    return { ok: false, reason: "request_failed", detail: `the chooser failed (${name ?? "unknown error"})` };
  }
  if (typeof device !== "object" || device === null) return { ok: false, reason: "request_failed", detail: "the chooser returned no device" };
  return { ok: true, adapter: { device, profiles } };
}

export type BleWriteMode = "with_response" | "without_response";

/** What `open()` found; null until the link is open. Says nothing about ELM behaviour. */
export type BleLinkInfo = {
  readonly profile: BleProfile;
  readonly notify: BleUuid;
  readonly write: BleUuid;
  readonly writeMode: BleWriteMode;
  readonly writeChunkBytes: number;
};

export type WebBluetoothTransportOptions = {
  /** Bytes per GATT write, 1-512. Default 20 (the default ATT MTU's payload). */
  writeChunkBytes?: number;
};

const NOT_FOUND = "NotFoundError";

/** Runs a best-effort browser call whose failure changes nothing (cleanup). */
function quietly(run: () => unknown): void {
  try {
    const result = run();
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // cleanup only
  }
}

export class WebBluetoothTransport implements ByteTransport {
  readonly kind = "web_bluetooth" as const;
  private currentState: TransportState = "idle";
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly closeListeners = new Set<(reason: TransportCloseReason) => void>();
  private readonly pendingWrites = new Set<(error: TransportError) => void>();
  private readonly chunkBytes: number;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private server: BleGattServer | null = null;
  private notifyCharacteristic: BleCharacteristic | null = null;
  private writeCharacteristic: BleCharacteristic | null = null;
  private notifying = false;
  private closeNotified = false;
  private info: BleLinkInfo | null = null;
  /** Ends an open in progress at once; null when no open is in progress. */
  private interruptOpen: ((error: TransportError) => void) | null = null;

  constructor(
    private readonly adapter: SelectedBleAdapter,
    options: WebBluetoothTransportOptions = {},
  ) {
    const chunk = options.writeChunkBytes ?? DEFAULT_BLE_WRITE_CHUNK_BYTES;
    if (!Number.isInteger(chunk) || chunk < 1 || chunk > MAX_BLE_WRITE_CHUNK_BYTES) {
      throw new RangeError(`writeChunkBytes must be an integer from 1 to ${MAX_BLE_WRITE_CHUNK_BYTES}`);
    }
    if (adapter.profiles.length === 0) throw new RangeError("no BLE profile to look for");
    this.chunkBytes = chunk;
  }

  get state(): TransportState {
    return this.currentState;
  }

  /** The profile and characteristics in use while open; null otherwise. */
  get link(): BleLinkInfo | null {
    return this.currentState === "open" ? this.info : null;
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
    this.adapter.device.addEventListener("gattserverdisconnected", this.handleDisconnect);
    try {
      this.info = await this.connect(signal, interrupted);
      this.checkpoint(signal);
    } catch (error) {
      const failure = error instanceof TransportError ? error : new TransportError("connect_failed", `the link did not open (${errorName(error) ?? "error"})`);
      this.abandonOpen(failure);
      throw failure;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.interruptOpen = null;
    }
    this.currentState = "open";
  }

  /**
   * Writes all bytes in order, after every earlier write, in chunks of the
   * configured size. See the contract in `ByteTransport.write`.
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
      for (let offset = 0; offset < data.length; offset += this.chunkBytes) {
        if (this.currentState !== "open") throw new TransportError("closed", "closed during write; part of it may have been sent");
        await this.guard(this.writeChunk(data.slice(offset, offset + this.chunkBytes)));
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

  async close(): Promise<void> {
    if (this.currentState === "failed") {
      this.currentState = "closed";
      this.teardown();
      return;
    }
    this.end("closed_by_client");
  }

  /** GATT connect and profile discovery. Every browser call goes through `step`. */
  private async connect(signal: AbortSignal | undefined, interrupted: Promise<never>): Promise<BleLinkInfo> {
    const gatt = this.adapter.device.gatt;
    if (!gatt) throw new TransportError("connect_failed", "the selected device exposes no GATT server");
    this.server = gatt;
    await this.step(signal, interrupted, "GATT connect", () => gatt.connect(), () => gatt.disconnect());

    const found: { profile: BleProfile; services: BleService[] }[] = [];
    for (const profile of this.adapter.profiles) {
      const services = await this.step(signal, interrupted, `service ${profile.service} lookup`, () => absentAsEmpty(gatt.getPrimaryServices(profile.service)));
      if (services.length > 0) found.push({ profile, services });
    }
    if (found.length === 0) {
      throw new TransportError("unsupported_adapter", `none of the profile services was found (${this.adapter.profiles.map((p) => p.service).join(", ")})`);
    }
    if (found.length > 1) {
      throw new TransportError("unsupported_adapter", `ambiguous: services of more than one profile are present (${found.map((f) => f.profile.id).join(", ")}); none is guessed`);
    }
    const [{ profile, services }] = found;
    if (services.length > 1) throw new TransportError("unsupported_adapter", `ambiguous: ${services.length} instances of service ${profile.service}`);

    const characteristics = await this.step(signal, interrupted, "characteristic discovery", () => absentAsEmpty(services[0].getCharacteristics()));
    const notify = only(characteristics, profile.notify, "notify");
    const write = only(characteristics, profile.write, "write");
    if (!notify.properties.notify && !notify.properties.indicate) {
      throw new TransportError("unsupported_adapter", `characteristic ${profile.notify} can neither notify nor indicate`);
    }
    const writeMode = chooseWriteMode(write, profile.write);

    this.notifyCharacteristic = notify;
    this.writeCharacteristic = write;
    notify.addEventListener("characteristicvaluechanged", this.handleValue);
    this.notifying = true;
    await this.step(signal, interrupted, "notification start", () => notify.startNotifications(), () => notify.stopNotifications());
    return { profile, notify: profile.notify, write: profile.write, writeMode, writeChunkBytes: this.chunkBytes };
  }

  /**
   * Runs one browser call during open; a rejection is `connect_failed`, unless
   * the open was closed or aborted meanwhile. An abort, close or disconnect
   * ends the step at once, without waiting for the call. If the call then
   * succeeds after the open has ended, `undo` releases what it acquired.
   */
  private async step<T>(
    signal: AbortSignal | undefined,
    interrupted: Promise<never>,
    what: string,
    run: () => Promise<T>,
    undo?: () => unknown,
  ): Promise<T> {
    let wanted = true;
    const outcome = new Promise<T>((resolve) => resolve(run())).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    void outcome.then((late) => {
      if (!wanted && late.ok && undo) quietly(undo);
    });
    let settled: Awaited<typeof outcome> | undefined;
    try {
      settled = await Promise.race([outcome, interrupted]);
      this.checkpoint(signal);
    } catch (error) {
      if (settled === undefined) wanted = false; // still pending: undone if it succeeds later
      else if (settled.ok && undo) quietly(undo); // succeeded, but the open had already ended
      throw error;
    }
    if (!settled.ok) throw new TransportError("connect_failed", `${what} failed (${errorName(settled.error) ?? "error"})`);
    return settled.value;
  }

  private checkpoint(signal: AbortSignal | undefined): void {
    if (this.currentState !== "connecting") throw new TransportError("closed", "closed while opening");
    if (signal?.aborted) throw new TransportError("aborted", "aborted while opening");
  }

  /** A failed or aborted open: releases everything; reports the close once. */
  private abandonOpen(failure: TransportError): void {
    if (this.currentState !== "connecting") {
      this.teardown(); // close() or a disconnect already ended it and reported the close
      return;
    }
    this.currentState = "failed";
    this.teardown();
    this.notifyClose(failure.code === "aborted" ? "closed_by_client" : "error");
  }

  private async writeChunk(chunk: Uint8Array): Promise<void> {
    const characteristic = this.writeCharacteristic;
    const mode = this.info?.writeMode;
    if (!characteristic || !mode) throw new TransportError("closed", "closed during write");
    try {
      if (mode === "with_response") await characteristic.writeValueWithResponse!(chunk);
      else await characteristic.writeValueWithoutResponse!(chunk);
    } catch (error) {
      if (this.currentState !== "open") throw new TransportError("closed", "closed during write");
      throw new TransportError("write_failed", `GATT write failed (${errorName(error) ?? "error"})`);
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

  private readonly handleValue = (event: Event): void => {
    if (this.currentState !== "open") return;
    const view = (event.target as { value?: DataView | null } | null)?.value ?? this.notifyCharacteristic?.value ?? null;
    if (!view || view.byteLength === 0) return;
    // Copied: the browser may reuse the buffer behind `value`.
    const chunk = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    for (const listener of [...this.dataListeners]) listener(chunk);
  };

  private readonly handleDisconnect = (): void => {
    if (this.currentState === "connecting" || this.currentState === "open") this.end("disconnected");
  };

  private end(reason: TransportCloseReason): void {
    if (this.currentState === "closed") return;
    this.currentState = "closed";
    this.teardown();
    for (const cancel of [...this.pendingWrites]) cancel(new TransportError("closed", "closed during write"));
    this.pendingWrites.clear();
    this.interruptOpen?.(new TransportError("closed", "closed while opening"));
    this.notifyClose(reason);
  }

  private notifyClose(reason: TransportCloseReason): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    for (const listener of [...this.closeListeners]) listener(reason);
  }

  /** Idempotent: removes every listener, stops notifications and drops the GATT connection. */
  private teardown(): void {
    this.adapter.device.removeEventListener("gattserverdisconnected", this.handleDisconnect);
    const notify = this.notifyCharacteristic;
    this.notifyCharacteristic = null;
    this.writeCharacteristic = null;
    if (notify) {
      notify.removeEventListener("characteristicvaluechanged", this.handleValue);
      if (this.notifying) quietly(() => notify.stopNotifications());
    }
    this.notifying = false;
    const server = this.server;
    this.server = null;
    if (server) quietly(() => server.disconnect());
  }
}

/** A browser `NotFoundError` from a lookup means "none", not a failure. */
async function absentAsEmpty<T>(lookup: Promise<T[]>): Promise<T[]> {
  try {
    return await lookup;
  } catch (error) {
    if (errorName(error) === NOT_FOUND) return [];
    throw error;
  }
}

/** Exactly one characteristic with this UUID, or `unsupported_adapter`. */
function only(characteristics: readonly BleCharacteristic[], uuid: BleUuid, role: "notify" | "write"): BleCharacteristic {
  const matches = characteristics.filter((c) => typeof c.uuid === "string" && c.uuid.toLowerCase() === uuid);
  if (matches.length === 0) throw new TransportError("unsupported_adapter", `${role} characteristic ${uuid} is missing`);
  if (matches.length > 1) throw new TransportError("unsupported_adapter", `ambiguous: ${matches.length} ${role} characteristics ${uuid}`);
  return matches[0];
}

/** Write with response when the characteristic and browser allow it (acknowledged, ordered); otherwise without. */
function chooseWriteMode(characteristic: BleCharacteristic, uuid: BleUuid): BleWriteMode {
  const { write, writeWithoutResponse } = characteristic.properties;
  if (!write && !writeWithoutResponse) throw new TransportError("unsupported_adapter", `characteristic ${uuid} is not writable`);
  if (write && typeof characteristic.writeValueWithResponse === "function") return "with_response";
  if (writeWithoutResponse && typeof characteristic.writeValueWithoutResponse === "function") return "without_response";
  throw new TransportError("connect_failed", `this browser provides no write method for characteristic ${uuid}`);
}
