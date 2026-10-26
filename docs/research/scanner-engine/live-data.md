# Scanner engine research: live data and freeze frames

Status: **research note and proposed design, documentation only.** Labels are
defined in [thinkcar-observed-architecture](thinkcar-observed-architecture.md#provenance-labels).
`AGENTS.md` remains binding.

## Two different things

- **Live data** ($01): values read now, while the vehicle runs.
- **Freeze frame** ($02, frame 0): values an ECU stored at the moment it set a
  code (STANDARD-DOCUMENTED (unverified copy), SAE J1979 $02).

**OBSERVED** (`AGENTS.md`, "Freeze-frame evidence is distinct from live
measurements"; `app/lib/diagnostic-workflow/types.ts:143-150`, `SnapshotInput`
"Not a live measurement"). The scanner keeps them apart in its own types, and
the mapper sends freeze frames only into `SnapshotInput` and never sends live
data into a snapshot.

## Rules for every value (Proposed, INFERRED)

1. A value is shown only for a PID the ECU **reported as supported** in its
   bitmap. An unsupported PID is `unsupported`, an unknown-support PID is
   `support_unknown`. Neither is ever shown as `0`, blank-as-zero, or "OK"
   ("Unknown context is not false", `AGENTS.md`).
2. Each value carries: ECU response id, PID, raw data bytes, decoded value,
   unit, the formula's table row id, and the caller-supplied read time. The raw
   bytes are kept so a formula correction can be audited.
3. A response with the wrong length for its PID is `malformed`; nothing is
   decoded from it.
4. When two ECUs answer the same PID, both values are kept, attributed. The
   scanner never averages or picks one.
5. No value is judged "good" or "bad" by the scanner. Judging a reading is the
   Guided Diagnostics engine's job, against **verified** specifications only
   (`AGENTS.md`, "Only verified/trusted specifications may drive pass/fail").
6. Polling is sequential (one command in flight) and bounded (Proposed: at most
   8 PIDs per refresh cycle in the preview). See [Live polling](#live-polling-start--stop).

## Live polling (Start / Stop)

Proposed (INFERRED); a baseline requirement of the preview
([carcode-scanner-architecture](carcode-scanner-architecture.md#preview-acceptance-criteria)):

- Polling runs only after an explicit **Start**, for PIDs the person selected
  from those each ECU reported as supported. It never starts by itself.
- **Stop** aborts the in-flight command (ELM interrupt, as in
  [protocol-stack](protocol-stack.md#cancellation)) and ends the loop; no value
  from the interrupted command is shown.
- Disconnect, page hide, navigation and unmount also stop polling. Polling does
  not resume by itself; the person presses Start again.
- Start is refused (`busy`) while discovery or a code read is running, and a
  code read is refused while polling runs; the two never interleave commands.
- Every displayed value is replaced only by a newer value for the same ECU and
  PID; a failed read shows its outcome (`no_response`, `malformed`, …), not the
  previous number as if current.
- Polled values are display-only and are not written anywhere.

## Readiness ($01 PID `01`)

Read once per scan, per ECU that lists PID `01` in its $01 bitmap. Layout
STANDARD-DOCUMENTED (unverified copy), SAE J1979 $01 PID `01` "monitor status
since DTCs cleared", cross-checked against
<https://en.wikipedia.org/wiki/OBD-II_PIDs> (section "Service 01", PID `01`;
public, secondary). **The bit table must be re-checked against a primary
source before S6 lands.**

| Bytes / bits | Meaning |
| --- | --- |
| A7 | MIL commanded on |
| A6–A0 | Count of emission-related DTCs |
| B3 | Ignition type: 0 spark, 1 compression (selects the meaning of C and D) |
| B0–B2 / B4–B6 | Misfire, fuel system, components: monitor available / monitor incomplete |
| C / D | Engine-type-specific monitors: available (C) / incomplete (D), same bit order |

Rules (Proposed, INFERRED):

1. Each monitor is one of `not_available`, `complete`, `incomplete`. A monitor
   whose "available" bit is clear is `not_available`, never `complete`. Reserved
   bits are kept raw and not interpreted.
2. `incomplete` is shown as a monitor status, never as a fault or a failure;
   the scanner draws no "ready for inspection" conclusion.
3. The A6–A0 count is compared with that ECU's $03 result. A mismatch is
   recorded in the ScannerReport as `dtc_count_mismatch`; neither value
   overrides the other, and the $03 list is not padded or trimmed.
4. Readiness and MIL are not mapped to GD (**OBSERVED**: no readiness field in
   `app/lib/diagnostic-workflow/types.ts`).

## PID table (preview)

Formulas: SAE J1979 (unverified copy), cross-checked against
<https://en.wikipedia.org/wiki/OBD-II_PIDs> (public, secondary). `A`, `B` are
the first and second data bytes. **Each row must be re-checked against a
primary source before S6 lands**, and the table records who checked and when.

The "GD unit" column uses the repository's unit list (**OBSERVED**,
`app/lib/diagnostic-workflow/types.ts:223`: `V, mV, ohm, kohm, A, kPa, bar, psi,
ms, Hz, rpm, percent, degC`).

| PID | Quantity | Formula | Scanner unit | GD unit | Proposed generic parameter id |
| --- | --- | --- | --- | --- | --- |
| `04` | Calculated engine load | `100·A/255` | % | `percent` | `calculated_load` |
| `05` | Engine coolant temperature | `A − 40` | °C | `degC` | `coolant_temperature` |
| `06`/`08` | Short-term fuel trim, bank 1/2 | `100·A/128 − 100` | % | `percent` | `short_term_fuel_trim_bank1` / `_bank2` |
| `07`/`09` | Long-term fuel trim, bank 1/2 | `100·A/128 − 100` | % | `percent` | `long_term_fuel_trim_bank1` / `_bank2` |
| `0B` | Intake manifold absolute pressure | `A` | kPa | `kPa` | `intake_manifold_pressure` |
| `0C` | Engine speed | `(256·A + B)/4` | rpm | `rpm` | `engine_speed` |
| `0D` | Vehicle speed | `A` | km/h | **none** | `vehicle_speed` |
| `0E` | Timing advance | `A/2 − 64` | ° before TDC | **none** | `timing_advance` |
| `0F` | Intake air temperature | `A − 40` | °C | `degC` | `intake_air_temperature` |
| `10` | Mass air flow rate | `(256·A + B)/100` | g/s | **none** | `mass_air_flow` |
| `11` | Absolute throttle position | `100·A/255` | % | `percent` | `throttle_position` |
| `1F` | Run time since engine start | `256·A + B` | s | `ms` only (×1000) | `run_time_since_start` |
| `42` | Control module voltage | `(256·A + B)/1000` | V | `V` | `control_module_voltage` |

PID `01` (MIL and monitor status) is a bit field handled separately under
[Readiness](#readiness-01-pid-01). Not in the preview (INFERRED: need their own
review): other bit-field PIDs such as `03` (fuel system status), `1C` (OBD standard);
oxygen-sensor PIDs whose layout depends on `13` / `1D`; anything with a
manufacturer-specific meaning (PROPRIETARY-NOT-REIMPLEMENTED).

**Mapping gaps (OBSERVED from the unit list):** km/h, degrees of crank angle,
g/s, seconds (only `ms` exists) and many others have no GD unit. Proposed
(INFERRED): the scanner shows such values with their own unit, and the mapper
**omits** them from a snapshot rather than sending a number without a unit or
inventing a conversion. `SnapshotParameter.unit` is optional
(**OBSERVED**, `types.ts:141`, and `dtc.ts:84-97` accepts a number with no unit),
so a unitless number would be accepted by GD; that is why the mapper, not GD,
must refuse it. Run time may be converted s → ms exactly (×1000) if a workflow
needs it; otherwise omitted. Listed in
[capability-gap-analysis](capability-gap-analysis.md#guided-diagnostics-mapping-gaps).

**Parameter ids (OBSERVED)**: snapshot parameter ids must match
`/^[a-z0-9][a-z0-9_.-]{0,63}$/` (`dtc.ts:32,86`). The proposed ids above fit.
**OBSERVED**: no workflow under `app/lib/diagnostic-workflow-content/workflows/`
uses a `snapshot_check` step today (no `snapshot_check` or `parameter:` there), so these ids are not yet
referenced by any content. The type's own example is `coolant_temperature`
(`types.ts:540`).

## Freeze frames to GD snapshots (Proposed)

- One `SnapshotInput` per ECU that returned a valid freeze frame (frame 0).
- The ECU's freeze-frame supported-PID bitmap comes from its own answer to
  `020000` ($02, PID `00`, frame `00`), not from its $01 bitmap: $01 support
  says nothing about $02 (see [scan-flow](scan-flow.md#freeze-frame-probe-02)).
- `parameters`: only PIDs that ECU's $02 bitmap lists and that
  have a GD unit (above). A PID that the ECU listed but returned `NO DATA` or
  malformed is omitted, and the snapshot's `completeness` is `partial`.
  Otherwise `completeness` is `unknown` (INFERRED: the scanner cannot prove it
  read every value the ECU stored, so it never claims `complete`).
- **No empty snapshot.** **OBSERVED** (`dtc.ts:136`): GD refuses a snapshot whose
  `parameters` list is empty, and refusing it fails the whole scan. So when no
  valid, GD-compatible parameter remains for an ECU (every read failed, or every
  value lacks a GD unit), the mapper emits **no** `SnapshotInput` for that ECU,
  and no code observation references one. The raw freeze-frame answers and the
  reason ("no mappable parameter") stay in the `ScannerReport`
  (`droppedForMapping`), so the evidence is kept but never sent to GD.
- **OBSERVED** (`types.ts:136-137`, `dtc.ts:174-181`): a code may name one
  snapshot of the same scan, and a snapshot may be named by at most one code.
  Proposed: $02 PID `02` (`020200`) gives the DTC that stored the freeze frame. If that
  code is among the same ECU's $03 results, that code observation references
  the snapshot. If it is not, the snapshot stays standalone; the scanner does
  **not** add the code to the scan, because that would invent a status.
- `captured`: left out. A freeze frame carries no capture time on generic OBD
  (INFERRED). The scanner's read time is not the capture time and is never put
  there.

## Live data and Guided Diagnostics

**OBSERVED** (`app/lib/diagnostic-workflow/engine.ts:393-400`): a measurement
step accepts source `instrument` or `scan_tool`; observation, question and
prerequisite steps accept only `person`. **OBSERVED**
(`types.ts:237-248`): `MeasurementDefinition` has a free-text `quantity` and a
unit, but no machine-readable parameter id.

Consequences (INFERRED):

- There is no deterministic link from a PID to a measurement step.
- **The preview has no GD interaction for live data**: no submission, no
  "use this reading" action, no attachment to a session
  ([carcode-scanner-architecture](carcode-scanner-architecture.md#scanner-independence),
  rule 6). Live values are display-only on `/scanner`.
- Any later link (manual or automatic) is a separate, human-gated GD
  integration task; an automatic link would also need a GD change (a parameter
  id on `MeasurementDefinition`).
- The reviewed misfire workflow's "Per-cylinder misfire data (scan tool)" step
  is an `observation` (**OBSERVED**, `generic-gasoline-misfire.ts:141-151`), so
  the person answers it; the scanner cannot be its source. Per-cylinder misfire
  counts are not standard $01 PIDs (INFERRED; often reported through $06
  monitor test results, which the preview defers).
