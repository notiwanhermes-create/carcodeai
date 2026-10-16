# Guided Diagnostics V2F: the AI bridge

Research prototype, still not wired into the app. Builds on V2E (`cde7f40`,
[v2e-next-best-test.md](v2e-next-best-test.md)). There are no model calls,
no SDK and no new dependency. Tests use deterministic fakes. Everything is
SYNTHETIC / TEST ONLY.

## Authority boundary

The deterministic engine (`app/lib/diagnostic-workflow`) remains the only
owner of:

- transitions, cause state and pass/fail;
- specification trust, conditions, safety and capability gates;
- code and snapshot interpretation and next-best-test ranking;
- repair verification and the final outcome.

The bridge (`app/lib/diagnostic-workflow-bridge`) sits around it, uses only
its public API, and is never imported by it:

```
text → adapter (any model) → strict schema → scoped to the current step
     → dry run through the engine → CANDIDATE → acceptProposal → submitStep
engine state → explanationContext (facts only) → adapter → strict schema
     → deterministic checks → explanation (or deterministic fallback)
```

Adapters (`ParserAdapter`, `WorkflowSuggestionAdapter`,
`ExplanationAdapter`) are three small interfaces that return `unknown`, so
the bridge validates everything and no vendor is assumed. User text travels
in its own field, never inside the instructions.

## Parsing flow

- **`expectedInput`** describes only what the current step accepts: its
  kind, the allowed options or units, and whether "unable" or "inconclusive"
  is allowed. At a test selection, the options are the deterministic
  ranking's eligible tests, in order.
- **`parseStepInput`** checks the model output against a strict schema, then
  checks that the kind matches the current step. The bridge supplies the step
  id, so a model can never name one. The engine then judges the candidate on
  a dry run with `submitStep`, whose result is discarded. Parsing never
  changes the session.
- **`acceptProposal`** applies a valid candidate through the normal
  `submitStep` path, identical to a direct submission. It is refused if the
  session has moved on, so the same text accepted twice never records the
  same evidence twice.
- **Repair verification is never parsed.** It needs structured after-repair
  evidence (scans, readings) entered directly.

## Ambiguity

The parser returns one of four results:

- **valid**;
- **ambiguous:** what was understood, what is unclear, the engine-allowed
  options, and only those readings the engine would accept. Ambiguous input
  can never be accepted;
- **unsupported**;
- **invalid:** malformed output, an adapter error, the wrong kind for the
  step, or rejected by the engine.

Only a valid result can advance a session.

## Schema validation

zod is the project's existing approach, and every object is strict. An
extra field makes the whole output invalid, and the bridge fails closed with
the schema paths, never the raw text. Examples of extra fields: a step id,
`rulesOut`, `supports`, a cause, `confidence`, `trust`, `completeness`, or a
workflow body. The schemas have no way to express a cause change, a
transition, a verdict or a specification.

## AI-specification trust rule

A value a model calls "normal" is kept only in the separate audit record, as
`{ trust: "unverified", origin: "ai_parser", usedByEngine: false }`.
`informationalNoteOnly` turns it into display-only data that the
SpecificationProvider cannot accept. A `trust` field in model output is
invalid. Readings are judged only against the provider's pinned
specification, under the V2B rules.

## Codes at the start

`parseStartFacts` turns mentioned codes into a scan with `source: "person"`,
`completeness: "unknown"` and unknown status. A model can never claim a
complete scan, so it can never create a definite absence. Only standard
P/B/C/U codes are accepted from a model, and symptoms must be ids the
workflow lists.

## Workflow-suggestion boundary

`suggestWorkflows` accepts only ids from the supplied catalog. Invented ids
are reported as rejected. Each suggestion is then checked deterministically
(valid, applicable to the vehicle) and comes back as `startable`,
`not_applicable`, `insufficient_context` or `invalid_workflow`. Nothing is
started, and there is no production discovery.

## Explanation boundary and safety preservation

`explanationContext` holds only deterministic facts:

- the current step;
- causes: unresolved, supported and ruled out;
- the evidence references;
- the `nextBestTests` result;
- safety warnings, and unavailable tests with why;
- the recorded conflict;
- verification status and `recheckPlan`.

The model is never asked to diagnose. Its output is
`{ summary, why, whatToDoNext, warnings }` in a strict schema. It is
**rejected**, and the deterministic explanation used instead, if it:

- softens a safety warning;
- invents numbers, probabilities or money;
- gives a driving verdict;
- claims a cause without a conclusion;
- claims repair success, or that codes are gone, before verification;
- takes a side in, or adds a fault to, a recorded conflict;
- puts an alternative ahead of the recommended test;
- proposes a test the engine marks unavailable.

Deterministic hazard warnings always come first and verbatim. A model may
only add to them. Explaining never changes the session.

## Audit and provenance

Every parse returns an audit record: `source: "ai_parser"`, an FNV-1a
reference to the text (not the text), the step, the expected kind, the
outcome and the proposal. It lives outside the session. Rejected proposals
never touch the evidence. Accepted ones become evidence only through the
engine's normal input path, with no AI markers.

## Why the engine has no AI dependency

The engine stays deterministic, offline and replayable. No model, network or
schema library can change a transition or a judgement, and replay never
depends on explanation text. A test enforces that the engine folder imports
no zod, openai, Anthropic SDK or bridge code, and does no network calls.

## Production build

Pending verification on a local machine or CI. The cloud environment blocks
Google Fonts and Prisma network access, and the same limitation reproduces on
untouched `ccc2aa9`.
