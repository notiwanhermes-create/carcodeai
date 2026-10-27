/**
 * Scan evidence (S10): ScanReport → preview evidence and a GD-compatible
 * `DiagnosticScanInput`.
 *
 * Design: docs/research/scanner-engine/carcode-scanner-architecture.md ("One-way
 * evidence mapping") and scan-flow.md. Rows covered: 7, 10, 11, 18-21, 24,
 * 31, 35, 36, 45, 46, 48, 51, 58, 59.
 *
 * Reports come from the scanner controller over SCRIPTED adapters. GD is used
 * only through its pure `normalizeScan`, `matchDtc` and `codesAbsentVerdict`,
 * in tests; no session and no service is involved.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codesAbsentVerdict, matchDtc, normalizeScan, type NormalizedScan } from "../app/lib/diagnostic-workflow/dtc";
import { DTC_STATUS_FLAGS, UNITS, type DiagnosticScanInput, type DtcStatusFlag, type Evidence, type SnapshotInput, type Unit } from "../app/lib/diagnostic-workflow/types";
import type {
  DiagnosticScanInput as LocalScanInput,
  DtcStatusFlag as LocalStatusFlag,
  SnapshotInput as LocalSnapshotInput,
  Unit as LocalUnit,
} from "../app/lib/vehicle-communication/evidence/gd-shapes";
import { GD_FLAG_FOR_SERVICE, GD_UNIT_FOR, mapScanEvidence, toSnapshotInput, type ScanEvidence, type StepRef } from "../app/lib/vehicle-communication/evidence/scan-evidence";
import { ScannerController } from "../app/lib/vehicle-communication/scanner/controller";
import type { DiscoveryReport, ScanReport } from "../app/lib/vehicle-communication/scanner/report";
import { ScriptedElmAdapter, SimulatedTransport, type ScriptedReply } from "../app/lib/vehicle-communication/transport/simulated";

type Replies = Record<string, ScriptedReply | ScriptedReply[]>;
const line = (...lines: string[]): ScriptedReply => ({ lines });

/** 7E8 as in the scanner tests: readiness MIL on with one DTC, $03 P0133, freeze frame 0 stored for P0133, VIN. */
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

