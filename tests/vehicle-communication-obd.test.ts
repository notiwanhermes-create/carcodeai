/**
 * Scanner foundation (S6): the OBD layer. Per-ECU ISO-TP reassembly with
 * padding, $01 / $02 / $09 bitmaps, $03 / $07 / $0A DTCs, readiness, the
 * reviewed PID table, freeze frame 0 and the VIN.
 *
 * Design: docs/research/scanner-engine/protocol-stack.md ("OBD layer"),
 * live-data.md and scan-flow.md ("Simulated test matrix"). Rows covered here:
 * 10-19, 22-24, 37-44 and 49-52, plus the OBD-level parts of 7, 9, 21 and
 * 45-48 (the scan-level parts belong to S7-S8).
 *
 * Every reply here is SCRIPTED. Passing shows the decoders behave as designed
 * against scripted replies, not that any real adapter or ECU answers this way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElmCommandExecutor, type CommandResult } from "../app/lib/vehicle-communication/elm/executor";
import { initialiseAdapter } from "../app/lib/vehicle-communication/elm/initialise";
import { ScriptedElmAdapter, SimulatedTransport } from "../app/lib/vehicle-communication/transport/simulated";
import type { CommandOutcome } from "../app/lib/vehicle-communication/types";
import { decodeDtc, mergeDtcReads, readDtcs } from "../app/lib/vehicle-communication/obd/dtc";
import { moduleLabel, protocolFromDpn } from "../app/lib/vehicle-communication/obd/frames";
import { decodePidData, PID_TABLE, PID_TABLE_REVIEW, readCurrentPid, readFreezeFrameDtc, readFreezeFramePid } from "../app/lib/vehicle-communication/obd/pids";
import { compareDtcCounts, decodeReadiness, READINESS_TABLE_REVIEW, readReadiness } from "../app/lib/vehicle-communication/obd/readiness";
import type { EcuAnswer, ServiceRead } from "../app/lib/vehicle-communication/obd/response";
import {
  bitmapChain,
  bitmapSet,
  planPidRequest,
  pidSupport,
  readCurrentDataSupport,
  readFreezeFrameSupport,
  readInfoTypeSupport,
} from "../app/lib/vehicle-communication/obd/support";
import { compareVins, readVin } from "../app/lib/vehicle-communication/obd/vin";

/** An `ok` elm result holding these data lines. */
function reply(command: string, lines: string[]): CommandResult {
  const received = `${lines.join("\r")}\r\r>`;
  return {
    command,
    written: true,
    outcome: "ok",
    token: null,
    detail: null,
    lines,
    info: [],
    raw: { received, lines, echoRemoved: false, incomplete: null, truncated: false, byteCount: received.length, discardedBefore: [], discardedAfter: [] },
  };
}

/** A non-`ok` elm result (an adapter token or an executor outcome). */
function failed(command: string, outcome: Exclude<CommandOutcome, "ok">, token: string | null): CommandResult {
  return { ...reply(command, []), outcome, token, detail: token ? `adapter replied "${token}"` : outcome, lines: [] };
}

function ecu<T>(read: ServiceRead<T>, responseId: string): EcuAnswer<T> {
  const answer = read.ecus.find((candidate) => candidate.responseId === responseId);
  if (!answer) throw new Error(`no answer from ${responseId}`);
  return answer;
}

function okValue<T>(read: ServiceRead<T>, responseId: string): T {
  const answer = ecu(read, responseId);
  if (answer.outcome !== "ok") throw new Error(`${responseId} was ${answer.outcome}`);
  return answer.value;
}

function malformedReason<T>(read: ServiceRead<T>, responseId: string): string {
  const answer = ecu(read, responseId);
  if (answer.outcome !== "malformed") throw new Error(`${responseId} was ${answer.outcome}`);
  return answer.reason;
}

/** Row 39: three codes for one ECU across a first frame and a padded final consecutive frame. */
const THREE_CODES_7E9 = ["7E9 10 08 43 03 01 33 02 44", "7E9 21 03 55 AA AA AA AA AA"];
const VIN_7E8 = ["7E8 10 14 49 02 01 31 44 34", "7E8 21 47 50 30 30 52 35 35", "7E8 22 42 31 32 33 34 35 36"];
const VIN_TEXT = "1D4GP00R55B123456";

