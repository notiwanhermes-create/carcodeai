# CarCode scanner architecture (proposed)

Status: **proposed design.** On 2026-10-26 the person directed
implementation of the read-only developer preview (tasks S1–S12 below); S1–S7
are implemented on research branches, nothing is released, and the approval
requests below stay not approved. S7 was implemented as one scanner
controller (`scanner/controller.ts`, `scanner/report.ts`) covering the
`scanner/` parts of S7–S9: discovery, the scan flow and reports, bounded
user-started live polling, cancellation and person-started recovery. Labels are defined in
[thinkcar-observed-architecture](thinkcar-observed-architecture.md#provenance-labels).
`AGENTS.md` remains binding and wins on any conflict.

Research set: [thinkcar-observed-architecture](thinkcar-observed-architecture.md) ·
[vci-transport](vci-transport.md) · [protocol-stack](protocol-stack.md) ·
[module-discovery](module-discovery.md) · [live-data](live-data.md) ·
[scan-flow](scan-flow.md) · this document ·
[capability-gap-analysis](capability-gap-analysis.md)

## Repository facts this design starts from

- **OBSERVED**: no scanner, transport or vehicle-communication code exists in
  the repository, and there is no `app/scanner/` route and no
  `app/lib/vehicle-communication/` directory.
- **OBSERVED** (`AGENTS.md`): `app/lib/diagnostic-workflow/` has no AI SDK, no
  database, no network and **no vehicle communication**; the bridge and
  persistence layers have their own boundaries.
- **OBSERVED** (`app/lib/diagnostic-workflow/types.ts:152-165`): scan evidence
  enters Guided Diagnostics (GD) as `DiagnosticScanInput`, through
  `SessionStartFacts.scans` (`types.ts:696-703`), the service's
  `StartRequest.scans` (`app/lib/diagnostic-workflow-service/service.ts:66-75`),
  or a `codes_absent` verification entry (`types.ts:716-717`).
- **OBSERVED** (`app/lib/diagnostic-workflow/engine.ts:393-400`): measurement
  steps accept source `scan_tool`; actuator tests and service functions are
  modelling-only and performed by an "external tool"
  (`types.ts:495-524`, `853-854`).
- **OBSERVED**: the garage vehicle page is `app/garage/[id]/page.tsx`
  (client part `app/garage/[id]/VehicleClient.tsx`); there is no garage index
  page under `app/garage/`.

## Baseline requirements and deviations

The baseline below follows the project goal for the scanner prototype: the
`app/lib/vehicle-communication/` layout with a `scanner/` layer, both browser
transports (Web Bluetooth and Web Serial), readiness (`$01` PID `01`), live
polling with start/stop, a `/scanner` route linked from the garage, guest use
without a database, the goal's own environment gate, and a pure evidence mapper
with **no** GD session wiring. Where this design would prefer something
different, it is listed under [Approval requests](#approval-requests) and is
**not** part of the baseline.

## Layers (Proposed)

```
app/lib/vehicle-communication/   (prescribed path, not created)
  transport/   ByteTransport: web-bluetooth, web-serial, simulated
  elm/         framing, error tokens, command policy, cancellation, timeouts
  obd/         request builders, per-ECU ISO-TP reassembly, DTC, PID and readiness decoding
  scanner/     discovery, scan flow, live polling, lifecycle, ScannerReport
  evidence/    toDiagnosticScanInput(report): the ONLY module importing GD types
app/scanner/page.tsx             (/scanner route, not created)
```

Details: [vci-transport](vci-transport.md), [protocol-stack](protocol-stack.md),
[module-discovery](module-discovery.md), [live-data](live-data.md),
[scan-flow](scan-flow.md).

## Scanner independence

Rules (Proposed, INFERRED; each checked by a test or lint rule when built):

1. `app/lib/diagnostic-workflow*/` never imports
   `app/lib/vehicle-communication/`. The engine stays free of vehicle
   communication, as `AGENTS.md` requires.
2. Inside `app/lib/vehicle-communication/`, only `evidence/` imports from GD,
   and only **types** (`import type`). It may call nothing in the engine.
   Tests of the mapper may call GD's pure `normalizeScan` to prove the output
   is accepted.
3. `transport/`, `elm/`, `obd/` and `scanner/` import nothing from GD, the AI
   bridge, Prisma or the service. They run, and are tested, with no database
   and no network.
4. The scanner is client-only code. No server action or API route talks to a
   vehicle, and no new `app/api/*` route is added for scanning. The `/scanner`
   page reads and writes no database.
5. The scanner never decides anything diagnostic: no pass/fail, no cause, no
   "safe to drive", no meanings attached to codes, no judgement of readiness.
   It reports what was read and how reliably.
6. **No GD session wiring in the preview.** Nothing in the preview starts,
   submits to, or attaches evidence to a GD session, suggests a GD capability
   context, or calls the GD service. The mapper is a pure function whose output
   is only shown (and tested); connecting it to sessions is a later,
   human-gated task.

## One-way evidence mapping

`ScannerReport → DiagnosticScanInput` is a pure function. GD output never
flows back into the scanner, and the mapper never strengthens evidence. In the
preview its output is displayed and exercised by tests only (rule 6).

| ScannerReport | GD field (OBSERVED type, `types.ts`) | Rule (Proposed) |
| --- | --- | --- |
| new id per scan | `id` (`/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/`, `dtc.ts:33`) | Generated, unique; never reused |
| — | `source: "scan_tool"` (`:157`) | Always `scan_tool` |
| scan ended / step outcomes | `completeness` (`:122`) | Always `partial` in the preview ([scan-flow](scan-flow.md#completeness-and-coverage)) |
| discovered ECUs | `coverage.modules` (`:160`) | Always set: module ids of ECUs that answered discovery |
| services `ok` for every ECU | `reportsStatus` (`:162`) | Only those flags; omitted when none |
| DTCs per ECU, merged across $03/$07/$0A | `codes[]` (`:129-138`) | `format: "obd"`, `status` from the service mapping, `module: { id }` |
| freeze frame per ECU | `snapshots[]` (`:144-150`) | Only parameters with a GD unit; `completeness` `partial` or `unknown`, never `complete`; no `captured` |
| freeze-frame DTC also in $03 for that ECU | `codes[].snapshot` (`:137`) | Linked; otherwise the snapshot stays standalone |
| readiness ($01 PID `01`), MIL status | — | Not mapped: GD has no readiness field (**OBSERVED**, no `readiness`/`monitor` in `types.ts`). Shown and kept in the ScannerReport |
| adapter identity, protocol, raw lines, step log, dropped items | — | Stay in the ScannerReport. GD has no field for them and gets none |
| VIN | — | Not mapped (GD `VehicleContext` has no VIN; the garage owns vehicle facts, `service.ts:62-63`) |
| live data | — | Not mapped ([live-data](live-data.md#live-data-and-guided-diagnostics)) |

Mapping gaps are listed in [capability-gap-analysis](capability-gap-analysis.md#guided-diagnostics-mapping-gaps).

## Preview acceptance criteria

A scanner preview is acceptable only when **all** hold (Proposed):

1. **Gate**: the preview is available exactly under the environment condition
   stated in the project goal, and under no other. The goal's wording, copied
   verbatim (supplied by the person running the project, 2026-10-26):

   > "a /scanner page (client-side) reached by a Connect Scanner link from the
   > garage (guest and signed-in), available when NODE_ENV is not production or
   > CARCODE_SCANNER_PREVIEW=1, otherwise not found; works for guests without a
   > database."

   So: `NODE_ENV` other than `production` means available;
   `CARCODE_SCANNER_PREVIEW=1` means available (in any environment); otherwise
   the route answers "not found". The S12 task covers each branch with one test.
   The gate is separate from, and not implied by, `GUIDED_DIAGNOSTICS_PREVIEW`.
   Gate off means no UI and no code path reachable.
2. **Route and navigation**: a `/scanner` route exists, and the garage vehicle
   page (`app/garage/[id]/page.tsx`) links to it when the gate is on (no link
   when off).
3. **Guest operation**: `/scanner` works for a signed-out guest and with no
   database configured or reachable. It performs no database read or write, no
   server action and no API call; nothing is persisted.
4. **Both transports**: Web Bluetooth and Web Serial are each offered when
   feature detection finds them, and each is covered by its own tests against a
   fake browser API.
5. **Functions**: connect, discover, read stored / pending / permanent codes,
   show freeze frame 0, show readiness ($01 PID `01`: MIL, DTC count, monitor
   support and completion), and **live polling with explicit Start and Stop
   controls** (one command in flight; Stop, disconnect, page hide and
   unmount all end polling; Start refused while a code read is running).
6. **Labelling**: every screen states "Preview. Generic OBD-II only. Not all
   modules or codes are visible. Not tested with your adapter or vehicle."
   Readiness "incomplete" is labelled as a monitor status, not a fault.
7. **Read-only**: the command allowlist is the only path to the adapter; tests
   assert that every denied command writes zero bytes; no `04`, no `08`, no
   UDS/KWP services.
8. **Fail closed**: every adapter error token, malformed response and lifecycle
   race in the [simulated test matrix](scan-flow.md#simulated-test-matrix) has a
   passing test, and none produces data.
9. **Provenance**: every scan yields a ScannerReport; every mapped scan is
   `partial`, has `coverage`, lists only `reportsStatus` flags whose services
   succeeded everywhere, and is accepted unchanged by GD `normalizeScan`.
10. **Independence**: the import rules above are enforced by a test or lint
    rule; nothing in the preview submits to or attaches to a GD session; GD's
    existing test suites pass unchanged.
11. **Compatibility honesty**: feature detection decides what is offered; an
    unsupported browser (including all iOS browsers) gets a plain explanation,
    not a failing button.
12. **Adapter honesty**: BLE profiles are marked `community_unverified` until
    validated; no adapter is named as compatible.
13. **Privacy**: raw lines and VIN stay on the device.
14. **Validation status shown**: the real-adapter and real-vehicle validation
    status below is accurate at the time of the preview.

## Small-task implementation sequence

Each task is one reviewable change with its own tests, started only on
approval. None needs a new dependency (INFERRED: Web Bluetooth and Web Serial
are browser APIs; TypeScript DOM typings for them may be missing and would be
declared locally rather than added as a package). Row numbers refer to the
[simulated test matrix](scan-flow.md#simulated-test-matrix).

| Task | Scope | Tests | Real hardware |
| --- | --- | --- | --- |
| S0 | These documents | — | No |
| S1 | `vehicle-communication/` types and outcome enums; command allowlist as data + pure check | Exhaustive allow/deny tests (rows 26–27) | No |
| S2 | `elm/` framer: bytes → lines → response at `>`; echo, CR/LF, NUL, byte cap | Rows 1–5 | No |
| S3 | `elm/` response classifier (error tokens) | Rows 6–9 | No |
| S4 | Simulated transport and scripted adapter model | Used by S5 onward | No |
| S5 | `elm/` command runner: one in flight, timeouts, AbortSignal, interrupt, late-reply drain | Rows 28–30, 32–34 | No |
| S6 | `obd/`: per-ECU ISO-TP with padding handling, $01 bitmaps, $03/$07/$0A, $02 bitmap and frame 0, $09 VIN, readiness PID `01`, reviewed PID table | Rows 10–19, 22–24, 37–44, 49–52 | No |
| S7 | `scanner/` discovery | Rows 6, 8, 12, 16, 21, 23 | No |
| S8 | `scanner/` scan flow (readiness, codes, $02 probe), lifecycle, ScannerReport | Rows 20, 21, 24, 31, 45–48 | No |
| S9 | `scanner/` live polling: start/stop, bounded sequential cycle, stop on abort / hide / disconnect / unmount | Rows 53–57 | No |
| S10 | `evidence/` pure mapper (decide module-id question first) | Rows 25, 35, 36 | No |
| S11a | Web Bluetooth transport with profile table | Unit tests with a fake `navigator.bluetooth`; **no claim of real-device behaviour** | No (pending) |
| S11b | Web Serial transport | Unit tests with a fake `navigator.serial`; **no claim of real-device behaviour** | No (pending) |
| S12 | Gated `/scanner` route, garage link, guest/no-database operation, UI for connect, discover, codes, freeze frame, readiness, live Start/Stop | Gate tests per the goal's condition; guest test with no database; UI tests with the simulated transport | No |
| S13 | Real-adapter and real-vehicle validation, by a person, recorded per adapter / firmware / vehicle / protocol | Manual, logged | **Yes: pending** |

No task in this sequence connects scanner output to a GD session.

## Approval requests

These are **not** baseline requirements. Each needs a person's decision; until
then the baseline above applies.

1. **Production refusal.** An earlier draft proposed that the scanner preview
   be refused in production regardless of its flag, like the V2J GD gate
   (`docs/research/guided-diagnostics/v2j-contract.md:26-28`). If that is
   wanted in addition to the goal's gate, it must be approved as a change to
   the goal's condition.
2. **GD session integration** (a "use this reading" action, attaching a mapped
   scan to a session, suggesting a capability context). Out of the preview by
   rule 6; a later human-gated task.
3. **Non-CAN protocols** remain out of the preview
   ([protocol-stack](protocol-stack.md#protocols)) unless approved with their
   own fixtures.

## Validation status

- **Simulated validation**: S1–S7 pass their tests against scripted adapters
  only, per the [simulated test matrix](scan-flow.md#simulated-test-matrix);
  S10–S12 are not yet built. Page hide, navigation and unmount reach the
  controller only through `cancel()` / `dispose()`, which S12 must wire. PID and readiness tables: primary-source check
  **pending** ([live-data](live-data.md#primary-source-check-pending)).
- **Real-adapter validation: PENDING.** No adapter of any kind has been
  connected. No BLE UUID has been confirmed on a device.
- **Real-vehicle validation: PENDING.** No vehicle has been read.
- **THINKCAR / ThinkDiag**: not evaluated; internals UNKNOWN
  ([thinkcar-observed-architecture](thinkcar-observed-architecture.md)).

Passing the simulated suite will show the code behaves as **designed** against
**scripted** adapters. It will not show that any real adapter or vehicle
behaves as scripted; only S13 can.
