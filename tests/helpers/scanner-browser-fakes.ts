/**
 * Deterministic doubles of `navigator.bluetooth` and `navigator.serial` for
 * the scanner preview, wired to the scripted ELM adapter. Everything here is
 * SCRIPTED: tests using it show the code behaves as designed against simulated
 * browser objects, not that any browser, adapter or vehicle does.
 */
import { ScriptedElmAdapter, SimulatedTransport, type ScriptedReply } from "../../app/lib/vehicle-communication/transport/simulated";
import type { BleCharacteristic, BleDevice, BleGattServer, BleRequestDeviceOptions, BleService, BluetoothApi, WebBluetoothEnvironment } from "../../app/lib/vehicle-communication/transport/web-bluetooth-api";
import type { SerialStreamReader, SerialStreamWriter, WebSerialApi, WebSerialEnvironment, WebSerialPort } from "../../app/lib/vehicle-communication/transport/web-serial-api";

export type Replies = Record<string, ScriptedReply | ScriptedReply[]>;

const line = (...lines: string[]): ScriptedReply => ({ lines });

/** One scripted CAN ECU (7E8), as in the controller tests: MIL on, one stored code P0133. */
export const scriptedVehicle = (): Replies => ({
  "0100": line("7E8 06 41 00 98 18 80 01"),
  "0120": line("7E8 06 41 20 00 00 00 01"),
  "0140": line("7E8 06 41 40 40 00 00 00"),
  "0900": line("7E8 06 49 00 40 00 00 00"),
  "0902": line("7E8 10 14 49 02 01 31 48 47", "7E8 21 43 4D 38 32 36 33 33", "7E8 22 41 30 30 34 33 35 32"),
  "0101": line("7E8 06 41 01 81 07 65 04"),
  "03": line("7E8 04 43 01 01 33"),
  "07": line("7E8 02 47 00"),
  "0A": line("7E8 02 4A 00"),
  "020000": line("7E8 07 42 00 00 58 18 00 00"),
  "020200": line("7E8 05 42 02 00 01 33"),
  "020400": line("7E8 04 42 04 00 80"),
  "020500": line("7E8 04 42 05 00 7B"),
  "020C00": line("7E8 05 42 0C 00 1A F8"),
  "020D00": line("7E8 04 42 0D 00 32"),
  "010C": line("7E8 04 41 0C 0B B8"),
  "010D": line("7E8 03 41 0D 00"),
  "0105": line("7E8 03 41 05 5A"),
  "0104": line("7E8 03 41 04 33"),
  "0111": line("7E8 03 41 11 26"),
  "0142": line("7E8 04 41 42 37 DC"),
});

export const domError = (name: string) => Object.assign(new Error(name), { name });

export type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

/** A new scripted adapter per link: each connection starts from a powered-on state. */
class Backend {
  transport: SimulatedTransport | null = null;
  adapter: ScriptedElmAdapter | null = null;
  readonly opened: ScriptedElmAdapter[] = [];

  constructor(private readonly replies: () => Replies) {}

  async open(): Promise<void> {
    this.transport = new SimulatedTransport();
    this.adapter = new ScriptedElmAdapter({ replies: this.replies() });
    this.opened.push(this.adapter);
    this.transport.attach(this.adapter);
    await this.transport.open();
  }

  /** Every command any link of this double received. */
  get commands(): string[] {
    return this.opened.flatMap((adapter) => adapter.received);
  }
}

export class FakeBleLink extends Listeners implements BleDevice {
  readonly id = "fake-device";
  readonly name = "Scripted BLE adapter";
  readonly backend: Backend;
  connected = false;
  /** When set, GATT connect waits on it. */
  holdConnect: Deferred<void> | null = null;
  chooser: Deferred<BleDevice> | null = null;
  requests: BleRequestDeviceOptions[] = [];
  private readonly notify: BleCharacteristic;
  private value: DataView | null = null;
  private readonly notifyListeners = new Listeners();

  constructor(
    readonly serviceUuid: string,
    private readonly notifyUuid: string,
    private readonly writeUuid: string,
    replies: () => Replies = scriptedVehicle,
  ) {
    super();
    this.backend = new Backend(replies);
    const current = () => this.value;
    this.notify = {
      uuid: notifyUuid,
      properties: { notify: true, indicate: false, write: false, writeWithoutResponse: false },
      get value() {
        return current();
      },
      addEventListener: (type, listener) => this.notifyListeners.addEventListener(type, listener),
      removeEventListener: (type, listener) => this.notifyListeners.removeEventListener(type, listener),
      startNotifications: async () => {
        this.backend.transport!.onData((chunk) => {
          this.value = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          this.notifyListeners.dispatch("characteristicvaluechanged", this.notify);
        });
        return this.notify;
      },
      stopNotifications: async () => this.notify,
    };
  }