describe("protocol and module labels", () => {
  it("accepts only CAN protocols and labels modules opaquely", () => {
    expect(protocolFromDpn("A6")).toEqual({ supported: true, number: "6", auto: true, family: "can11" });
    expect(protocolFromDpn("9")).toEqual({ supported: true, number: "9", auto: false, family: "can29" });
    // Row 12: a non-CAN protocol is reported, not read.
    expect(protocolFromDpn("A3")).toEqual({ supported: false, number: "3", auto: true, reason: "unsupported_protocol" });
    expect(protocolFromDpn("SAE J1850")).toBeNull();
    expect(moduleLabel("can11", "7E8")).toBe("obd-can11-7e8");
    expect(moduleLabel("can29", "18DAF110")).toBe("obd-can29-18daf110");
  });
});

describe("ISO-TP padding and reassembly (rows 13-15, 17, 37-44)", () => {
  it("row 37/38: padded and unpadded single frames give the same zero-code answer", () => {
    for (const line of ["7E8 02 43 00 AA AA AA AA AA", "7E8 02 43 00"]) {
      const read = readDtcs(reply("03", [line]), "can11", "03");
      expect(read.outcome).toBe("ok");
      const answer = ecu(read, "7E8");
      expect(answer).toMatchObject({ module: "obd-can11-7e8", outcome: "ok", value: { count: 0, codes: [] }, payloads: [[0x43, 0x00]] });
      expect(answer.rawLines).toEqual([line]);
    }
  });

  it("row 39: padding after the declared length of the final consecutive frame is excluded", () => {
    const read = readDtcs(reply("03", THREE_CODES_7E9), "can11", "03");
    expect(okValue(read, "7E9")).toEqual({ count: 3, codes: ["P0133", "P0244", "P0355"] });
    expect(ecu(read, "7E9").payloads).toEqual([[0x43, 0x03, 0x01, 0x33, 0x02, 0x44, 0x03, 0x55]]);
  });

  it("row 40: interleaved ECUs reassemble separately", () => {
    const lines = [THREE_CODES_7E9[0], "7E8 02 43 00 AA AA AA AA AA", THREE_CODES_7E9[1]];
    const read = readDtcs(reply("03", lines), "can11", "03");
    expect(read.ecus.map((answer) => [answer.module, answer.outcome])).toEqual([
      ["obd-can11-7e9", "ok"],
      ["obd-can11-7e8", "ok"],
    ]);
    expect(okValue(read, "7E8").codes).toEqual([]);
    expect(okValue(read, "7E9").codes).toHaveLength(3);
    expect(ecu(read, "7E9").rawLines).toEqual(THREE_CODES_7E9);
  });

  it("rows 13 and 17: VINs reassembled per ECU from interleaved multi-frame answers", () => {
    const other = ["7E9 10 14 49 02 01 57 56 57", "7E9 21 5A 5A 5A 31 4A 5A 33", "7E9 22 57 33 38 36 37 35 32"];
    const lines = [VIN_7E8[0], other[0], VIN_7E8[1], other[1], other[2], VIN_7E8[2]];
    const read = readVin(reply("0902", lines), "can11");
    expect(okValue(read, "7E8")).toMatchObject({ text: VIN_TEXT, charset: "iso3779" });
    expect(okValue(read, "7E9").text).toBe("WVWZZZ1JZ3W386752");
    // Disagreement is kept, not resolved.
    expect(compareVins(read)).toEqual({
      status: "conflicting",
      reports: [
        { responseId: "7E8", module: "obd-can11-7e8", text: VIN_TEXT },
        { responseId: "7E9", module: "obd-can11-7e9", text: "WVWZZZ1JZ3W386752" },
      ],
    });
    expect(compareVins(readVin(reply("0902", VIN_7E8), "can11"))).toEqual({ status: "consistent", text: VIN_TEXT, modules: ["obd-can11-7e8"] });
  });

  it.each([
    ["row 14: missing sequence number", [VIN_7E8[0], VIN_7E8[2]], /sequence number 2 where 1/],
    ["row 14: repeated sequence number", [VIN_7E8[0], VIN_7E8[1], VIN_7E8[1], VIN_7E8[2]], /sequence number 1 where 2/],
    ["row 15: fewer bytes than declared at the prompt", [VIN_7E8[0], VIN_7E8[1]], /13 of 20 declared bytes/],
    ["consecutive frame without a first frame", [VIN_7E8[1]], /without a first frame/],
    ["first frame inside a message", [VIN_7E8[0], VIN_7E8[0]], /first frame inside/],
    ["short non-final consecutive frame", [VIN_7E8[0], "7E8 21 47 50 30", VIN_7E8[2]], /fewer bytes than the message still needs/],
    ["flow control frame", ["7E8 30 00 00"], /flow control/],
    ["unknown frame type", ["7E8 40 49 02"], /unknown frame type/],
  ])("%s is malformed for that ECU only", (_name, lines, reason) => {
    const read = readVin(reply("0902", [...lines, "7E9 06 49 02 01 00 00 00"]), "can11");
    expect(read.outcome).toBe("ok");
    expect(malformedReason(read, "7E8")).toMatch(reason);
    expect(ecu(read, "7E8").payloads).toEqual([]);
    expect(ecu(read, "7E8").rawLines).toEqual(lines);
    expect(ecu(read, "7E9").outcome).toBe("malformed"); // too short for a VIN, judged on its own
  });

  it.each([
    ["row 41: SF_DL beyond the bytes present", ["7E8 05 43 01 01 33"], /fewer bytes than its declared length/],
    ["row 42: SF_DL of 0", ["7E8 00 43 00 AA AA AA AA AA"], /length 0 is outside/],
    ["row 42: SF_DL greater than 7", ["7E8 08 43 03 01 33 02 44 03"], /length 8 is outside/],
    ["row 42: FF_DL below 8", ["7E8 10 07 43 03 01 33 02 44"], /below 8/],
    ["row 43: extra consecutive frame after FF_DL bytes", [...THREE_CODES_7E9.map((line) => line.replace("7E9", "7E8")), "7E8 22 AA AA AA AA AA AA AA"], /without a first frame, or after/],
    ["row 44: count disagrees with the declared length", ["7E8 04 43 02 01 33 AA AA AA"], /count 2 needs 6 bytes/],
    ["a counted 0000 pair", ["7E8 06 43 02 01 33 00 00"], /pair 2 is 0000/],
    ["CAN frame longer than 8 bytes", ["7E8 02 43 00 AA AA AA AA AA AA"], /longer than 8/],
  ])("%s: malformed, padding never read as a code, other ECU kept", (_name, lines, reason) => {
    const read = readDtcs(reply("03", [...lines, "7E9 04 43 01 01 33"]), "can11", "03");
    expect(malformedReason(read, "7E8")).toMatch(reason);
    expect(okValue(read, "7E9").codes).toEqual(["P0133"]);
  });
});

