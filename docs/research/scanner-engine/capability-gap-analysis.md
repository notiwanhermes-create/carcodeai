# Scanner engine research: capability gap analysis

Status: **research note, documentation only.** Labels are defined in
[thinkcar-observed-architecture](thinkcar-observed-architecture.md#provenance-labels).
`AGENTS.md` remains binding.

## Basis of comparison

- **UNKNOWN**: what THINKCAR / ThinkDiag actually does internally. This
  analysis does **not** compare against it
  ([thinkcar-observed-architecture](thinkcar-observed-architecture.md)).
  Public marketing descriptions of any vendor's features were not used as
  evidence.
- The comparison is between the **proposed** CarCode scanner and what
  **generic, standardized OBD-II** allows in principle, plus capability
  categories GD already models (**OBSERVED**, `types.ts:57-59`:
  `none`, `codes`, `live_data`, `bidirectional`).

## Capability table

| Capability | Proposed CarCode preview | Label | Gap / reason |
| --- | --- | --- | --- |
| Read stored / pending / permanent emission DTCs | Yes ($03/$07/$0A, CAN only) | Proposed, INFERRED | Non-CAN protocols deferred |
| DTCs from non-emission modules (body, chassis, network) | No | PROPRIETARY-NOT-REIMPLEMENTED | Needs manufacturer-enhanced diagnostics |
| Manufacturer-specific DTC meanings | No | PROPRIETARY-NOT-REIMPLEMENTED | GD attaches no meanings either (**OBSERVED**, `types.ts:101`) |
| Clear DTCs ($04) | No (denied) | Proposed | Erases evidence; changes vehicle state |
| Freeze frame 0 | Yes, PIDs with a GD unit only | Proposed, INFERRED | Unit gaps below |
| Live data, standard $01 PIDs | Yes, small reviewed table, live polling with Start / Stop, display only | Proposed, INFERRED | No GD measurement link ([live-data](live-data.md#live-data-and-guided-diagnostics)) |
| Manufacturer live data (enhanced PIDs / DIDs) | No | PROPRIETARY-NOT-REIMPLEMENTED | |
| Readiness monitors and MIL status ($01 PID `01`) | Yes, per ECU, display only | Proposed; layout STANDARD-DOCUMENTED (unverified copy) | Not mapped: GD has no readiness field ([live-data](live-data.md#readiness-01-pid-01)) |
| On-board monitoring test results ($06) | Deferred | Proposed | Test-ID semantics review needed |
| VIN ($09 `02`) | Read and shown; not mapped | Proposed | See vehicle identity below |
| Actuator tests / bidirectional control | No (denied) | PROPRIETARY-NOT-REIMPLEMENTED | GD models them as external-tool steps only (**OBSERVED**, `types.ts:495-524`) |
| Service functions, adaptations, coding, programming | No (denied) | PROPRIETARY-NOT-REIMPLEMENTED | Same |
| BLE adapters (Web Bluetooth) | Yes, required transport | Proposed; adapters UNKNOWN | Profiles `community_unverified` ([vci-transport](vci-transport.md#candidate-ble-uuids-unverified-community-claims)) |
| USB-serial adapters (Web Serial) | Yes, required transport | Proposed; adapters UNKNOWN | Browser support varies; re-verify |
| iOS / Safari / Firefox users | Not reachable from a browser | INFERRED ([vci-transport](vci-transport.md#browser-compatibility-to-be-re-verified-before-implementation)) | Platform limit, re-verify |
| Classic Bluetooth SPP and Wi-Fi adapters | Not reachable via Web Bluetooth | INFERRED | Web Serial may reach SPP on some platforms; UNKNOWN |
| Known-good adapter list | None | UNKNOWN | Real-adapter validation pending |
| GD session integration (submit, attach, suggest capability context) | No | Proposed | Out of the preview; later human-gated task ([carcode-scanner-architecture](carcode-scanner-architecture.md#approval-requests)) |

**OBSERVED** (`types.ts:80-89`, "The engine reads only this"): GD's capability
context is stated by the person. The preview does not suggest or set it.

## Guided Diagnostics mapping gaps

Checked against the repository (**OBSERVED** facts, Proposed handling):

| # | Gap | Repository fact (OBSERVED) | Proposed handling |
| --- | --- | --- | --- |
| G1 | No GD unit for km/h, crank-angle degrees, g/s, seconds, L/h, lambda, km | `UNITS` = `V, mV, ohm, kohm, A, kPa, bar, psi, ms, Hz, rpm, percent, degC` (`types.ts:223`) | Omit from snapshots; record in `droppedForMapping`; s → ms only if needed. Adding units is a GD change needing approval |
| G2 | GD accepts a snapshot number with no unit | `SnapshotParameter.unit` optional (`types.ts:141`); `dtc.ts:92-95` checks a unit only if present | Mapper never emits a unitless number |
| G3 | Module id derived from a CAN address vs. "no addressing" | `ModuleOrigin` comment (`types.ts:125`); id pattern (`dtc.ts:32`) | Use `obd-can11-7e8` style ids as opaque labels; **decision needed** |
| G4 | No VIN in GD vehicle context; garage owns vehicle facts | `VehicleContext` (`types.ts:664-674`); `VehicleDetails` limited to fuel/cylinders/market (`service.ts:62-63`) | Show VIN only; never written anywhere |
| G5 | No machine-readable parameter id on measurement steps | `MeasurementDefinition` (`types.ts:237-248`) | Live data is not linked to measurement steps; any link is a later GD change needing approval |
| G6 | Observation steps accept only `person` | `sourcesFor` (`engine.ts:393-400`) | Scanner never answers an observation step (e.g. per-cylinder misfire, `generic-gasoline-misfire.ts:141-151`) |
| G7 | `reportsStatus` constrains code flags | `dtc.ts:167-169` | Drop flags of services that failed anywhere; record the drop |
| G8 | One observation per code + module | `dtc.ts:175` | Merge $03/$07/$0A flags per ECU |
| G9 | A snapshot belongs to at most one code | `dtc.ts:178-181` | One freeze frame per ECU, linked only when its DTC is in that ECU's $03 list |
| G10 | No GD place for adapter identity, protocol, step log | `DiagnosticScanInput` accepts only `id, source, completeness, coverage, reportsStatus, codes, snapshots` (`dtc.ts:127-128`) | Kept in the ScannerReport only |
| G11 | No GD scan-capture time | `DiagnosticScanInput` has no time field (`types.ts:153-165`); evidence `at` is caller-supplied (`types.ts:870-871`) | The caller passes the read time as the step/start `at`, as today |
| G12 | Absence across uncovered modules | `absenceProvable` (`dtc.ts:219-222`) | Always set `coverage`, always `partial` in preview |
| G13 | No GD field for readiness or MIL status | No `readiness` / `monitor` in `types.ts` | Shown and kept in the ScannerReport only; never mapped |

No gap requires changing GD for the preview: every one is handled by the
mapper being stricter than GD. G1, G3 and G5 are candidates for later,
separately approved GD changes.

## Vehicle identity

Proposed (INFERRED): a VIN read from $09 is reported text, shown on the
`/scanner` page only. It is never written to the garage, to GD facts, or to any
store by the scanner. Comparing it with a garage vehicle belongs to the later
GD/garage integration task, not the preview.

## Decisions needed

Before the named tasks start (none blocks this documentation change):

1. **Approve or reject this design** before S1.
2. **The goal's exact environment gate**: resolved 2026-10-26; now quoted
   verbatim in
   [carcode-scanner-architecture](carcode-scanner-architecture.md#preview-acceptance-criteria),
   criterion 1.
3. **Module-id scheme (G3)** before S10.
4. **Sources for BLE profiles**: recorded 2026-10-26 for the `18F0` and
   `FFF0` profiles; none found for `FFE0`, which stays out of the profile
   table ([vci-transport](vci-transport.md#candidate-ble-uuids-unverified-community-claims)).
5. **Whether a scanner read may ever be `complete`** (module-scoped), after
   the preview ([scan-flow](scan-flow.md#completeness-and-coverage)).
6. **The approval requests** in
   [carcode-scanner-architecture](carcode-scanner-architecture.md#approval-requests)
   (production refusal, GD session integration, non-CAN protocols).
7. **Which adapters to buy and validate** for S13, and who performs and
   records real-vehicle validation.
8. **Any THINKCAR / ThinkDiag evaluation** only with an authorized artifact and
   recorded terms.
