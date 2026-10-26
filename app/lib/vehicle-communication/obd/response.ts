/**
 * One OBD command's reply → per-ECU answers (protocol-stack.md, "ECU-aware
 * parsing", rules 4-7).
 *
 * RESEARCH PROTOTYPE. Pure. The command-level outcome comes from the elm
 * layer unchanged: `NO DATA` stays `no_response` for every ECU (never "no
 * codes", never "unsupported"), and an adapter error never produces data.
 * When the reply holds data, each ECU's answer is judged on its own:
 *
 * - `negative_response`: `7F <service> <code>`, the code kept as sent;
 * - `malformed`: an ISO-TP fault, a reply for another service / PID / frame,
 *   the wrong length for its service and PID, several conflicting answers
 *   from one ECU, or only a "response pending" answer;
 * - `ok`: the decoded value, with the reassembled payload kept as evidence.
 *
 * Every answer carries its response identifier, opaque module label and raw
 * lines. Nothing here knows about Guided Diagnostics.
 */
import type { CommandResult } from "../elm/executor";
import { buildObdCommand, type ObdRequest } from "../elm/command-policy";
import type { CommandOutcome } from "../types";
import { moduleLabel, parseCanLines, reassemble, type ProtocolFamily } from "./frames";

export type BodyDecode<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Negative response code 0x78: "request correctly received, response pending"; a final answer follows. */
export const RESPONSE_PENDING = 0x78;

export type EcuIdentity = { responseId: string; module: string };

export type EcuAnswer<T> = EcuIdentity & {
  rawLines: string[];
  /** Reassembled ISO-TP payloads, padding removed (evidence; empty when reassembly failed). */
  payloads: number[][];
} & (
    | { outcome: "ok"; value: T }
    | { outcome: "negative_response"; code: number }
    | { outcome: "malformed"; reason: string }
  );

export type ServiceRead<T> = {
  request: ObdRequest;
  command: string;
  family: ProtocolFamily;
  /** `ok` only when the reply held data attributable to response identifiers. */
  outcome: CommandOutcome;
  detail: string | null;
  /** One answer per ECU that sent at least one frame; empty unless `outcome` is `ok`. */
  ecus: EcuAnswer<T>[];
  /** The elm layer's raw evidence for this command, unchanged (incomplete bytes, truncation and discarded replies included). */
  raw: CommandResult["raw"];
};

const hexByte = (value: number) => value.toString(16).toUpperCase().padStart(2, "0");

function serviceByte(request: ObdRequest): number {
  return parseInt(request.service, 16);
}

/** The bytes a positive answer must echo after its service byte. */
function echoBytes(request: ObdRequest): number[] {
  switch (request.service) {
    case "01":
      return [request.pid];
    case "02":
      return [request.pid, request.frame];
    case "09":
      return [request.infoType];
    default:
      return [];
  }
}

function judgeMessage<T>(request: ObdRequest, payload: readonly number[], decodeBody: (body: number[]) => BodyDecode<T>) {
  const service = serviceByte(request);
  if (payload[0] === 0x7f) {
    if (payload.length !== 3) return { outcome: "malformed" as const, reason: "negative response is not 3 bytes" };
    if (payload[1] !== service) return { outcome: "malformed" as const, reason: `negative response for service ${hexByte(payload[1])}` };
    return { outcome: "negative_response" as const, code: payload[2] };
  }
  if (payload[0] !== service + 0x40) return { outcome: "malformed" as const, reason: `answer for service byte ${hexByte(payload[0])}` };
  const echo = echoBytes(request);
  for (let i = 0; i < echo.length; i++) {
    if (payload.length <= 1 + i) return { outcome: "malformed" as const, reason: "answer shorter than its echoed request" };
    if (payload[1 + i] !== echo[i]) return { outcome: "malformed" as const, reason: `echo ${hexByte(payload[1 + i])} where ${hexByte(echo[i])} was requested` };
  }
  const decoded = decodeBody(payload.slice(1 + echo.length));
  return decoded.ok ? { outcome: "ok" as const, value: decoded.value } : { outcome: "malformed" as const, reason: decoded.reason };
}

/**
 * Turns the elm layer's result for `request` into per-ECU answers.
 * `decodeBody` receives the payload after the service byte and the echo and
 * must check the exact length its PID / service requires.
 */
export function readService<T>(
  result: CommandResult,
  family: ProtocolFamily,
  request: ObdRequest,
  decodeBody: (body: number[]) => BodyDecode<T>,
): ServiceRead<T> {
  const built = buildObdCommand(request);
  const base = { request, family, raw: result.raw };
  if (!built.allowed) {
    return { ...base, command: result.command, outcome: "command_not_allowed", detail: built.reason, ecus: [] };
  }
  const command = built.command;
  if (result.command !== command) {
    return { ...base, command, outcome: "unexpected_reply", detail: `result is for "${result.command}", not "${command}"`, ecus: [] };
  }
  if (result.outcome !== "ok") return { ...base, command, outcome: result.outcome, detail: result.detail, ecus: [] };
  const parsed = parseCanLines(result.lines, family);
  if (!parsed.ok) return { ...base, command, outcome: "unexpected_reply", detail: `${parsed.reason}: "${parsed.line}"`, ecus: [] };
  if (parsed.frames.length === 0) return { ...base, command, outcome: "unexpected_reply", detail: "no data lines", ecus: [] };

  const service = serviceByte(request);
  const ecus = reassemble(parsed.frames).map((ecu): EcuAnswer<T> => {
    const identity = { responseId: ecu.responseId, module: moduleLabel(family, ecu.responseId), rawLines: ecu.rawLines };
    if (!ecu.result.ok) return { ...identity, payloads: [], outcome: "malformed", reason: ecu.result.reason };
    const payloads = ecu.result.messages;
    const isPending = (p: readonly number[]) => p.length === 3 && p[0] === 0x7f && p[1] === service && p[2] === RESPONSE_PENDING;
    const finals = payloads.filter((p) => !isPending(p));
    if (finals.length === 0) return { ...identity, payloads, outcome: "malformed", reason: "only a response-pending answer; no final answer" };
    if (finals.length > 1) return { ...identity, payloads, outcome: "malformed", reason: `${finals.length} answers from one ECU to one request (conflicting)` };
    return { ...identity, payloads, ...judgeMessage(request, finals[0], decodeBody) };
  });
  return { ...base, command, outcome: "ok", detail: null, ecus };
}
