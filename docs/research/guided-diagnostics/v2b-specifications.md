# Guided Diagnostics V2B: specifications

Research prototype, still not wired into the app. Builds on V2A (`34e89c4`,
[v2a.md](v2a.md)). No real vehicle data: every specification here is
SYNTHETIC / TEST ONLY.

## Why specifications live outside workflows

A workflow is generic troubleshooting logic ("if the fuel pressure is low,
suspect the supply"). The number that counts as low depends on the vehicle,
the source and its edition. Keeping that number out of the workflow means:

- one reviewed workflow serves many vehicles;
- every value carries its source and trust, and can be replaced without
  touching or re-reviewing the logic;
- a workflow can never quietly embed an unsourced number. The checker now
  refuses a range bound that is not a fixed generic number.

A measurement names one `specification` id, and its outcomes say where the
reading sits against it: `relativeToSpec: "below" | "within" | "above"`.
Fixed numeric ranges remain only for generic checks.

```
workflow → specification id → provider → resolution → engine interpretation
```

## Provider contract

```ts
interface SpecificationProvider {
  resolve(request: { id }): SpecificationResolution;   // synchronous, deterministic
}

DiagnosticSpecification = {
  id, revision,             // revision identifies this exact value set
  unit,                     // as the source gives it
  expected: { min?, max? }, // inclusive pass range, at least one end
  plausible?: { min, max }, // optional, applied only when verified
  conditions?: [...],       // named conditions the value holds under
  source: { name, reference? },
  trust: "verified" | "reference" | "unverified",
  note?,
}
```

The engine never calls a provider directly. `resolveSpecification` wraps
every call:

- a thrown error becomes `unavailable: provider_error`;
- no provider becomes `unavailable: no_provider`;
- a malformed record, or one answered under another id, becomes `unavailable`;
- results are deep-copied and frozen.

`createInMemorySpecificationProvider` (in `examples/`) is a test and
development provider only. It is not a model of the production data store.

## Resolution states

| Status | Meaning | Engine behavior |
| --- | --- | --- |
| `verified` | One match, trust `verified` | Judges the reading (if conditions are confirmed) |
| `informational` | One match, not verified | Records the reading and the spec for display; no judgement |
| `not_found` | No match | Step not presented (`spec_not_found`), cannot-be-done route |
| `ambiguous` | Several candidates | Step not presented (`spec_ambiguous`); candidates kept, none picked |
| `unavailable` | Lookup failed | Step not presented (`spec_unavailable`) |

A spec in another kind of unit (volts for a pressure) is also unusable
(`spec_incompatible_unit`). A compatible unit (bar for a kPa step) is converted
by the existing converter, and the source unit is kept in the judgement.

## Trust behavior

This is the V2A rule, unchanged. Only a `verified` resolution may produce
pass or fail, change causes or choose a route. Anything else is recorded with
its value, source and trust (`judgement: { evaluated: false, reason:
"untrusted_spec" }`) and takes the step's inconclusive route. Trust is never
upgraded. A provider that says `verified` for an unverified record, or the
reverse, is refused as `unavailable: inconsistent_trust` rather than
corrected.

## Conditions

The provider states the conditions a value holds under. It does not decide
whether they are met. The engine checks them against the session:

- `met`: established by a prerequisite or an action;
- `not_met`: a prerequisite was answered "not met";
- `unknown`: never confirmed either way.

Not met or unknown leaves the reading unjudged (`condition_not_met`,
`condition_unknown`), with each condition's state recorded.

## Ambiguity behavior

The engine never chooses between candidates. The step is skipped as not
evaluable, and the candidates are kept in the session for display. Narrowing
candidates (by vehicle, engine, edition) is applicability work, deferred to V2C.

## Replay and history

The smallest safe design: **pin, record, never re-resolve history.**

- Each spec is resolved once per session, when its step is reached. The
  resolution is recorded as evidence (`kind: "specification"`, value
  `verified <id>@<revision>`) and pinned in `session.specifications`.
- Later steps, repair re-tests and resumes use the pinned resolution.
  `resumeSession` replays against a provider built only from the pinned
  resolutions, never the live one. A change in the data cannot rewrite a
  recorded judgement.
- Editing a pinned value in a saved session makes its inputs lead somewhere
  else, so the resume is refused.
- `specificationDrift(session, provider)` reports, explicitly, when the
  provider now answers differently (another revision or value). Using new
  data means starting a new session.
- `replaySession` with a given provider is a fresh run with that data, which
  is deterministic for the same data.

## Future production-data considerations

- The engine stays synchronous. A production provider would fetch the
  specifications a workflow names before the session runs (a database or
  licensed service), then hand the engine an in-memory snapshot.
- `revision` must be a real, immutable identity (source edition plus dataset
  version). Stored sessions should keep their pinned resolutions with them.
- Applicability (VIN, engine code, year) belongs in the provider's lookup
  (V2C), so that `ambiguous` becomes rare without the engine ever guessing.
- Who may mark a value `verified`, and how sources are licensed, are content
  and governance decisions, not engine features.

## Production build

Pending verification on a local machine or CI. The cloud environment blocks
Google Fonts and Prisma network access, and the same limitation reproduces on
untouched `ccc2aa9`.
