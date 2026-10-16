# Guided Diagnostics V2E: next best test and limited recheck

Research prototype, still not wired into the app. Builds on V2D (`f71c55e`,
[v2d-dtc-freeze-frame.md](v2d-dtc-freeze-frame.md)). Everything is
SYNTHETIC / TEST ONLY / NOT OEM DATA.

## Explicit reorderable regions

The engine ranks tests only where the workflow author has said they are
interchangeable: a `test_selection` step.

```
{ type: "test_selection", group: "misfire_primary_tests",
  candidates: [{ step, when? }, ...],   // author's order = final tie-break
  next }                                // where the region exits
```

The validator enforces the region's shape:

- **Membership:** a region holds two or more distinct candidates. Each is a
  test (check, observation, measurement or actuator test) with a
  `testProfile`, and belongs to one region only.
- **Entry:** a candidate can be reached only from its own selection, so no
  route can jump into the middle of a region.
- **Exit:** a candidate's results lead back to the selection, or out of the
  region (for example to a conclusion), never to another candidate.
- **Group ids** are generic and unique.
- **Hazards:** a high-risk test must state them.

The only repetition allowed is a candidate returning to its selection. Each
candidate runs at most once, so loop analysis ignores those return edges and
every run still ends. Outside a region, `nextBestTests` returns
`follow_workflow`, and the workflow's order is authoritative. Prerequisites,
safety steps, actions, conclusions and verification are never candidates.

## Candidate eligibility

At the selection, each candidate falls into exactly one bucket, checked in
this order:

1. **Already done** (any evidence at that step, including unable or
   inconclusive) → excluded.
2. **`when` guard** (three-valued):
   - false → excluded as not applicable;
   - unknown → **potential**, with the missing context named. It never
     competes and is never treated as no.
3. **Cannot change the remaining causes** (no result rules out or supports
   one, or one cause is left) → excluded.
4. **Capability shortfall** → **blocked**, with what is missing. This is not
   evidence about a cause.
5. **Required conditions not established** → **blocked**, with the
   conditions.
6. **Otherwise** → eligible and ranked.

A test is **not** hidden because one of its possible results might
conflict with earlier evidence. That is only hypothetical; if the result is
actually observed, the session ends inconclusive (below).

The person chooses with `{ kind: "select_test", test }`. Only a ranked
candidate is accepted; anything else is refused with the reason. The
recommendation is advice. The evidence records both the choice and the
recommended test. When no ranked candidate remains, the region exits to
`next` by itself (evidence value `exhausted:<why>`).

## Deterministic ranking policy

Lexicographic. Every key comes from the reviewed workflow, and lower is
better:

1. **Risk:** low < moderate < high. Safety dominates.
2. **Separation:** how many causes are still in play after the least helpful
   result (minimax). Only declared `rulesOut` counts, and many branches earn
   nothing unless they separate.
3. **Decisiveness:** decisive (every result changes the causes) < partial.
   Context-only tests are never ranked.
4. **Invasiveness:** observe < read_data < command < disconnect < disassemble.
5. **Setup:** none < minor < significant.
6. **Additional instruments and facilities** needed (fewer is better).
7. **Capability fit:** lower required skill, then lower scan access.
8. **Tie-break:** the author's declaration order.

## Discrimination vs burden

Separation and decisiveness measure what a test can tell. Invasiveness,
setup and instruments measure what it costs to do. Risk comes first, then
diagnostic value, then burden: a safer test wins even if a riskier one
separates more. Burden only decides between tests of equal value.

## Why there are no probabilities or costs

There are no reviewed prevalence data, repair frequencies, labour times or
prices, and inventing them would look precise without being true. Every key
is a categorical fact an author can review. `worstCaseRemaining` is a count
of causes ("at most 3 remain whatever the result"), not a score.
Recommendations carry no numeric score, percentage, confidence or cost.

## Recommendation structure

`nextBestTests(workflow, session)` returns `{ status: "region", group,
selection, recommended, alternatives, blocked, potential, excluded }`.

Each recommendation contains:

- `eligibleBecause`;
- `separates` (causes, remaining now, worst case, and each result's declared
  effect);
- `decisiveness`, `profile`, `requires` and `hazards` (always shown);
- `preferredOver`: each lower alternative, with the first key that decided,
  in words.

It is pure: computing it changes nothing.

## Reachable, potential, unavailable

The V2D reachability labels carry through:

- **reachable and capable** → ranked;
- **potential** (missing context) → reported separately, never ranked;
- **unreachable** → excluded;
- **unavailable** (capability or conditions) → reported as blocked, never
  ranked, and never evidence about a cause.

## Limited repair recheck

`recheckPlan(workflow, session)` works at a repair verification step. It is a
bounded list, in priority order:

1. **Detecting tests:** the test(s) whose recorded result supported the
   concluded cause before the repair.
   - Repeatable: listed with requirements and hazards, linked to the
     verification criterion that repeats it, or marked advisory if there is
     none.
   - Not repeatable: listed with the reason (`historical_snapshot`,
     `workflow_marks_not_repeatable` such as the coil swap, or
     `capability_missing`).
2. **The workflow's other re-test criteria.**
3. **The code re-scan:** needs a complete scan; a partial scan, or a code
   still listed only as permanent or history, is inconclusive.
4. **Symptom confirmation.**

The plan never includes unrelated tests, never restarts the workflow and
never sets a verdict. Verification still comes only from after-repair
evidence, under the V2D rules.

## Conflicting evidence ends inconclusive

Under the single-primary-fault assumption, the engine never throws on
contradictory evidence. A recorded result conflicts when it would:

- support a cause earlier evidence ruled out;
- rule out a cause earlier evidence supported;
- reach a conclusion about a ruled-out cause.

When that happens:

1. The conflicting result is kept in the evidence, but none of its effect is
   applied. The earlier cause state stays exactly as it was: no cause wins,
   the latest evidence does not override, and no second fault is assumed.
2. A `conflict` evidence record names the new evidence, each cause, its
   earlier state, what the new result would have done, and the earlier
   evidence (by seq) behind that state. Its explanation reads: "The evidence
   cannot be reconciled under this workflow's single-primary-fault
   assumption."
3. The session ends `completed` with `endResult: "inconclusive"` and no
   conclusion.

Replay and resume reproduce it, and an edited conflict record is refused.
Invalid workflows are still validation errors.

## One recommendation API

`nextBestTests` is the only public recommendation API. `separatingSteps` is
no longer exported. It remains internal and deprecated, imported directly
from the engine only by the V1–V2D regression tests that check reachability.

## Synthetic fixture (version 6)

A new "I don't know: help me test" answer leads, after a vehicle-secured
prerequisite, to one region of seven synthetic tests:

- intake leak listen;
- coil connector check;
- live misfire counters;
- ignition scope;
- fuel-pump actuator command;
- compression check, blocked by `engine_off_cool`;
- injector balance, guarded by a synthetic engine family.

Basic and DIY users get the intake listen. Advanced DIY users and workshops
get the misfire counters. After "one cylinder", a workshop gets the coil
connector check ahead of the riskier scope. All earlier routes are unchanged.

## Not built

Probabilities, Bayesian diagnosis, repair frequencies, confirmed-fix
influence, money or time ranking, whole-workflow optimization, the AI
bridge, OEM data, persistence, UI, API integration and automatic tool
execution.

## Production build

Pending verification on a local machine or CI. The cloud environment blocks
Google Fonts and Prisma network access, and the same limitation reproduces on
untouched `ccc2aa9`.
