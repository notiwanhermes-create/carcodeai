# Guided Diagnostics v2: gap analysis of the `ccc2aa9` prototype

Compared against [findings.md](findings.md). The prototype on
`research/guided-diagnostics` (commit `ccc2aa9`) was read only from git. It
was **not** changed.

Classification:

- **ALREADY SUPPORTED**: the prototype does what the evidence suggests.
- **PARTIALLY SUPPORTED**: the idea is there, but too thin for real content.
- **MISSING**: absent, and the evidence says CarCode needs it.
- **NOT NEEDED FOR CARCODE**: real in the standards, wrong for our product.

CarCode guides owners and mechanics by hand. It does not talk to control
units, flash, code or certify emissions. That rules out much of what ODX and
OTX exist for.

## Summary

| Capability | Status | Finding |
| --- | --- | --- |
| Workflows as checked data, separate from the engine | ALREADY SUPPORTED | F6.1 |
| Validator that rejects bad workflows before use | ALREADY SUPPORTED | F6.1 |
| Branching on results | ALREADY SUPPORTED | F7.1 |
| Explicit, replayable session state | ALREADY SUPPORTED | F9.2 |
| Evidence log, immutable | ALREADY SUPPORTED | F10.1 |
| "Cannot be done" routing (level, tools, missing spec) | ALREADY SUPPORTED | F11.2 |
| Units and conversion | ALREADY SUPPORTED | F4.1 |
| Repair verification step | PARTIALLY SUPPORTED | F12.1 |
| VehicleContext | PARTIALLY SUPPORTED | F1.1, F1.2 |
| Specifications | PARTIALLY SUPPORTED | F4.2, F4.3 |
| Trouble-code matching | PARTIALLY SUPPORTED | F3.1–F3.3 |
| Prerequisites | PARTIALLY SUPPORTED | F8.1, F8.2 |
| Tool capabilities | PARTIALLY SUPPORTED | F5.2, F11.2 |
| Cause elimination | PARTIALLY SUPPORTED | F10.1, F13.4 |
| Next-test ranking | PARTIALLY SUPPORTED | F13.1–F13.3 |
| Inconclusive / not-available result | MISSING | F11.1 |
| Workflow applicability (which vehicles) | MISSING | F1.2, F2.1, F6.4 |
| Measurement conditions | MISSING | F4.3, F8.2 |
| Plausible range vs specification | MISSING | F4.1 |
| Freeze-frame / recorded context as evidence | MISSING | F3.3 |
| Evidence phase (before / after repair) | MISSING | F9.1, F10.1 |
| Named, reusable conditions | MISSING | F8.2 |
| Routines (actuator / service functions) as a step kind | MISSING | F5.1 |
| Bounded re-check after repair | MISSING | F7.2, F12.1 |
| Sub-workflows | MISSING, but defer | F7.2 |
| Control-unit (ECU) context | NOT NEEDED (yet) | F2.1 |
| Variant inheritance (ODX layering) | NOT NEEDED | F2.1 |
| General loops, variables, arithmetic, parallel steps | NOT NEEDED | F6.2 |
| Protocol / service encoding (requests, bytes) | NOT NEEDED | F5.1 |
| Diagnostic sessions and security states | NOT NEEDED (must stay out) | F8.1 |
| Probability-based ranking | NOT NEEDED now | F13.3 |

## Detail

### Already supported

- **Separate, checked workflow data (F6.1).** OTX's core idea is test logic
  kept apart from the runtime, with checker rules. The prototype does exactly
  this: `validateWorkflow` rejects unreachable steps, loops, unrouted answers,
  bad units and ranges, and steps needing skill without a fallback. Keep it.
- **Session state (F9.2).** The session is inputs → evidence → current step,
  frozen, replayable, refused if edited. Nothing in the sources argues for
  more.
- **Unsupported routing (F11.1, F11.2).** Industry tools discover what is
  available and define behaviour when data is missing. The prototype routes
  around missing skill, tools and specifications, and records why. That is
  right for us.
- **Units (F4.1).** Quantity plus unit with same-kind conversion is the right
  model.

### Partially supported

- **Repair verification (F12.1).** Today it is one yes/no question. The
  evidence favours re-running *the test that found the fault*: the same check
  passing, a code not returning, a re-measurement in range. We need a
  verification that can name its re-test.
- **VehicleContext (F1.1, F1.2).** The prototype has year, make, model,
  engine, fuel, cylinders and mileage. It can only branch on `equals`. It
  cannot say "this workflow applies to diesel engines" or "this spec is for
  this engine code".
