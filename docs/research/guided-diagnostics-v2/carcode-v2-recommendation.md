# CarCode Guided Diagnostics v2: recommendation

Research and design only. Nothing here is built yet. It is based on:

- [findings.md](findings.md): what public standards and literature say;
- [gap-analysis.md](gap-analysis.md): where the `ccc2aa9` prototype stands.

Everything in this document is **our recommendation for CarCode**, not a
statement of any standard. Each part says which finding supports it. The
names are CarCode's own; no standard schema or class is copied.

## Guiding decisions

1. **Keep what the evidence confirms.** Workflows stay checked data,
   separate from the engine (F6.1). Runs stay deterministic, replayable and
   loop-free, apart from one bounded exception (below). The evidence log stays
   append-only.
2. **Add only what owners and mechanics need.** No control-unit addressing,
   protocols, security states, general scripting or variant inheritance (see
   the gap analysis, "Not needed").
3. **No invented numbers.** Rankings are ordinal. Causes are ruled out or
   supported, never scored. Specifications come only from sourced data.
4. **Vehicle-specific knowledge lives outside workflows** (F2.1, F4.2): a
   generic workflow, plus vehicle-specific specifications and applicability
   supplied by separate, sourced data.

## Proposed concepts

| Concept | What it is | Why it exists |
| --- | --- | --- |
| **VehicleContext** | Structured vehicle facts: year, make, model, engine code, fuel, cylinders, mileage, VIN-decoded fields, plus where each fact came from | F1.1: identification is first-class. Feeds applicability and specification lookup, not just branching |
| **WorkflowApplicability** | A simple rule on VehicleContext saying which vehicles a workflow (or one step) is valid for: fuel type, cylinder count, make, year range, engine code list | F1.2 (applicability must be data), F2.1 / F6.4 (generic content specialised per vehicle). Replaces ODX-style inheritance with one filter |
| **DiagnosticCapability** | What the person has, as a profile (see the capability model below) | F5.2, F11.2: tools differ in kind, and what is available is discovered |
| **DiagnosticWorkflow** | As today: id, version, provenance, causes, steps, plus applicability and a reviewer field | F6.1 |
| **DiagnosticNode** | As today, plus two new kinds (`routine`, `test_selection`) and an `inconclusive` outcome where a check can fail to decide | F5.1, F11.1, F13 |
| **DiagnosticTransition** | As today (outcome → next step), plus an `inconclusive` route | F11.1 |
| **Condition** (named) | A reusable named state, for example `engine_warm` or `key_on_engine_off`. A step *requires* conditions; a step can *establish* them | F8.1, F8.2: preconditions and enable conditions. Ask once, reuse |
| **DiagnosticSpecification** | A sourced, vehicle-specific value: quantity, unit, min and/or max, conditions, source, trust level | F4.2, F4.3 |
| **SpecificationProvider** | The interface the engine asks for a specification by name and vehicle | Keeps the engine generic and the data separate (below) |
| **MeasurementDefinition** | Quantity, unit and a **plausible range** for that quantity (rejects typos), separate from the specification (judges pass or fail) | F4.1 |
| **MeasurementResult** | Value as entered, value converted, the specification it was judged against (with its source), and the outcome: within / below / above / inconclusive | F4.1, F4.2, F11.1 |
| **DiagnosticRoutine** | A step where the person (or their tool) runs a function, such as commanding a fan, running an injector test or clearing codes. It states the capability it needs and what to observe | F5.1, F5.2 |
| **DiagnosticEvidence** | As today, plus `phase` (before repair / after repair), `source` (person / tool / freeze frame / AI-extracted, never AI-decided) and recorded context | F3.3, F9.1, F10.1 |
| **CauseState** | Per cause: in play, supported, ruled out, plus *which evidence* did it | F10.1, F13.4. Explanations ("ruled out because the misfire did not move with the coil") come from data |
| **DiagnosticSession** | As today: facts, inputs, evidence, current step, causes, conclusion, end, plus established conditions | F9.2 |
| **RepairVerification** | Names its re-test (repeat step X; code Y must not return; reading must be within spec) as well as the person's yes/no, and allows one bounded re-check | F12.1, F7.2 |

`ToolRequirement` is folded into the capability model, and `Prerequisite`
into named conditions. They do not need their own concepts.

ControlUnitContext is **not** proposed (gap analysis). If CarCode later
reads data from a connected adapter, it would be added to VehicleContext as
"control units reported", not as a modelling layer.

## The specification model

The question: should named specifications become a `SpecificationProvider`?
**Yes.** The evidence supports it:

- Industry data keeps generic definitions separate from vehicle-specific
  limits (F2.1, F3.4).
- On-board test limits and scaling are manufacturer-defined and vary by
  vehicle (F4.2).
- Values only hold under conditions (F4.3).

Shape:

