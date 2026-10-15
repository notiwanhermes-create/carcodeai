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
| Evidence source | Every evidence record has `source`: `person`, `instrument`, `scan_tool` or `engine` (branches, skipped steps, the verification verdict). Inputs may state a source; it is refused when it could not have produced that input (a person cannot produce a pressure reading). Start codes take `facts.dtcSource`. `source` is who produced the evidence; `kind` is what it is (below). |
| Named conditions | A workflow declares `conditions`. Prerequisites (when met) and actions (when done) `establish` them, and steps declare `needsConditions`. The checker proves every route establishes them first (`condition_not_guaranteed`), and the engine guards at run time. Branches can test `{ established }`. |
| Plausible vs pass range | `measurement.plausible` (required) holds generic physical limits that catch typos. A reading outside it is refused and nothing changes. Pass ranges now have ids, and the evidence records which range judged the reading (`judgement.range`, or `otherwise`). |
| Specification trust | Approved rule, enforced: **only a `verified` specification may drive the engine** (pass or fail, ruling causes in or out, choosing a route). `reference`, `unverified` and bare numbers (`unspecified`) are informational only. A measurement whose ranges need one is recorded with its reading and the spec's value, source and trust (`judgement: { evaluated: false, reason: "untrusted_spec" }`), changes no cause, and takes the step's `ifInconclusive` route (or `ifUnsupported` without one), never a pass or fail route. A repair re-test against one is inconclusive. A missing spec routes the step away as before. |
| Single primary fault | `faultModel: "single_primary_fault"` is required on every workflow and carried on every session. The engine refuses to reach a conclusion for a cause the evidence already ruled out (`contradiction`). |
| Reachable-only separating tests | `separatingSteps` lists only steps reachable from the current step, and nothing once complete. Full next-best-test ranking is V2E. |
| Repair verification | A verification names `criteria`: `symptom_absent`, `codes_absent` (`"reported"` or a list) or `retest` of an earlier check, observation or measurement with `passWhen`. Each criterion is its own after-repair evidence. A re-test links to the before-repair result (`comparesTo`), and a re-measurement is checked for plausibility and judged like the original. Verdict: any not met means `not_verified`; otherwise any inconclusive means `inconclusive`; only all met means `verified`. `ifInconclusive` is required. |
| Resume | `resumeSession` replays the inputs and compares results (`sessionOutcome`: evidence step, kind, value and destination; where the session stands; the conclusion; the causes), plus V2A fields when the save has them. Key order, unknown fields and older saves without V2A fields are fine. A save whose inputs no longer lead to what it recorded is refused. |

## Evidence kind versus source

`kind` already says what a piece of evidence is, and `source` says who produced it, so no extra field is needed. The one gap, start facts that told codes from symptoms only by a `dtc:`/`symptom:` text prefix, was fixed by splitting `start_fact` into `code` and `symptom` with plain values.

| Evidence | How it is recorded |
| --- | --- |
| User-reported symptom | `kind: "symptom"` (at the start), or `kind: "answer"` to a question, with `source: "person"` |
| Trouble code | `kind: "code"`, with `source` `person` (typed in) or `scan_tool` |
| Scan or live data | `kind: "measurement"` or `"check"`, with `source: "scan_tool"` |
| Measurement | `kind: "measurement"`, with `source` `instrument` or `scan_tool` |
| Visual or audible observation | `kind: "observation"` |
| Component test | `kind: "check"` |
| Repair verification | `kind: "verification_criterion"` per criterion and `"verification"` for the verdict, both in phase `after_repair` |

## Production build

Pending verification on a local machine or CI. The cloud environment blocks Google Fonts and Prisma network access, and the same build limitation reproduces on untouched `ccc2aa9`.

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