- **Specifications (F4.2, F4.3).** Today a specification is a bare number by
  name (`specs: Record<string, number>`). Real specifications carry a unit,
  min and/or max, the conditions they hold under, and a source. One number
  cannot say "300–450 kPa at idle, engine warm, from the service manual,
  edition X".
- **Trouble codes (F3.1–F3.3).**
  - Matching is exact string only.
  - There is no failure-type byte and no pending / confirmed / permanent
    status.
  - Freeze-frame data is not used.
- **Prerequisites (F8.1, F8.2).** Prerequisites are one-off yes/no steps. A
  condition met once ("engine warm") cannot be reused by later steps, and a
  step cannot declare "needs engine warm" so the engine asks only when
  needed.
- **Tool capabilities (F5.2, F11.2).** Tools are a flat list
  (`multimeter`, `scan_tool` ...). It cannot distinguish:
  - a generic code reader from a tool with live data;
  - a tool with live data from one with bidirectional control.

  Those decide whether many tests are possible at all.
- **Cause elimination (F10.1, F13.4).** Rule-out / support is good and
  honest. It is all-or-nothing, and it assumes a single fault without saying
  so.
- **Next-test ranking (F13.1–F13.3).** The ordering idea is sound (separating
  power versus cost, ordinal, no numbers). Two weaknesses:
  1. It scores steps anywhere in the workflow, not only steps the session can
     actually reach from where it is. In a fixed graph the next step is
     already decided, so today the ranking is advisory at best.
  2. Cost is only skill level and tool count. It ignores safety, how invasive
     a test is (removing parts) and time.

### Missing

- **Inconclusive results (F11.1).** A check is pass or fail; a measurement
  that matches no range goes to `otherwise`. There is no "could not tell" or
  "not available", so a weak result is forced into pass or fail.
- **Applicability (F1.2, F2.1).** There is no way to state which vehicles a
  workflow, or a step, is valid for.
- **Measurement conditions (F4.3).** There is no way to say a reading is only
  meaningful at idle / warm / key-on.
- **Plausible ranges (F4.1).** A typo of 4500 kPa is accepted and judged
  against the spec. A per-quantity plausibility range would reject it.
- **Recorded context (F3.3).** Freeze-frame values are not evidence today.
- **Evidence phase (F9.1, F10.1).** Readings before and after a repair look
  the same in the log.
- **Routines (F5.1, F5.2).** Actuator tests and service functions are just
  `check` steps with no notion of "needs bidirectional control" or "what to
  observe while it runs".
- **Bounded re-check (F7.2, F12.1).** A failed verification can only go
  forward. "Re-test after repair, at most once more, then refer" cannot be
  expressed without a loop, and loops are refused.
- **Sub-workflows (F7.2).** Shared checks would be copied. **Defer** until
  real content shows duplication.

### Not needed for CarCode

- **Control-unit context and ODX variant layering (F2.1).** CarCode does not
  address control units. Function / system grouping (F2.2) and workflow
  applicability cover what owners need. Revisit only if CarCode ever reads
  live data from a connected adapter.
- **A general test language (F6.2).** Variables, arithmetic, parallel
  execution and exception handling are for automated testers. They would
  make workflows harder to write and review, and they are not needed to guide
  a person.
- **Protocol encoding (F5.1).** Requests, responses and byte layouts are tool
  territory.
- **Sessions and security states (F8.1).** Out of scope, and they must
  stay out: CarCode does not do security access, programming or coding.
- **Probability-based ranking (F13.3).** The literature's best methods need
  calibrated fault probabilities and costs. We have neither, and invented
  numbers would break our "no fake precision" rule.

## Where the prototype is over-built

- **`separatingSteps` over the whole graph.** It ranks steps the session may
  never reach. Either restrict it to reachable steps or make the workflow
  allow re-ordering. Until then it is a demonstration, not a feature.
- **Full-session JSON equality on resume.** Correct and cheap at prototype
  size. It will be fragile when stored sessions outlive a code change (field
  order, new optional fields). Compare replayed inputs and outcomes instead.

## Where it is too simple

- Pass/fail with no "inconclusive".
- Specifications as bare numbers.
- Exact-string trouble-code matching with no status.
- One flat tool list.
- Verification as one yes/no.

## What we should not build

- ODX/OTX-style data models, inheritance, protocol data or a general
  scripting language.
- Anything touching control-unit sessions, security access, programming or
  coding.
- Numeric probabilities or "confidence %" for causes or tests.
- Automatic re-ordering of steps across a reviewed workflow without rules for
  what evidence stays valid (see the open questions in the recommendation).