describe("reply attribution and failure forms", () => {
  it("row 10: a negative response keeps its code; the other ECU's codes are kept", () => {
    const read = readDtcs(reply("03", ["7E8 04 43 01 01 33", "7E9 03 7F 03 31"]), "can11", "03");
    expect(ecu(read, "7E9")).toMatchObject({ outcome: "negative_response", code: 0x31, payloads: [[0x7f, 0x03, 0x31]] });
    expect(okValue(read, "7E8").codes).toEqual(["P0133"]);
  });

  it("row 11: an answer for the wrong service or PID is malformed for that ECU", () => {
    expect(malformedReason(readDtcs(reply("03", ["7E8 02 47 00"]), "can11", "03"), "7E8")).toMatch(/service byte 47/);
    expect(malformedReason(readCurrentPid(reply("010C", ["7E8 04 41 0D 1A F8"]), "can11", 0x0c), "7E8")).toMatch(/echo 0D where 0C/);
    expect(malformedReason(readFreezeFramePid(reply("020C00", ["7E8 05 42 0C 01 1A F8"]), "can11", 0x0c), "7E8")).toMatch(/echo 01 where 00/);
    expect(malformedReason(readDtcs(reply("03", ["7E8 03 7F 01 11"]), "can11", "03"), "7E8")).toMatch(/negative response for service 01/);
  });

  it("a response-pending answer is skipped for the final answer; alone it is not data", () => {
    const pendingThenFinal = readDtcs(reply("03", ["7E8 03 7F 03 78", "7E8 04 43 01 01 33"]), "can11", "03");
    expect(okValue(pendingThenFinal, "7E8").codes).toEqual(["P0133"]);
    expect(ecu(pendingThenFinal, "7E8").payloads).toHaveLength(2);
    expect(malformedReason(readDtcs(reply("03", ["7E8 03 7F 03 78"]), "can11", "03"), "7E8")).toMatch(/response-pending/);
  });

  it("two answers from one ECU to one request are conflicting, not chosen between", () => {
    const read = readDtcs(reply("03", ["7E8 04 43 01 01 33", "7E8 02 43 00"]), "can11", "03");
    expect(malformedReason(read, "7E8")).toMatch(/conflicting/);
    expect(ecu(read, "7E8").payloads).toHaveLength(2);
  });

  it("29-bit identifiers are attributed per ECU", () => {
    const read = readDtcs(reply("07", ["18 DA F1 10 04 47 01 01 33 55 55 55", "18 DA F1 18 02 47 00"]), "can29", "07");
    expect(read.ecus.map((answer) => answer.module)).toEqual(["obd-can29-18daf110", "obd-can29-18daf118"]);
    expect(okValue(read, "18DAF110").codes).toEqual(["P0133"]);
  });

  it.each([
    ["headers off", ["43 01 01 33"], "can11"],
    ["an identifier outside 7E8-7EF", ["7E0 04 43 01 01 33"], "can11"],
    ["an 11-bit line on a 29-bit protocol", ["7E8 04 43 01 01 33"], "can29"],
    ["unspaced data", ["7E8 0443010133"], "can11"],
  ] as const)("a line with %s fails the whole reply closed", (_name, lines, family) => {
    const read = readDtcs(reply("03", ["7E9 02 43 00", ...lines]), family, "03");
    expect(read.outcome).toBe("unexpected_reply");
    expect(read.ecus).toEqual([]);
    expect(read.raw.lines).toEqual(["7E9 02 43 00", ...lines]);
  });

  it("rows 7 and 9: adapter outcomes pass through and produce no data", () => {
    const noData = readDtcs(failed("03", "no_response", "NO DATA"), "can11", "03");
    expect(noData).toMatchObject({ outcome: "no_response", ecus: [] });
    expect(readDtcs(failed("03", "adapter_overflow", "BUFFER FULL"), "can11", "03")).toMatchObject({ outcome: "adapter_overflow", ecus: [] });
    expect(readDtcs(failed("07", "timeout", null), "can11", "07").outcome).toBe("timeout");
  });

  it("a lost link keeps every received byte as provenance: incomplete bytes and truncation pass through unchanged, nothing is decoded", () => {
    const lost: CommandResult = {
      ...failed("03", "transport_lost", null),
      raw: {
        received: null,
        lines: [],
        echoRemoved: false,
        incomplete: "7E8 06 43 02 01",
        truncated: true,
        byteCount: 4100,
        discardedBefore: [{ reason: "unsolicited", text: "7E8 02 43 00\r\r>", lines: ["7E8 02 43 00"], overflowed: false, byteCount: 15 }],
        discardedAfter: [],
      },
    };
    const read = readDtcs(lost, "can11", "03");
    expect(read).toMatchObject({ outcome: "transport_lost", ecus: [] });
    expect(read.raw).toEqual(lost.raw);
  });

  it("a result for a different command is never read as this command's answer", () => {
    const read = readDtcs(reply("07", ["7E8 04 47 01 01 33"]), "can11", "03");
    expect(read).toMatchObject({ outcome: "unexpected_reply", ecus: [], command: "03" });
  });
});

