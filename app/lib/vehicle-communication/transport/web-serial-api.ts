/**
 * Minimal local types for the parts of the Web Serial API the transport uses
 * (WICG Web Serial draft, https://wicg.github.io/serial/).
 *
 * RESEARCH PROTOTYPE. TypeScript's DOM library does not declare Web Serial,
 * so the subset used is declared here instead of adding a package. Only what
 * the transport calls is listed; real browser objects satisfy these shapes.
 * Tests pass deterministic doubles through `WebSerialEnvironment`.
 */

export type SerialParity = "none" | "even" | "odd";
export type SerialFlowControl = "none" | "hardware";

/** `SerialOptions` (draft): the settings `SerialPort.open()` requires. */
export type SerialOpenOptions = {
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: SerialParity;
  flowControl: SerialFlowControl;
  bufferSize?: number;
};

/** `SerialPortInfo` (draft). Every field is optional; a Windows COM port may expose none. */
export type SerialPortInfo = {
  readonly usbVendorId?: number;
  readonly usbProductId?: number;
  readonly bluetoothServiceClassId?: number | string;
};

/** `ReadableStreamDefaultReader<Uint8Array>` (subset). */
export interface SerialStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

/** `WritableStreamDefaultWriter<Uint8Array>` (subset). */
export interface SerialStreamWriter {
  write(chunk: Uint8Array): Promise<void>;
  abort(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

/** `SerialPort` (subset). Fires `disconnect` when the device goes away. */
export interface WebSerialPort {
  readonly readable: { getReader(): SerialStreamReader } | null;
  readonly writable: { getWriter(): SerialStreamWriter } | null;
  open(options: SerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  getInfo?(): SerialPortInfo;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** `navigator.serial` (subset). Called with no filters: every port the browser offers is listed. */
export interface WebSerialApi {
  requestPort(): Promise<WebSerialPort>;
}

/** The injectable browser boundary: everything the transport reads from the page. */
export type WebSerialEnvironment = {
  readonly serial: WebSerialApi | undefined;
  readonly isSecureContext: boolean;
};

/**
 * The real browser boundary. Reads `navigator.serial` and `isSecureContext`
 * at call time, never at module evaluation, so importing this module on the
 * server is safe (there it reports the API as missing).
 */
export function browserWebSerialEnvironment(): WebSerialEnvironment {
  const scope = globalThis as { navigator?: { serial?: WebSerialApi }; isSecureContext?: boolean };
  return { serial: scope.navigator?.serial, isSecureContext: scope.isSecureContext === true };
}
