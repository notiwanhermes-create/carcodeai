/**
 * The byte transport between the browser and the adapter (vci-transport.md,
 * "Proposed transport interface").
 *
 * RESEARCH PROTOTYPE. A transport moves bytes only: it never parses text and
 * knows no commands. Chunk boundaries carry no meaning. Exactly one transport
 * is open per session, there is no automatic reconnect, and after `closed`
 * every call is refused.
 */

export type TransportKind = "web_bluetooth" | "web_serial" | "simulated";

export type TransportState = "idle" | "connecting" | "open" | "closing" | "closed" | "failed";

/** `closed_by_client`: close() was called. `disconnected`: the link went away. */
export type TransportCloseReason = "closed_by_client" | "disconnected" | "error";

/**
 * `unsupported_adapter`: the link opened but no single suitable service and
 * characteristic pair was found (fail closed, nothing guessed).
 * `connect_failed`: the link could not be opened (connection, service lookup
 * or notification start failed).
 */
export type TransportErrorCode =
  | "not_open"
  | "already_open"
  | "closed"
  | "aborted"
  | "write_failed"
  | "unsupported_adapter"
  | "connect_failed";

export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface ByteTransport {
  readonly kind: TransportKind;
  readonly state: TransportState;
  /** Opens the link. Refused when already open or after close. */
  open(signal?: AbortSignal): Promise<void>;
  /**
   * Writes all bytes, chunked to the link's limit. Rejects (TransportError) if
   * not open, closed meanwhile, or aborted. Rejects `aborted` ONLY when no byte
   * of this write reached the link; once any byte was sent, an abort either
   * lets the write finish or rejects with another code (delivery uncertain).
   */
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** Every received chunk, in order, unmodified. Returns an unsubscribe function. */
  onData(listener: (chunk: Uint8Array) => void): () => void;
  /** Called once when the link closes, for any reason. Returns an unsubscribe function. */
  onClose(listener: (reason: TransportCloseReason) => void): () => void;
  /** Idempotent. */
  close(): Promise<void>;
}
