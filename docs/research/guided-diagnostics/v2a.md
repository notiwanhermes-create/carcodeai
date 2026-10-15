# Guided Diagnostics V2A: honest outcomes

Research prototype, still not wired into the app. Builds on the `ccc2aa9`
prototype ([design.md](design.md)) and implements stage V2A of the V2
recommendation (branch `research/guided-diagnostics-v2-standards`,
`docs/research/guided-diagnostics-v2/carcode-v2-recommendation.md`).

Development fixture: the synthetic misfire workflow, now version 2. It is
still not manufacturer data.

## What V2A adds

| Item | How it works |
| --- | --- |
| Inconclusive outcome | `{ kind: "inconclusive", reason }` on check, observation and measurement steps that declare `ifInconclusive`. It rules nothing in or out. New end result `inconclusive`. |
| Evidence phase | Every evidence record has `phase`. It is `before_repair` until the session reaches a repair verification, then `after_repair`. |
| Evidence source | Every evidence record has `source`: `person`, `instrument`, `scan_tool` or `engine` (branches, skipped steps, the verification verdict). Inputs may state a source; it is refused when it could not have produced that input (a person cannot produce a pressure reading). Start codes take `facts.dtcSource`. |
| Named conditions | A workflow declares `conditions`. Prerequisites (when met) and actions (when done) `establish` them, and steps declare `needsConditions`. The checker proves every route establishes them first (`condition_not_guaranteed`), and the engine guards at run time. Branches can test `{ established }`. |
| Plausible vs pass range | `measurement.plausible` (required) holds generic physical limits that catch typos. A reading outside it is refused and nothing changes. Pass ranges now have ids, and the evidence records which range judged the reading (`judgement.range`, or `otherwise`). |
| Specification trust (placeholder) | A spec can be a bare number or `{ value, trust: verified / reference / unverified, source? }`. Every judgement records the specs it used with their trust (bare numbers are `unspecified`). **Not enforced yet**: whether unverified values may decide pass or fail is open decision #1, for V2B. |
| Single primary fault | `faultModel: "single_primary_fault"` is required on every workflow and carried on every session. The engine refuses to reach a conclusion for a cause the evidence already ruled out (`contradiction`). |
| Reachable-only separating tests | `separatingSteps` lists only steps reachable from the current step, and nothing once complete. Full next-best-test ranking is V2E. |
| Repair verification | A verification names `criteria`: `symptom_absent`, `codes_absent` (`"reported"` or a list) or `retest` of an earlier check, observation or measurement with `passWhen`. Each criterion is its own after-repair evidence. A re-test links to the before-repair result (`comparesTo`), and a re-measurement is checked for plausibility and judged like the original. Verdict: any not met means `not_verified`; otherwise any inconclusive means `inconclusive`; only all met means `verified`. `ifInconclusive` is required. |
| Resume | `resumeSession` replays the inputs and compares results (`sessionOutcome`: evidence step, kind, value and destination; where the session stands; the conclusion; the causes), plus V2A fields when the save has them. Key order, unknown fields and older saves without V2A fields are fine. A save whose inputs no longer lead to what it recorded is refused. |

## Not in V2A (later stages)

SpecificationProvider, vehicle and control-unit applicability, capability
presets, richer trouble-code and freeze-frame support, full next-best-test
ranking, a bounded re-check after repair, the AI bridge, database changes,
production UI and `/api/diagnose` integration.

## Known limits

- Conditions do not expire: once established, a condition is treated as
  holding for the rest of the session.
- A retest whose specification is missing is recorded as inconclusive.
- Verification inputs carry one `source` for all criteria. A re-measurement
  defaults to `instrument`.