describe("DTC decoding and merging (rows 18, 19, 21)", () => {
  it("decodes the system letter and first digit from the top four bits", () => {
    expect(decodeDtc(0x01, 0x33)).toBe("P0133");
    expect(decodeDtc(0x41, 0x23)).toBe("C0123");
    expect(decodeDtc(0x81, 0x00)).toBe("B0100");
    expect(decodeDtc(0xc1, 0x55)).toBe("U0155");
    expect(decodeDtc(0xf2, 0xab)).toBe("U32AB");
    expect(decodeDtc(0x10, 0x01)).toBe("P1001");
  });

  it("keeps stored, pending and permanent distinct and per module", () => {
    const stored = readDtcs(reply("03", ["7E8 04 43 01 01 33", "7E9 04 43 01 01 33"]), "can11", "03");
    const pending = readDtcs(reply("07", ["7E8 06 47 02 01 33 03 00"]), "can11", "07");
    const permanent = readDtcs(failed("0A", "no_response", "NO DATA"), "can11", "0A");
    const discovered = [
      { responseId: "7E8", module: "obd-can11-7e8" },
      { responseId: "7E9", module: "obd-can11-7e9" },
      { responseId: "7EA", module: "obd-can11-7ea" },
    ];
    expect(mergeDtcReads({ "03": stored, "07": pending, "0A": permanent }, discovered)).toEqual([
      {
        responseId: "7E8",
        module: "obd-can11-7e8",
        outcomes: { "03": "ok", "07": "ok", "0A": "no_response" },
        // Row 19: one entry with both kinds.
        codes: [
          { code: "P0133", kinds: ["stored", "pending"] },
          { code: "P0300", kinds: ["pending"] },
        ],
      },
      // Row 18: the same code from another ECU is a separate entry; row 21: no answer to 07 is no_response.
      { responseId: "7E9", module: "obd-can11-7e9", outcomes: { "03": "ok", "07": "no_response", "0A": "no_response" }, codes: [{ code: "P0133", kinds: ["stored"] }] },
      { responseId: "7EA", module: "obd-can11-7ea", outcomes: { "03": "no_response", "07": "no_response", "0A": "no_response" }, codes: [] },
    ]);
  });

  it("codes from a malformed or negative answer are never merged; unread services stay not_read", () => {
    const stored = readDtcs(reply("03", ["7E8 04 43 02 01 33", "7E9 03 7F 03 22"]), "can11", "03");
    expect(mergeDtcReads({ "03": stored })).toEqual([
      { responseId: "7E8", module: "obd-can11-7e8", outcomes: { "03": "malformed", "07": "not_read", "0A": "not_read" }, codes: [] },
      { responseId: "7E9", module: "obd-can11-7e9", outcomes: { "03": "negative_response", "07": "not_read", "0A": "not_read" }, codes: [] },
    ]);
  });
});