```
SpecificationProvider.lookup(name, vehicleContext) →
  | { found: DiagnosticSpecification }
  | { notFound }
  | { ambiguous: candidates }   // e.g. two engine variants match

DiagnosticSpecification = {
  name            // e.g. fuel_pressure_idle
  quantity, unit
  min?, max?      // at least one
  conditions[]    // named conditions it applies under (idle, warm, key on)
  appliesTo       // the applicability it was recorded for
  source          // document / dataset, edition, where
  trust           // verified (recorded source) / reference (unverified)
}
```

Rules we recommend:

- **No specification without a recorded source.** This is the same rule as
  our trouble-code data (Phase 2B).
- **Ambiguous or not found means the step is not evaluated.** It takes its
  "cannot be done" route, as the prototype does today. The engine never picks
  between candidates.
- **The engine checks the specification's conditions** against the
  conditions the session has established. Not met means ask for the
  condition first. Unknown means inconclusive, never pass.
- **Show the source** next to any judgement. Unverified reference values are
  labelled as such, or not used for pass/fail at all (an open decision).

This keeps the engine and workflows free of any vehicle data. Content and
its licensing become a separate problem.

## The capability model

The question: should workflows understand what is actually available?
**Yes, as a profile the person chooses, routed by the engine.**
Industry tools discover what they and the vehicle support (F11.2), and the
kinds of access differ materially (F5.2).

```
DiagnosticCapability = {
  skill: owner | diy | professional
  scanAccess: none | code_reader | live_data | bidirectional
  instruments: multimeter, pressure_gauge, compression_tester,
               oscilloscope, smoke_machine
  facilities: lift, hand_tools
}
```

- Each step declares the minimum it needs. The engine routes to the step's
  "cannot be done" route when the profile falls short, as today. The
  person never sees a step they cannot safely or practically do.
- `scanAccess` is ordered: bidirectional includes live data, which includes
  reading codes.
- **Offered as presets** in the eventual UI: "Just me", "Me with a code
  reader", "Home mechanic", "Workshop". Fine-tuning is optional.
- **We never claim a capability.** It is what the person tells us. A future
  connected adapter could report it instead.

## The next-best-test model

Evidence:

- Optimal sequencing is intractable (F13.1).
- The principled criterion is "uncertainty reduced per cost" (F13.2).
- That needs probabilities and costs we do not have (F13.3).

Recommendation: an **ordinal, lexicographic ranking**. No numeric score is
shown, and every rank has a plain reason.

### Where it applies

A new `test_selection` step lists candidate tests that the author has
reviewed as valid in any order at that point. Each test returns to the
selection, and each runs at most once. Selection ends when one cause
remains, no candidate can separate the remaining causes, or no candidate can
be done. This is the one bounded repetition we allow. Termination is
guaranteed because each test runs once; the validator checks this.

### The ranking

It is applied only to tests the person can do now. Tests that fail
applicability or capability are excluded, never ranked low.

1. **Safety class**: owner-safe → DIY → professional.
2. **Worst-case remaining causes**: after the test's least helpful outcome,
   how many causes are still in play. Fewer is better. This is a
   minimax view of separation and needs no probabilities.
3. **Invasiveness**: look/listen → read data → reversible change (swap,
   unplug) → disassembly. The author sets it.
4. **Decisiveness**: definitive → indicative. The author sets it, matching
   "unreliable tests" in the literature (F13.1).
5. **Prerequisite cost**: conditions already established → conditions to
   set up.
6. **Fewest instruments**, then **stable id**.

### Shown to the person

The top test, with its reason in words. For example: "Quick, needs no tools,
and tells the ignition causes apart from the fuel causes."

### Later, not now

Once Phase 2E's confirmed repairs build up, *observed* repair frequencies per
vehicle could break ties at step 2.

- They would never be shown as percentages.
- They would only be used where counts are large enough.
- They would only be used after a product decision.

## AI versus the deterministic engine

The proposed split still holds, and the literature backs it:

- Decision-theoretic troubleshooting separates *belief about causes* from
  *actions and their observed results* (F10.1).
- Industry practice separates test logic from runtime (F6.1).

| AI may | The deterministic engine alone controls |
| --- | --- |
| Turn free-text symptoms into structured symptoms (shown to the person to confirm) | Which step comes next |
| Suggest which workflow fits; the person confirms, applicability must pass | Which transitions are allowed |
| Explain a step, a result or a reason in plain words | Evaluating measurements against specifications |
| Ask clarifying questions *before* a workflow starts | Prerequisites and established conditions |
| Summarise the session afterwards | Safety and capability routing |
| Keep giving today's ranked-causes diagnosis when no workflow fits | The evidence log, which cannot be changed |
| | Cause rule-out and support |
| | Completion and repair verification |

Two rules make the split real:

1. **AI output enters the session only as evidence marked `source: ai`,
   after the person confirms it.** It can never answer a step.
