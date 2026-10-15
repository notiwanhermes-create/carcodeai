/**
 * ============================================================================
 *   SYNTHETIC / TEST ONLY SPECIFICATIONS
 *   NOT BMW, TOYOTA, FORD OR ANY MANUFACTURER'S DATA. NOT FROM ANY MANUAL.
 * ============================================================================
 *
 * Made-up values for the synthetic misfire workflow's tests and development.
 * They are not real limits for any vehicle and must never be shown to users
 * as such. Marked "verified" only so tests can exercise the trusted path.
 */
import type { DiagnosticSpecification } from "../types";

export const SYNTHETIC_SOURCE = { name: "SYNTHETIC / TEST ONLY: made up for CarCode's engine tests", reference: "not a real source" } as const;

export const SYNTHETIC_SPECIFICATIONS: readonly DiagnosticSpecification[] = [
  {
    id: "synthetic.cylinder_compression_min",
    revision: "SYNTHETIC-TEST-ONLY-r1",
    unit: "kPa",
    expected: { min: 900 },
    conditions: ["engine_off_cool"],
    source: SYNTHETIC_SOURCE,
    trust: "verified",
    note: "SYNTHETIC / TEST ONLY",
  },
  {
    id: "synthetic.fuel_supply_pressure_idle",
    revision: "SYNTHETIC-TEST-ONLY-r1",
    unit: "kPa",
    expected: { min: 300, max: 450 },
    source: SYNTHETIC_SOURCE,
    trust: "verified",
    note: "SYNTHETIC / TEST ONLY",
  },
];
