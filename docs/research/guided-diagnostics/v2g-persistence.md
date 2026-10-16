# Guided Diagnostics V2G: persisted diagnostic sessions

Research prototype, still not wired into the app. Builds on V2F (`2caaade`,
[v2f-ai-bridge.md](v2f-ai-bridge.md)). No routes, no UI, no AI calls.
Everything is SYNTHETIC / TEST ONLY / NOT OEM DATA.

## Boundary

```
engine (app/lib/diagnostic-workflow)          ← imports nothing below
   ↑ public API only
persistence (app/lib/diagnostic-workflow-persistence)
   canonical.ts         one codec: canonical JSON, digests, workflow fingerprint
   envelope.ts          versioned envelope + payload schemas (zod)
   workflow-resolver.ts exact id + version lookup
   owner.ts             authenticated owner
   repository.ts        storage contract
   in-memory-repository.ts   deterministic, for tests
   session-store.ts     save / load / history: all validation lives here
   prisma-repository.ts the only file that touches Prisma (client passed in)
```

Save: engine session → codec → checks → repository (compare-and-set).
Load: repository → envelope schema → versions → digest → exact workflow →
engine replay (`resumeSession`) → full equality → usable session.

Persistence never advances a session. The caller runs `submitStep` (or the
V2F bridge's `acceptProposal`) and saves the result. The database is never the
diagnostic authority.

## Envelope

**Relational columns** (ownership, lookup, lifecycle, concurrency):

- id, owner (`user_id`), vehicle (`vehicle_id`);
- workflow id, version and content fingerprint;
- persistence version (envelope layout) and session-format version (the
  engine's session layout as of V2F);
- revision, lifecycle (`active` / `completed`), current step;
- integrity algorithm and payload digest;
- an optional `create_key` for idempotent starts;
- created, updated and completed timestamps.

**Payload:** the engine's `DiagnosticSession`, exactly as produced, in
canonical form. It carries the pinned vehicle, the scans with their
completeness and snapshots, the inputs, the evidence (including
before/after-repair phase, provenance, conflict and test-selection records),
the pinned specifications, the conditions, the causes, the fault model, the
current position, the conclusion and the repair verification. No explanation
text and no AI output is stored.

The lifecycle is separate from the diagnostic outcome (`endResult`), which
stays in the payload.

## Codec and versioning

- **One canonical serialization:** sorted keys, so it never relies on key
  order.
- **Plain data only:** objects, arrays, strings, finite numbers, booleans and
  null. Functions, class instances (`Date`, `Map`), symbols, bigints,
  NaN/Infinity and cycles are refused, never coerced.
- **Strict schemas:** the envelope and the payload's top level are strict, so
  an unknown field is corruption.
- **Versions:** both are explicit. A higher persistence version, or an unknown
  session format, answers `unsupported_version` and is never guessed at.
- **Engine fix:** the engine's resume comparison used plain `JSON.stringify`
  for structured evidence detail and the V2A fields, so a session whose keys
  had been reordered by storage (sorted, or reordered by `jsonb`) was refused.
  It now compares with sorted keys. This is the only engine change, and it is
  what `resumeSession` already promised ("key order … ignored").

## Exact-version rule

`WorkflowResolver.resolve(id, version)` returns that exact definition or
null. There is no "latest" lookup and no fallback:

- A session is checked against the content fingerprint stored with it.
  Edited content under the same version answers
  `incompatible_workflow: workflow_changed`.
- A missing version answers `incompatible_workflow: workflow_unavailable`,
  even when a newer version exists.
- A session is never migrated to a newer workflow. Continuing under a newer
  one means starting a new session.

The in-memory resolver refuses two different definitions under one id and
version. There is no production registry.

## Load and replay

Checked in order, failing closed at the first problem:

1. **Record shape:** a malformed record is corrupted.
2. **Versions:** an unsupported one answers `unsupported_version`.
3. **Envelope and payload schema.**
4. **Integrity:** the algorithm matches, and the digest matches. The digest
   seals the identity, owner, vehicle, workflow and its fingerprint, the
   versions, the revision, the lifecycle, the current step and the payload.
5. **Metadata is possible:**
   - the revision equals the number of inputs + 1;
   - the lifecycle matches the session status;
   - the current step matches the session;
   - the timestamps are ordered, with `completedAt` set exactly when the
     session is completed;
   - the workflow identity matches the payload.
6. **Exact workflow, unchanged.**
7. **Replay:** `resumeSession` replays the inputs against the pinned facts and
   pinned specifications, and the rebuilt session must equal the stored one
   field for field, in canonical form.

Outcomes: `loaded`, `not_found`, `forbidden`, `corrupted`,
`incompatible_workflow`, `unsupported_version`.

Nothing is repaired. Loading uses no AI, no specification provider and no
live vehicle data, and changes nothing. The store has no provider to ask.
`specificationDrift` remains a separate, read-only report.

## Corruption

The digest catches any edit made without recomputing it. If someone does
recompute it, replay still catches edits to:

- evidence, causes, conflicts and the current step;
- a pinned specification, whenever the edit changes a judgement.

Replay cannot catch an edit to replay *inputs* (a pinned specification limit,
the pinned vehicle) that changes no judgement. For that, `hmac-sha256` keys
the digest with a server secret, so a record edited without the secret is
refused. Tests cover:

- edited evidence, cause state, conflict record and pinned specification;
- a changed workflow version;
- an invalid current step;
- a malformed payload or record;
- unsupported versions;
- impossible revision, lifecycle and timestamp metadata;
- an inconsistent history;
- a rewritten completed session.

## Concurrency and idempotency

**Optimistic concurrency.** Every update names the revision it was based on.
The repository does compare-and-set on (id, owner, revision,
`lifecycle = active`):

- a stale writer gets `conflict` with the current revision;
- a completed session gets `immutable`;
- there is no last-write-wins;
- the (session, revision) primary key makes a double write of one revision
  impossible.

**Valid transitions.** A save must be exactly one accepted input past the
stored revision. It must keep the same workflow, pinned facts, start time and
fault model, and leave earlier inputs, evidence and pinned specifications
untouched. The new state must itself replay exactly. Anything else is
`invalid_transition` or `invalid_session`.

**Idempotency, without an event framework:**

- A retried save whose result is already the current revision (same digest)
  answers `saved` with `duplicate: true`. Nothing is written twice, including
  when two identical retries race.
- A retried start with the same `createKey` returns the session it made.
- The same key with a different session is `create_key_conflict`.

## Ownership

`SessionOwner` can only come from `ownerFromAuthenticatedUser`, which a future
route calls with the server-side signed-in user's id, never an id from the
request.

- Every repository call takes the owner and filters by it.
- Another user's session answers exactly like a missing one (`not_found`), so
  existence never leaks.
- A missing or malformed identity is `forbidden`.
- A new session's vehicle must belong to the owner; this is checked in the
  same transaction as the insert.

## Vehicle relation and deletion

`vehicle_id` is a required foreign key to `garage_vehicles`. The pinned
`VehicleContext` in the payload is history, and later edits to the garage
vehicle never touch it (tested on PostgreSQL).

Phase 2E behaviour, inspected before choosing:

- removing a vehicle archives it, and deletes nothing;
- `deleteVehiclePermanently` deletes an *archived* vehicle's repairs,
  diagnoses and service records itself, in one transaction, then the vehicle.

**Decision: `ON DELETE CASCADE`**, from the vehicle and from the account.

- **Why:**
  - `NO ACTION` would make permanent deletion fail once a vehicle had a
    session.
  - Avoiding that by deleting sessions explicitly would mean changing
    production delete code, which is out of scope.
  - `SET NULL` would leave a "deleted for good" vehicle's diagnostic history
    (and its pinned description) behind, against what the user asked for.
  - Cascade matches the meaning of permanent deletion, needs no production
    change, and can only fire for a vehicle the app already allows to be
    deleted (archived).
- **Tested on PostgreSQL:**
  - archiving keeps the sessions;
  - the unchanged `deleteVehiclePermanently` succeeds and removes them;
  - deleting an account removes them.
- **Deviation from convention:** the convention elsewhere is "nothing
  cascades from a vehicle". When sessions reach production, the delete should
  also remove them explicitly and report the count. The foreign key could then
  become `NO ACTION`, like `diagnoses`.

## History

Strategy A: the current row plus append-only revision rows (metadata only:
transition, step answered, input count, lifecycle, current step, end result,
digest, input origin, timestamp). The state at any revision is the replay of
its first N inputs, so payloads are not copied.

`history()` answers when the session started, which transition changed it,
the current revision, when it completed, and how it ended. It checks itself
against the session (count, order, steps, latest digest).

## AI separation

- Replay needs no adapter and no explanation.
- An accepted AI-parsed input is stored exactly like a direct one (identical
  payloads, tested). The revision row records `input_origin = ai_parser` and
  the V2F FNV-1a hash of the text, never the text itself; raw text is refused
  as a reference.
- Rejected and ambiguous proposals produce no new revision and are not stored
  anywhere.

## Database adapter status

- **Schema:** two additive models.
- **Migration:** `20261016120000_guided_diagnostic_sessions`, hand-written
  because the Prisma schema engine cannot be downloaded in the cloud
  environment. It is only `CREATE TABLE`, `CREATE INDEX` and
  `ADD CONSTRAINT`, and touches no existing table. It has not been applied to
  any shared or production database. A Vercel preview build skips migrations;
  only a production build applies them.
- **`createPrismaSessionRepository(prisma)`:** implements the same contract.

**Verified in the cloud environment against a throwaway local PostgreSQL 16:**

- every contract test, on PostgreSQL;
- PostgreSQL-specific tests: row layout, vehicle edits, SQL tampering, check
  constraints, archive and permanent delete, account delete;
- the existing database suites.

**Pending local database verification:** the suites that need the Prisma
CLI (`prisma migrate deploy` / `migrate diff`). These are the real migration
command, schema-file vs migration equality, and the rollback check. They fail
the same way on untouched `2caaade` here, because the Prisma engine download
is blocked.

## Production build

Pending verification on a local machine or CI, for the same environment
reasons as in earlier stages.
