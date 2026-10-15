# Guided diagnostics: workflow engine design (research)

Status: **research prototype**. Nothing in the app uses it. It is not wired to
any route, page, database table or AI call. Branch `research/guided-diagnostics`.

The design and the example workflow are original CarCode work, written from
general troubleshooting practice. No third-party diagnostic software or data
was examined for it.

## Why

Today a diagnosis ends with a ranked list of possible causes. The next step
for CarCode is to say **which test to do next to tell those causes apart**,
and to walk the person through it: answer, look, measure, decide, repeat,
until one cause stands or the job needs a workshop. Then, after the repair,
check that it actually worked.

## Principles

1. **Deterministic.** Running a workflow involves no AI, network, clock or
   randomness. The same workflow, starting facts and answers always give the
   same steps and the same conclusion. AI may later help *choose* a workflow;
   it never decides a step's outcome.
2. **Evidence is never rewritten.** Every answer, observation and reading is
   recorded once, in order, and frozen. A session can be saved, resumed and
   replayed exactly; a saved session that does not match its own inputs is
   refused.
3. **No invented data.** A workflow carries no manufacturer values. Any limit
   that depends on the vehicle is a *named specification* supplied with the
   session. Without it, that step is not evaluated and the workflow takes its
   "cannot be done" route.
4. **No percentages.** Causes are ruled out or supported by evidence, never
   scored.
5. **Safety first.** A step above the person's skill level, or needing a tool
   they do not have, is never shown to them; the workflow routes to "have a
   professional check it" instead. Hazards are part of each step.
6. **Every run ends.** A workflow is checked before use: one start, no loops,
   every answer routed, every step reachable, at least one end.

## Concepts

| Concept | In the prototype |
| --- | --- |
| Workflow | `WorkflowDefinition`: id, version, title, provenance, the candidate causes it separates, and its steps |
| Step | `WorkflowNode`, one of the node types below |
| Transition | each outcome's `to`, plus `otherwise`, `ifMet`/`ifNotMet`, `ifVerified`/`ifNotVerified`, `ifUnsupported` |
| Session | `DiagnosticSession`: facts, inputs, evidence, current step, remaining and supported causes, conclusion, end result |
| Evidence | `Evidence`: sequence number, step, kind, value, converted reading, where it led, caller's timestamp |
| Vehicle context | `VehicleContext`: year, make, model, engine, fuel, cylinders, mileage |
| Tool / skill | `StepRequirements`: owner / diy / professional (the levels the diagnosis already uses), tools, hazards |
| Measurement | `MeasurementDefinition` (quantity, unit) and numeric ranges whose bounds are numbers or named specifications |
| Repair verification | a `repair_verification` step after a repairable conclusion |

### Node types

| Type | Needs input | What it does |
| --- | --- | --- |
| `start` | no | entry point; exactly one |
| `prerequisite` | yes (met / not met) | a condition to satisfy first, with a route for "not yet" |
| `question` | yes (yes/no or one choice) | asks the person |
| `observation` | yes (one of fixed findings) | something to look at or listen for |
| `measurement` | yes (number + unit) | a reading; first matching range wins, `otherwise` required |
| `check` | yes (pass / fail) | a component, swap or actuator test |
| `action` | yes (done) | an instruction to carry out before going on |
| `branch` | no | decided from what is already known: codes, symptoms, vehicle facts, earlier answers |
| `conclusion` | no | where the evidence led, a recommendation, then a verification step or the end |
| `repair_verification` | yes (verified / not) | after the repair: did it fix it? |
| `end` | no | resolved, concluded, referred or not reproducible |

### Causes and "the next best test"

A workflow lists the causes it separates. Each outcome may **rule out** or
**support** causes. The session keeps the causes still in play.

`separatingSteps` lists the not-yet-done steps that could rule out at least
one remaining cause without ruling out all of them. They are ordered by:

1. steps the person can do;
2. the lowest skill level;
3. the most causes ruled out by the step's most telling outcome;
4. the fewest tools.

