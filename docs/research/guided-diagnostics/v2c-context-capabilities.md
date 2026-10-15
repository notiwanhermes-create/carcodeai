# Guided Diagnostics V2C: vehicle context, capabilities, external-tool steps

Research prototype, still not wired into the app. Builds on V2B (`862fb83`,
[v2b-specifications.md](v2b-specifications.md)). Everything is SYNTHETIC /
TEST ONLY / NOT OEM DATA. There is no VIN decoding, no vehicle database and
no vehicle communication.

## VehicleContext (pinned)

`{ year?, make?, model?, engine?, fuel?, cylinders?, market? }`. These are
only the fields that decide applicability or a specification. At session
start the context is normalized (text trimmed, single-spaced and lower case;
blank means unknown) and frozen into `session.facts.vehicle`. Invalid values
(a fractional year, an unknown fuel, an unsupported field such as `vin`) are
refused, not repaired.

That pinned copy is the vehicle for the whole session. Replays and resumes
use the saved facts, so a later change of the selected vehicle never reaches
an old session. Re-pointing a saved session at an inapplicable vehicle makes
the resume fail.

## Workflow applicability

`workflow.applicability` is declarative, not scripted:

```
{ fuel?: [...], make?: [...], engine?: [...], market?: [...],   // any of
  years?: { from?, to? }, cylinders?: { min?, max? } }           // all must hold
```

`checkApplicability` returns one of three results:

- `not_applicable`, naming the mismatched fields, if any known fact fails.
  A known mismatch is decisive even when other facts are unknown.
- `insufficient_context`, naming the missing fields, if any needed fact is
  unknown. It is never guessed.
- `applicable` otherwise. No declaration means any vehicle.

`startSession` refuses anything but `applicable`, so an inapplicable workflow
never starts. Comparisons are case-insensitive.

## SpecificationProvider and vehicle context

The request is now `{ id, vehicle }`, carrying the session's pinned, frozen
context, so a future provider can choose the value for that vehicle. The
in-memory test provider ignores it. Trust, ambiguity, units, conditions and
pinning are unchanged. Resume still replays only pinned resolutions, and
`specificationDrift` re-asks with the pinned vehicle.

## Capability context

```
DiagnosticCapabilityContext = {
  skill: owner | diy | professional,
  scanAccess: none | codes | live_data | bidirectional,   // ordered
  instruments: [hand_tools, multimeter, pressure_gauge, compression_tester, oscilloscope, smoke_machine, other],
  facilities: [vehicle_lift, workshop_space],
}
```

Steps declare `requires: { level, scan?, instruments?, facilities?, hazards? }`.
The old flat tool list is gone: a scan tool is now scan access, and a lift is
a facility. The engine reads only this explicit data.

Basic, DIY, Advanced DIY and Workshop are helpers in
`examples/capability-presets.ts` (tests and development only). They return
fresh explicit contexts and grant nothing on their own.

## Unavailable is not failure

Before a step is presented, `capabilityShortfall` checks skill, then scan
access, then instruments, then facilities. If anything is missing, the step
is not presented. An `unsupported` evidence record (source `engine`) keeps the
reason and every missing item (`missingCapabilities`, e.g.
`scan_access:bidirectional`). The step then takes its cannot-be-done route.
It has no effect on causes. The person can still say "unable", or record an
inconclusive result, where the step allows it. Prerequisites and named
conditions still apply to every step, including the new kinds: the checker
refuses a workflow where any route could reach them unestablished.

## actuator_test (modelling only)

An external, compatible tool commands a generic actuator (`actuator:
"fuel_pump"`), and the person reports what happened, from the step's own
`results`. The checker requires bidirectional scan access, hazard notes, a
generic lower-case id (no manufacturer commands) and exactly one route per
result. Evidence: `kind: "actuator_test"`, `actuator`, `performedBy:
"external_tool"`, source `scan_tool` (default) or `person`. The engine never
connects to or commands a vehicle.

## service_function (modelling only)

This is kept separate from actuator tests because the semantics differ. The
tool runs a generic routine (`serviceFunction: "generic_self_test"`) and
reports a fixed status: `completed` or `failed` (each routed and able to
affect causes), or `not_supported`. Not supported is unavailable, not failure:
it takes the cannot-be-done route and can never affect causes. `inconclusive`
uses the usual input. The checker applies the same bidirectional, hazard and
generic-id rules. Evidence is recorded like an actuator test, with
`serviceFunction`.

## Synthetic fixture (version 4)

The fixture applies to synthetic gasoline or hybrid engines with 2–8
cylinders. Steps state their capability needs. A synthetic fuel-pump actuator
test sits before the fuel pressure test.

- Basic and DIY users are routed safely past it. With no bidirectional
  access, it goes straight to the pressure test.
- A workshop context can run it. No response supports the fuel-supply cause.

## Not built

VIN decoding, applicability databases, ECU definitions or communication,
actuator or service execution, UDS/CAN, richer trouble codes, freeze frames,
next-best-test ranking, the AI bridge, persistence, UI and API integration,
and real specifications.

## Production build

Pending verification on a local machine or CI. The cloud environment blocks
Google Fonts and Prisma network access, and the same limitation reproduces on
untouched `ccc2aa9`.
