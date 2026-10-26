/**
 * Response classification (protocol-stack.md, "Adapter error tokens").
 *
 * RESEARCH PROTOTYPE. Every adapter token maps to its own outcome and is
 * never data. A reply is `ok` only when it has exactly the shape its command
 * may return; anything else is `unexpected_reply`. The elm layer checks shape
 * only (hex lines for OBD requests); it gives the bytes no OBD meaning.
 */
import type { AdapterReplyOutcome } from "../types";
import type { ResponseKind } from "./command-policy";

export type Classification =
  | { outcome: "ok"; dataLines: string[]; infoLines: string[] }
  | { outcome: AdapterReplyOutcome; token: string | null; detail: string; infoLines: string[] };

/** Progress lines: recorded, then removed before classification. */
const INFO_LINES = [/^SEARCHING\.\.\.$/, /^BUS INIT: ?\.\.\. ?(OK)?$/];

/**
 * The identity line printed after a reset (INFERRED: genuine ELM327 prints "ELM327 v…"; clones vary).
 * Outside a command that asks for it, it means the adapter reset itself.
 */
const IDENTITY_LINE = /^ELM327\b/i;

const HEX_LINE = /^[0-9A-F]+( [0-9A-F]+)*$/;
const PRINTABLE = /^[\x20-\x7E]+$/;

/** The outcome an adapter token stands for, or null when the line is not a token. */
export function tokenOutcome(line: string): AdapterReplyOutcome | null {
  switch (line) {
    case "?":
      return "adapter_rejected_command";
    case "NO DATA":
      return "no_response";
    case "UNABLE TO CONNECT":
      return "no_vehicle_protocol";
    case "CAN ERROR":
    case "BUS ERROR":
    case "BUS BUSY":
    case "FB ERROR":
      return "bus_error";
    case "DATA ERROR":
      return "data_error";
    case "BUFFER FULL":
      return "adapter_overflow";
    case "STOPPED":
      return "interrupted";
    case "LV RESET":
    case "ACT ALERT":
      return "adapter_power_event";
  }
  if (/^BUS INIT: ?\.\.\. ?ERROR$/.test(line)) return "bus_init_failed";
  if (line.includes("<DATA ERROR") || line.includes("<RX ERROR")) return "data_error";
  if (/^ERR\d+$/.test(line)) return "adapter_internal_error";
  return null;
}

/**
 * Classifies the lines of one framed response (echo already removed) for a
 * command whose replies have the given kind. `identityExpected` is set only
 * for a command whose own answer is the identity line (ATZ, ATWS, ATI); for
 * every other command, of any kind, that line is a spontaneous reset.
 */
export function classifyResponse(lines: readonly string[], kind: ResponseKind, identityExpected = false): Classification {
  const infoLines = lines.filter((line) => INFO_LINES.some((pattern) => pattern.test(line)));
  const rest = lines.filter((line) => !INFO_LINES.some((pattern) => pattern.test(line)));

  // A power event wins over every other token: the adapter's state is lost.
  for (const line of rest) {
    if (tokenOutcome(line) === "adapter_power_event") {
      return { outcome: "adapter_power_event", token: line, detail: "the adapter reported a power event", infoLines };
    }
    if (!identityExpected && IDENTITY_LINE.test(line)) {
      return { outcome: "adapter_power_event", token: line, detail: "identity line outside a reset: the adapter reset itself", infoLines };
    }
  }
  for (const line of rest) {
    const outcome = tokenOutcome(line);
    if (outcome) return { outcome, token: line, detail: `adapter replied "${line}"`, infoLines };
  }

  const unexpected = (detail: string): Classification => ({ outcome: "unexpected_reply", token: null, detail, infoLines });
  if (rest.length === 0) return unexpected("no reply lines");
  switch (kind) {
    case "ok_only":
      return rest.length === 1 && rest[0] === "OK" ? { outcome: "ok", dataLines: rest, infoLines } : unexpected('expected exactly "OK"');
    case "text":
      return rest.every((line) => PRINTABLE.test(line)) ? { outcome: "ok", dataLines: rest, infoLines } : unexpected("non-printable text");
    case "protocol_number":
      return rest.length === 1 && /^A?[0-9A-C]$/.test(rest[0]) ? { outcome: "ok", dataLines: rest, infoLines } : unexpected("expected a protocol number");
    case "voltage":
      return rest.length === 1 && /^\d{1,2}(\.\d{1,2})?V$/.test(rest[0]) ? { outcome: "ok", dataLines: rest, infoLines } : unexpected("expected a voltage");
    case "obd":
      return rest.every((line) => HEX_LINE.test(line)) ? { outcome: "ok", dataLines: rest, infoLines } : unexpected("a reply line is not hex data");
    default:
      return unexpected("unknown reply kind");
  }
}