describe("supported-PID bitmaps (rows 16, 22, 23)", () => {
  const two = reply("0100", ["7E8 06 41 00 BE 3F A8 13", "7E9 06 41 00 98 18 80 00"]);

  it("row 16: two ECUs answering 0100 get separate bitmaps", () => {
    const read = readCurrentDataSupport(two, "can11", 0x00);
    const e8 = okValue(read, "7E8");
    expect(e8.supported).toEqual([0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x15, 0x1c, 0x1f, 0x20]);
    expect(e8.nextRange).toBe(true);
    const e9 = okValue(read, "7E9");
    expect(e9).toMatchObject({ supported: [0x01, 0x04, 0x05, 0x0c, 0x0d, 0x11], nextRange: false, raw: [0x98, 0x18, 0x80, 0x00] });
    expect(pidSupport(bitmapSet([e9]), 0x42)).toBe("unsupported"); // the chain ended at 00
    expect(bitmapChain(bitmapSet([e9]))).toEqual({ next: null, supportKnownUpTo: 0xff });
  });

  it("row 22: a PID missing from the bitmap is refused before sending", () => {
    const bitmaps = bitmapSet([okValue(readCurrentDataSupport(two, "can11", 0x00), "7E9")]);
    expect(planPidRequest("01", 0x0b, bitmaps)).toEqual({ status: "unsupported" });
    expect(planPidRequest("01", 0x0c, bitmaps)).toEqual({ status: "request", request: { service: "01", pid: 0x0c }, command: "010C" });
  });

  it("row 23: ranges after a chain that stopped answering are support_unknown", () => {
    const bitmaps = bitmapSet([okValue(readCurrentDataSupport(two, "can11", 0x00), "7E8")]);
    expect(bitmapChain(bitmaps)).toEqual({ next: 0x20, supportKnownUpTo: 0x00 });
    expect(pidSupport(bitmaps, 0x42)).toBe("support_unknown");
    expect(planPidRequest("01", 0x42, bitmaps)).toEqual({ status: "support_unknown" });
    expect(pidSupport(bitmapSet([]), 0x0c)).toBe("support_unknown");
    expect(bitmapChain(bitmapSet([]))).toEqual({ next: 0x00, supportKnownUpTo: null });
  });

  it("follows the chain into a later range", () => {
    const later = okValue(readCurrentDataSupport(reply("0120", ["7E8 06 41 20 80 01 A0 01"]), "can11", 0x20), "7E8");
    const bitmaps = bitmapSet([okValue(readCurrentDataSupport(two, "can11", 0x00), "7E8"), later]);
    expect(later.supported).toEqual([0x21, 0x30, 0x31, 0x33, 0x40]);
    expect(pidSupport(bitmaps, 0x21)).toBe("supported");
    expect(pidSupport(bitmaps, 0x22)).toBe("unsupported");
    expect(bitmapChain(bitmaps)).toEqual({ next: 0x40, supportKnownUpTo: 0x20 });
  });

  it("a bitmap of the wrong length is malformed; $09 infotype support decodes", () => {
    expect(malformedReason(readCurrentDataSupport(reply("0100", ["7E8 05 41 00 BE 3F A8"]), "can11", 0x00), "7E8")).toMatch(/3 bitmap bytes/);
    expect(okValue(readInfoTypeSupport(reply("0900", ["7E8 06 49 00 54 40 00 00"]), "can11"), "7E8").supported).toEqual([0x02, 0x04, 0x06, 0x0a]);
    expect(() => readCurrentDataSupport(two, "can11", 0x10)).toThrow(RangeError);
  });
});