In the example, for a DIY user with a single-cylinder misfire, the coil swap
comes first: it can rule out three causes.

### Measurements and units

Readings are converted only between units of the same kind (kPa, bar and psi;
V and mV; ohm and kohm). A reading in the wrong kind of unit is refused, not
guessed at. Range bounds are inclusive by default; either end can be made
exclusive.

### Things the person cannot do

There are three ways to reach a step's `ifUnsupported` route, each recorded as
evidence with its reason:

- the step needs a higher level than the person has (`level`);
- it needs a tool they lack (`tools`);
- a vehicle specification it depends on is missing (`missing_spec`).

The person can also say they cannot do a step (`unable`, with a reason) when
the step has that route.

## The checker

`validateWorkflow` returns every problem at once, each with a stable code:

- `malformed`, `no_provenance`
- `no_start`, `multiple_starts`, `no_end`
- `duplicate_id`, `duplicate_cause`
- `broken_transition`, `broken_condition`
- `unreachable`, `cycle`
- `incomplete_outcomes`, `unknown_option`
- `unknown_unit`, `invalid_range`
- `no_unsupported_route`
- `unknown_cause`, `bad_conclusion_next`

A workflow that fails is never run: `startSession` refuses it.

## The example

`app/lib/diagnostic-workflow/examples/synthetic-misfire.ts` is a **SYNTHETIC**
generic engine-misfire flow, labelled as such:

1. Confirm the symptom. A flashing check engine light means stop driving.
2. Work out single or multiple cylinders from the codes, or ask.
3. **Single cylinder:** engine cool → coil swap ("did the misfire move?") →
   spark plug condition → injector test (professional) → compression against
   the vehicle's specification (professional).
4. **Several cylinders:** listen and look for an air leak → fuel pressure
   against the vehicle's specification (professional).
5. Conclusions, then repair verification for those a repair can fix.

It contains no manufacturer values. The tests supply made-up specification
numbers, marked as test-only.

## Files

| File | Purpose |
| --- | --- |
| `app/lib/diagnostic-workflow/types.ts` | all shapes |
| `app/lib/diagnostic-workflow/units.ts` | unit conversion |
| `app/lib/diagnostic-workflow/validate.ts` | the checker |
| `app/lib/diagnostic-workflow/engine.ts` | start, submit, replay, resume, separating steps |
| `app/lib/diagnostic-workflow/index.ts` | public exports |
| `app/lib/diagnostic-workflow/examples/synthetic-misfire.ts` | the synthetic example |
| `tests/diagnostic-workflow.test.ts` | 41 tests, no AI, network or database |

## A possible path into the product (not started)

Each step would be its own reviewed change.

1. **Workflows as reviewed content.** Keep workflows as checked files in the
   repository, each with provenance and a reviewer. Specifications come only
   from sourced data with a recorded source, never from the model, following
   the existing trouble-code rules.
2. **Offer a workflow after a diagnosis.** When the AI's ranked causes match a
   workflow's causes, show "Narrow it down" next to them. The AI picks the
   workflow; it does not run it.
3. **Save sessions** to the saved diagnosis. That needs a schema change, to be
   designed then and shipped additively per the database rules: a
   `diagnostic_sessions` table holding workflow id and version, facts, inputs
   and evidence, linked to `diagnoses`. Not implemented.
4. **Tie in repair verification** with the existing "Did you fix this?" and
   confirmed repairs, so a verified step can record the repair.
5. **Specifications.** Decide where vehicle-specific limits come from and how
   they are sourced. Until then, steps needing them refer to a professional.

## Open questions

- Who writes and reviews workflows, and how are they versioned in use?
- What source of vehicle specifications would be reliable enough?
- Should a session be allowed to jump to a step from `separatingSteps`
  instead of following the fixed graph? That would need rules for which
  evidence still applies.
- How should a workflow handle two codes pointing different ways?
