/**
 * The fail-closed, read-only command policy (protocol-stack.md, "Fail-closed
 * command policy").
 *
 * RESEARCH PROTOTYPE. A closed allowlist as data plus a pure check. It runs
 * on every command before any byte is written; anything not on the list is
 * refused and nothing is sent. There is no raw-command escape hatch.
 *
 * Only the exact canonical text is accepted: upper case, no spaces, no line
 * endings, no separators. Commands are built from typed requests, so a
 * lower-case, spaced or concatenated variant can only come from free text,
 * and it is refused rather than normalised.
 */

/** What a command may legitimately answer; the classifier checks the reply against it. */
export type ResponseKind =
  | "ok_only" // exactly "OK"
  | "text" // printable identity / description lines
  | "protocol_number" // ATDPN: optional "A" + protocol digit
  | "voltage" // ATRV: e.g. "12.6V"
  | "obd"; // hex data lines

export type CommandGroup = "adapter_setup" | "obd";

/**
 * `printsIdentity`: the command's own answer is the adapter's identity line.
 * For every other command that line means the adapter reset itself.
 */
type AtRule = { kind: ResponseKind; resetsAdapter?: true; printsIdentity?: true; note: string };

/** Adapter setup commands, exactly as sent. */
const AT_ALLOWLIST = {
  ATZ: { kind: "text", resetsAdapter: true, printsIdentity: true, note: "reset; prints the identity line" },
  ATWS: { kind: "text", resetsAdapter: true, printsIdentity: true, note: "warm start; prints the identity line" },
  ATE0: { kind: "ok_only", note: "echo off" },
  ATL0: { kind: "ok_only", note: "no line feed after CR" },
  ATS0: { kind: "ok_only", note: "no spaces between bytes" },
  ATS1: { kind: "ok_only", note: "spaces between bytes" },
  ATH0: { kind: "ok_only", note: "headers off" },
  ATH1: { kind: "ok_only", note: "headers on" },
  ATSP0: { kind: "ok_only", note: "automatic protocol search" },
  ATDP: { kind: "text", note: "describe protocol" },
  ATDPN: { kind: "protocol_number", note: "protocol number" },
  ATI: { kind: "text", printsIdentity: true, note: "adapter identity (reported, not proven)" },
  "AT@1": { kind: "text", note: "device description (reported, not proven)" },
  ATRV: { kind: "voltage", note: "adapter-measured supply voltage, not an ECU value" },
} as const satisfies Record<string, AtRule>;

export type AllowedAtCommand = keyof typeof AT_ALLOWLIST;
export const ALLOWED_AT_COMMANDS = Object.freeze(Object.keys(AT_ALLOWLIST) as AllowedAtCommand[]);

/** Read-only SAE J1979 requests, as exact forms. */
export const OBD_ALLOWLIST: readonly { form: RegExp; note: string }[] = Object.freeze([
  { form: /^01[0-9A-F]{2}$/, note: "$01 current data: service + one PID" },
  { form: /^02[0-9A-F]{2}00$/, note: "$02 freeze frame: service + PID + frame 00 only" },
  { form: /^03$/, note: "$03 stored (confirmed) DTCs" },
  { form: /^07$/, note: "$07 pending DTCs" },
  { form: /^0A$/, note: "$0A permanent DTCs" },
  { form: /^09(00|02)$/, note: "$09 vehicle information: infotypes 00 and 02 (VIN) only" },
]);

/** The longest allowed command ("020000"). Anything longer is malformed. */
export const MAX_COMMAND_LENGTH = 6;

/**
 * Known-dangerous or out-of-scope commands, with the reason. Informational:
 * they are refused because they are not on the allowlist; this table only
 * explains why, and its examples are tested.
 */
