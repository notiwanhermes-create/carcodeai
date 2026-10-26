/**
 * Supported-PID bitmaps and request construction (protocol-stack.md, "PID
 * decoding"; module-discovery.md step 4; scan-flow.md, "Freeze-frame probe").
 *
 * RESEARCH PROTOTYPE. Pure. STANDARD-DOCUMENTED (unverified copy), SAE J1979:
 * a bitmap PID (`00`, `20`, … `E0`) answers four bytes; byte A bit 7 is the
 * first PID of its range and the last bit says whether the next bitmap PID is
 * supported. $01, $02 (frame 0) and $09 have separate bitmaps: the $01 bitmap
 * says nothing about $02 support.
 *
 * Support is three-valued. A range that was never read, or whose read failed,
 * is `support_unknown`, never `unsupported`. Only a bitmap that was read and
 * has the bit clear (or a read chain that says the range does not exist)
 * makes a PID `unsupported`. A request is built only for a `supported` PID.
 */
import type { CommandResult } from "../elm/executor";
import { buildObdCommand, type ObdRequest } from "../elm/command-policy";
import type { ProtocolFamily } from "./frames";
import { readService, type ServiceRead } from "./response";

export const BITMAP_PIDS = Object.freeze([0x00, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0]);

export type SupportedPidBitmap = {
  /** The bitmap PID that was read (range base + 1 … base + 0x20). */
  base: number;
  supported: number[];
  /** The last bit: the next bitmap PID is supported. */
  nextRange: boolean;
  raw: number[];
};

export type SupportStatus = "supported" | "unsupported" | "support_unknown";

export function decodeBitmap(base: number, bytes: readonly number[]): SupportedPidBitmap {
  const supported: number[] = [];
  for (let i = 0; i < 32; i++) {
    if (bytes[i >> 3] & (0x80 >> (i & 7))) supported.push(base + i + 1);
  }
  return { base, supported, nextRange: supported.includes(base + 0x20), raw: [...bytes] };
}

function bitmapBody(base: number) {
  return (body: number[]) =>
    body.length === 4
      ? { ok: true as const, value: decodeBitmap(base, body) }
      : { ok: false as const, reason: `${body.length} bitmap bytes where 4 are required` };
}

function assertBitmapPid(base: number) {
  if (!BITMAP_PIDS.includes(base)) throw new RangeError("not a bitmap PID");
}

/** `01` + bitmap PID: current-data support. */
export function readCurrentDataSupport(result: CommandResult, family: ProtocolFamily, base: number): ServiceRead<SupportedPidBitmap> {
  assertBitmapPid(base);
  return readService(result, family, { service: "01", pid: base }, bitmapBody(base));
}

/** `02` + bitmap PID + `00`: freeze-frame (frame 0) support. */
export function readFreezeFrameSupport(result: CommandResult, family: ProtocolFamily, base: number): ServiceRead<SupportedPidBitmap> {
  assertBitmapPid(base);
  return readService(result, family, { service: "02", pid: base, frame: 0 }, bitmapBody(base));
}

/** `0900`: supported vehicle-information types (no item count on CAN). */
export function readInfoTypeSupport(result: CommandResult, family: ProtocolFamily): ServiceRead<SupportedPidBitmap> {
  return readService(result, family, { service: "09", infoType: 0 }, bitmapBody(0));
}

/** One ECU's bitmaps from successful reads, by base. */
export type BitmapSet = ReadonlyMap<number, SupportedPidBitmap>;

export function bitmapSet(bitmaps: Iterable<SupportedPidBitmap>): BitmapSet {
  const set = new Map<number, SupportedPidBitmap>();
  for (const bitmap of bitmaps) set.set(bitmap.base, bitmap);
  return set;
}

/**
 * Whether one ECU supports `pid`, from that ECU's own bitmaps. The chain is
 * walked from `00`: a range not read is `support_unknown`; a range after a
 * bitmap whose "next range" bit is clear is `unsupported`.
 */
export function pidSupport(bitmaps: BitmapSet, pid: number): SupportStatus {
  if (!Number.isInteger(pid) || pid < 0 || pid > 0xff) return "unsupported";
  if (pid === 0) return bitmaps.has(0) ? "supported" : "support_unknown";
  const target = Math.floor((pid - 1) / 0x20) * 0x20;
  for (let base = 0; base <= target; base += 0x20) {
    const bitmap = bitmaps.get(base);
    if (!bitmap) return "support_unknown";
    if (base === target) return bitmap.supported.includes(pid) ? "supported" : "unsupported";
    if (!bitmap.nextRange) return "unsupported";
  }
  return "support_unknown";
}

/**
 * The chain's state for one ECU: the next bitmap PID to request (null when
 * the chain ended or a range is missing), and the last range whose support is
 * known (`supportKnownUpTo`, null when not even `00` was read).
 */
export function bitmapChain(bitmaps: BitmapSet): { next: number | null; supportKnownUpTo: number | null } {
  let last: number | null = null;
  for (const base of BITMAP_PIDS) {
    const bitmap = bitmaps.get(base);
    if (!bitmap) return { next: last === null ? 0 : base, supportKnownUpTo: last };
    last = base;
    if (!bitmap.nextRange) return { next: null, supportKnownUpTo: 0xff };
  }
  return { next: null, supportKnownUpTo: 0xff };
}

export type PlannedRequest =
  | { status: "request"; request: ObdRequest; command: string }
  | { status: "unsupported" | "support_unknown" }
  | { status: "refused"; reason: string };

/**
 * Builds a `01` or `02` (frame 0) request for `pid` only when the ECU's own
 * bitmap for that service lists it. Otherwise nothing is sent and the PID is
 * shown `unsupported` or `support_unknown` (scan-flow.md row 22).
 */
export function planPidRequest(service: "01" | "02", pid: number, bitmaps: BitmapSet): PlannedRequest {
  const support = pidSupport(bitmaps, pid);
  if (support !== "supported") return { status: support };
  const request: ObdRequest = service === "01" ? { service, pid } : { service, pid, frame: 0 };
  const built = buildObdCommand(request);
  return built.allowed ? { status: "request", request, command: built.command } : { status: "refused", reason: built.reason };
}
