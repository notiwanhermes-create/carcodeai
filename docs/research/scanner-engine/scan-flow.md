# Scanner engine research: scan flow, lifecycle and provenance

Status: **research note and proposed design, documentation only.** Labels are
defined in [thinkcar-observed-architecture](thinkcar-observed-architecture.md#provenance-labels).
`AGENTS.md` remains binding.

## Code-read sequence (Proposed)

After discovery ([module-discovery](module-discovery.md#proposed-discovery-sequence)):

| Step | Request | Meaning | Label |
| --- | --- | --- | --- |
| 1 | `0101` (if any ECU's $01 bitmap lists PID `01`) | Readiness and MIL status ([live-data](live-data.md#readiness-01-pid-01)) | STANDARD-DOCUMENTED (unverified copy), SAE J1979 $01 |
| 2 | `03` | Stored emission-related DTCs, called "confirmed" in current J1979 wording | STANDARD-DOCUMENTED (unverified copy), SAE J1979 $03 |
| 3 | `07` | Pending DTCs (detected in the current or last drive cycle, not yet confirmed) | STANDARD-DOCUMENTED (unverified copy), SAE J1979 $07 |
| 4 | `0A` | Permanent DTCs (cannot be cleared by $04) | STANDARD-DOCUMENTED (unverified copy), SAE J1979 $0A |
| 5 | `020000`, then `020200`, then `02` + PID + `00` per listed PID | Freeze frame 0 ([probe below](#freeze-frame-probe-02)) | STANDARD-DOCUMENTED (unverified copy), SAE J1979 $02 |

Steps 1–4 are one command each; step 5 is a short series. Every command is
answered by zero or more ECUs. Each ECU's answer to each command gets its own
outcome (`ok`, `no_response`, `negative_response`, `malformed`, `interrupted`,
`timeout`, …). The scan never stops at the first problem unless the **link**
fails (transport lost, adapter unresponsive, adapter power event); a single
ECU's problem is recorded and the flow continues.

## Freeze-frame probe ($02)

STANDARD-DOCUMENTED (unverified copy), SAE J1979 $02: a request is service
`02`, a PID, and a frame number; PID `00` of frame `00` returns that ECU's
supported-PID bitmap **for the freeze frame**, and PID `02` returns the DTC
that caused the freeze frame to be stored (`0000` when none is stored). The
$01 bitmap describes current data only and says nothing about $02 support, so
it is never used to decide whether to ask an ECU for a freeze frame.

Proposed (INFERRED):

1. Send `020000` (functional request, like every other request). Each ECU's
   answer is classified on its own:
   - positive `42 00 00` + four bitmap bytes → that ECU's $02 bitmap is known;
   - `7F 02 <code>` → `negative_response` with its code: that ECU declined $02
     (recorded, not reinterpreted);
   - no line from that ECU, or `NO DATA` for the whole request → `no_response`:
     $02 support is `support_unknown` for that ECU, **not** `unsupported`;
   - malformed → `malformed`.
   Further bitmap ranges (`022000`, `024000`, …) follow the "next range" bit
   exactly as for $01.
2. Only ECUs with a known $02 bitmap continue. If that bitmap lists PID `02`,
   send `020200`; a `0000` answer means no freeze frame is stored for that ECU,
   and no further $02 request is made for it.
3. For each PID with a GD unit ([live-data](live-data.md#pid-table-preview))
   that the ECU's **$02** bitmap lists, send `02` + PID + `00`. A PID whose bit
   is clear in that ECU's $02 bitmap is `unsupported` for the freeze frame and is
   never requested; this is the only way a freeze-frame PID becomes
   `unsupported`.
4. Because requests are functional, other ECUs may answer a $02 request they
   were not the reason for. Their answers are recorded, but only used if their
   own $02 bitmap lists that PID.

## DTC status mapping (Proposed)

**OBSERVED** (`app/lib/diagnostic-workflow/types.ts:114-115`): GD status flags
are `pending`, `confirmed`, `permanent`, `history`, `active`.

| Service | GD flag | Label |
| --- | --- | --- |
| `03` | `confirmed` | INFERRED from J1979's wording for $03 (unverified copy) |
| `07` | `pending` | INFERRED |
| `0A` | `permanent` | INFERRED |
| none | `active` | Never used: generic OBD services do not report "present now", and **OBSERVED** (`dtc.ts:167-169`) GD refuses `active` unless the scan declares it in `reportsStatus` |
| none | `history` | Never used |

- `reportsStatus` lists **only** the flags of services that returned `ok` for
  **every** discovered ECU. **OBSERVED** (`dtc.ts:244-246`): GD concludes a
  flag is absent only when the scan says it reports that flag; listing a flag
  whose service partly failed would let GD read a failed read as "not
  pending". If no service succeeded for every ECU, `reportsStatus` is omitted.
- **OBSERVED** (`dtc.ts:168`): when `reportsStatus` is present, a code's
  status may not include a flag outside it. So a code found by `07` on an ECU
  where `07` succeeded, in a scan where `07` failed on another ECU, carries a
  flag GD would refuse. Proposed: the mapper **drops that flag from the code**
  (keeps the code with the remaining flags, or with status omitted = unknown)
  and records the drop in the ScannerReport. It never adds the flag to
  `reportsStatus` to make the input pass.
- **OBSERVED** (`dtc.ts:175`): GD refuses the same code listed twice for the
  same module. A code reported by both `03` and `07` on one ECU becomes **one**
  observation with both flags (`["confirmed", "pending"]`).

## Completeness and coverage

**OBSERVED** (`types.ts:117-122`, `dtc.ts:218-222`): `complete` means a code
not listed is not present within coverage; `partial` / `unknown` mean no
absence can be concluded. With `coverage`, absence is provable only for a
matcher that names a covered module.

Proposed (INFERRED):

- `coverage.modules` is **always** set, to the module ids of the ECUs that
  answered discovery. A scanner read therefore never supports a vehicle-wide
  "no code" conclusion, matching the real limit of generic OBD
  ([module-discovery](module-discovery.md#scope-what-discovery-can-mean-for-carcode)).
- `completeness` for the **preview is always `partial`.** Generic OBD cannot
  show that every emission-related ECU answered (an ECU that never answers the
  functional request is invisible), and this is the safest value.
- A later change may emit `complete` only when every one of $03, $07 and $0A
  returned `ok` for every discovered ECU, no `BUFFER FULL`, no interruption and
  no transport event occurred. That would let a workflow's module-scoped
  `noDtc` or `codes_absent` check pass on a covered module. **This is a
  product decision, not part of the preview** (see
  [capability-gap-analysis](capability-gap-analysis.md#decisions-needed)).
- A scan that failed before any code service ran is not mapped at all. There is
  no GD scan with "nothing read"; the person sees the failure reason.

## Partial-scan provenance

Every scan produces a `ScannerReport` (Proposed) that is kept with, but never
replaced by, the mapped GD input:

```ts
type StepRecord = {
  seq: number;                        // 1, 2, 3 in order sent
  command: string;                    // the allowlisted text actually sent
  at?: string;                        // supplied by the caller, as in GD
  outcome: CommandOutcome;            // ok | no_response | negative_response | malformed | interrupted | timeout | adapter_* | transport_lost ...
  perEcu: Array<{ responseId: string; outcome: EcuOutcome; rawLines: string[] }>;
};

type ScannerReport = {
  scannerVersion: string;
  transport: { kind: "web_bluetooth" | "web_serial" | "simulated"; profile?: { id: string; provenance: "community_unverified" | "validated" } };
  adapter: { reportedIdentity: string[] };              // ATI / AT@1, as reported
  protocol?: { number: string; auto: boolean };
  ecus: DiscoveredEcu[];
  steps: StepRecord[];
  ended: "finished" | "cancelled" | "transport_lost" | "adapter_unresponsive" | "failed";
  completeness: "partial";                               // preview
  droppedForMapping: Array<{ what: string; why: string }>;  // e.g. a flag removed, a unitless parameter omitted
};
```

Rules (Proposed, INFERRED):

- Nothing in the report is ever rewritten after the scan ends. A re-scan is a
  new report and a new GD scan id. **OBSERVED** (`dtc.ts:111`): GD refuses a
  scan id already in the session, so a later scan can never replace an earlier
  one.
- Raw lines are kept in the report on the device for audit. Whether the report
  is persisted server-side is a separate decision (privacy: it may hold a VIN).
- GD sees only the mapped `DiagnosticScanInput`; it never reads the report.

## Lifecycle

States (Proposed): `idle → connecting → initialising → discovering → ready →
scanning → ready → … → closing → closed`, with `failed` reachable from any
state.

| Event | Rule |
| --- | --- |
| `cancel()` during any step | Abort signal fires; the elm layer interrupts (CR, wait for `>`); the scan ends `cancelled`; results already completed are kept, marked as from a cancelled scan; the mapper still emits `partial` |
| `cancel()` twice, or after the scan ended | No-op |
| Second `scan()` while scanning | Refused (`busy`); never queued silently |
| `disconnect` event mid-command | In-flight command fails `transport_lost`; scan ends `transport_lost`; no reconnect |
| `close()` while scanning | Same as cancel, then transport close |
| Page hidden / navigation | Treated as cancel (Proposed; avoids a background radio session) |
| Response arrives after timeout | Drained until `>`, discarded, recorded as `late_reply_discarded` |
| Adapter prints its identity line mid-session (`LV RESET` or spontaneous reset) | `adapter_power_event`; scan ends `failed`; earlier steps kept |
| Connect while connected | Refused |
| Result delivered after the caller unsubscribed / unmounted | Dropped; no state update on a disposed scanner |

## Simulated test matrix

All automated tests use the simulated transport. **No test claims real-adapter
or real-vehicle behaviour.**

| # | Area | Scenario | Expected |
| --- | --- | --- | --- |
| 1 | Framing | Response split across many 1–20 byte chunks, prompt `>` in its own chunk | Same parsed result as unsplit |
| 2 | Framing | Two lines and `>` in one chunk | Parsed once, correctly |
| 3 | Framing | CR only, CRLF, stray LF, `0x00` bytes | Same result |
| 4 | Framing | Echo still on before `ATE0` | Echo line removed only until `ATE0` returns `OK` |
| 5 | Framing | No `>` and more than the byte cap | `framing_error`; adapter reset before next command |
| 6 | Protocol error | `?` to `ATH1` | Init fails `adapter_rejected_command`; no OBD request sent |
| 7 | Protocol error | `NO DATA` to `03` | `no_response`, never "no codes"; scan `partial` |
| 8 | Protocol error | `UNABLE TO CONNECT`, `BUS INIT: ...ERROR`, `CAN ERROR` | Distinct outcomes; discovery stops; nothing mapped |
| 9 | Protocol error | `BUFFER FULL` mid-response | `adapter_overflow`; that response unusable |
| 10 | Protocol error | Negative response `7F 03 xx` from one ECU | `negative_response` for that ECU; other ECU's codes kept |
| 11 | Protocol error | Response for wrong service / PID | `malformed` for that ECU |
| 12 | Protocol error | Non-CAN protocol detected | `unsupported_protocol`; no service request |
| 13 | Fragmentation | ISO-TP first + consecutive frames for `0902` | VIN reassembled |
| 14 | Fragmentation | Missing / repeated sequence number | `malformed` for that ECU only |
| 15 | Fragmentation | Fewer bytes than declared when `>` arrives | `malformed` |
| 16 | Multiple ECUs | `7E8` and `7E9` both answer `0100` | Two ECUs, separate bitmaps |
| 17 | Multiple ECUs | Interleaved multi-frame responses from two ECUs | Both reassembled correctly |
| 18 | Multiple ECUs | Same DTC from two ECUs | Two observations with different modules |
| 19 | Multiple ECUs | Same DTC from `03` and `07` on one ECU | One observation, `["confirmed","pending"]` |
| 20 | Multiple ECUs | `07` fails on one ECU | `pending` not in `reportsStatus`; flag dropped from other ECU's codes and recorded |
| 21 | Multiple ECUs | ECU answers `0100` but not `03` | `no_response` for that ECU; still in coverage |
| 22 | Unsupported capability | PID not in bitmap requested | Refused before sending; shown `unsupported` |
| 23 | Unsupported capability | Bitmap chain stops answering | Later ranges `support_unknown`, not unsupported |
| 24 | Unsupported capability | ECU answers `0100` (bitmap set) but gives no answer to `020000` | $02 `support_unknown` for that ECU (not `unsupported`); no snapshot; no code references one; $01 bits not used to infer $02 |
| 25 | Unsupported capability | Freeze-frame value in km/h or g/s | Omitted from snapshot; recorded in `droppedForMapping` |
| 26 | Command policy | Every denied example (`04`, `08`, `10 03`, `2E…`, `ATMA`, `ATSH…`, `ATPP…`) | Refused; zero bytes written (asserted on the simulated transport) |
| 27 | Command policy | Case / whitespace / CR-injection variants (`at ma`, `03\r04`) | Refused |
| 28 | Lifecycle race | Cancel while waiting for `>` | `STOPPED` handled; `cancelled`; no partial data from that command |
| 29 | Lifecycle race | Cancel and adapter never sends `>` | `adapter_unresponsive`; transport closed |
| 30 | Lifecycle race | Late reply after timeout, next command queued | Late reply discarded; next command's answer is its own |
| 31 | Lifecycle race | Disconnect during `07` | `transport_lost`; `03` results kept; scan `partial` |
| 32 | Lifecycle race | Second `scan()` while scanning | `busy`; first scan unaffected |
| 33 | Lifecycle race | `close()` during write | Write rejected; state `closed`; no further writes |
| 34 | Lifecycle race | Spontaneous adapter reset mid-scan | `adapter_power_event`; scan `failed` |
| 35 | Mapping | Every mapped scan from rows 1–34, 37–52 and 58–59 | Accepted by GD `normalizeScan` (`dtc.ts:106`) unchanged; `completeness: "partial"`; `coverage` set |
| 36 | Mapping | Mapped scan given to GD's pure absence check **in a unit test only** (no session, no service call) | `noDtc` without a module returns unknown; module-scoped `noDtc` returns unknown because `partial` |
| 37 | ISO-TP padding | Padded single frame, zero DTCs: `7E8 02 43 00 AA AA AA AA AA` | `ok`, zero codes for `7E8`; padding bytes excluded |
| 38 | ISO-TP padding | Same single frame without padding (`7E8 02 43 00`), as some adapters display it | Same result as row 37 |
| 39 | ISO-TP padding | Padded final consecutive frame: `7E8 10 08 43 03 01 33 02 44`, `7E8 21 03 55 AA AA AA AA AA` | Three codes for `7E8`; the five padding bytes excluded |
| 40 | ISO-TP padding | Multiple ECUs: row 37 from `7E8` interleaved with row 39's frames from `7E9` | `7E8` zero codes, `7E9` three codes; both `ok` |
| 41 | ISO-TP malformed | Single frame whose `SF_DL` exceeds the bytes present (`7E8 05 43 01 01 33`) | `malformed` for that ECU only |
| 42 | ISO-TP malformed | `SF_DL` of 0 or greater than 7; `FF_DL` below 8 | `malformed` for that ECU only |
| 43 | ISO-TP malformed | Extra consecutive frame after `FF_DL` bytes were received | `malformed` for that ECU only |
| 44 | ISO-TP malformed | Application length disagrees inside the declared length (`7E8 04 43 02 01 33 AA AA AA`: count 2, one pair) | `malformed`; padding never read as a DTC |
| 45 | Freeze frame | `NO DATA` to `020000` | Every ECU $02 `support_unknown`; no snapshot; not `unsupported` |
| 46 | Freeze frame | `7F 02 12` from `7E9`, valid bitmap from `7E8` | `negative_response` (code kept) for `7E9`; `7E8` freeze frame read |
| 47 | Freeze frame | PID set in an ECU's $01 bitmap but clear in its $02 bitmap | Not requested in $02; `unsupported` for the freeze frame only |
| 48 | Freeze frame | `020200` returns `0000` | No stored freeze frame; no snapshot; no further $02 request to that ECU |
| 49 | Readiness | Monitor "available" bit clear | `not_available`, never `complete` |
| 50 | Readiness | Compression ignition (B3 = 1) | C / D read with the compression-ignition monitor list |
| 51 | Readiness | PID `01` DTC count differs from that ECU's `03` list | `dtc_count_mismatch` recorded; both values kept unchanged |
| 52 | Readiness | PID `01` not in an ECU's $01 bitmap | `0101` not used for that ECU; readiness `unsupported` for it |
| 53 | Live polling | Start with three PIDs | Sequential reads; the transport never sees a second write before `>` |
| 54 | Live polling | Stop mid-command | Interrupt sent; loop ends; no value from the interrupted command |
| 55 | Live polling | Disconnect while polling | Polling stops `transport_lost`; no automatic restart |
| 56 | Live polling | Page hidden / unmount while polling | Polling stops; no state update after unmount |
| 57 | Live polling | Start during a code read; code read during polling | Both refused `busy`; the running activity is unaffected |
| 58 | Mapping | ECU has a stored freeze frame (`020200` gives a code that is also in its `03` list), but every requested $02 parameter read returns `NO DATA` or is malformed | No `SnapshotInput` for that ECU; its code observation has no `snapshot`; raw answers and "no mappable parameter" in `droppedForMapping`; the mapped scan is accepted by `normalizeScan` |
| 59 | Mapping | ECU's freeze frame reads succeed, but every value lacks a GD unit (e.g. only km/h and g/s values) | Same as row 58: no snapshot, no reference, drop recorded, scan accepted by `normalizeScan` |