describe("PID table values", () => {
  const value = (pid: number, data: string, command = `01${pid.toString(16).toUpperCase().padStart(2, "0")}`) => {
    const bytes = data.split(" ");
    const line = `7E8 ${(2 + bytes.length).toString(16).toUpperCase().padStart(2, "0")} 41 ${command.slice(2)} ${data}`;
    return okValue(readCurrentPid(reply(command, [line]), "can11", pid), "7E8");
  };

  it.each([
    [0x04, "FF", 100, "%"],
    [0x05, "7B", 83, "degC"],
    [0x06, "80", 0, "%"],
    [0x07, "00", -100, "%"],
    [0x0b, "65", 101, "kPa"],
    [0x0c, "1A F8", 1726, "rpm"],
    [0x0d, "3C", 60, "km/h"],
    [0x0e, "80", 0, "deg_before_tdc"],
    [0x0f, "28", 0, "degC"],
    [0x10, "01 F4", 5, "g/s"],
    [0x11, "00", 0, "%"],
    [0x1f, "01 00", 256, "s"],
    [0x42, "30 D4", 12.5, "V"],
  ])("PID %i decodes %s to %d %s, keeping the raw bytes", (pid, data, expected, unit) => {
    const reading = value(pid, data);
    expect(reading).toMatchObject({ source: "current_data", status: "decoded", pid, value: expected, unit, undecoded: [] });
    if (reading.status === "decoded") expect(reading.data).toEqual(data.split(" ").map((byte) => parseInt(byte, 16)));
  });

  it("every table row is pending a primary-source check", () => {
    expect(PID_TABLE_REVIEW.primarySourceCheck).toBe("pending");
    expect(READINESS_TABLE_REVIEW.primarySourceCheck).toBe("pending");
    expect(new Set(PID_TABLE.map((row) => row.pid)).size).toBe(PID_TABLE.length);
  });

  it("the longer fuel-trim form decodes A and keeps B raw", () => {
    expect(value(0x06, "80 90")).toMatchObject({ value: 0, undecoded: [0x90] });
  });

  it("a wrong length is malformed; a PID outside the table is not decoded", () => {
    expect(malformedReason(readCurrentPid(reply("010C", ["7E8 03 41 0C 1A"]), "can11", 0x0c), "7E8")).toMatch(/1 data bytes where 2/);
    expect(value(0x33, "65")).toEqual({ source: "current_data", status: "not_decoded", pid: 0x33, reason: "PID is not in the reviewed table", data: [0x65] });
    expect(decodePidData(0x05, [])).toMatchObject({ ok: false });
    expect(() => readCurrentPid(reply("0101", []), "can11", 0x01)).toThrow(RangeError);
  });

  it("two ECUs answering one PID keep both values, attributed", () => {
    const read = readCurrentPid(reply("0105", ["7E8 03 41 05 7B", "7E9 03 41 05 7C"]), "can11", 0x05);
    expect(read.ecus.map((answer) => [answer.module, answer.outcome === "ok" && answer.value.status === "decoded" ? answer.value.value : null])).toEqual([
      ["obd-can11-7e8", 83],
      ["obd-can11-7e9", 84],
    ]);
  });
});

