/**
 * Scanner foundation (S7): the scanner controller over the elm and OBD layers.
 * Discovery, one-shot scan, live polling, cancellation and recovery.
 *
 * Design: docs/research/scanner-engine/module-discovery.md, scan-flow.md and
 * live-data.md. Rows covered at scan level: 6, 7, 8, 12, 16, 18-23, 31, 32,
 * 45-48, 51-57.
 *
 * Every adapter and vehicle here is SCRIPTED. Passing shows the controller
 * behaves as designed against scripted replies, not that any real adapter or
 * vehicle answers this way.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PID_TABLE_REVIEW } from "../app/lib/vehicle-communication/obd/pids";
import { READINESS_TABLE_REVIEW } from "../app/lib/vehicle-communication/obd/readiness";
import { ScannerController, type ScannerOptions, type ScannerProgress, type ScannerRefusal } from "../app/lib/vehicle-communication/scanner/controller";
import type { DiscoveryReport, LiveReport, ScanReport, Unverified } from "../app/lib/vehicle-communication/scanner/report";
import { ScriptedElmAdapter, SimulatedTransport, type ScriptedReply } from "../app/lib/vehicle-communication/transport/simulated";

type Replies = Record<string, ScriptedReply | ScriptedReply[]>;

const line = (...lines: string[]): ScriptedReply => ({ lines });

/**
 * One CAN 11-bit ECU (7E8). $01 bitmap: PIDs 01 04 05 0C 0D 11, next range;
 * 0120: next range; 0140: PID 42. $02 bitmap: 02 04 05 0C 0D. VIN
 * 1HGCM82633A004352 (multi-frame). Readiness: MIL on, one DTC; $03 P0133.
 */
function vehicle(): Replies {
  return {
    "0100": line("7E8 06 41 00 98 18 80 01"),
    "0120": line("7E8 06 41 20 00 00 00 01"),
    "0140": line("7E8 06 41 40 40 00 00 00"),
    "0900": line("7E8 06 49 00 40 00 00 00"),
    "0902": line("7E8 10 14 49 02 01 31 48 47", "7E8 21 43 4D 38 32 36 33 33", "7E8 22 41 30 30 34 33 35 32"),
    "0101": line("7E8 06 41 01 81 07 65 04"),
    "03": line("7E8 04 43 01 01 33"),
    "07": line("7E8 02 47 00"),
    "0A": line("7E8 02 4A 00"),
    "020000": line("7E8 07 42 00 00 58 18 00 00"),
    "020200": line("7E8 05 42 02 00 01 33"),
    "020400": line("7E8 04 42 04 00 80"),
    "020500": line("7E8 04 42 05 00 7B"),
    "020C00": line("7E8 05 42 0C 00 1A F8"),
    "020D00": line("7E8 04 42 0D 00 32"),
    "010C": line("7E8 04 41 0C 0B B8"),
    "010D": line("7E8 03 41 0D 00"),
    "0105": line("7E8 03 41 05 5A"),
    "0104": line("7E8 03 41 04 33"),
    "0111": line("7E8 03 41 11 26"),
    "0142": line("7E8 04 41 42 37 DC"),
  };
}

let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 26) + tick++ * 1000).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  tick = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