/** A second ECU, 7E9: $01 PIDs 01 04 05 0C 0D 11 (chain ends), MIL off, $03 P0133, declines $02. */
function twoEcus(): Replies {
  return {
    "0100": line("7E8 06 41 00 98 18 80 01", "7E9 06 41 00 98 18 80 00"),
    "0101": line("7E8 06 41 01 81 07 65 04", "7E9 06 41 01 01 07 65 04"),
    "03": line("7E8 04 43 01 01 33", "7E9 04 43 01 01 33"),
    "07": line("7E8 04 47 01 01 33", "7E9 02 47 00"),
    "0A": line("7E8 02 4A 00", "7E9 02 4A 00"),
    "020000": line("7E8 07 42 00 00 58 18 00 00", "7E9 03 7F 02 12"),
    "010C": line("7E8 04 41 0C 0B B8", "7E9 04 41 0C 0C 00"),
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

async function scanned(replies: Replies = {}): Promise<ScanReport> {
  const transport = new SimulatedTransport();
  transport.attach(new ScriptedElmAdapter({ replies: { ...vehicle(), ...replies } }));
  const scanner = new ScannerController(transport, { now });
  const connecting = scanner.connect();
  await vi.runAllTimersAsync();
  expect((await connecting as DiscoveryReport).result).toEqual({ status: "vehicle_found" });
  const scanning = scanner.scan();
  await vi.runAllTimersAsync();
  const report = await scanning;
  if ("status" in report) throw new Error(`refused: ${report.reason}`);
  return report as ScanReport;
}

const SCAN_ID = "scanner-1";
const fresh = () => ({ scans: new Set<string>(), snapshots: new Set<string>() });

function mapped(evidence: ScanEvidence): DiagnosticScanInput {
  if (evidence.gd.status !== "mapped") throw new Error(`not mapped: ${evidence.gd.reason}`);
  return evidence.gd.input;
}

/** Row 35: GD's pure normalizeScan accepts the input unchanged; always partial with coverage. */
function accepted(evidence: ScanEvidence): NormalizedScan {
  const input = mapped(evidence);
  const result = normalizeScan(structuredClone(input), fresh());
  if (!result.ok) throw new Error(result.error);
  expect(result.value.record.completeness).toBe("partial");
  expect(result.value.record.coverage?.modules.length).toBeGreaterThan(0);
  return result.value;
}

/** The GD input's text: used to prove no preview-only value leaked into it. */
const gdText = (evidence: ScanEvidence) => JSON.stringify(evidence.gd);

function asEvidence(scan: NormalizedScan): Evidence[] {
  const base = { nodeId: "scan", phase: "before_repair", source: "scan_tool" } as const;
  return [
    { ...base, seq: 1, kind: "scan", value: scan.record.id, scanInfo: scan.record } as Evidence,
    ...scan.codes.map((dtc, index) => ({ ...base, seq: index + 2, kind: "code", value: dtc.code, dtc }) as Evidence),
  ];
}

describe("one ECU, full scan", () => {
  it("maps codes with provenance to an input GD accepts; nothing unverified enters it", async () => {
    const report = await scanned();
    const evidence = mapScanEvidence(report, { scanId: SCAN_ID });
    const scan = accepted(evidence);
    expect(mapped(evidence)).toEqual({
      id: SCAN_ID,
      source: "scan_tool",
      completeness: "partial",
      coverage: { modules: ["obd-can11-7e8"] },
      reportsStatus: ["confirmed", "pending", "permanent"],
      codes: [{ code: "P0133", format: "obd", status: ["confirmed"], module: { id: "obd-can11-7e8" } }],
    });
    expect(scan.codes[0]).toMatchObject({ code: "P0133", status: ["confirmed"], module: { id: "obd-can11-7e8" } });

    // Freeze frame 0 is stored and read, but every value is unverified: no snapshot, no reference, drops recorded.
    const ff = evidence.freezeFrames[0];
    expect(ff).toMatchObject({ module: "obd-can11-7e8", frame: "stored", storedDtc: { outcome: "ok", value: { status: "stored", code: "P0133" } } });
    expect(ff.snapshot).toEqual({ id: null, reason: expect.stringContaining("primary-source check pending") });
    expect(mapped(evidence)).not.toHaveProperty("snapshots");
    const rpm = ff.values.find((v) => v.pid === 0x0c)!;
    expect(rpm).toMatchObject({
      source: "freeze_frame",
      outcome: "ok",
      readAt: expect.stringMatching(/^2026-10-26T/),
      rawLines: ["7E8 05 42 0C 00 1A F8"],
      payloads: [[0x42, 0x0c, 0x00, 0x1a, 0xf8]],
      reading: { status: "decoded", id: "engine_speed", value: 1726, unit: "rpm", gdUnit: "rpm", data: [0x1a, 0xf8] },
      verification: { status: "unverified", primarySourceCheck: "pending", diagnosticUse: "display_only" },
      gd: { eligible: false, reasons: ["unverified", "primary_source_check_pending"] },
    });
    const speed = ff.values.find((v) => v.pid === 0x0d)!;
    expect(speed.gd).toEqual({ eligible: false, reasons: ["unverified", "primary_source_check_pending", "no_gd_unit"] });
    // A PID the ECU's $02 bitmap does not list was not read: no time, no value.
    const iat = ff.values.find((v) => v.pid === 0x0f)!;
    expect(iat).toMatchObject({ outcome: "unsupported", readAt: null, reading: null, verification: null, gd: { eligible: false, reasons: ["not_read"] } });
    expect(evidence.droppedForMapping).toEqual(
      expect.arrayContaining([
        { what: "freeze frame 0", module: "obd-can11-7e8", why: expect.stringContaining("no freeze-frame value is eligible") },
        { what: "freeze-frame PID 0D", module: "obd-can11-7e8", why: "unverified, primary_source_check_pending, no_gd_unit" },
        { what: "VIN", why: expect.any(String) },
        { what: "readiness (PID 01)", why: expect.any(String) },
        { what: "current data", why: expect.any(String) },
      ]),
    );

    // Current data: measurements with units, raw bytes and read times; preview only.
    const coolant = evidence.currentData.find((m) => m.pid === 0x05)!;
    expect(coolant).toMatchObject({
      source: "current_data",
      module: "obd-can11-7e8",
      responseId: "7E8",
      discovered: true,
      readAt: expect.stringMatching(/^2026-10-26T/),
      rawLines: ["7E8 03 41 05 5A"],
      reading: { status: "decoded", id: "coolant_temperature", value: 50, unit: "degC", gdUnit: "degC", formula: "A-40", data: [0x5a] },
      diagnosticUse: "display_only",
      gd: { eligible: false, reasons: ["unverified", "primary_source_check_pending", "current_data_not_mapped"] },
    });
    // PID 06 is not in this ECU's bitmap: not read, so no read time.
    expect(evidence.currentData.find((m) => m.pid === 0x06)).toMatchObject({ outcome: "unsupported", readAt: null, reading: null });

    // Vehicle identity, readiness and capabilities: shown, with provenance.
    expect(evidence.vehicle).toMatchObject({
      diagnosticUse: "display_only",
      protocol: { family: "can11", number: "6" },
      vin: { comparison: { status: "consistent", text: "1HGCM82633A004352" }, reports: [{ module: "obd-can11-7e8", outcome: "ok", text: "1HGCM82633A004352", charset: "iso3779" }] },
    });
    expect(evidence.vehicle.vin.reports[0].rawLines).toHaveLength(3);
    expect(evidence.readiness[0]).toMatchObject({
      module: "obd-can11-7e8",
      outcome: "ok",
      readAt: expect.stringMatching(/^2026-10-26T/),
      rawLines: ["7E8 06 41 01 81 07 65 04"],
      readiness: { decoded: { milOn: true, dtcCount: 1 }, verification: { primarySourceCheck: "pending" } },
      gd: { eligible: false, reasons: ["not_mapped"] },
    });
    expect(evidence.capabilities[0]).toMatchObject({ module: "obd-can11-7e8", readiness: "supported", freezeFrame: "bitmap_read" });

    // Nothing preview-only is in the GD input.
    const text = gdText(evidence);
    for (const leaked of ["1HGCM82633A004352", "engine_speed", "coolant_temperature", "milOn", "1726", "rawLines", "7E8 "]) expect(text).not.toContain(leaked);

    // Per-code status keeps the three kinds apart; a read that answered without the code is not_listed, never absent.
    expect(evidence.dtcs).toMatchObject({ completeness: "partial", absence: "not_established", servicesOkForEveryModule: ["03", "07", "0A"] });
    const e8 = evidence.dtcs.modules[0];
    expect(e8.codes).toEqual([
      { responseId: "7E8", module: "obd-can11-7e8", discovered: true, code: "P0133", kinds: { stored: { state: "reported" }, pending: { state: "not_listed" }, permanent: { state: "not_listed" } } },
    ]);
    expect(e8.services[0]).toMatchObject({ service: "03", kind: "stored", outcome: "ok", raw: { command: "03", rawLines: ["7E8 04 43 01 01 33"], payloads: [[0x43, 0x01, 0x01, 0x33]] } });
    expect(evidence.conflicts).toEqual([]);
  });

  it("row 36: GD's pure absence checks stay unknown for a mapped partial scan", async () => {
    const evidence = mapScanEvidence(await scanned(), { scanId: SCAN_ID });
    const scan = accepted(evidence);
    const facts = asEvidence(scan);
    expect(matchDtc(facts, { code: "P0300" })).toBeNull();
    expect(matchDtc(facts, { code: "P0300", module: "obd-can11-7e8" })).toBeNull();
    expect(matchDtc(facts, { code: "P0133", status: "pending", module: "obd-can11-7e8" })).toBeNull();
    expect(matchDtc(facts, { code: "P0133" })).toBe(true);
    expect(codesAbsentVerdict([{ format: "obd", code: "P0300", module: "obd-can11-7e8" }], scan).result).toBe("inconclusive");
  });

  it("is deterministic, sealed, and leaves the report unchanged", async () => {
    const report = await scanned();
    const before = structuredClone(report);
    const first = mapScanEvidence(report, { scanId: SCAN_ID });
    const second = mapScanEvidence(report, { scanId: SCAN_ID });
    expect(second).toEqual(first);
    expect(report).toEqual(before);
    expect(Object.isFrozen(first.gd)).toBe(true);
    expect(Object.isFrozen(first.freezeFrames[0].values[0])).toBe(true);
    expect(first).toMatchObject({ kind: "scan_evidence", mapperVersion: "s10-preview", scanNumber: 1, completeness: "partial", ended: "finished" });
  });
});

describe("partial and unavailable reads", () => {
  it("row 7: NO DATA to 03 is unknown, never no codes; confirmed is not declared", async () => {
    const evidence = mapScanEvidence(await scanned({ "03": line("NO DATA") }), { scanId: SCAN_ID });
    const scan = accepted(evidence);
    expect(mapped(evidence)).toMatchObject({ reportsStatus: ["pending", "permanent"], codes: [] });
    expect(evidence.dtcs.modules[0].services[0]).toMatchObject({ service: "03", outcome: "no_response" });
    // P0133 was not read at all: GD cannot say it is absent, with or without a module.
    const facts = asEvidence(scan);
    expect(matchDtc(facts, { code: "P0133" })).toBeNull();
    expect(matchDtc(facts, { code: "P0133", module: "obd-can11-7e8" })).toBeNull();
    expect(matchDtc(facts, { code: "P0133", status: "confirmed", module: "obd-can11-7e8" })).toBeNull();
    // The freeze frame's code is not in a $03 list that was never read: no conflict is invented.
    expect(evidence.conflicts).toEqual([]);
  });

  it("no code service answered ok anywhere: not mapped at all", async () => {
    const evidence = mapScanEvidence(await scanned({ "03": line("NO DATA"), "07": line("NO DATA"), "0A": line("CAN ERROR") }), { scanId: SCAN_ID });
    expect(evidence.gd).toEqual({ status: "not_mapped", reason: "no_code_read", detail: expect.any(String) });
    expect(evidence.dtcs.modules[0].services.map((s) => s.outcome)).toEqual(["no_response", "no_response", "bus_error"]);
    // The preview keeps everything else.
    expect(evidence.currentData.find((m) => m.pid === 0x0c)?.reading).toMatchObject({ value: 750, unit: "rpm" });
  });

  it("an invalid scan id is not mapped (never repaired)", async () => {
    const evidence = mapScanEvidence(await scanned(), { scanId: "bad id!" });
    expect(evidence.gd).toMatchObject({ status: "not_mapped", reason: "invalid_scan_id" });
  });

  it("rows 10-11, 51: a malformed 03 answer is unknown for that kind; a count mismatch is a preserved conflict", async () => {
    const malformed = mapScanEvidence(await scanned({ "03": line("7E8 04 43 02 01 33 AA AA AA") }), { scanId: SCAN_ID });
    accepted(malformed);
    expect(malformed.dtcs.modules[0].services[0]).toMatchObject({ outcome: "malformed", raw: { rawLines: ["7E8 04 43 02 01 33 AA AA AA"] } });
    expect(mapped(malformed).reportsStatus).toEqual(["pending", "permanent"]);

    const mismatch = mapScanEvidence(await scanned({ "03": line("7E8 06 43 02 01 33 03 00") }), { scanId: SCAN_ID });
    accepted(mismatch);
    expect(mismatch.conflicts).toContainEqual({ kind: "dtc_count_mismatch", module: "obd-can11-7e8", responseId: "7E8", readinessCount: 1, storedCount: 2 });
    expect(mapped(mismatch).codes.map((c) => c.code)).toEqual(["P0133", "P0300"]);
    expect(mismatch.readiness[0].readiness?.decoded.dtcCount).toBe(1);
  });

  it("row 31: a disconnect during 07 keeps 03, leaves 07 / 0A unknown and maps partial", async () => {
    const transport = new SimulatedTransport();
    transport.attach(new ScriptedElmAdapter({ replies: { ...vehicle(), "07": { lines: ["7E8 02 47 00"], delayMs: 1000 } } }));
    const scanner = new ScannerController(transport, { now });
    const connecting = scanner.connect();
    await vi.runAllTimersAsync();
    await connecting;
    const scanning = scanner.scan();
    await vi.advanceTimersByTimeAsync(500);
    transport.disconnect();
    await vi.runAllTimersAsync();
    const report = (await scanning) as ScanReport;
    expect(report.ended).toBe("transport_lost");
    const evidence = mapScanEvidence(report, { scanId: SCAN_ID });
    accepted(evidence);
    expect(evidence.ended).toBe("transport_lost");
    expect(mapped(evidence)).toMatchObject({ reportsStatus: ["confirmed"], codes: [{ code: "P0133", status: ["confirmed"] }] });
    expect(evidence.dtcs.modules[0].codes[0].kinds).toEqual({
      stored: { state: "reported" },
      pending: { state: "unknown", outcome: "transport_lost" },
      permanent: { state: "unknown", outcome: "not_read" },
    });
    expect(evidence.dtcs.modules[0].services[2].raw).toBeNull();
    expect(evidence.freezeFrames[0]).toMatchObject({ frame: "unknown", snapshot: { id: null } });
  });
});

describe("multiple responding modules", () => {
  it("rows 18-19, 46: each module keeps its own observations, labels, raw answers and conflicts", async () => {
    const evidence = mapScanEvidence(await scanned(twoEcus()), { scanId: SCAN_ID });
    const scan = accepted(evidence);
    expect(evidence.coverage).toEqual(["obd-can11-7e8", "obd-can11-7e9"]);
    expect(evidence.modules.map((m) => [m.module, m.responseId, m.discovered])).toEqual([
      ["obd-can11-7e8", "7E8", true],
      ["obd-can11-7e9", "7E9", true],
    ]);
    // Same code from two modules: two observations. 03 + 07 on one module: one observation with both flags.
    expect(mapped(evidence).codes).toEqual([
      { code: "P0133", format: "obd", status: ["confirmed", "pending"], module: { id: "obd-can11-7e8" } },
      { code: "P0133", format: "obd", status: ["confirmed"], module: { id: "obd-can11-7e9" } },
    ]);
    expect(scan.codes.map((c) => c.module?.id)).toEqual(["obd-can11-7e8", "obd-can11-7e9"]);
    expect(evidence.dtcs.modules[1].services[0].raw).toMatchObject({ rawLines: ["7E9 04 43 01 01 33"] });

    // Readiness and current values that differ between modules are both kept, never merged or picked.
    expect(evidence.conflicts).toEqual(
      expect.arrayContaining([
        {
          kind: "mil_status_differs",
          reports: [
            { responseId: "7E8", module: "obd-can11-7e8", milOn: true },
            { responseId: "7E9", module: "obd-can11-7e9", milOn: false },
          ],
        },
        {
          kind: "current_value_differs",
          pid: 0x0c,
          id: "engine_speed",
          readings: [
            { responseId: "7E8", module: "obd-can11-7e8", value: 750, unit: "rpm", readAt: expect.any(String) },
            { responseId: "7E9", module: "obd-can11-7e9", value: 768, unit: "rpm", readAt: expect.any(String) },
          ],
        },
      ]),
    );
    // 7E9 declined $02 (code kept); 7E8's freeze frame was read. Neither yields a snapshot.
    const [e8, e9] = evidence.freezeFrames;
    expect(e9.support).toMatchObject({ outcome: "negative_response", code: 0x12, rawLines: ["7E9 03 7F 02 12"] });
    expect(e9.snapshot).toEqual({ id: null, reason: "freeze-frame support negative_response" });
    expect(e8.frame).toBe("stored");
    expect(mapped(evidence)).not.toHaveProperty("snapshots");
    // 7E9 did not answer 010D: its outcome is kept with no value.
    expect(evidence.currentData.find((m) => m.module === "obd-can11-7e9" && m.pid === 0x0d)).toMatchObject({ outcome: "no_response", reading: null });
  });

  it("row 20: 07 failing on one module drops pending from every code in GD and records it; the preview keeps it", async () => {
    const evidence = mapScanEvidence(await scanned({ ...twoEcus(), "07": line("7E8 06 47 02 01 33 03 00") }), { scanId: SCAN_ID });
    accepted(evidence);
    const input = mapped(evidence);
    expect(input.reportsStatus).toEqual(["confirmed", "permanent"]);
    expect(input.codes).toEqual([
      { code: "P0133", format: "obd", status: ["confirmed"], module: { id: "obd-can11-7e8" } },
      // Reported only as pending: status omitted (unknown), never an invented flag.
      { code: "P0300", format: "obd", module: { id: "obd-can11-7e8" } },
      { code: "P0133", format: "obd", status: ["confirmed"], module: { id: "obd-can11-7e9" } },
    ]);
    expect(evidence.droppedForMapping).toEqual(
      expect.arrayContaining([
        { what: "P0133 status pending", module: "obd-can11-7e8", why: expect.stringContaining("07") },
        { what: "P0300 status pending", module: "obd-can11-7e8", why: expect.stringContaining("07") },
      ]),
    );
    const [e8, e9] = evidence.dtcs.modules;
    expect(e8.codes.find((c) => c.code === "P0300")?.kinds).toEqual({ stored: { state: "not_listed" }, pending: { state: "reported" }, permanent: { state: "not_listed" } });
    expect(e9.codes[0].kinds.pending).toEqual({ state: "unknown", outcome: "no_response" });
    expect(e9.services[1]).toMatchObject({ service: "07", outcome: "no_response", raw: { rawLines: [] } });
  });

  it("row 21 and VINs: a module that answered discovery but not 03 stays in coverage; differing VINs are kept apart", async () => {
    const evidence = mapScanEvidence(
      await scanned({
        ...twoEcus(),
        "03": line("7E8 04 43 01 01 33"),
        "0900": line("7E8 06 49 00 40 00 00 00", "7E9 06 49 00 40 00 00 00"),
        "0902": line(
          "7E8 10 14 49 02 01 31 48 47",
          "7E9 10 14 49 02 01 31 48 47",
          "7E8 21 43 4D 38 32 36 33 33",
          "7E9 21 43 4D 38 32 36 33 33",
          "7E8 22 41 30 30 34 33 35 32",
          "7E9 22 41 30 30 34 33 35 33",
        ),
      }),
      { scanId: SCAN_ID },
    );
    accepted(evidence);
    expect(mapped(evidence).coverage).toEqual({ modules: ["obd-can11-7e8", "obd-can11-7e9"] });
    expect(evidence.dtcs.modules[1].services[0].outcome).toBe("no_response");
    expect(evidence.conflicts).toContainEqual({
      kind: "vin_differs",
      reports: [
        { responseId: "7E8", module: "obd-can11-7e8", text: "1HGCM82633A004352" },
        { responseId: "7E9", module: "obd-can11-7e9", text: "1HGCM82633A004353" },
      ],
    });
    expect(gdText(evidence)).not.toContain("1HGCM");
  });
});

describe("freeze frames", () => {
  it("rows 24, 45: NO DATA to 020000 leaves support unknown and emits no snapshot", async () => {
    const evidence = mapScanEvidence(await scanned({ "020000": line("NO DATA") }), { scanId: SCAN_ID });
    accepted(evidence);
    expect(evidence.freezeFrames[0]).toMatchObject({ support: { outcome: "no_response" }, frame: "unknown", values: [], snapshot: { id: null } });
    expect(evidence.capabilities[0].freezeFrame).toBe("support_unknown");
    expect(mapped(evidence)).not.toHaveProperty("snapshots");
    expect(mapped(evidence).codes[0]).not.toHaveProperty("snapshot");
  });

  it("row 48: 0000 from 020200 is no stored frame: no snapshot, no further reads", async () => {
    const evidence = mapScanEvidence(await scanned({ "020200": line("7E8 05 42 02 00 00 00") }), { scanId: SCAN_ID });
    accepted(evidence);
    expect(evidence.freezeFrames[0]).toMatchObject({ frame: "none_stored", values: [], snapshot: { id: null, reason: "the module reports no stored freeze frame" } });
    expect(evidence.freezeFrames[0].storedDtc.value).toEqual({ status: "none_stored", raw: [0, 0] });
  });

  it("row 58: a stored frame whose every value read fails yields no snapshot and no code reference; the drop is recorded", async () => {
    const evidence = mapScanEvidence(
      await scanned({ "020400": line("NO DATA"), "020500": line("NO DATA"), "020C00": line("7E8 03 42 0C 00"), "020D00": line("NO DATA") }),
      { scanId: SCAN_ID },
    );
    accepted(evidence);
    const ff = evidence.freezeFrames[0];
    expect(ff.frame).toBe("stored");
    expect(ff.values.find((v) => v.pid === 0x0c)).toMatchObject({ outcome: "malformed", reading: null, rawLines: ["7E8 03 42 0C 00"] });
    expect(ff.snapshot).toEqual({ id: null, reason: "no freeze-frame value was read" });
    expect(evidence.droppedForMapping).toContainEqual({ what: "freeze frame 0", module: "obd-can11-7e8", why: "no freeze-frame value was read" });
    expect(mapped(evidence).codes[0]).not.toHaveProperty("snapshot");
  });

  it("row 59: values with no GD unit are dropped as well as unverified", async () => {
    const evidence = mapScanEvidence(await scanned({ "020000": line("7E8 07 42 00 00 40 08 00 00") }), { scanId: SCAN_ID });
    accepted(evidence);
    const read = evidence.freezeFrames[0].values.filter((v) => v.reading);
    expect(read.map((v) => v.pid)).toEqual([0x0d]);
    expect(read[0].gd).toEqual({ eligible: false, reasons: ["unverified", "primary_source_check_pending", "no_gd_unit"] });
    expect(mapped(evidence)).not.toHaveProperty("snapshots");
  });

  it("a freeze frame stored for a code missing from that module's 03 list is a preserved conflict", async () => {
    const evidence = mapScanEvidence(await scanned({ "03": line("7E8 04 43 01 03 00"), "0101": line("7E8 06 41 01 81 07 65 04") }), { scanId: SCAN_ID });
    expect(evidence.conflicts).toContainEqual({ kind: "freeze_frame_code_not_stored", module: "obd-can11-7e8", responseId: "7E8", code: "P0133" });
  });

  it("toSnapshotInput never builds an empty snapshot; a non-empty one is partial and accepted by GD", () => {
    expect(toSnapshotInput("s.ff0.obd-can11-7e8", [])).toBeNull();
    expect(toSnapshotInput("bad id", [{ id: "engine_speed", value: 750, unit: "rpm" }])).toBeNull();
    const snapshot = toSnapshotInput("s.ff0.obd-can11-7e8", [{ id: "engine_speed", value: 750, unit: "rpm" }])!;
    expect(snapshot).toEqual({ id: "s.ff0.obd-can11-7e8", parameters: [{ id: "engine_speed", value: 750, unit: "rpm" }], completeness: "partial" });
    const result = normalizeScan({ id: "s", source: "scan_tool", completeness: "partial", coverage: { modules: ["obd-can11-7e8"] }, codes: [], snapshots: [snapshot] }, fresh());
    expect(result.ok).toBe(true);
  });
});

/** Every `StepRef` in the evidence (any object with `log` and `seq`), with the path it was found at. */
function stepRefs(value: unknown, at = "evidence", found: Array<{ at: string; ref: StepRef }> = []) {
  if (Array.isArray(value)) value.forEach((item, index) => stepRefs(item, `${at}[${index}]`, found));
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.log === "string" && typeof record.seq === "number") found.push({ at, ref: record as unknown as StepRef });
    for (const [key, child] of Object.entries(record)) if (key !== "log" || typeof child !== "object") stepRefs(child, `${at}.${key}`, found);
  }
  return found;
}