export const DENIED_COMMANDS: readonly { match: RegExp; why: string }[] = Object.freeze([
  { match: /^04/, why: "$04 clears DTCs and resets emission monitors: changes vehicle state and erases evidence" },
  { match: /^08/, why: "$08 controls an on-board system: commands the vehicle" },
  { match: /^0[56]/, why: "$05 / $06 deferred until their semantics are reviewed" },
  {
    match: /^(10|11|14|19|22|23|27|28|2C|2E|2F|31|34|35|36|37|3D|3E|85|87)/,
    why: "UDS / KWP2000 service: manufacturer-enhanced or state-changing diagnostics, security access or programming",
  },
  { match: /^AT(MA|MR|MT|MP)/, why: "monitor mode: floods the link; passive bus sniffing is out of scope" },
  { match: /^AT(SH|CRA|CF|CM|CP|CEA|CSM|FC|AR)/, why: "header / filter override: addresses an ECU outside the functional OBD request" },
  {
    match: /^AT(PP|@3|BRD|BRT|PB|SI|FI|LP|ST|AT|IB|TP|SP[1-9A-C]|D$)/,
    why: "persistent setting, baud change, low-power mode, manual protocol or timing change",
  },
]);

export type CommandRefusal = "malformed" | "denied" | "not_on_allowlist";

export type CommandCheck =
  | { allowed: true; command: string; group: CommandGroup; kind: ResponseKind; resetsAdapter: boolean; printsIdentity: boolean }
  | { allowed: false; refusal: CommandRefusal; reason: string };

/** Upper-case letters, digits and "@" only: rejects spaces, CR / LF, NUL, lower case and separators. */
const CANONICAL_CHARS = /^[0-9A-Z@]+$/;

/** The pure policy check. */
export function checkCommand(command: unknown): CommandCheck {
  if (typeof command !== "string" || command.length === 0) {
    return { allowed: false, refusal: "malformed", reason: "a command must be non-empty text" };
  }
  if (!CANONICAL_CHARS.test(command)) {
    return {
      allowed: false,
      refusal: "malformed",
      reason: "only upper-case letters, digits and @ are accepted (no spaces, line endings, separators or lower case)",
    };
  }
  if (Object.prototype.hasOwnProperty.call(AT_ALLOWLIST, command)) {
    const rule: AtRule = AT_ALLOWLIST[command as AllowedAtCommand];
    return {
      allowed: true,
      command,
      group: "adapter_setup",
      kind: rule.kind,
      resetsAdapter: rule.resetsAdapter === true,
      printsIdentity: rule.printsIdentity === true,
    };
  }
  if (OBD_ALLOWLIST.some((entry) => entry.form.test(command))) {
    return { allowed: true, command, group: "obd", kind: "obd", resetsAdapter: false, printsIdentity: false };
  }
  const denied = DENIED_COMMANDS.find((entry) => entry.match.test(command));
  if (denied) return { allowed: false, refusal: "denied", reason: denied.why };
  if (command.length > MAX_COMMAND_LENGTH) {
    return { allowed: false, refusal: "malformed", reason: "longer than any allowed command" };
  }
  return { allowed: false, refusal: "not_on_allowlist", reason: "not on the read-only allowlist" };
}

/** A typed read-only OBD request. Commands are built from these, never from free text. */
export type ObdRequest =
  | { service: "01"; pid: number }
  | { service: "02"; pid: number; frame: 0 }
  | { service: "03" | "07" | "0A" }
  | { service: "09"; infoType: 0 | 2 };

function hexByte(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xff) return null;
  return value.toString(16).toUpperCase().padStart(2, "0");
}

/** Builds the command text for a typed request, then runs the policy check again on the built text. */
export function buildObdCommand(request: ObdRequest): CommandCheck {
  const refused = (reason: string): CommandCheck => ({ allowed: false, refusal: "malformed", reason });
  let text: string;
  switch (request.service) {
    case "01": {
      const pid = hexByte(request.pid);
      if (pid === null) return refused("a PID is an integer 0-255");
      text = `01${pid}`;
      break;
    }
    case "02": {
      const pid = hexByte(request.pid);
      if (pid === null) return refused("a PID is an integer 0-255");
      if (request.frame !== 0) return refused("only freeze frame 0 is read");
      text = `02${pid}00`;
      break;
    }
    case "03":
    case "07":
    case "0A":
      text = request.service;
      break;
    case "09": {
      if (request.infoType !== 0 && request.infoType !== 2) return refused("only $09 infotypes 00 and 02 are read");
      text = `090${request.infoType}`;
      break;
    }
    default:
      return refused("unknown service");
  }
  return checkCommand(text);
}
