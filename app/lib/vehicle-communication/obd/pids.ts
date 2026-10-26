/**
 * The reviewed PID table and $01 / $02 value decoding (live-data.md, "PID
 * table (preview)", "Rules for every value"; scan-flow.md, "Freeze-frame
 * probe").
 *
 * RESEARCH PROTOTYPE. Pure. Formulas: SAE J1979 (unverified copy),
 * cross-checked only against the public secondary source
 * <https://en.wikipedia.org/wiki/OBD-II_PIDs>. PRIMARY-SOURCE CHECK PENDING
 * for every row (see `PID_TABLE_REVIEW`); nothing here judges a value.
 *
 * A value keeps its raw data bytes and the table row it was decoded with. A
 * PID outside the table is `not_decoded` with its raw bytes, never guessed.
 * Live values ($01) and freeze-frame values ($02) are separate reads with
 * separate types: a freeze-frame value is never a live measurement.
 */
import type { CommandResult } from "../elm/executor";
import type { ProtocolFamily } from "./frames";
import { decodeDtc } from "./dtc";
import { readService, type BodyDecode, type ServiceRead } from "./response";

export const PID_TABLE_REVIEW = Object.freeze({
  standard: "SAE J1979 $01 / $02 (unverified copy)",
  secondaryCrossCheck: "https://en.wikipedia.org/wiki/OBD-II_PIDs (Service 01)",
  primarySourceCheck: "pending" as const,
});

export type PidDefinition = {
  pid: number;
  id: string;
  quantity: string;
  /** Allowed data lengths; the first byte(s) the formula uses come first. */
  dataBytes: readonly number[];
  formula: string;
  unit: string;
  decode: (data: readonly number[]) => number;
  /** Bytes the formula does not use, when the longer form is sent. */
  note?: string;
};

const percent = (d: readonly number[]) => (100 * d[0]) / 255;
const trim = (d: readonly number[]) => (100 * d[0]) / 128 - 100;
const word = (d: readonly number[]) => 256 * d[0] + d[1];
const TRIM_NOTE = "a second byte (bank 3 / 4 per the secondary source) is kept raw, not decoded";

export const PID_TABLE: readonly PidDefinition[] = Object.freeze([
  { pid: 0x04, id: "calculated_load", quantity: "Calculated engine load", dataBytes: [1], formula: "100*A/255", unit: "%", decode: percent },
  { pid: 0x05, id: "coolant_temperature", quantity: "Engine coolant temperature", dataBytes: [1], formula: "A-40", unit: "degC", decode: (d) => d[0] - 40 },
  { pid: 0x06, id: "short_term_fuel_trim_bank1", quantity: "Short-term fuel trim, bank 1", dataBytes: [1, 2], formula: "100*A/128-100", unit: "%", decode: trim, note: TRIM_NOTE },
  { pid: 0x07, id: "long_term_fuel_trim_bank1", quantity: "Long-term fuel trim, bank 1", dataBytes: [1, 2], formula: "100*A/128-100", unit: "%", decode: trim, note: TRIM_NOTE },
  { pid: 0x08, id: "short_term_fuel_trim_bank2", quantity: "Short-term fuel trim, bank 2", dataBytes: [1, 2], formula: "100*A/128-100", unit: "%", decode: trim, note: TRIM_NOTE },
  { pid: 0x09, id: "long_term_fuel_trim_bank2", quantity: "Long-term fuel trim, bank 2", dataBytes: [1, 2], formula: "100*A/128-100", unit: "%", decode: trim, note: TRIM_NOTE },
  { pid: 0x0b, id: "intake_manifold_pressure", quantity: "Intake manifold absolute pressure", dataBytes: [1], formula: "A", unit: "kPa", decode: (d) => d[0] },
  { pid: 0x0c, id: "engine_speed", quantity: "Engine speed", dataBytes: [2], formula: "(256*A+B)/4", unit: "rpm", decode: (d) => word(d) / 4 },
  { pid: 0x0d, id: "vehicle_speed", quantity: "Vehicle speed", dataBytes: [1], formula: "A", unit: "km/h", decode: (d) => d[0] },
  { pid: 0x0e, id: "timing_advance", quantity: "Timing advance", dataBytes: [1], formula: "A/2-64", unit: "deg_before_tdc", decode: (d) => d[0] / 2 - 64 },
  { pid: 0x0f, id: "intake_air_temperature", quantity: "Intake air temperature", dataBytes: [1], formula: "A-40", unit: "degC", decode: (d) => d[0] - 40 },
  { pid: 0x10, id: "mass_air_flow", quantity: "Mass air flow rate", dataBytes: [2], formula: "(256*A+B)/100", unit: "g/s", decode: (d) => word(d) / 100 },
  { pid: 0x11, id: "throttle_position", quantity: "Absolute throttle position", dataBytes: [1], formula: "100*A/255", unit: "%", decode: percent },
  { pid: 0x1f, id: "run_time_since_start", quantity: "Run time since engine start", dataBytes: [2], formula: "256*A+B", unit: "s", decode: word },
  { pid: 0x42, id: "control_module_voltage", quantity: "Control module voltage", dataBytes: [2], formula: "(256*A+B)/1000", unit: "V", decode: (d) => word(d) / 1000 },
]);

