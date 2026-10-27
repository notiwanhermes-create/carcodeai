/**
 * Minimal local types for the parts of the Web Bluetooth API the transport
 * uses (W3C Web Bluetooth CG draft, https://webbluetoothcg.github.io/web-bluetooth/).
 *
 * RESEARCH PROTOTYPE. TypeScript's DOM library does not declare Web Bluetooth,
 * so the subset used is declared here instead of adding a package. Only what
 * the transport calls is listed; real browser objects satisfy these shapes.
 * Tests pass deterministic doubles through `WebBluetoothEnvironment`.
 */

export type BleUuid = string;

/** `requestDevice()` options (draft, `RequestDeviceOptions`). */
export type BleRequestDeviceOptions =
  | { filters: { services: BleUuid[] }[]; optionalServices?: BleUuid[] }
  | { acceptAllDevices: true; optionalServices: BleUuid[] };

export interface BleEventTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface BleCharacteristicProperties {
  readonly notify: boolean;
  readonly indicate: boolean;
  readonly write: boolean;
  readonly writeWithoutResponse: boolean;
}

/** `BluetoothRemoteGATTCharacteristic` (subset). */
export interface BleCharacteristic extends BleEventTarget {
  readonly uuid: BleUuid;
  readonly properties: BleCharacteristicProperties;
  /** The last notified value; read inside a `characteristicvaluechanged` handler. */
  readonly value?: DataView | null;
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
  writeValueWithResponse?(value: Uint8Array): Promise<void>;
  writeValueWithoutResponse?(value: Uint8Array): Promise<void>;
}

/** `BluetoothRemoteGATTService` (subset). */
export interface BleService {
  readonly uuid: BleUuid;
  getCharacteristics(): Promise<BleCharacteristic[]>;
}

/** `BluetoothRemoteGATTServer` (subset). */
export interface BleGattServer {
  readonly connected: boolean;
  connect(): Promise<BleGattServer>;
  disconnect(): void;
  getPrimaryServices(service: BleUuid): Promise<BleService[]>;
}

/** `BluetoothDevice` (subset). Fires `gattserverdisconnected`. */
export interface BleDevice extends BleEventTarget {
  readonly id: string;
  readonly name?: string | null;
  readonly gatt?: BleGattServer | null;
}

/** `navigator.bluetooth` (subset). */
export interface BluetoothApi {
  /** Missing in some browsers; absent means "unknown", not "unavailable". */
  getAvailability?(): Promise<boolean>;
  requestDevice(options: BleRequestDeviceOptions): Promise<BleDevice>;
}

/** The injectable browser boundary: everything the transport reads from the page. */
export type WebBluetoothEnvironment = {
  readonly bluetooth: BluetoothApi | undefined;
  readonly isSecureContext: boolean;
};

/** The real browser boundary. Reads `navigator.bluetooth` and `isSecureContext` at call time. */
export function browserWebBluetoothEnvironment(): WebBluetoothEnvironment {
  const scope = globalThis as { navigator?: { bluetooth?: BluetoothApi }; isSecureContext?: boolean };
  return { bluetooth: scope.navigator?.bluetooth, isSecureContext: scope.isSecureContext === true };
}

/** The DOMException-style `name` of a rejection, if it has one. */
export function errorName(error: unknown): string | null {
  return typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string" ? (error as { name: string }).name : null;
}