function rig(replies: Replies = {}, options: ScannerOptions = {}) {
  const transport = new SimulatedTransport();
  const adapter = new ScriptedElmAdapter({ replies: { ...vehicle(), ...replies } });
  transport.attach(adapter);
  const scanner = new ScannerController(transport, { now, ...options });
  const progress: ScannerProgress[] = [];
  scanner.onProgress((event) => progress.push(event));
  return { transport, adapter, scanner, progress };
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

function ok<T extends { kind: string }>(result: T | ScannerRefusal): T {
  if ("status" in result && result.status === "refused") throw new Error(`refused: ${result.reason} ${result.detail}`);
  return result as T;
}

async function connected(replies: Replies = {}, options: ScannerOptions = {}) {
  const parts = rig(replies, options);
  const discovery = ok<DiscoveryReport>(await settle(parts.scanner.connect()));
  return { ...parts, discovery };
}

/** OBD requests the adapter received (AT commands, probes and bare CRs left out). */
const obdSent = (adapter: ScriptedElmAdapter) => adapter.received.filter((command) => /^[0-9A-F]{2,6}$/.test(command));

const expectPending = (wrapped: Unverified<unknown> | undefined) =>
  expect(wrapped?.verification).toEqual({
    status: "unverified",
    primarySourceCheck: "pending",
    diagnosticUse: "display_only",
    standard: expect.any(String),
    secondaryCrossCheck: expect.any(String),
  });

describe("discovery", () => {
  it("identifies the adapter and protocol, follows the bitmap chain and reads the VIN", async () => {
    const { scanner, adapter, discovery, progress } = await connected();
    expect(scanner.state).toBe("ready");
    expect(discovery.result).toEqual({ status: "vehicle_found" });
    expect(discovery.adapter).toEqual({ identity: ["ELM327 v1.5"], ati: { outcome: "ok", lines: ["ELM327 v1.5"] }, description: { outcome: "ok", lines: ["SIMULATED ADAPTER"] } });
    expect(discovery.protocol).toEqual({ supported: true, number: "6", auto: true, family: "can11" });
    expect(discovery.ecus).toHaveLength(1);
    const ecu = discovery.ecus[0];
    expect(ecu.module).toBe("obd-can11-7e8");
    expect(ecu.currentData.supportedPids).toEqual([0x01, 0x04, 0x05, 0x0c, 0x0d, 0x11, 0x20, 0x40, 0x42]);
    expect(ecu.currentData.supportKnownUpTo).toBe(0xff);
    expect(ecu.vin).toMatchObject({ outcome: "ok", value: { text: "1HGCM82633A004352", charset: "iso3779" } });
    expect(ecu.vin.rawLines).toHaveLength(3);
    expect(discovery.vinComparison).toEqual({ status: "consistent", text: "1HGCM82633A004352", modules: ["obd-can11-7e8"] });
    expect(adapter.received.slice(0, 11)).toEqual(["ATZ", "ATE0", "ATL0", "ATS1", "ATH1", "ATSP0", "ATI", "AT@1", "0100", "ATDPN", "0120"]);
    // Steps: sequential numbers, timestamps, raw text and per-ECU attribution.
    expect(discovery.steps.map((step) => step.seq)).toEqual(discovery.steps.map((_, index) => index + 1));
    const first = discovery.steps.find((step) => step.command === "0100");
    expect(first?.startedAt).toMatch(/^2026-10-26T/);
    expect(first?.raw.received).toContain("7E8 06 41 00 98 18 80 01");
    expect(first?.perEcu).toEqual([expect.objectContaining({ responseId: "7E8", module: "obd-can11-7e8", outcome: "ok", payloads: [[0x41, 0x00, 0x98, 0x18, 0x80, 0x01]] })]);
    // Observable progress.
    expect(progress.filter((event) => event.type === "state").map((event) => (event as { state: string }).state)).toEqual(["connecting", "initialising", "discovering", "ready"]);
    expect(progress.filter((event) => event.type === "phase").map((event) => (event as { phase: string }).phase)).toEqual([
      "open",
      "initialise",
      "identify",
      "protocol",
      "current_data_support",
      "vin",
    ]);
    expect(Object.isFrozen(discovery.ecus[0].currentData)).toBe(true);
    expect(scanner.log).toHaveLength(discovery.steps.length);
  });

  it("row 6: an adapter that rejects ATH1 fails initialisation, sends no OBD request and fails closed", async () => {
    const { scanner, adapter, transport } = rig({ ATH1: line("?") });
    const discovery = ok<DiscoveryReport>(await settle(scanner.connect()));
    expect(discovery.result).toMatchObject({ status: "no_vehicle", reason: "adapter_initialisation_failed", outcome: "adapter_rejected_command" });
    expect(obdSent(adapter)).toEqual([]);
    expect(scanner.state).toBe("failed");
    expect(transport.state).toBe("closed");
    expect(await scanner.scan()).toMatchObject({ status: "refused", reason: "session_unavailable" });
  });

  it("row 8: UNABLE TO CONNECT stops discovery; nothing is concluded about the vehicle", async () => {
    const { scanner, adapter } = rig({ "0100": line("UNABLE TO CONNECT") });
    const discovery = ok<DiscoveryReport>(await settle(scanner.connect()));
    expect(discovery.result).toMatchObject({ status: "no_vehicle", reason: "no_vehicle_protocol", outcome: "no_vehicle_protocol" });
    expect(obdSent(adapter)).toEqual(["0100"]);
    expect(scanner.state).toBe("ready");
    expect(await scanner.scan()).toMatchObject({ status: "refused", reason: "no_vehicle" });
  });

  it("row 12: a non-CAN protocol is unsupported_protocol and no further OBD request is sent", async () => {
    const { scanner, adapter } = rig({ ATDPN: line("A3") });
    const discovery = ok<DiscoveryReport>(await settle(scanner.connect()));
    expect(discovery.result).toMatchObject({ status: "no_vehicle", reason: "unsupported_protocol" });
    expect(discovery.protocol).toEqual({ supported: false, number: "3", auto: true, reason: "unsupported_protocol" });
    expect(discovery.ecus).toEqual([]);
    expect(obdSent(adapter)).toEqual(["0100"]);
  });

  it("a protocol number the adapter cannot give stops discovery (fail closed)", async () => {
    const { scanner, adapter } = rig({ ATDPN: line("?") });
    const discovery = ok<DiscoveryReport>(await settle(scanner.connect()));
    expect(discovery.result).toMatchObject({ status: "no_vehicle", reason: "protocol_unknown" });
    expect(obdSent(adapter)).toEqual(["0100"]);
  });

  it("rows 16, 23: two ECUs keep separate bitmaps; a chain that stops answering leaves later ranges unknown", async () => {
    const { discovery } = await connected({
      "0100": line("7E8 06 41 00 98 18 80 01", "7E9 06 41 00 80 00 00 00", "7EA 03 41 00 80"),
      "0120": line("NO DATA"),
    });
    expect(discovery.ecus.map((ecu) => ecu.module)).toEqual(["obd-can11-7e8", "obd-can11-7e9"]);
    const [e8, e9] = discovery.ecus;
    expect(e8.currentData).toMatchObject({ supportKnownUpTo: 0x00, problems: [{ command: "0120", outcome: "no_response" }] });
    expect(e9.currentData).toMatchObject({ supportedPids: [0x01], supportKnownUpTo: 0xff, problems: [] });
    // A malformed 0100 answer is kept with its identifier but is not a discovered ECU.
    expect(discovery.rejectedAnswers).toEqual([expect.objectContaining({ responseId: "7EA", outcome: "malformed" })]);
    // 7E9 did not answer 0900: its VIN support is unknown, not unsupported.
    expect(e9.vin).toMatchObject({ outcome: "support_unknown" });
  });
});

describe("scan", () => {
  it("reads readiness, DTC statuses, freeze frame 0 and basic current data with provenance", async () => {
    const { scanner, adapter } = await connected();
    const report = ok<ScanReport>(await settle(scanner.scan()));
    expect(report).toMatchObject({ kind: "scan", ended: "finished", completeness: "partial", diagnosticUse: "display_only", scanNumber: 1 });
    expect(report.sections).toEqual({ readiness: "done", dtcs: "done", freeze_frame: "done", current_data: "done" });
    expect(report.readiness[0]).toMatchObject({ module: "obd-can11-7e8", outcome: "ok", rawLines: ["7E8 06 41 01 81 07 65 04"] });
    expect(report.readiness[0].value?.decoded).toMatchObject({ milOn: true, dtcCount: 1, raw: [0x81, 0x07, 0x65, 0x04] });
    expectPending(report.readiness[0].value);
    expect(report.dtcs.ecus).toEqual([
      expect.objectContaining({ module: "obd-can11-7e8", outcomes: { "03": "ok", "07": "ok", "0A": "ok" }, codes: [{ code: "P0133", kinds: ["stored"] }] }),
    ]);
    expect(report.dtcs.servicesOkForEveryEcu).toEqual(["03", "07", "0A"]);
    expect(report.dtcs.countChecks).toEqual([expect.objectContaining({ status: "consistent", count: 1 })]);
    // Freeze frame: stored by P0133; only PIDs in the ECU's own $02 bitmap requested (row 47: 11 is in $01, not $02).
    const ff = report.freezeFrames[0];
    expect(ff.frame).toBe("stored");
    expect(ff.storedDtc.value).toEqual({ status: "stored", code: "P0133", raw: [0x01, 0x33] });
    expect(ff.values.find((value) => value.pid === 0x0c)?.value?.decoded).toMatchObject({ source: "freeze_frame", value: 1726, unit: "rpm", data: [0x1a, 0xf8] });
    expectPending(ff.values.find((value) => value.pid === 0x0c)?.value);
    expect(ff.values.find((value) => value.pid === 0x11)).toMatchObject({ outcome: "unsupported", readAt: null });
    expect(obdSent(adapter)).not.toContain("021100");
    // Each freeze-frame value keeps its own read time: the end of its own 02 request in the step log.
    const readValues = ff.values.filter((value) => value.readAt !== null);
    expect(readValues.map((value) => value.pid)).toEqual([0x04, 0x05, 0x0c, 0x0d]);
    for (const value of readValues) {
      const command = `02${value.pid.toString(16).toUpperCase().padStart(2, "0")}00`;
      expect(value.readAt).toBe(report.steps.find((step) => step.command === command)?.endedAt);
    }
    expect(new Set(readValues.map((value) => value.readAt)).size).toBe(readValues.length);
    // Current data: attributed, timestamped, raw bytes kept, pending verification.
    const rpm = report.currentData.find((reading) => reading.pid === 0x0c);
    expect(rpm).toMatchObject({ module: "obd-can11-7e8", outcome: "ok", rawLines: ["7E8 04 41 0C 0B B8"], payloads: [[0x41, 0x0c, 0x0b, 0xb8]] });
    expect(rpm?.value?.decoded).toMatchObject({ source: "current_data", value: 750, unit: "rpm", data: [0x0b, 0xb8] });
    expect(rpm?.at).toMatch(/^2026-10-26T/);
    expectPending(rpm?.value);
    expect(report.currentData.find((reading) => reading.pid === 0x42)?.value?.decoded).toMatchObject({ value: 14.3, unit: "V" });
    expect(report.capabilities[0]).toMatchObject({ readiness: "supported", vin: "supported", freezeFrame: "bitmap_read", currentDataSupportKnownUpTo: 0xff });
    expect(report.verification).toEqual({ pidTable: PID_TABLE_REVIEW, readinessTable: READINESS_TABLE_REVIEW });
    expect(scanner.state).toBe("ready");
    expect(Object.isFrozen(report.currentData[0])).toBe(true);
  });

  it("rows 18-21, 46, 51: multi-ECU attribution, a failed service per ECU and a declined freeze frame", async () => {
    const { scanner } = await connected({
      "0100": line("7E8 06 41 00 98 18 80 01", "7E9 06 41 00 80 00 00 00"),
      "0101": line("7E8 06 41 01 81 07 65 04", "7E9 06 41 01 00 04 00 00"),
      "03": line("7E8 04 43 01 01 33", "7E9 04 43 01 01 33"),
      "07": line("7E8 04 47 01 01 33"),
      "0A": line("7E8 02 4A 00", "7E9 02 4A 00"),
      "020000": line("7E8 07 42 00 00 58 18 00 00", "7E9 03 7F 02 12"),
    });
    const report = ok<ScanReport>(await settle(scanner.scan()));
    const [e8, e9] = report.dtcs.ecus;
    expect(e8).toMatchObject({ module: "obd-can11-7e8", codes: [{ code: "P0133", kinds: ["stored", "pending"] }] });
    expect(e9).toMatchObject({ module: "obd-can11-7e9", outcomes: { "03": "ok", "07": "no_response", "0A": "ok" }, codes: [{ code: "P0133", kinds: ["stored"] }] });
    expect(report.dtcs.servicesOkForEveryEcu).toEqual(["03", "0A"]);
    expect(report.dtcs.countChecks).toEqual([
      expect.objectContaining({ module: "obd-can11-7e8", status: "consistent" }),
      expect.objectContaining({ module: "obd-can11-7e9", status: "dtc_count_mismatch", readinessCount: 0, storedCount: 1 }),
    ]);
    expect(report.freezeFrames[1]).toMatchObject({ module: "obd-can11-7e9", frame: "unknown", values: [], support: { outcome: "negative_response", code: 0x12 } });
    expect(report.freezeFrames[0].frame).toBe("stored");
    expect(report.capabilities[1]).toMatchObject({ freezeFrame: "declined", vin: "support_unknown" });
    // 7E9 lists no current-data PID beyond 01: nothing is requested for it.
    expect(report.currentData.filter((reading) => reading.module === "obd-can11-7e9").every((reading) => reading.outcome === "unsupported")).toBe(true);
    const step = report.steps.find((candidate) => candidate.command === "03");
    expect(step?.perEcu.map((ecu) => ecu.responseId)).toEqual(["7E8", "7E9"]);
  });

  it("rows 7, 45, 48 and malformed answers: NO DATA is no_response, a malformed ECU answer is isolated, 0000 stops $02", async () => {
    const { scanner, adapter } = await connected({
      "0101": line("7E8 05 41 01 81 07 65"),
      "03": line("NO DATA"),
      "07": line("7E8 02 43 00"),
      "020200": line("7E8 05 42 02 00 00 00"),
    });
    const report = ok<ScanReport>(await settle(scanner.scan()));
    expect(report.ended).toBe("finished");
    expect(report.readiness[0]).toMatchObject({ outcome: "malformed" });
    expect(report.readiness[0].value).toBeUndefined();
    expect(report.dtcs.ecus[0]).toMatchObject({ outcomes: { "03": "no_response", "07": "malformed", "0A": "ok" }, codes: [] });
    expect(report.dtcs.servicesOkForEveryEcu).toEqual(["0A"]);
    expect(report.freezeFrames[0]).toMatchObject({ frame: "none_stored", values: [] });
    expect(obdSent(adapter).filter((command) => command.startsWith("02"))).toEqual(["020000", "020200"]);
  });

  it("row 45: NO DATA to 020000 leaves $02 support unknown for every ECU, never unsupported", async () => {
    const { scanner, adapter } = await connected({ "020000": line("NO DATA") });
    const report = ok<ScanReport>(await settle(scanner.scan()));
    expect(report.freezeFrames[0]).toMatchObject({ frame: "unknown", values: [], support: { outcome: "no_response" } });
    expect(report.capabilities[0].freezeFrame).toBe("support_unknown");
    expect(obdSent(adapter).filter((command) => command.startsWith("02"))).toEqual(["020000"]);
  });

  it("row 22 / 52: PIDs outside an ECU's bitmap are never requested and are shown unsupported or support_unknown", async () => {
    const { scanner, adapter } = await connected({ "0100": line("7E8 06 41 00 18 00 00 00") });
    const report = ok<ScanReport>(await settle(scanner.scan()));
    expect(report.readiness[0]).toMatchObject({ outcome: "unsupported" });
    expect(obdSent(adapter)).not.toContain("0101");
    expect(report.currentData.find((reading) => reading.pid === 0x0c)).toMatchObject({ outcome: "unsupported" });
    expect(report.currentData.find((reading) => reading.pid === 0x05)).toMatchObject({ outcome: "ok" });
    expect(obdSent(adapter)).not.toContain("010C");
  });

  it("only an ECU whose own bitmap lists PID 01 enters the DTC-count check; another ECU's 0101 answer stays in the step log", async () => {
    const { scanner } = await connected({
      // 7E9 lists only PIDs 04 and 05, but answers the functional 0101 sent for 7E8 (claiming 3 codes).
      "0100": line("7E8 06 41 00 98 18 80 01", "7E9 06 41 00 18 00 00 00"),
      "0101": line("7E8 06 41 01 81 07 65 04", "7E9 06 41 01 83 07 65 04"),
      "03": line("7E8 04 43 01 01 33", "7E9 02 43 00"),
    });
    const report = ok<ScanReport>(await settle(scanner.scan()));
    expect(report.dtcs.countChecks).toEqual([{ responseId: "7E8", module: "obd-can11-7e8", status: "consistent", count: 1 }]);
    expect(report.readiness.find((entry) => entry.module === "obd-can11-7e9")).toMatchObject({ outcome: "unsupported" });
    const step = report.steps.find((candidate) => candidate.command === "0101");
    expect(step?.perEcu.map((answer) => answer.responseId)).toEqual(["7E8", "7E9"]);
  });

  it("a 020200 answer from an ECU whose $02 bitmap does not list PID 02 never stops that ECU's own freeze-frame reads", async () => {
    const { scanner, adapter } = await connected({
      "0100": line("7E8 06 41 00 98 18 80 01", "7E9 06 41 00 80 00 00 00"),
      // 7E8 lists 02 04 05 0C 0D; 7E9 lists only 0F, yet answers the functional 020200 with "none stored".
      "020000": line("7E8 07 42 00 00 58 18 00 00", "7E9 07 42 00 00 00 02 00 00"),
      "020200": line("7E8 05 42 02 00 01 33", "7E9 05 42 02 00 00 00"),
      "020F00": line("7E9 04 42 0F 00 50"),
    });
    const report = ok<ScanReport>(await settle(scanner.scan()));
    expect(obdSent(adapter)).toContain("020F00");
    const e9 = report.freezeFrames.find((entry) => entry.module === "obd-can11-7e9");
    expect(e9).toMatchObject({ frame: "unknown", storedDtc: { outcome: "unsupported" } });
    expect(e9?.values.find((value) => value.pid === 0x0f)?.value?.decoded).toMatchObject({ source: "freeze_frame", value: 40, unit: "degC", data: [0x50] });
    expect(report.freezeFrames.find((entry) => entry.module === "obd-can11-7e8")?.frame).toBe("stored");
    // The ignored answer is still in the step log.
    expect(report.steps.find((candidate) => candidate.command === "020200")?.perEcu.map((answer) => answer.responseId)).toEqual(["7E8", "7E9"]);
  });
});

/** The latest record published for each step: a `step_updated` replaces the `step` with the same `seq`. */
function publishedSteps(progress: ScannerProgress[]) {
  const steps = new Map<number, unknown>();
  for (const event of progress) if (event.type === "step" || event.type === "step_updated") steps.set(event.step.seq, event.step);
  return [...steps.values()];
}

describe("the first 0100 record", () => {
  it("is finalised once the protocol is known: progress and report agree, per-ECU attribution included", async () => {
    const { discovery, progress } = await connected();
    expect(publishedSteps(progress)).toEqual(discovery.steps);
    const updates = progress.filter((event) => event.type === "step_updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ step: { command: "0100", outcome: "ok", perEcu: [expect.objectContaining({ responseId: "7E8", outcome: "ok" })] } });
  });

  it("a headerless 0100 answer cannot be attributed: the record is not left ok, and discovery finds no vehicle", async () => {
    const { discovery, progress, adapter } = await connected({ "0100": line("41 00 98 18 80 01") });
    expect(discovery.result).toMatchObject({ status: "no_vehicle", reason: "no_valid_answer", outcome: "unexpected_reply" });
    const first = discovery.steps.find((step) => step.command === "0100");
    expect(first).toMatchObject({ outcome: "unexpected_reply", perEcu: [] });
    expect(first?.detail).toEqual(expect.any(String));
    expect(first?.raw.received).toContain("41 00 98 18 80 01");
    expect(publishedSteps(progress)).toEqual(discovery.steps);
    expect(obdSent(adapter)).toEqual(["0100"]);
  });

  it("an unknown protocol leaves the record unread per ECU, and says so", async () => {
    const { discovery, progress } = await connected({ ATDPN: line("?") });
    expect(discovery.steps.find((step) => step.command === "0100")).toMatchObject({ outcome: "ok", perEcu: [], detail: "not read per ECU: the protocol is unknown" });
    expect(publishedSteps(progress)).toEqual(discovery.steps);
  });
});

describe("fuel trims in the basic scan", () => {
  it("reads each trim only from ECUs whose own bitmap lists it; the rest are unsupported or support_unknown", async () => {
    const { scanner, adapter } = await connected({
      // 7E8: 01 04 05 06 07 08 09 0C 0D 11, next range. 7E9: 01 04 05 06 only.
      "0100": line("7E8 06 41 00 9F 98 80 01", "7E9 06 41 00 9C 00 00 00"),
      "0106": line("7E8 03 41 06 80", "7E9 03 41 06 84"),
      "0107": line("7E8 03 41 07 78"),
      "0108": line("7E8 03 41 08 80"),
      "0109": line("NO DATA"),
    });
    const report = ok<ScanReport>(await settle(scanner.scan()));
    expect(report.ended).toBe("finished");
    const sent = obdSent(adapter);
    for (const command of ["0106", "0107", "0108", "0109"]) expect(sent.filter((c) => c === command)).toHaveLength(1);
    const reading = (module: string, pid: number) => report.currentData.find((r) => r.module === module && r.pid === pid);
    expect(reading("obd-can11-7e8", 0x06)?.value?.decoded).toMatchObject({ source: "current_data", value: 0, unit: "%" });
    expect(reading("obd-can11-7e9", 0x06)?.value?.decoded).toMatchObject({ value: 3.125, unit: "%" });
    expect(reading("obd-can11-7e8", 0x07)?.value?.decoded).toMatchObject({ value: -6.25 });
    expect(reading("obd-can11-7e8", 0x07)?.rawLines).toEqual(["7E8 03 41 07 78"]);
    for (const pid of [0x06, 0x07, 0x08]) expectPending(reading("obd-can11-7e8", pid)?.value);
    // Supported but no answer: no value, never a zero.
    expect(reading("obd-can11-7e8", 0x09)).toMatchObject({ outcome: "no_response" });
    expect(reading("obd-can11-7e8", 0x09)?.value).toBeUndefined();
    // Not in 7E9's bitmap: never requested for it.
    for (const pid of [0x07, 0x08, 0x09]) expect(reading("obd-can11-7e9", pid)).toMatchObject({ outcome: "unsupported", rawLines: [] });
  });

  it("an ECU listing no trims gets none requested; a range that was never read leaves its PIDs support_unknown", async () => {
    const { scanner, adapter } = await connected({ "0120": line("NO DATA") });
    const report = ok<ScanReport>(await settle(scanner.scan()));
    for (const pid of [0x06, 0x07, 0x08, 0x09]) {
      expect(report.currentData.find((r) => r.pid === pid)).toMatchObject({ outcome: "unsupported" });
      expect(obdSent(adapter)).not.toContain(`010${pid}`);
    }
    // 0x42 lies past the unread 0120 range.
    expect(report.currentData.find((r) => r.pid === 0x42)).toMatchObject({ outcome: "support_unknown" });
    expect(obdSent(adapter)).not.toContain("0142");
  });
});

describe("refusals and lifecycle races", () => {
  it("row 32 / 57: a second scan or live polling while scanning is refused busy; the first is unaffected", async () => {
    const { scanner } = await connected();
    const first = scanner.scan();
    expect(await scanner.scan()).toMatchObject({ status: "refused", reason: "busy" });
    expect(await scanner.startLivePolling({ selection: [{ module: "obd-can11-7e8", pid: 0x0c }], cycles: 1 })).toMatchObject({ status: "refused", reason: "busy" });
    expect(await scanner.connect()).toMatchObject({ status: "refused", reason: "busy" });
    expect(ok<ScanReport>(await settle(first)).ended).toBe("finished");
  });

  it("connect while connected is refused; cancel with nothing running is a no-op", async () => {
    const { scanner } = await connected();
    expect(await scanner.connect()).toMatchObject({ status: "refused", reason: "not_ready" });
    scanner.cancel();
    expect(scanner.state).toBe("ready");
  });
});

describe("cancellation", () => {
  it("row 28: cancel mid-command keeps completed sections, yields no data from the interrupted command, and the session goes on", async () => {
    const { scanner, adapter } = await connected({ "03": { lines: ["7E8 04 43 01 01 33"], delayMs: 1000 } });
    const pending = scanner.scan();
    await vi.advanceTimersByTimeAsync(500);
    expect(scanner.status).toMatchObject({ state: "scanning", activity: "scan", phase: "dtcs" });
    scanner.cancel();
    scanner.cancel(); // twice: no-op
    const report = ok<ScanReport>(await settle(pending));
    expect(report.ended).toBe("cancelled");
    expect(report.sections).toEqual({ readiness: "done", dtcs: "interrupted", freeze_frame: "not_run", current_data: "not_run" });
    expect(report.readiness[0].outcome).toBe("ok");
    expect(report.dtcs.ecus[0]).toMatchObject({ outcomes: { "03": "interrupted", "07": "not_read", "0A": "not_read" }, codes: [] });
    expect(report.steps.find((step) => step.command === "03")).toMatchObject({ outcome: "interrupted", perEcu: [] });
    expect(adapter.interrupts).toBe(1);
    expect(scanner.state).toBe("ready");
    expect(ok<ScanReport>(await settle(scanner.scan())).ended).toBe("finished");
  });

  it("a scan cancelled during freeze frame keeps the values already read with their own read times; the interrupted one holds no data", async () => {
    const { scanner } = await connected({ "020C00": { lines: ["7E8 05 42 0C 00 1A F8"], delayMs: 1000 } });
    const pending = scanner.scan();
    await vi.advanceTimersByTimeAsync(500);
    expect(scanner.status).toMatchObject({ phase: "freeze_frame" });
    scanner.cancel();
    const report = ok<ScanReport>(await settle(pending));
    expect(report.sections.freeze_frame).toBe("interrupted");
    const values = report.freezeFrames[0].values;
    for (const pid of [0x04, 0x05]) {
      const value = values.find((candidate) => candidate.pid === pid);
      expect(value).toMatchObject({ outcome: "ok" });
      expect(value?.readAt).toBe(report.steps.find((step) => step.command === `02${pid.toString(16).padStart(2, "0")}00`)?.endedAt);
    }
    expect(values.find((value) => value.pid === 0x05)?.readAt).not.toBe(values.find((value) => value.pid === 0x04)?.readAt);
    const rpm = values.find((value) => value.pid === 0x0c);
    expect(rpm).toMatchObject({ outcome: "interrupted" });
    expect(rpm?.value).toBeUndefined();
    expect(rpm?.readAt).toBe(report.steps.find((step) => step.command === "020C00")?.endedAt);
    expect(values.find((value) => value.pid === 0x0d)).toMatchObject({ readAt: null });
  });

  it("row 31: a disconnect during 07 ends the scan transport_lost, keeps the 03 results and fails the session", async () => {
    const { scanner, transport } = await connected({ "07": { lines: ["7E8 02 47 00"], delayMs: 1000 } });
    const pending = scanner.scan();
    await vi.advanceTimersByTimeAsync(500);
    transport.disconnect();
    const report = ok<ScanReport>(await settle(pending));
    expect(report.ended).toBe("transport_lost");
    expect(report.dtcs.ecus[0]).toMatchObject({ outcomes: { "03": "ok", "07": "transport_lost", "0A": "not_read" }, codes: [{ code: "P0133", kinds: ["stored"] }] });
    expect(scanner.state).toBe("failed");
    expect(await scanner.scan()).toMatchObject({ status: "refused", reason: "session_unavailable" });
    expect(await scanner.recover()).toMatchObject({ status: "refused", reason: "session_unavailable" });
  });
});

describe("bitmap chains stopped part-way", () => {
  const stops = [
    ["cancel", "cancelled", "interrupted"],
    ["disconnect", "transport_lost", "transport_lost"],
  ] as const;

  it.each(stops)("a %s during 0120 keeps the 0100 bitmap; later ranges stay unknown", async (how, ended, outcome) => {
    const { scanner, transport } = rig({ "0120": { lines: ["7E8 06 41 20 00 00 00 01"], delayMs: 1000 } });
    const pending = scanner.connect();
    await vi.advanceTimersByTimeAsync(500);
    expect(scanner.status.phase).toBe("current_data_support");
    if (how === "cancel") scanner.cancel();
    else transport.disconnect();
    const discovery = ok<DiscoveryReport>(await settle(pending));
    expect(discovery.ended).toBe(ended);
    // The run did not finish, so it is not a usable discovery; but what was read is kept.
    expect(discovery.result).toMatchObject({ status: "no_vehicle", reason: "not_completed" });
    expect(discovery.ecus).toHaveLength(1);
    expect(discovery.ecus[0].currentData).toMatchObject({
      supportedPids: [0x01, 0x04, 0x05, 0x0c, 0x0d, 0x11, 0x20],
      supportKnownUpTo: 0x00,
      problems: [{ command: "0120", outcome }],
    });
    expect(discovery.ecus[0].currentData.bitmaps.map((bitmap) => bitmap.base)).toEqual([0x00]);
    expect(await scanner.scan()).toMatchObject({ status: "refused" });
  });

  it.each(stops)("a %s during 022000 keeps the 020000 bitmap in the freeze-frame report", async (how, ended, outcome) => {
    const { scanner, transport } = await connected({
      "020000": line("7E8 07 42 00 00 58 18 00 01"),
      "022000": { lines: ["7E8 07 42 20 00 00 00 00 00"], delayMs: 1000 },
    });
    const pending = scanner.scan();
    await vi.advanceTimersByTimeAsync(500);
    expect(scanner.status.phase).toBe("freeze_frame");
    if (how === "cancel") scanner.cancel();
    else transport.disconnect();
    const report = ok<ScanReport>(await settle(pending));
    expect(report.ended).toBe(ended);
    expect(report.sections).toMatchObject({ dtcs: "done", freeze_frame: "interrupted", current_data: "not_run" });
    const ff = report.freezeFrames[0];
    expect(ff.support.outcome).toBe("ok");
    expect(ff.support.value?.map((bitmap) => bitmap.base)).toEqual([0x00]);
    expect(ff.supportProblems).toEqual([expect.objectContaining({ command: "022000", outcome })]);
    // 020200 was never read: the frame stays unknown, not "none stored".
    expect(ff.frame).toBe("unknown");
    expect(ff.storedDtc.outcome).toBe("not_read");
    expect(report.capabilities[0].freezeFrame).toBe("bitmap_read");
  });
});

describe("VIN reads stopped part-way", () => {
  const stops = [
    ["cancel", "cancelled", "interrupted"],
    ["disconnect", "transport_lost", "transport_lost"],
  ] as const;

  it.each(stops)("a %s during 0900 records the infotype read's outcome; the VIN stays not read", async (how, ended, outcome) => {
    const { scanner, transport, adapter } = rig({ "0900": { lines: ["7E8 06 49 00 40 00 00 00"], delayMs: 1000 } });
    const pending = scanner.connect();
    await vi.advanceTimersByTimeAsync(500);
    expect(scanner.status.phase).toBe("vin");
    if (how === "cancel") scanner.cancel();
    else transport.disconnect();
    const discovery = ok<DiscoveryReport>(await settle(pending));
    expect(discovery.ended).toBe(ended);
    expect(discovery.ecus[0].currentData.supportedPids).toContain(0x42);
    expect(discovery.ecus[0].infoTypes).toMatchObject({ outcome, rawLines: [], payloads: [] });
    expect(discovery.ecus[0].infoTypes).not.toHaveProperty("value");
    expect(discovery.ecus[0].vin.outcome).toBe("not_read");
    expect(discovery.vinComparison).toEqual({ status: "none" });
    expect(obdSent(adapter)).not.toContain("0902");
  });

  it.each(stops)("a %s during 0902 keeps the infotype bitmap and records the VIN read's outcome without a value", async (how, ended, outcome) => {
    const { scanner, transport } = rig({ "0902": { lines: ["7E8 10 14 49 02 01 31 48 47"], delayMs: 1000 } });
    const pending = scanner.connect();
    await vi.advanceTimersByTimeAsync(500);
    expect(scanner.status.phase).toBe("vin");
    if (how === "cancel") scanner.cancel();
    else transport.disconnect();
    const discovery = ok<DiscoveryReport>(await settle(pending));
    expect(discovery.ended).toBe(ended);
    expect(discovery.ecus[0].infoTypes.outcome).toBe("ok");
    expect(discovery.ecus[0].vin).toMatchObject({ outcome, rawLines: [], payloads: [] });
    expect(discovery.ecus[0].vin).not.toHaveProperty("value");
    expect(discovery.vinComparison).toEqual({ status: "none" });
  });

  it("a VIN already parsed is kept when a step listener cancels before the run moves on", async () => {
    const { scanner } = rig();
    scanner.onProgress((event) => {
      if (event.type === "step" && event.step.command === "0902") scanner.cancel();
    });
    const discovery = ok<DiscoveryReport>(await settle(scanner.connect()));
    expect(discovery.ended).toBe("cancelled");
    expect(discovery.ecus[0].vin).toMatchObject({ outcome: "ok", value: { text: "1HGCM82633A004352" } });
    expect(discovery.vinComparison).toMatchObject({ status: "consistent", text: "1HGCM82633A004352" });
  });
});

describe("starting a scan from a discovery-completion listener", () => {
  const triggers = [
    ["state ready", (event: ScannerProgress) => event.type === "state" && event.state === "ready"],
    ["activity_ended", (event: ScannerProgress) => event.type === "activity_ended" && event.activity === "discovery"],
  ] as const;

  async function scanOnCompletion(scanner: ScannerController, when: (event: ScannerProgress) => boolean, begin: () => Promise<unknown>) {
    let started: Promise<ScanReport | ScannerRefusal> | null = null;
    let seen: DiscoveryReport | null = null;
    const off = scanner.onProgress((event) => {
      if (started || !when(event)) return;
      seen = scanner.discovery;
      started = scanner.scan();
    });
    const discovery = ok<DiscoveryReport>(await settle(begin() as Promise<DiscoveryReport | ScannerRefusal>));
    off();
    expect(started).not.toBeNull();
    expect(seen).toBe(discovery);
    expect(scanner.discovery).toBe(discovery);
    return ok<ScanReport>(await settle(started as unknown as Promise<ScanReport | ScannerRefusal>));
  }

  it.each(triggers)("after connect(), on %s, the scan sees the new discovery", async (_name, when) => {
    const { scanner } = rig();
    const report = await scanOnCompletion(scanner, when, () => scanner.connect());
    expect(report.ended).toBe("finished");
  });

  it.each(triggers)("after recover(), on %s, the scan sees the rediscovery", async (_name, when) => {
    const { scanner } = await connected({ "0100": [line("NO DATA"), line("7E8 06 41 00 98 18 80 01")] });
    expect(scanner.status.vehicleFound).toBe(false);
    const report = await scanOnCompletion(scanner, when, () => scanner.recover());
    expect(report.ended).toBe("finished");
    expect(scanner.discovery?.result).toEqual({ status: "vehicle_found" });
  });
});

describe("recovery", () => {
  it("no ECU answered (ignition off): scan refused, then a person-started recover() finds the vehicle", async () => {
    const { scanner } = await connected({ "0100": [line("NO DATA"), line("7E8 06 41 00 98 18 80 01")] });
    expect(scanner.discovery?.result).toMatchObject({ status: "no_vehicle", reason: "no_ecu_answered" });
    expect(scanner.discovery?.result).toHaveProperty("detail", expect.stringContaining("ignition"));
    expect(await scanner.scan()).toMatchObject({ status: "refused", reason: "no_vehicle" });
    const again = ok<DiscoveryReport>(await settle(scanner.recover()));
    expect(again.result).toEqual({ status: "vehicle_found" });
    expect(again.steps[0].command).toBe("ATZ");
    expect(ok<ScanReport>(await settle(scanner.scan())).ended).toBe("finished");
  });

  it("a framing error stops the scan; scans are refused until recover() resets the adapter", async () => {
    const overflow: ScriptedReply = { raw: "7E8 02 4A 00\r".repeat(40), chunkSize: 13, chunkIntervalMs: 10 };
    const { scanner } = await connected({ "0A": [overflow, line("7E8 02 4A 00")] }, { executor: { byteCap: 128 } });
    const report = ok<ScanReport>(await settle(scanner.scan()));
    expect(report.ended).toBe("failed");
    expect(report.endDetail).toContain("recover");
    expect(report.dtcs.ecus[0].outcomes).toEqual({ "03": "ok", "07": "ok", "0A": "framing_error" });
    expect(scanner.status).toMatchObject({ state: "ready", needsRecovery: true });
    expect(await scanner.scan()).toMatchObject({ status: "refused", reason: "needs_recovery" });
    const again = ok<DiscoveryReport>(await settle(scanner.recover()));
    expect(again.result).toEqual({ status: "vehicle_found" });
    expect(scanner.status.needsRecovery).toBe(false);
    expect(ok<ScanReport>(await settle(scanner.scan())).ended).toBe("finished");
  });
});

describe("live polling", () => {
  const selection = [
    { module: "obd-can11-7e8", pid: 0x0c },
    { module: "obd-can11-7e8", pid: 0x0d },
    { module: "obd-can11-7e8", pid: 0x05 },
  ];

  it("row 53: user-started, bounded, sequential cycles of attributed, pending-verification readings", async () => {
    const { scanner, adapter, transport, progress } = await connected();
    const writesBefore = transport.writes.length;
    const report = ok<LiveReport>(await settle(scanner.startLivePolling({ selection, cycles: 2, intervalMs: 100 })));
    expect(report).toMatchObject({ kind: "live", ended: "finished", cyclesRequested: 2, diagnosticUse: "display_only" });
    expect(report.cycles).toHaveLength(2);
    expect(transport.writes.slice(writesBefore)).toEqual(["010C\r", "010D\r", "0105\r", "010C\r", "010D\r", "0105\r"]);
    expect(adapter.interrupts).toBe(0);
    for (const reading of report.cycles[1].readings) {
      expect(reading).toMatchObject({ module: "obd-can11-7e8", outcome: "ok" });
      expectPending(reading.value);
    }
    expect(report.cycles[0].readings.map((reading) => reading.value?.decoded)).toEqual([
      expect.objectContaining({ status: "decoded", value: 750 }),
      expect.objectContaining({ status: "decoded", value: 0 }),
      expect.objectContaining({ status: "decoded", value: 50 }),
    ]);
    expect(progress.filter((event) => event.type === "live_cycle")).toHaveLength(2);
    expect(scanner.state).toBe("ready");
  });

  it("refuses unsupported, unknown or unbounded selections before writing anything", async () => {
    const { scanner, transport } = await connected();
    const writes = transport.writes.length;
    const cases = [
      { selection: [{ module: "obd-can11-7e8", pid: 0x0f }], cycles: 1 }, // not in this ECU's bitmap
      { selection: [{ module: "obd-can11-7e9", pid: 0x0c }], cycles: 1 }, // not discovered
      { selection: [{ module: "obd-can11-7e8", pid: 0x01 }], cycles: 1 }, // readiness has its own reader
      { selection, cycles: 0 },
      { selection, cycles: 1001 },
      { selection, cycles: 1, intervalMs: -1 },
      { selection: [], cycles: 1 },
      { selection: [selection[0], selection[0]], cycles: 1 },
    ];
    for (const request of cases) expect(await scanner.startLivePolling(request), JSON.stringify(request)).toMatchObject({ status: "refused", reason: "invalid_request" });
    expect(transport.writes.length).toBe(writes);
  });

  it("row 54: Stop mid-command interrupts, ends the loop and shows no value from the interrupted command", async () => {
    const { scanner, adapter } = await connected({ "010D": [line("7E8 03 41 0D 00"), { lines: ["7E8 03 41 0D 10"], delayMs: 1000 }] });
    const pending = scanner.startLivePolling({ selection, cycles: 5, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(300);
    expect(scanner.status.activity).toBe("live");
    scanner.stopLivePolling();
    const report = ok<LiveReport>(await settle(pending));
    expect(report.ended).toBe("cancelled");
    // Cycle 1 complete; cycle 2 keeps its 010C reading and shows 010D interrupted, with no value.
    expect(report.cycles.map((cycle) => cycle.complete)).toEqual([true, false]);
    expect(report.cycles[1].readings).toEqual([
      expect.objectContaining({ pid: 0x0c, outcome: "ok" }),
      expect.objectContaining({ pid: 0x0d, outcome: "interrupted", rawLines: [] }),
    ]);
    expect(report.cycles[1].readings[1].value).toBeUndefined();
    expect(report.steps.at(-1)).toMatchObject({ command: "010D", outcome: "interrupted", perEcu: [] });
    expect(adapter.interrupts).toBe(1);
    expect(scanner.state).toBe("ready");
  });

  it.each([
    ["stop", "cancelled", "interrupted"],
    ["disconnect", "transport_lost", "transport_lost"],
  ] as const)("a %s during the second PID of the first cycle keeps the first reading", async (how, ended, outcome) => {
    const { scanner, transport, progress } = await connected({ "010D": { lines: ["7E8 03 41 0D 00"], delayMs: 1000 } });
    const pending = scanner.startLivePolling({ selection, cycles: 3 });
    await vi.advanceTimersByTimeAsync(500);
    if (how === "stop") scanner.stopLivePolling();
    else transport.disconnect();
    const report = ok<LiveReport>(await settle(pending));
    expect(report.ended).toBe(ended);
    expect(report.cycles).toHaveLength(1);
    expect(report.cycles[0].complete).toBe(false);
    expect(report.cycles[0].readings).toEqual([
      expect.objectContaining({ module: "obd-can11-7e8", pid: 0x0c, outcome: "ok", rawLines: ["7E8 04 41 0C 0B B8"] }),
      expect.objectContaining({ module: "obd-can11-7e8", pid: 0x0d, outcome }),
    ]);
    expect(report.cycles[0].readings[0].value?.decoded).toMatchObject({ value: 750 });
    expect(report.cycles[0].readings[1].value).toBeUndefined();
    // Only complete cycles are announced as live_cycle progress.
    expect(progress.filter((event) => event.type === "live_cycle")).toHaveLength(0);
  });

  it("row 55: a disconnect while polling stops it transport_lost, with no restart", async () => {
    const { scanner, transport } = await connected();
    const pending = scanner.startLivePolling({ selection, cycles: 100, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1500);
    transport.disconnect();
    const report = ok<LiveReport>(await settle(pending));
    expect(report.ended).toBe("transport_lost");
    expect(report.cycles.length).toBeLessThan(100);
    expect(scanner.state).toBe("failed");
    expect(await scanner.startLivePolling({ selection, cycles: 1 })).toMatchObject({ status: "refused", reason: "session_unavailable" });
  });

  it("row 56: dispose (unmount) while polling stops it, closes the link and delivers no further progress", async () => {
    const { scanner, transport, progress } = await connected();
    const pending = scanner.startLivePolling({ selection, cycles: 100, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1500);
    const seen = progress.length;
    const disposed = scanner.dispose();
    const report = ok<LiveReport>(await settle(pending));
    await disposed;
    expect(report.ended).not.toBe("finished");
    expect(progress.length).toBe(seen);
    expect(scanner.state).toBe("closed");
    expect(transport.state).toBe("closed");
    expect(await scanner.scan()).toMatchObject({ status: "refused", reason: "disposed" });
  });
});

describe("isolation of unverified values from diagnostic decisions", () => {
  it("the PID and readiness tables stay pending and every decoded value says so", async () => {
    expect(PID_TABLE_REVIEW.primarySourceCheck).toBe("pending");
    expect(READINESS_TABLE_REVIEW.primarySourceCheck).toBe("pending");
    const { scanner } = await connected();
    const report = ok<ScanReport>(await settle(scanner.scan()));
    const decoded = [
      ...report.readiness.map((entry) => entry.value),
      ...report.currentData.map((reading) => reading.value),
      ...report.freezeFrames.flatMap((entry) => entry.values.map((value) => value.value)),
    ].filter((value) => value !== undefined);
    expect(decoded.length).toBeGreaterThan(5);
    for (const value of decoded) expectPending(value);
  });

  it("nothing outside the vehicle-communication layer imports it (no path into Guided Diagnostics, routes or pages)", () => {
    const root = path.resolve(__dirname, "..");
    const layer = path.join(root, "app/lib/vehicle-communication");
    const listTs = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        if (full === layer || name === "node_modules") return [];
        if (statSync(full).isDirectory()) return listTs(full);
        return /\.tsx?$/.test(name) ? [full] : [];
      });
    const files = [...listTs(path.join(root, "app")), ...listTs(path.join(root, "components"))];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(file, "utf8"), path.relative(root, file)).not.toMatch(/vehicle-communication/);
  });
});