describe("freeze frame 0 (rows 24, 45-48)", () => {
  it("row 46: a negative response keeps its code; the other ECU's bitmap is read", () => {
    const read = readFreezeFrameSupport(reply("020000", ["7E8 07 42 00 00 78 18 00 00", "7E9 03 7F 02 12"]), "can11", 0x00);
    expect(okValue(read, "7E8").supported).toEqual([0x02, 0x03, 0x04, 0x05, 0x0c, 0x0d]);
    expect(ecu(read, "7E9")).toMatchObject({ outcome: "negative_response", code: 0x12 });
  });

  it("rows 24 and 45: no answer to 020000 leaves $02 support unknown, not unsupported", () => {
    expect(readFreezeFrameSupport(failed("020000", "no_response", "NO DATA"), "can11", 0x00)).toMatchObject({ outcome: "no_response", ecus: [] });
    // $01 support is never used for $02: the ECU's $02 bitmaps are empty.
    expect(planPidRequest("02", 0x0c, bitmapSet([]))).toEqual({ status: "support_unknown" });
  });

  it("row 47: a PID clear in the $02 bitmap is unsupported for the freeze frame only", () => {
    const current = bitmapSet([okValue(readCurrentDataSupport(reply("0100", ["7E8 06 41 00 98 18 80 00"]), "can11", 0x00), "7E8")]);
    const frozen = bitmapSet([okValue(readFreezeFrameSupport(reply("020000", ["7E8 07 42 00 00 78 18 00 00"]), "can11", 0x00), "7E8")]);
    expect(planPidRequest("01", 0x11, current).status).toBe("request");
    expect(planPidRequest("02", 0x11, frozen)).toEqual({ status: "unsupported" });
    expect(planPidRequest("02", 0x0c, frozen)).toMatchObject({ status: "request", command: "020C00" });
  });

  it("row 48: 0000 means no stored freeze frame; a code is decoded", () => {
    const read = readFreezeFrameDtc(reply("020200", ["7E8 05 42 02 00 00 00", "7E9 05 42 02 00 01 33"]), "can11");
    expect(okValue(read, "7E8")).toEqual({ status: "none_stored", raw: [0, 0] });
    expect(okValue(read, "7E9")).toEqual({ status: "stored", code: "P0133", raw: [0x01, 0x33] });
  });

  it("freeze-frame values are their own type and echo the frame number", () => {
    const read = readFreezeFramePid(reply("020500", ["7E8 04 42 05 00 7B AA AA AA"]), "can11", 0x05);
    expect(okValue(read, "7E8")).toMatchObject({ source: "freeze_frame", frame: 0, status: "decoded", value: 83, unit: "degC" });
    expect(() => readFreezeFramePid(reply("020200", []), "can11", 0x02)).toThrow(RangeError);
  });
});