describe("acquisition provenance", () => {
  it("every read item points at its own command-log entry, and every reference resolves to that entry's command and end time", async () => {
    const evidence = mapScanEvidence(await scanned(), { scanId: SCAN_ID });
    const refs = stepRefs({ ...evidence, log: undefined });
    expect(refs.length).toBeGreaterThan(10);
    for (const { at, ref } of refs) {
      const entry = evidence.log[ref.log].find((step) => step.seq === ref.seq);
      expect(entry, at).toBeDefined();
      expect({ command: entry?.command, endedAt: entry?.endedAt }, at).toEqual({ command: ref.command, endedAt: ref.endedAt });
    }
    const [ff] = evidence.freezeFrames;
    expect(ff.support).toMatchObject({ step: { log: "scan", command: "020000" } });
    expect(ff.support.readAt).toBe(ff.support.step?.endedAt);
    expect(ff.storedDtc).toMatchObject({ step: { log: "scan", command: "020200" } });
    expect(ff.storedDtc.readAt).toBe(ff.storedDtc.step?.endedAt);
    expect(ff.values.find((m) => m.pid === 0x0c)?.step).toMatchObject({ log: "scan", command: "020C00" });
    expect(evidence.currentData.find((m) => m.pid === 0x0c)?.step).toMatchObject({ log: "scan", command: "010C" });
    expect(evidence.readiness[0].step).toMatchObject({ log: "scan", command: "0101" });
  });

  it("the VIN keeps the discovery's own read time, from before the scan", async () => {
    const evidence = mapScanEvidence(await scanned(), { scanId: SCAN_ID });
    const [vin] = evidence.vehicle.vin.reports;
    expect(vin).toMatchObject({ text: "1HGCM82633A004352", step: { log: "discovery", command: "0902" } });
    expect(vin.readAt).toBe(vin.step?.endedAt);
    expect(Date.parse(vin.readAt!)).toBeLessThan(Date.parse(evidence.startedAt));
    expect(evidence.log.scan.some((step) => step.command === "0902")).toBe(false);
  });

  it("reads that were never made have null provenance, never the scan's time", async () => {
    const evidence = mapScanEvidence(await scanned(twoEcus()), { scanId: SCAN_ID });
    const e9 = (list: Array<{ module: string }>) => list.find((item) => item.module === "obd-can11-7e9");
    // 7E9 did not answer 0900, so 0902 was never sent for it.
    expect(e9(evidence.vehicle.vin.reports)).toMatchObject({ outcome: "support_unknown", readAt: null, step: null });
    // 7E9 declined $02: its support read was made (negative response), its 020200 never was.
    const ff = e9(evidence.freezeFrames) as (typeof evidence.freezeFrames)[number];
    expect(ff.support).toMatchObject({ outcome: "negative_response", step: { log: "scan", command: "020000" } });
    expect(ff.storedDtc).toMatchObject({ outcome: "not_read", readAt: null, step: null });
    // A current-data PID 7E9 does not list was never requested for it.
    const unsupported = evidence.currentData.find((m) => m.module === "obd-can11-7e9" && m.outcome === "unsupported");
    expect(unsupported).toMatchObject({ readAt: null, step: null });
  });
});

