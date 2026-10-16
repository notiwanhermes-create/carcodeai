# Guided Diagnostics V2D: structured trouble codes and freeze frames

Research prototype, still not wired into the app. Builds on V2C (`f71e53e`,
[v2c-context-capabilities.md](v2c-context-capabilities.md)). Everything is
SYNTHETIC / TEST ONLY / NOT OEM DATA. There are no code definitions, no
manufacturer meanings and no vehicle communication.

## Structured code evidence

`facts.dtcs: string[]` is gone. Codes arrive as **scans**:

```
DiagnosticScanInput = {
  id, source: scan_tool | person,
  completeness: complete | partial | unknown,
  coverage?: { modules: [...] },        // what a complete scan covers
  reportsStatus?: [flags...],           // which flags this source can report
  codes: [{ code, format?: obd | opaque, status?: [flags...], module?: { id, name? }, snapshot? }],
  snapshots?: [...],
}
```

Each code is recorded as `kind: "code"` evidence with a structured `dtc`:
`raw` (exactly as given), `code` (canonical), `format`, `system` (OBD only),
`status`, `module`, `snapshot` and `scan`.

Normalization happens only where it is unambiguous:

- **OBD:** a standard P/B/C/U five-character code is upper-cased (`p0301`
  becomes `P0301`).
- **Opaque:** a code declared opaque is kept exactly as given.
- **Unclassified:** anything else that is one clean token is kept exactly as
  given.
- **Rejected:** malformed input (internal spaces, control characters,
  over-long, a non-OBD code declared OBD), a duplicate code in one scan, and
  unknown fields such as `canId`.

Surrounding whitespace is trimmed. The raw text is always kept.

## Reported-status semantics

Status is a set of **reported** flags (`pending`, `confirmed`, `permanent`,
`history`, `active`), or `unknown` when none were given.

- **Flags must be declared:** a source can only report flags it declares in
  `reportsStatus`. `active` (present now) additionally needs that explicit
  declaration.
- **No inference:** a status never changes causes or routes on its own. A
  workflow uses it only through an explicit rule (the fixture's
  `{ dtc: { code, status: "confirmed" } }`).
- **A missing flag proves nothing** unless the source declares it reports
  that flag and the scan is complete.

## Matching and input completeness

Conditions are now three-valued (yes, no, unknown), and a branch rule fires
only on a definite yes:

- `{ dtc: { code?, status?, module? } }`: yes if reported.
- `{ noDtc: … }`: yes only when absence is provable.
- `all`, `any` and `not` follow three-valued logic.

**Absence is provable only from a complete scan that covers the question**:
no coverage, or the asked module within its coverage. A partial or unknown
scan, or none, gives "unknown". That means "not observed in the supplied
evidence", never "absent". A matching code from an unstated module blocks a
definite "absent from that module". `dtcAny` and every text-prefix match are
gone.

### Vehicle-fact conditions (correction)

`{ vehicle, equals }` is three-valued too. It is yes when the pinned fact
matches, no when the pinned fact is known and differs, and unknown when the
fact is missing. A blank value is normalized away at session start, so it is
missing too.

A branch takes the first rule that is definitely yes. If it reaches a rule
that is unknown because of a vehicle fact, it stops there and takes its
`ifInconclusive` route, recorded as `unknown:<facts>`:

- going on to a later rule, or to `otherwise`, would treat unknown as no;
- the validator requires that route on any branch with a vehicle condition.

Scan-evidence rules are unchanged: a rule left unknown by an incomplete scan
is passed over, and absence is never concluded.

Applicability at session start is separate and unchanged. It can refuse to
start when required context is missing. Conditions inside a running workflow
never turn a missing fact into no.

`stepReachability(workflow, session)` labels every step ahead:

- reachable: a route this session can take leads there;
- potential: reachable only if missing context (a vehicle fact, or scan
  evidence) were known;
- unreachable.

Only branches on fixed facts prune. `separatingSteps` leaves out unreachable
steps and keeps potential ones, labelled `reachability: "potential"`. Its
ranking is unchanged.

## Snapshot vs live measurement

A snapshot (`kind: "snapshot"`) holds values captured with a fault. It has an
id, the code it was captured with (`forCode`) or none (standalone), generic
parameter ids, values (number or text, or missing when not provided), units,
`captured` time and order, and completeness. It is frozen and pinned.

It is **not** a measurement:

- importing one never produces pass or fail, never changes causes, and never
  picks a route;
- a workflow step asking for a live reading still asks for one, even when a
  snapshot holds the same quantity.

Only an explicit `snapshot_check` step interprets one parameter. It reads
from the first matching code's snapshot or the first snapshot, and judges it
like a measurement against a fixed generic range or a pinned V2B
specification. Only a verified specification with confirmed conditions
drives it.

- **Cannot read or use the value** (no snapshot, missing or text value,
  wrong unit kind, implausible value, unresolvable spec): it takes
  `ifUnavailable`.
- **Untrusted spec or unconfirmed condition:** it takes `ifInconclusive`.
- **The record** names the snapshot, the parameter, the value and the pinned
  spec (id and revision).

## Before- and after-repair evidence

Start scans are before-repair evidence. A post-repair scan is supplied with
the `codes_absent` verification criterion. It is recorded as its own
after-repair evidence, and the earlier scan is untouched.

| Post-repair scan shows the target codes as | Criterion |
| --- | --- |
| pending, confirmed or active | not met |
| only permanent or history, or unknown status | inconclusive (reported data, not proof of failure) |
| not listed, complete scan covering them | met |
| not listed, partial or unknown scan | inconclusive ("not observed in supplied evidence") |

A bare "met" without a scan is refused. A person may still report
`not_met` or `inconclusive`.

## Control-unit provenance

A code can carry `module: { id, name? }` as supplied. The id is a normalized
generic identifier and the name is kept as text. A complete scan may state
`coverage.modules`. It is provenance only: no ECU database, topology,
addressing, CAN identifiers or diagnostic sessions.

## Replay

Start scans are pinned in the frozen session facts, and post-repair scans in
the recorded inputs, so replay rebuilds the same evidence.

- **New evidence needs a new id:** scan and snapshot ids are unique per
  session, so a later scan can never replace an earlier one. New scan
  evidence enters only through repair verification, or a new session.
- **Resume checks the structured details:** `resumeSession` also compares
  each code, scan, snapshot and snapshot-check record, so an edited status
  or frame is refused.

## What V2D deliberately does not infer

V2D never infers any of these:

- that a status means a bad part, an active fault or a confirmed cause;
- that a code is absent from an incomplete scan, or that a missing vehicle
fact means no;
- that a repair worked because a code was not supplied, or failed because a
  permanent code remains;
- a pass or fail from any snapshot value it was not explicitly asked to judge.

It also never infers a code's meaning or the module that sent it.

## Production build

Pending verification on a local machine or CI. The cloud environment blocks
Google Fonts and Prisma network access, and the same limitation reproduces on
untouched `ccc2aa9`.