describe("readiness (rows 49-52)", () => {
  it("decodes MIL, count and spark monitors", () => {
    const read = readReadiness(reply("0101", ["7E8 06 41 01 81 07 65 04"]), "can11");
    const readiness = okValue(read, "7E8");
    expect(readiness).toMatchObject({ milOn: true, dtcCount: 1, ignition: "spark", reservedBitsSet: [], raw: [0x81, 0x07, 0x65, 0x04] });
    const statuses = Object.fromEntries(readiness.monitors.map((monitor) => [monitor.id, monitor.status]));
    expect(statuses).toEqual({
      misfire: "complete",
      fuel_system: "complete",
      comprehensive_components: "complete",
      catalyst: "complete",
      heated_catalyst: "not_available",
      evaporative_system: "incomplete",
      secondary_air_system: "not_available",
      spark_monitor_bit4: "not_available",
      oxygen_sensor: "complete",
      oxygen_sensor_heater: "complete",
      egr_vvt_system: "not_available",
    });
  });

  it("row 49: an incomplete bit without the available bit is not_available, never complete", () => {
    const readiness = decodeReadiness([0x00, 0x70, 0x00, 0xff]);
    expect(readiness.monitors.every((monitor) => monitor.status === "not_available")).toBe(true);
    expect(readiness.reservedBitsSet).toEqual([]);
  });

  it("row 50: compression ignition reads C / D with its own list; reserved bits kept, not interpreted", () => {
    const readiness = decodeReadiness([0x00, 0x8f, 0x45, 0x50]);
    expect(readiness.ignition).toBe("compression");
    const statuses = Object.fromEntries(readiness.monitors.filter((monitor) => monitor.group === "engine_specific").map((monitor) => [monitor.id, monitor.status]));
    expect(statuses).toEqual({
      nmhc_catalyst: "complete",
      nox_scr_monitor: "not_available",
      boost_pressure: "not_available",
      exhaust_gas_sensor: "not_available",
      pm_filter: "incomplete",
      egr_vvt_system: "not_available",
    });
    expect(readiness.reservedBitsSet).toEqual(["B7", "C2", "D4"]);
  });

  it("row 51: a count differing from the $03 list is recorded with both values", () => {
    const readiness = readReadiness(reply("0101", ["7E8 06 41 01 82 07 65 04", "7E9 06 41 01 01 00 00 00", "7EA 03 7F 01 12"]), "can11");
    const stored = readDtcs(reply("03", ["7E8 04 43 01 01 33", "7E9 04 43 01 01 33"]), "can11", "03");
    expect(compareDtcCounts(readiness, stored)).toEqual([
      { responseId: "7E8", module: "obd-can11-7e8", status: "dtc_count_mismatch", readinessCount: 2, storedCount: 1 },
      { responseId: "7E9", module: "obd-can11-7e9", status: "consistent", count: 1 },
      { responseId: "7EA", module: "obd-can11-7ea", status: "not_comparable" },
    ]);
    expect(compareDtcCounts(readiness, readDtcs(failed("03", "no_response", "NO DATA"), "can11", "03")).every((check) => check.status === "not_comparable")).toBe(true);
  });

  it("row 52: PID 01 missing from the bitmap means 0101 is not requested", () => {
    const bitmaps = bitmapSet([okValue(readCurrentDataSupport(reply("0100", ["7E8 06 41 00 7E 3F A8 12"]), "can11", 0x00), "7E8")]);
    expect(planPidRequest("01", 0x01, bitmaps)).toEqual({ status: "unsupported" });
  });

  it("a wrong-length readiness answer is malformed", () => {
    expect(malformedReason(readReadiness(reply("0101", ["7E8 05 41 01 81 07 65"]), "can11"), "7E8")).toMatch(/3 data bytes/);
  });
});

describe("VIN", () => {
  it.each([
    ["a wrong item count", "02", /number of data items is 2/],
    ["a non-printable byte", "01", /not printable/],
  ])("%s is malformed", (_name, count, reason) => {
    const lines = [`7E8 10 14 49 02 ${count} 31 44 34`, VIN_7E8[1], count === "01" ? "7E8 22 42 31 32 33 34 35 00" : VIN_7E8[2]];
    expect(malformedReason(readVin(reply("0902", lines), "can11"), "7E8")).toMatch(reason);
  });

  it("a VIN outside the ISO 3779 alphabet is kept as reported but marked nonstandard", () => {
    const lines = [VIN_7E8[0], VIN_7E8[1], "7E8 22 42 31 32 33 34 35 4F"];
    expect(okValue(readVin(reply("0902", lines), "can11"), "7E8")).toMatchObject({ text: "1D4GP00R55B12345O", charset: "nonstandard" });
  });

  it("no ECU answering gives no VIN, not an empty one", () => {
    expect(compareVins(readVin(failed("0902", "no_response", "NO DATA"), "can11"))).toEqual({ status: "none" });
  });
});

describe("through the ELM executor (scripted adapter)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("multi-ECU padded replies pass the elm classifier and decode per module", async () => {
    const transport = new SimulatedTransport();
    const adapter = new ScriptedElmAdapter({
      replies: { "03": { lines: [THREE_CODES_7E9[0], "7E8 02 43 00 AA AA AA AA AA", THREE_CODES_7E9[1]], chunkSize: 5 } },
    });
    transport.attach(adapter);
    await transport.open();
    const executor = new ElmCommandExecutor(transport);
    const init = initialiseAdapter(executor);
    await vi.runAllTimersAsync();
    expect((await init).ok).toBe(true);

    const pending = executor.run("03");
    await vi.runAllTimersAsync();
    const read = readDtcs(await pending, "can11", "03");
    expect(read.outcome).toBe("ok");
    expect(okValue(read, "7E8").codes).toEqual([]);
    expect(okValue(read, "7E9").codes).toEqual(["P0133", "P0244", "P0355"]);
    expect(read.raw.received).toContain("7E9 21 03 55 AA AA AA AA AA");
  });
});