describe("boundaries", () => {
  it("vehicle-communication imports and names nothing from GD, not even types; the layers below evidence/ never import it", () => {
    const root = path.join(__dirname, "../app/lib/vehicle-communication");
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith(".ts"));
    expect(files).toContain(path.join("evidence", "scan-evidence.ts"));
    for (const file of files) {
      const source = readFileSync(path.join(root, file), "utf8");
      expect(source, file).not.toMatch(/diagnostic-workflow|prisma|fetch\(/i);
      if (!file.startsWith("evidence")) expect(source, file).not.toMatch(/evidence\//);
    }
  });

  it("the local GD shapes stay assignable to GD's own types, and use only GD's flags and units", () => {
    // Compile time (tsc --noEmit): each local shape must be assignable to GD's type, or this file does not typecheck.
    const scan = (input: LocalScanInput): DiagnosticScanInput => input;
    const snapshot = (input: LocalSnapshotInput): SnapshotInput => input;
    const flag = (input: LocalStatusFlag): DtcStatusFlag => input;
    const unit = (input: LocalUnit): Unit => input;
    // Run time: every flag and unit the mapper can produce is in GD's own lists.
    for (const value of Object.values(GD_FLAG_FOR_SERVICE)) expect(DTC_STATUS_FLAGS).toContain(flag(value));
    for (const value of Object.values(GD_UNIT_FOR)) expect(UNITS).toContain(unit(value));
    const built = toSnapshotInput("s.ff0.obd-can11-7e8", [{ id: "engine_speed", value: 750, unit: "rpm" }]);
    expect(built && snapshot(built)).toMatchObject({ completeness: "partial" });
    expect(normalizeScan(scan({ id: "s", source: "scan_tool", completeness: "partial", coverage: { modules: ["obd-can11-7e8"] }, codes: [] }), fresh()).ok).toBe(true);
  });
});
