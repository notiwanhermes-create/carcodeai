/**
 * Units for measurement steps. A reading is converted only between units of
 * the same kind (pressure to pressure, voltage to voltage). Anything else is
 * refused: a reading in the wrong kind of unit is a mistake, not a value.
 */
import type { Unit } from "./types";

const KIND_AND_FACTOR: Record<Unit, { kind: string; factor: number }> = {
  V: { kind: "voltage", factor: 1 },
  mV: { kind: "voltage", factor: 0.001 },
  ohm: { kind: "resistance", factor: 1 },
  kohm: { kind: "resistance", factor: 1000 },
  A: { kind: "current", factor: 1 },
  kPa: { kind: "pressure", factor: 1 },
  bar: { kind: "pressure", factor: 100 },
  psi: { kind: "pressure", factor: 6.894757293168 },
  ms: { kind: "time", factor: 1 },
  Hz: { kind: "frequency", factor: 1 },
  rpm: { kind: "rotation", factor: 1 },
  percent: { kind: "ratio", factor: 1 },
  degC: { kind: "temperature", factor: 1 },
};

export function isUnit(value: unknown): value is Unit {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(KIND_AND_FACTOR, value);
}

/** The value in `to`, or null when the two units measure different things. Rounded to 6 decimals so replays compare exactly. */
export function convert(value: number, from: Unit, to: Unit): number | null {
  const a = KIND_AND_FACTOR[from];
  const b = KIND_AND_FACTOR[to];
  if (!a || !b || a.kind !== b.kind || !Number.isFinite(value)) return null;
  return Math.round(((value * a.factor) / b.factor) * 1e6) / 1e6;
}
