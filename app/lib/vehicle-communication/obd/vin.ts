/**
 * VIN: $09 infotype `02` (module-discovery.md step 5; capability-gap-analysis.md,
 * "Vehicle identity").
 *
 * RESEARCH PROTOTYPE. Pure. STANDARD-DOCUMENTED (unverified copy), SAE J1979
 * on CAN: the answer is `49 02`, a number-of-data-items byte (`01`), then 17
 * ASCII bytes, usually as an ISO-TP multi-frame message. Anything else is
 * `malformed` for that ECU; padding or filler bytes are not trimmed or
 * guessed at.
 *
 * The VIN is what each ECU REPORTED: it is never verified (no check digit is
 * computed) and never overwrites a garage vehicle. Characters outside the
 * ISO 3779 VIN alphabet (digits and capitals except I, O, Q) keep the text
 * but mark it `nonstandard`. Answers from several ECUs are compared, never
 * merged.
 */
import type { CommandResult } from "../elm/executor";
import type { ProtocolFamily } from "./frames";
import { readService, type EcuIdentity, type ServiceRead } from "./response";

export type ReportedVin = { text: string; charset: "iso3779" | "nonstandard"; raw: number[] };

const VIN_CHARSET = /^[A-HJ-NPR-Z0-9]{17}$/;

export function readVin(result: CommandResult, family: ProtocolFamily): ServiceRead<ReportedVin> {
  return readService(result, family, { service: "09", infoType: 2 }, (body) => {
    if (body.length !== 18) return { ok: false, reason: `${body.length} bytes where an item count and 17 characters are required` };
    if (body[0] !== 0x01) return { ok: false, reason: `number of data items is ${body[0]}, not 1` };
    const chars = body.slice(1);
    if (!chars.every((byte) => byte >= 0x20 && byte <= 0x7e)) return { ok: false, reason: "VIN bytes are not printable ASCII" };
    const text = String.fromCharCode(...chars);
    return { ok: true, value: { text, charset: VIN_CHARSET.test(text) ? "iso3779" : "nonstandard", raw: chars } };
  });
}

export type VinComparison =
  | { status: "none" }
  | { status: "consistent"; text: string; modules: string[] }
  | { status: "conflicting"; reports: Array<EcuIdentity & { text: string }> };

/** Compares the VINs that ECUs reported. Disagreement is kept as `conflicting`; no value is picked. */
export function compareVins(read: ServiceRead<ReportedVin>): VinComparison {
  const reports = read.ecus.flatMap((answer) => (answer.outcome === "ok" ? [{ responseId: answer.responseId, module: answer.module, text: answer.value.text }] : []));
  if (reports.length === 0) return { status: "none" };
  if (reports.every((report) => report.text === reports[0].text)) {
    return { status: "consistent", text: reports[0].text, modules: reports.map((report) => report.module) };
  }
  return { status: "conflicting", reports };
}