  private readonly write = (): BleCharacteristic => ({
    uuid: this.writeUuid,
    properties: { notify: false, indicate: false, write: true, writeWithoutResponse: false },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    startNotifications: async () => undefined,
    stopNotifications: async () => undefined,
    writeValueWithResponse: async (value) => {
      await this.backend.transport!.write(value);
    },
  });

  get gatt(): BleGattServer {
    const server: BleGattServer = {
      connected: this.connected,
      connect: async () => {
        await this.holdConnect?.promise;
        await this.backend.open();
        this.connected = true;
        return server;
      },
      disconnect: () => {
        this.connected = false;
        void this.backend.transport?.close();
      },
      getPrimaryServices: async (uuid) => {
        if (uuid !== this.serviceUuid) throw domError("NotFoundError");
        const service: BleService = { uuid, getCharacteristics: async () => [this.notify, this.write()] };
        return [service];
      },
    };
    return server;
  }

  /** The adapter goes away. */
  drop(): void {
    this.connected = false;
    void this.backend.transport?.close();
    this.dispatch("gattserverdisconnected", this);
  }

  get listening(): number {
    return this.count("gattserverdisconnected");
  }

  get api(): BluetoothApi {
    return {
      getAvailability: async () => true,
      requestDevice: async (options) => {
        this.requests.push(options);
        return this.chooser ? this.chooser.promise : this;
      },
    };
  }

  environment(secure = true): WebBluetoothEnvironment {
    return { bluetooth: this.api, isSecureContext: secure };
  }
}

export class FakeSerialLink extends Listeners implements WebSerialPort {
  readonly backend: Backend;
  isOpen = false;
  opens: unknown[] = [];
  closes = 0;
  chooser: Deferred<WebSerialPort> | null = null;
  /** When set, closing the port waits on it. */
  holdClose: Deferred<void> | null = null;
  requests = 0;
  private incoming: Uint8Array[] = [];
  private wake: ((result: { done: boolean; value?: Uint8Array }) => void) | null = null;
  private failRead: ((error: unknown) => void) | null = null;

  constructor(replies: () => Replies = scriptedVehicle) {
    super();
    this.backend = new Backend(replies);
  }

  async open(options: unknown): Promise<void> {
    this.opens.push(options);
    if (this.isOpen) throw domError("InvalidStateError");
    await this.backend.open();
    this.backend.transport!.onData((chunk) => {
      if (this.wake) {
        const wake = this.wake;
        this.wake = this.failRead = null;
        wake({ done: false, value: chunk });
      } else this.incoming.push(chunk);
    });
    this.isOpen = true;
  }

  async close(): Promise<void> {
    this.closes++;
    this.isOpen = false;
    await this.holdClose?.promise;
    await this.backend.transport?.close();
  }

  get readable(): { getReader(): SerialStreamReader } | null {
    if (!this.isOpen) return null;
    return {
      getReader: () => ({
        read: () => {
          const next = this.incoming.shift();
          if (next) return Promise.resolve({ done: false, value: next });
          return new Promise((resolve, reject) => {
            this.wake = resolve;
            this.failRead = reject;
          });
        },
        cancel: async () => {
          this.wake?.({ done: true });
          this.wake = this.failRead = null;
        },
        releaseLock: () => undefined,
      }),
    };
  }

  get writable(): { getWriter(): SerialStreamWriter } | null {
    if (!this.isOpen) return null;
    return {
      getWriter: () => ({
        write: async (chunk) => {
          await this.backend.transport!.write(chunk);
        },
        abort: async () => undefined,
        releaseLock: () => undefined,
      }),
    };
  }

  getInfo() {
    return { bluetoothServiceClassId: "00001101-0000-1000-8000-00805f9b34fb" };
  }

  /** The adapter goes away. */
  drop(): void {
    this.failRead?.(domError("NetworkError"));
    this.wake = this.failRead = null;
    this.dispatch("disconnect", this);
  }

  get listening(): number {
    return this.count("disconnect");
  }

  get api(): WebSerialApi {
    return {
      requestPort: async () => {
        this.requests++;
        return this.chooser ? this.chooser.promise : this;
      },
    };
  }

  environment(secure = true): WebSerialEnvironment {
    return { serial: this.api, isSecureContext: secure };
  }
}

const uuid = (hex4: string) => `0000${hex4}-0000-1000-8000-00805f9b34fb`;

/** A double exposing the documented 18F0 profile. */
export const fakeBle18f0 = (replies?: () => Replies) => new FakeBleLink(uuid("18f0"), uuid("2af0"), uuid("2af1"), replies);
