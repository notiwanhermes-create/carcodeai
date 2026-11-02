/**
 * Local copies of the Guided Diagnostics scan-input shapes the evidence mapper
 * builds (OBSERVED in GD's `types.ts`: `DiagnosticScanInput`,
 * `DtcObservationInput`, `SnapshotInput`, the status-flag and unit lists).
 *
 * The scanner imports nothing from GD, not even types: GD's own boundary
 * tests keep every app file outside GD free of GD imports while the engine is
 * unused by the app. So the shapes are mirrored here, narrowed to what a
 * generic OBD scan in the preview can produce, and
 * `tests/vehicle-communication-evidence.test.ts` proves they stay assignable
 * to GD's types and that GD's pure `normalizeScan` accepts the output.
 */

/** GD's status flags a generic OBD scan can report ($03 confirmed, $07 pending, $0A permanent); never `history` or `active`. */
export type DtcStatusFlag = "pending" | "confirmed" | "permanent";

/** GD's unit list, copied. */
export type Unit = "V" | "mV" | "ohm" | "kohm" | "A" | "kPa" | "bar" | "psi" | "ms" | "Hz" | "rpm" | "percent" | "degC";

/** Provenance only: an opaque module label, never addressing. */
export type ModuleOrigin = { id: string; name?: string };

export type DtcObservationInput = {
  code: string;
  format?: "obd" | "opaque";
  /** Reported flags; never empty when present. */
  status?: DtcStatusFlag[];
  module?: ModuleOrigin;
  /** The id of a snapshot in the same scan that was captured with this code. */
  snapshot?: string;
};

export type SnapshotParameter = { id: string; value: number; unit: Unit };

/** A freeze-frame snapshot: never `complete`, and no capture time (the ECU's capture time is not known). */
export type SnapshotInput = { id: string; parameters: SnapshotParameter[]; completeness: "partial" | "unknown" };

/** A generic OBD scan is always `partial`: a code it did not list may still be present. */
export type DiagnosticScanInput = {
  id: string;
  source: "scan_tool";
  completeness: "partial";
  coverage: { modules: string[] };
  reportsStatus?: DtcStatusFlag[];
  codes: DtcObservationInput[];
  snapshots?: SnapshotInput[];
};
