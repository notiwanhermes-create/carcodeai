/**
 * $03 / $07 / $0A DTC reads (protocol-stack.md, "DTC decoding"; scan-flow.md,
 * "DTC status mapping").
 *
 * RESEARCH PROTOTYPE. Pure. STANDARD-DOCUMENTED (unverified copy):
 * - SAE J2012 / ISO 15031-6: a DTC is two bytes; the top two bits select the
 *   system (P, C, B, U), the next two the first digit (0-3), the remaining
 *   twelve bits three hex digits;
 * - SAE J1979 on CAN: the positive answer is the service byte + 0x40, a DTC
 *   count, then two bytes per DTC.
 *
 * The count governs: the payload (ISO-TP padding already removed) must be
 * exactly 2 + 2 × count bytes, and a `0000` pair inside the counted pairs is
 * not guessed at; either makes that ECU's answer `malformed`.
 *
 * Each service keeps its own meaning: $03 stored ("confirmed" in current
 * J1979 wording), $07 pending, $0A permanent. A code is attributed to the ECU
 * that sent it; nothing here says a code is active now.
 */
import type { CommandResult } from "../elm/executor";
import type { CommandOutcome } from "../types";
import type { ProtocolFamily } from "./frames";
import { readService, type EcuIdentity, type ServiceRead } from "./response";

export type DtcService = "03" | "07" | "0A";
export type DtcKind = "stored" | "pending" | "permanent";

export const DTC_SERVICE_KIND: Readonly<Record<DtcService, DtcKind>> = Object.freeze({ "03": "stored", "07": "pending", "0A": "permanent" });

const SYSTEMS = ["P", "C", "B", "U"] as const;

/** Decodes one two-byte DTC to its `P0133` form. */
export function decodeDtc(high: number, low: number): string {
  const system = SYSTEMS[(high >> 6) & 0x03];
  const first = (high >> 4) & 0x03;
  const rest = (((high & 0x0f) << 8) | low).toString(16).toUpperCase().padStart(3, "0");
  return `${system}${first}${rest}`;
}

export type DtcList = { count: number; codes: string[] };

function dtcBody(body: number[]) {
  if (body.length < 1) return { ok: false as const, reason: "no DTC count" };
  const count = body[0];
  if (body.length !== 1 + 2 * count) {
    return { ok: false as const, reason: `count ${count} needs ${2 + 2 * count} bytes; the answer has ${body.length + 1}` };
  }
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const high = body[1 + 2 * i];
    const low = body[2 + 2 * i];
    if (high === 0 && low === 0) return { ok: false as const, reason: `counted pair ${i + 1} is 0000` };
    codes.push(decodeDtc(high, low));
  }
  return { ok: true as const, value: { count, codes } };
}

export function readDtcs(result: CommandResult, family: ProtocolFamily, service: DtcService): ServiceRead<DtcList> {
  return readService(result, family, { service }, dtcBody);
}

/**
 * How one ECU's read of one service ended. `no_response` for an ECU that sent
 * nothing while others answered; the command's own outcome when the whole
 * reply failed; `not_read` when the service was not run.
 */
export type EcuReadOutcome = "ok" | "negative_response" | "malformed" | Exclude<CommandOutcome, "ok"> | "not_read";

export type MergedDtc = { code: string; kinds: DtcKind[] };

export type EcuDtcs = EcuIdentity & {
  outcomes: Record<DtcService, EcuReadOutcome>;
  /** Codes from services that answered `ok` for this ECU; one entry per code with every kind that reported it. */
  codes: MergedDtc[];
};

const SERVICES: readonly DtcService[] = ["03", "07", "0A"];

/**
 * Merges one scan's $03 / $07 / $0A reads per ECU (scan-flow.md rows 18-19):
 * the same code from two services on one ECU is one entry with both kinds;
 * the same code from two ECUs stays two entries. `discovered` adds ECUs that
 * answered discovery but none of these reads, so their failed reads stay
 * visible.
 */
export function mergeDtcReads(reads: Partial<Record<DtcService, ServiceRead<DtcList>>>, discovered: readonly EcuIdentity[] = []): EcuDtcs[] {
  const ecus = new Map<string, EcuIdentity>();
  for (const ecu of discovered) ecus.set(ecu.module, { responseId: ecu.responseId, module: ecu.module });
  for (const service of SERVICES) {
    for (const answer of reads[service]?.ecus ?? []) {
      if (!ecus.has(answer.module)) ecus.set(answer.module, { responseId: answer.responseId, module: answer.module });
    }
  }
  return [...ecus.values()].map((ecu) => {
    const outcomes = {} as Record<DtcService, EcuReadOutcome>;
    const codes: MergedDtc[] = [];
    for (const service of SERVICES) {
      const read = reads[service];
      if (!read) {
        outcomes[service] = "not_read";
        continue;
      }
      if (read.outcome !== "ok") {
        outcomes[service] = read.outcome;
        continue;
      }
      const answer = read.ecus.find((candidate) => candidate.module === ecu.module);
      outcomes[service] = answer ? answer.outcome : "no_response";
      if (answer?.outcome !== "ok") continue;
      for (const code of answer.value.codes) {
        const kind = DTC_SERVICE_KIND[service];
        const existing = codes.find((entry) => entry.code === code);
        if (!existing) codes.push({ code, kinds: [kind] });
        else if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
      }
    }
    return { ...ecu, outcomes, codes };
  });
}