export function pidDefinition(pid: number): PidDefinition | undefined {
  return PID_TABLE.find((definition) => definition.pid === pid);
}

export type PidValue =
  | {
      status: "decoded";
      pid: number;
      id: string;
      value: number;
      unit: string;
      formula: string;
      data: number[];
      /** Data bytes the formula does not use (kept, not interpreted). */
      undecoded: number[];
    }
  | { status: "not_decoded"; pid: number; reason: string; data: number[] };

/** Decodes the data bytes of one PID; the length must be one the table allows. */
export function decodePidData(pid: number, data: readonly number[]): BodyDecode<PidValue> {
  const definition = pidDefinition(pid);
  if (!definition) return { ok: true, value: { status: "not_decoded", pid, reason: "PID is not in the reviewed table", data: [...data] } };
  if (!definition.dataBytes.includes(data.length)) {
    return { ok: false, reason: `${data.length} data bytes where ${definition.dataBytes.join(" or ")} are required for PID ${definition.id}` };
  }
  const used = definition.dataBytes[0];
  return {
    ok: true,
    value: {
      status: "decoded",
      pid,
      id: definition.id,
      value: definition.decode(data),
      unit: definition.unit,
      formula: definition.formula,
      data: [...data],
      undecoded: data.slice(used),
    },
  };
}

/** A live ($01) value: read now. */
export type LiveValue = { source: "current_data" } & PidValue;
/** A freeze-frame ($02, frame 0) value: stored by the ECU when it set a code. Not a live measurement. */
export type FreezeFrameValue = { source: "freeze_frame"; frame: 0 } & PidValue;

/** Bitmap PIDs, readiness ($01 `01`) and the freeze-frame DTC ($02 `02`) have their own readers. */
function refuseSpecial(pid: number, own: number, service: string) {
  if (pid === own || pid % 0x20 === 0) throw new RangeError(`$${service} PID ${pid} has its own reader`);
}

/** `01` + PID: a current value. Bitmap PIDs and PID `01` have their own readers. */
export function readCurrentPid(result: CommandResult, family: ProtocolFamily, pid: number): ServiceRead<LiveValue> {
  refuseSpecial(pid, 0x01, "01");
  return readService(result, family, { service: "01", pid }, (body) => {
    const decoded = decodePidData(pid, body);
    return decoded.ok ? { ok: true, value: { source: "current_data", ...decoded.value } } : decoded;
  });
}

/** `02` + PID + `00`: a freeze-frame value. Bitmap PIDs and PID `02` have their own readers. */
export function readFreezeFramePid(result: CommandResult, family: ProtocolFamily, pid: number): ServiceRead<FreezeFrameValue> {
  refuseSpecial(pid, 0x02, "02");
  return readService(result, family, { service: "02", pid, frame: 0 }, (body) => {
    const decoded = decodePidData(pid, body);
    return decoded.ok ? { ok: true, value: { source: "freeze_frame", frame: 0, ...decoded.value } } : decoded;
  });
}

/** The DTC that stored freeze frame 0; `none_stored` for `0000`. */
export type FreezeFrameDtc = { status: "stored"; code: string; raw: number[] } | { status: "none_stored"; raw: number[] };

/** `020200`: the DTC that caused freeze frame 0 to be stored. */
export function readFreezeFrameDtc(result: CommandResult, family: ProtocolFamily): ServiceRead<FreezeFrameDtc> {
  return readService<FreezeFrameDtc>(result, family, { service: "02", pid: 0x02, frame: 0 }, (body) => {
    if (body.length !== 2) return { ok: false, reason: `${body.length} data bytes where 2 are required` };
    const raw = [...body];
    return body[0] === 0 && body[1] === 0 ? { ok: true, value: { status: "none_stored", raw } } : { ok: true, value: { status: "stored", code: decodeDtc(body[0], body[1]), raw } };
  });
}
