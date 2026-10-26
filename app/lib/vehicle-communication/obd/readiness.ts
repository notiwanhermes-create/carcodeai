/**
 * Readiness: $01 PID `01`, "monitor status since DTCs cleared" (live-data.md,
 * "Readiness").
 *
 * RESEARCH PROTOTYPE. Pure. Layout STANDARD-DOCUMENTED (unverified copy),
 * SAE J1979 $01 PID `01`, cross-checked only against the public secondary
 * source <https://en.wikipedia.org/wiki/OBD-II_PIDs> ("Service 01", PID 01).
 * PRIMARY-SOURCE CHECK PENDING: the bit table has not been checked against a
 * licensed copy of SAE J1979 (see `READINESS_TABLE_REVIEW`).
 *
 * Each monitor is `not_available` (its "available" bit is clear, whatever the
 * other bit says), `complete` or `incomplete`. `incomplete` is a monitor
 * status, not a fault. Reserved bits are kept raw and not interpreted. The
 * scanner draws no "ready" conclusion.
 */
import type { CommandResult } from "../elm/executor";
import type { ProtocolFamily } from "./frames";
import type { DtcList } from "./dtc";
import { readService, type EcuIdentity, type ServiceRead } from "./response";

export const READINESS_TABLE_REVIEW = Object.freeze({
  standard: "SAE J1979 $01 PID 01 (unverified copy)",
  secondaryCrossCheck: "https://en.wikipedia.org/wiki/OBD-II_PIDs (Service 01, PID 01)",
  primarySourceCheck: "pending" as const,
});

export type MonitorStatus = "not_available" | "complete" | "incomplete";

export type Monitor = { id: string; group: "continuous" | "engine_specific"; status: MonitorStatus };

export type Readiness = {
  milOn: boolean;
  /** A6-A0: count of emission-related DTCs, as reported. */
  dtcCount: number;
  /** B3: selects the meaning of bytes C and D. */
  ignition: "spark" | "compression";
  monitors: Monitor[];
  /** Reserved bits that were set; kept, never interpreted. */
  reservedBitsSet: string[];
  raw: number[];
};

/** Byte B: [available bit, incomplete bit]. */
const CONTINUOUS = [
  ["misfire", 0, 4],
  ["fuel_system", 1, 5],
  ["comprehensive_components", 2, 6],
] as const;

/**
 * Bytes C (available) / D (incomplete), bit 0 first; null is a reserved bit.
 * Spark bit 4 is named differently by different editions of the secondary
 * source (A/C refrigerant; gasoline particulate filter), so its status is
 * kept under a neutral id and no meaning is asserted.
 */
const SPARK = ["catalyst", "heated_catalyst", "evaporative_system", "secondary_air_system", "spark_monitor_bit4", "oxygen_sensor", "oxygen_sensor_heater", "egr_vvt_system"] as const;
const COMPRESSION = ["nmhc_catalyst", "nox_scr_monitor", null, "boost_pressure", null, "exhaust_gas_sensor", "pm_filter", "egr_vvt_system"] as const;

const bit = (byte: number, n: number) => (byte >> n) & 1;

function status(available: number, incomplete: number): MonitorStatus {
  if (!available) return "not_available";
  return incomplete ? "incomplete" : "complete";
}

export function decodeReadiness(bytes: readonly number[]): Readiness {
  const [a, b, c, d] = bytes;
  const ignition = bit(b, 3) ? "compression" : "spark";
  const monitors: Monitor[] = CONTINUOUS.map(([id, av, inc]) => ({ id, group: "continuous", status: status(bit(b, av), bit(b, inc)) }));
  const reservedBitsSet: string[] = [];
  if (bit(b, 7)) reservedBitsSet.push("B7");
  const names = ignition === "spark" ? SPARK : COMPRESSION;
  names.forEach((id, n) => {
    if (id === null) {
      if (bit(c, n)) reservedBitsSet.push(`C${n}`);
      if (bit(d, n)) reservedBitsSet.push(`D${n}`);
      return;
    }
    monitors.push({ id, group: "engine_specific", status: status(bit(c, n), bit(d, n)) });
  });
  return { milOn: bit(a, 7) === 1, dtcCount: a & 0x7f, ignition, monitors, reservedBitsSet, raw: [...bytes] };
}

export function readReadiness(result: CommandResult, family: ProtocolFamily): ServiceRead<Readiness> {
  return readService(result, family, { service: "01", pid: 0x01 }, (body) =>
    body.length === 4 ? { ok: true, value: decodeReadiness(body) } : { ok: false, reason: `${body.length} data bytes where 4 are required` },
  );
}

export type DtcCountCheck = EcuIdentity &
  (
    | { status: "consistent"; count: number }
    | { status: "dtc_count_mismatch"; readinessCount: number; storedCount: number }
    | { status: "not_comparable" }
  );

/**
 * Compares each ECU's PID `01` count with its own $03 list (live-data.md
 * rule 3, scan-flow.md row 51). A mismatch is recorded; neither value is
 * changed. An ECU without an `ok` answer to both reads is `not_comparable`.
 */
export function compareDtcCounts(readiness: ServiceRead<Readiness>, stored: ServiceRead<DtcList>): DtcCountCheck[] {
  return readiness.ecus.map((answer) => {
    const identity = { responseId: answer.responseId, module: answer.module };
    const storedAnswer = stored.outcome === "ok" ? stored.ecus.find((candidate) => candidate.module === answer.module) : undefined;
    if (answer.outcome !== "ok" || storedAnswer?.outcome !== "ok") return { ...identity, status: "not_comparable" };
    const readinessCount = answer.value.dtcCount;
    const storedCount = storedAnswer.value.codes.length;
    return readinessCount === storedCount
      ? { ...identity, status: "consistent", count: readinessCount }
      : { ...identity, status: "dtc_count_mismatch", readinessCount, storedCount };
  });
}
