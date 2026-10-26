/**
 * CAN response lines → per-ECU ISO-TP messages (protocol-stack.md,
 * "Protocols" and "ECU-aware parsing").
 *
 * RESEARCH PROTOTYPE. Pure. Lines are the data lines of one `ok` reply with
 * headers on (`ATH1`) and spaces on (`ATS1`). They are grouped by CAN
 * identifier first; each identifier is one ECU with its own reassembly
 * buffer, so frames from several ECUs may interleave. The ISO-TP length
 * governs extraction: bytes after the declared length are padding and are
 * dropped unchecked, so padded and unpadded frames parse identically. A
 * transport-level fault makes that ECU's answer `malformed`; the other ECUs'
 * answers stay usable. A line without a parseable identifier fails the whole
 * reply closed.
 *
 * Frame types and lengths: STANDARD-DOCUMENTED (unverified copy),
 * ISO 15765-2 / ISO 15765-4.
 */

/** CAN protocols in the preview; everything else is `unsupported_protocol`. */
export type ProtocolFamily = "can11" | "can29";

export type ProtocolInfo =
  | { supported: true; number: string; auto: boolean; family: ProtocolFamily }
  | { supported: false; number: string; auto: boolean; reason: "unsupported_protocol" };

/**
 * Reads an `ATDPN` answer ("6", "A7", …). Protocols 6 and 8 are CAN 11-bit,
 * 7 and 9 CAN 29-bit (ELM327 numbering); every other protocol is reported
 * `unsupported_protocol` with its number. Returns null for anything that is
 * not a protocol number.
 */
export function protocolFromDpn(answer: string): ProtocolInfo | null {
  const match = /^(A?)([0-9A-C])$/.exec(answer);
  if (!match) return null;
  const auto = match[1] === "A";
  const number = match[2];
  if (number === "6" || number === "8") return { supported: true, number, auto, family: "can11" };
  if (number === "7" || number === "9") return { supported: true, number, auto, family: "can29" };
  return { supported: false, number, auto, reason: "unsupported_protocol" };
}

/**
 * The opaque module label for a responding ECU, e.g. `obd-can11-7e8`,
 * `obd-can29-18daf110` (module-discovery.md). It names which address
 * answered, not what the ECU is; nothing may parse it.
 */
export function moduleLabel(family: ProtocolFamily, responseId: string): string {
  return `obd-${family}-${responseId.toLowerCase()}`;
}

export type CanFrame = { responseId: string; data: number[]; line: string };

export type ParsedLines = { ok: true; frames: CanFrame[] } | { ok: false; line: string; reason: string };

const BYTE = /^[0-9A-F]{2}$/;

/**
 * Splits each line into its response identifier and data bytes. 11-bit
 * responses come from `7E8`–`7EF`, 29-bit responses from `18 DA F1 xx`
 * (ISO 15765-4, unverified copy); any other identifier, or any token that is
 * not one spaced byte, fails the whole reply.
 */
export function parseCanLines(lines: readonly string[], family: ProtocolFamily): ParsedLines {
  const frames: CanFrame[] = [];
  for (const line of lines) {
    const tokens = line.split(" ");
    let responseId: string;
    let rest: string[];
    if (family === "can11") {
      if (!/^7E[89A-F]$/.test(tokens[0])) return { ok: false, line, reason: "no 11-bit OBD response identifier (7E8-7EF)" };
      responseId = tokens[0];
      rest = tokens.slice(1);
    } else {
      if (tokens.length < 4 || tokens[0] !== "18" || tokens[1] !== "DA" || tokens[2] !== "F1" || !BYTE.test(tokens[3])) {
        return { ok: false, line, reason: "no 29-bit OBD response identifier (18 DA F1 xx)" };
      }
      responseId = `18DAF1${tokens[3]}`;
      rest = tokens.slice(4);
    }
    if (!rest.every((token) => BYTE.test(token))) return { ok: false, line, reason: "data is not spaced bytes" };
    frames.push({ responseId, data: rest.map((token) => parseInt(token, 16)), line });
  }
  return { ok: true, frames };
}

/** One ECU's reassembled ISO-TP messages, padding removed, in arrival order. */
export type EcuMessages = {
  responseId: string;
  rawLines: string[];
  result: { ok: true; messages: number[][] } | { ok: false; reason: string };
};

type Buffer = {
  rawLines: string[];
  messages: number[][];
  receiving: { declared: number; bytes: number[]; nextSeq: number } | null;
  fault: string | null;
};

function step(buffer: Buffer, data: readonly number[]): string | null {
  if (data.length === 0) return "empty CAN frame";
  if (data.length > 8) return "CAN frame longer than 8 data bytes";
  const pci = data[0] >> 4;
  const low = data[0] & 0x0f;
  switch (pci) {
    case 0: {
      if (buffer.receiving) return "single frame inside a multi-frame message";
      if (low === 0 || low > 7) return `single frame length ${low} is outside 1-7`;
      if (data.length - 1 < low) return "single frame holds fewer bytes than its declared length";
      buffer.messages.push(data.slice(1, 1 + low));
      return null;
    }
    case 1: {
      if (buffer.receiving) return "first frame inside a multi-frame message";
      if (data.length < 2) return "first frame without its length byte";
      const declared = (low << 8) | data[1];
      if (declared < 8) return `first frame length ${declared} is below 8`;
      if (data.length < 8) return "first frame holds fewer than 6 payload bytes";
      buffer.receiving = { declared, bytes: data.slice(2, 8), nextSeq: 1 };
      return null;
    }
    case 2: {
      const receiving = buffer.receiving;
      if (!receiving) return "consecutive frame without a first frame, or after the declared length was received";
      if (low !== receiving.nextSeq) return `sequence number ${low} where ${receiving.nextSeq} was expected`;
      const take = Math.min(7, receiving.declared - receiving.bytes.length);
      if (data.length - 1 < take) return "consecutive frame holds fewer bytes than the message still needs";
      receiving.bytes.push(...data.slice(1, 1 + take));
      receiving.nextSeq = (receiving.nextSeq + 1) & 0x0f;
      if (receiving.bytes.length === receiving.declared) {
        buffer.messages.push(receiving.bytes);
        buffer.receiving = null;
      }
      return null;
    }
    case 3:
      return "flow control frame in a response";
    default:
      return `unknown frame type ${pci}`;
  }
}

/**
 * Reassembles each identifier's frames on its own. Identifiers keep the order
 * in which they first answered.
 */
export function reassemble(frames: readonly CanFrame[]): EcuMessages[] {
  const buffers = new Map<string, Buffer>();
  for (const frame of frames) {
    let buffer = buffers.get(frame.responseId);
    if (!buffer) {
      buffer = { rawLines: [], messages: [], receiving: null, fault: null };
      buffers.set(frame.responseId, buffer);
    }
    buffer.rawLines.push(frame.line);
    if (buffer.fault === null) buffer.fault = step(buffer, frame.data);
  }
  return [...buffers].map(([responseId, buffer]) => {
    let fault = buffer.fault;
    if (fault === null && buffer.receiving) {
      fault = `${buffer.receiving.bytes.length} of ${buffer.receiving.declared} declared bytes received when the reply ended`;
    }
    return {
      responseId,
      rawLines: buffer.rawLines,
      result: fault === null ? { ok: true, messages: buffer.messages } : { ok: false, reason: fault },
    };
  });
}