2. **Specifications and code definitions never come from the model.** This
   is the same rule as Phase 2B.

## Data CarCode would eventually need

### Engine architecture (ours, can be built now)

Workflow format, validator, session engine, specification-provider
interface, capability model, ranking, persistence.

### Data content (separate problem)

| Data | Why | Notes |
| --- | --- | --- |
| Generic trouble-code definitions (with failure types) | Codes as evidence | Licensed SAE J2012-DA or another lawful source; trust levels as in Phase 2B |
| Manufacturer-specific code definitions | Most real codes | Per-make licensing; until then "unidentified code" handling stays |
| Vehicle applicability (engine codes, fuel, cylinders by model/year) | Applicability and specification lookup | Phase 2A vehicle data is a start |
| Specifications (ranges, units, conditions) | Measurement steps | Service information, licensed. Where none is held, steps refer to a professional |
| Reviewed workflows | The content itself | Written in-house from general practice, reviewed, versioned. Provenance required |
| Capability presets | Routing | Ours |
| Confirmed repair outcomes | Later ranking tie-breaks, workflow improvement | Already collected by Phase 2E. Privacy and minimum-count rules first |

We will not scrape or copy proprietary service information, test plans or
code databases. Missing data means "refer to a professional", never a
guess.

## What not to build

- ODX/OTX-style data models, inheritance or a scripting language.
- Control-unit sessions, security access, programming or coding.
- Probability or confidence percentages.
- Free re-ordering of a whole reviewed workflow. Re-ordering happens only
  inside `test_selection` steps the author marked as order-free.
- Sub-workflows. Defer until real workflows repeat the same checks.

## Implementation stages

Ordered by dependency and risk. Each stage is a separate reviewed change,
with no user-facing product change before V2F.

| Stage | What | Why this order |
| --- | --- | --- |
| **V2A: honest outcomes** | `inconclusive` results; evidence `phase` and `source`; named, reusable conditions; plausible ranges on measurements; resume compares inputs and outcomes, not whole JSON | Fixes correctness gaps in what exists (gap analysis). Everything else builds on it |
| **V2B: specifications** | `DiagnosticSpecification` and `SpecificationProvider`; conditions on specifications; source and trust shown with judgements; a test-only synthetic provider | The main structural change (F4.2, F4.3). Keeps the engine generic |
| **V2C: applicability and capability** | `WorkflowApplicability` on VehicleContext; the capability profile with ordered scan access; `routine` steps | Determines what may be offered at all (F1.2, F5.2, F11.2) |
| **V2D: richer codes** | Code matchers with failure type and pending / confirmed / permanent status; freeze-frame values as evidence | Needs V2A's evidence model (F3.1–F3.3) |
| **V2E: next best test** | `test_selection` steps with the ordinal ranking and reasons; bounded re-check in repair verification; validator rules for both | Needs V2B and V2C to know what can be done (F13) |
| **V2F: AI bridge** | Structured symptom extraction with confirmation; workflow suggestion gated by applicability; explanations. Behind a flag, alongside today's diagnosis | Only once the engine is complete. AI never drives steps |
| **V2G: persistence and product** | Sessions saved with the diagnosis and confirmed repairs, verification feeding "Did you fix this?" | Requires a schema change, designed at that point and shipped additively (database rules) |
| **V2H: real content** | First reviewed workflows; sourced specifications; licensing decisions | Content can start in parallel as documents. It must not ship before V2B and V2C |

## Unresolved decisions (for the product owner)

1. **Unverified specifications**: show for information only, or never use?
   We recommend information only, never pass/fail.
2. **Who reviews workflows**, and what qualifies a reviewer?
3. **Source of specifications**: which licensed service information, if any,
   and for which makes first?
4. **Capability presets**: the four suggested, or different ones?
5. **Single-fault assumption**: accept for v2 and rely on "did not hold"
   re-checks, or design for two simultaneous causes now? We recommend
   accepting it, and stating it in the product.
6. **Repair frequencies**: whether, and when, confirmed repairs may influence
   ranking, and the minimum counts and privacy rules first.
7. **First workflows**: which symptoms to cover first. We suggest the most
   common reasons people use CarCode, from analytics.

## Quality check

- Every recommendation names its supporting finding(s). Findings cite
  sources, and paywalled texts are marked as not consulted.
- Uncertain points:
  - the exact OTX extension list and semantics;
  - OBD enable-condition text;
  - the full ranking methods of the decision-theoretic papers (abstracts
    only).
- None of the recommendations depends on those details.
- Over-built in `ccc2aa9`: whole-graph `separatingSteps`; JSON-equality
  resume.
- Too simple in `ccc2aa9`:
  - no inconclusive result;
  - bare-number specifications;
  - exact code strings;
  - flat tool list;
  - yes/no verification.
- Explicitly not to build: listed above.
