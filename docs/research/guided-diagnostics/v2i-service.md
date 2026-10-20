# Guided Diagnostics V2I: integration readiness

Research prototype, still not wired into the app. Builds on V2H (`085b959`,
[v2h-reviewed-content.md](v2h-reviewed-content.md)).

- **No route, no UI, no change to `/api/diagnose`.** Nothing in the app
  imports the new service (tested).
- **No engine, bridge or content change.** The service foundation
  (`b66aca7`) changed no persistence code either. The concurrency contract
  (`cb4179e`, below) later changed the V2G session store and both
  repositories. That change is behavioural only: no schema change.
- **No migration, no schema change, no AI calls.**

V2I had two gates: first verify the V2A–V2H line for real, then add a
server-only service. The concurrency and retry contract was finished
afterwards, at `cb4179e`.

## How to read the evidence in this document

Three kinds of evidence appear below. They are kept apart on purpose:

- **Inspected:** read in the code at `cb4179e` while this document was
  updated (2026-10-20). Nothing was executed.
- **Historical:** checks recorded when they were run, in this document or in
  a commit message. They were **not** re-run when this document was updated.
  They describe the code as it was then.
- **Executed for this update (2026-10-20, at `cb4179e`):** only the in-memory
  V2I suites. See "Evidence executed for this update" below. No database,
  PostgreSQL, build or rollback check was run for this update.

## Gate A: verification of the V2A–V2H line (historical)

Run on a Windows machine against throwaway local databases only, before the
service existed. Not re-run since.

| Check | Result |
| --- | --- |
| `npx prisma generate` from this branch's schema | done |
| `npm run typecheck` | pass |
| `npx eslint` | 0 errors (21 warnings, the existing baseline) |
| `npm run build` | pass; its migration step skipped itself (not a Vercel production build) |
| Full `vitest` with the database suites, real PostgreSQL 17.10 | pass, except one intermittent test (below) |
| Real migration command, from the Phase 2E database with data | V2G migration applied; data intact |
| `prisma migrate status` | "Database schema is up to date" |
| `prisma migrate diff` (database vs `schema.prisma`) | "No difference detected" |
| `db:migrate` a second time | "No pending migrations" |
| `npm run db:rollback-check` (Phase 2D, its default) | pass |

**The V2G migration** (`20261016120000_guided_diagnostic_sessions`) only
creates two tables, three indexes and three foreign keys. It drops, renames,
retypes and updates nothing. No earlier migration was edited.

**Rehearsal from the real pre-V2G state:**

1. The Phase 2E release (`7bb5408`) built an empty database with its own three
   migrations through `prisma migrate deploy`.
2. Two users and three garage vehicles were added, one of them archived.
3. This branch's `npm run db:migrate` applied only the V2G migration.
4. Every row was still there, and the status and diff checks above passed.

**Rollback:**

- The migration only adds tables, which older releases never read. The
  Phase 2D rollback check passes (Gate A run above).
- At Gate A there was no Phase 2E harness: pointed at `7bb5408`, the runner fell
  back to the 2D harness, which fails on 2E's two extra tables.

**Rollback tooling follow-up (historical; 2026-10-19 to 2026-10-20, branch
`test/phase2e-rollback-compatibility`, now in this line as `6176121`):**

- `scripts/rollback-check/baselines.mjs` now lists each release, by full commit
  id, with its own harness: `phase-2c`, `phase-2d`, `phase-2e`. The default is
  `phase-2e`, the release in production. Phase 2D is still selected, and runs
  the same unchanged harness, with `phase-2d` or `bdf96de`.
- Any other ref is refused before anything is copied or a database touched.
  The fallback is gone.
- `scripts/rollback-check/harness.phase-2e.mjs` runs Phase 2E's real code
  against a database migrated by this release, with guided sessions and
  revisions in the V2G tables. See docs/database.md, "Rollback check", for
  what it exercises.

| Check | Result |
| --- | --- |
| `npx vitest run tests/rollback-baselines.test.ts` (Phase 2D selection, Phase 2E selection and default, unsupported/unknown/missing baselines refused with nothing copied, Phase 2E harness expects 2E's own migrations and tables and the V2G ones) | pass, 16 of 16 |
| `npm run typecheck` | pass |
| `npx eslint` on the changed files | pass, no findings |
| **Phase 2E rollback rehearsal against a database** (`npm run db:rollback-check`) | **pass** (2026-10-20). Ran against a throwaway real PostgreSQL 17.10 (embedded-postgres in a separate scratch project, not `prisma dev`). The Phase 2E harness ran its four parts (A: 2E builds its DB and stores data; B: this release's migrations apply on top, keep every value, and add the V2G tables; C: after a rollback 2E reads everything back and keeps working, guided sessions survive, and permanent-delete of the archived vehicle cascades to its sessions; D: roll-forward finds nothing to do), 4 of 4. |
| Phase 2D rollback check after this change (`npm run db:rollback-check -- phase-2d`) | **pass** (2026-10-20), same database, 4 of 4, still running `harness.phase-2d.mjs`. |

Both rehearsals passed on real PostgreSQL, so Phase 2E rollback compatibility
with V2G is verified, not merely expected from the migration being additive.
(The full `database.db.test.ts` suite was not run whole: its known legacy
embedded-Postgres connection timeout is unrelated to this change; the rollback
checks here were run directly through `scripts/rollback-check/run.mjs`.)

**Environment findings, not defects (historical):**

- **`prisma dev` (PGlite):** two V2G concurrency tests fail on it with a
  wire-protocol error (`08P01`). They pass on real PostgreSQL. PGlite is not
  enough for concurrency tests; use a real PostgreSQL. Here that was the
  `embedded-postgres` npm package (PostgreSQL 17.10), installed outside the
  repository, with a UTF-8 database.
- **Intermittent test on `main`:** "clears out expired counters and nothing
  else" (the rate-limit suite) failed in 2 of 4 runs on real PostgreSQL. It
  passes alone and in other runs. Neither the test nor `app/lib/rate-limit.ts`
  differs from `main`.

## Gate B: the service

```
app/lib/diagnostic-workflow-service/
  policy.ts          which content a NEW session may start from (one place)
  vehicles.ts        the owner's garage, as a small interface (+ in-memory, for tests)
  prisma-vehicles.ts the only file that touches Prisma: reads garage_vehicles, owner-filtered
  service.ts         orchestration
  index.ts           public API (without the Prisma file)
```

`createGuidedDiagnosticsService({ catalog, repository, vehicles, contentPolicy?, specifications?, clock? })`
returns:

- **`listStartable()`:** what a new session may start from.
- **`startGuidedSession(owner, { vehicleId, workflow: { id, version }, capabilities, vehicleDetails?, scans?, symptoms?, createKey? })`**
- **`submitGuidedStep(owner, { sessionId, expectedRevision, input })`**, or
  `{ …, proposal }` with a V2F `ParseResult`.
- **`loadGuidedSession(owner, sessionId)`**
- **`guidedSessionHistory(owner, sessionId)`**

**Owner.** Every call takes a `SessionOwner`. A forged owner object answers
`forbidden`. Another user's session or vehicle answers exactly like a missing
one (`not_found`, `vehicle_not_found`).

**New-session content policy.**

- The default, `PRODUCTION_CONTENT_POLICY`, offers only `approved`
  `generic_source_backed` or `oem_licensed` content. Today that is nothing.
- Start and `listStartable` both use the catalog's `suggestionCatalog` (the
  V2F allow-list) filtered by the policy, in `policy.ts` only.
- A weaker policy can only be made by `testOnlyContentPolicy`. The service
  throws on any other policy object.
- The exact id and integer version are required. There is no "latest".

**Vehicle.**

- To **start**, the vehicle must be in the owner's garage and not archived.
  See "Archived vehicles" below for what happens afterwards.
- Year, make, model and engine come from the garage only.
- The caller may add only what the garage does not record: `fuel`,
  `cylinders` and `market`.
- The engine normalizes and pins the result. Unknown stays unknown: without a
  fuel, the generic workflow does not start (`insufficient_context`).

**Start.**

1. `startSession`.
2. The V2G `store.start`, with an optional `createKey`.

**Submit.**

1. V2G load: exact workflow, replay, fail closed.
2. If the caller's `expectedRevision` is not the stored revision, the answer
   is `conflict`. The input is never applied to a state the caller did not
   see. Only then is a completed session at the current revision `immutable`.
3. The engine's `submitStep`, or for a proposal the bridge's `acceptProposal`,
   which refuses non-valid and stale proposals and otherwise calls
   `submitStep`.
4. V2G `store.advance` (compare-and-set). An AI-parsed input is recorded with
   its text hash only.
5. A refused input or proposal records nothing.

## Concurrency and retry contract (current, `cb4179e`)

Inspected in `service.ts`, `session-store.ts`,
`in-memory-repository.ts` and `prisma-repository.ts`. Each rule names the
tests that assert it.

**1. Revision before immutability, everywhere.** A stale `expectedRevision`
is `conflict` (with the current revision), even when the session has since
completed — never `immutable`. `immutable` is only for a writer at the
**current** revision of a completed session. Revision is checked before
lifecycle at each layer:

- the service's pre-check (`service.ts`: revision, then lifecycle);
- the store's `advance` (`session-store.ts`: revision, then lifecycle);
- the in-memory repository's compare-and-set;
- the Prisma repository's compare-and-set, on both of its failure paths: the
  `updateMany` miss, and a lost transaction or unique violation.

One qualification at the store layer, not an exception to the order above: in
`advance`, a stale `expectedRevision` whose next revision equals the current
one is first checked against the already-persisted save (rule 3). If that save
matches in digest and provenance it is the same save, so the store returns
`saved` with `duplicate: true` — including when that matching save completed the
session. Only when it does not match does the store return `conflict`. Either
way the store decides on the revision before it ever considers immutability;
lifecycle never turns a stale writer into `immutable`.

Before `cb4179e` both repositories checked lifecycle first, so a stale writer
that lost to a completing update wrongly got `immutable`. That gap is closed.

Tests:

- shared contract, "starts from the owner's garage vehicle…", on in-memory and
  Prisma (`tests/helpers/guided-service-contract.ts`);
- "keeps a completed session immutable: stale revisions conflict, current ones
  are refused, typed or AI-parsed" (`tests/diagnostic-workflow-v2i-safety.test.ts`);
- "that loses the race to a winning save which completes the session is a
  conflict, not immutable" (`tests/diagnostic-workflow-v2i-retry.test.ts`);
- "on real PostgreSQL, a stale update after a competing update completes the
  session is a conflict, not immutable, and appends no revision"
  (`tests/integration/suites/guided-service.ts`). This drives the Prisma
  failure path directly.

**2. A retried submit that already went through is a `conflict`, not a
duplicate.** The service compares `expectedRevision` before it runs the
engine. A repeat of an applied submit, typed or as the same AI proposal,
therefore gets `conflict` on the revision it moved the session to. Nothing is
written twice. This holds even when the retry would produce an identical
session. A route must treat `conflict` as "reload and show the current
state". Tests (`v2i-retry`):

- "repeated after it went through is a conflict on the revision it moved to,
  and writes nothing twice";
- "repeated as the same AI proposal after it went through is a conflict too…".

**3. Losing the compare-and-set race to exactly the same save is that save.**
Two requests can both pass the service's pre-check, and one can lose at the
repository. The loser answers `saved` with `duplicate: true` only when the
winner's persisted revision matches it in two ways:

- the same payload digest, which includes the evidence time;
- the same provenance: the same `inputOrigin`, and for `ai_parser` the same
  `aiTextRef` hash.

Otherwise the loser gets `conflict`, and only the winner's evidence and
provenance are recorded. Provenance never changes diagnostic state. Raw AI
text is never persisted. Tests (`v2i-retry`), "a retried submission…":

- "…that loses the race to exactly the same typed / AI-parsed save is that
  save: duplicate, one revision";
- "…to the same answer given at another time is a conflict";
- "…to a different answer is a conflict";
- "…to the same answer with a different provenance is a conflict, not a
  duplicate";
- "…to the same answer parsed from different AI text is a conflict, not a
  duplicate".

The shared contract also covers this: "lets exactly one of two concurrent
submissions win".

**4. A retried start is a duplicate only when it is the same start.** A start
with the same `createKey` returns the existing session (`duplicate: true`,
written once) only when the vehicle and the revision-1 payload are identical.
The evidence time is part of that payload. The service stamps it when it
handles the request. A retry handled at a later time, for another vehicle,
with different starting evidence, or after the session has moved on is
therefore `create_key_conflict`. That fails closed: no second session, and the
first one is unchanged and still usable. A `createKey` is scoped to its owner.
Two simultaneous identical starts make one session. Tests (`v2i-retry`), "a
retried start…":

- "…with the same key, vehicle and evidence time is the same start";
- "…sent twice at once with the same key makes one session";
- "…handled later (a new evidence time) fails closed as create_key_conflict";
- "…with the same key for another vehicle of the same owner / different
  starting evidence";
- "…after the session has moved on";
- "…uses a key that belongs to its owner".

The contract also covers this: "makes a retried start with the same key the
same start".

This is current, intended fail-closed behaviour, not a defect. A route that
wants a later retry to succeed needs a design decision (see the prerequisites
at the end of this document).

**5. Malformed revisions record nothing.** An `expectedRevision` that is missing, not an
integer, or below 1 is `invalid_transition` before the session is loaded,
for typed and AI-parsed input alike. A stale or future revision is `conflict`
before the bridge, the engine or completion see it. Tests (`v2i-safety`):

- "refuses expectedRevision … for typed and AI-parsed input alike";
- "answers a stale or future revision with conflict before the bridge, the
  engine or completion see it".

**No last-write-wins anywhere.** On PostgreSQL the (session, revision) primary
key also makes a second write of one revision impossible.

## Archived vehicles (current behaviour; product decision open)

Inspected in `service.ts`, `vehicles.ts`, `prisma-vehicles.ts`,
`session-store.ts` and `prisma-repository.ts`:

- **Start:** refused. The garage directory reports `archived`
  (`archived_at IS NOT NULL`), and the service answers `vehicle_not_found`,
  the same answer as for a missing or someone else's vehicle. Tested in the
  shared contract ("starts only on a vehicle in the owner's garage…",
  `car-ann-old`), on in-memory and Prisma. The service is the only place
  that checks archiving. The V2G store and the Prisma repository check
  ownership only.
- **A session whose vehicle is archived after it started:** the service's
  `submitGuidedStep`, `loadGuidedSession` and `guidedSessionHistory` never
  consult the garage. By inspection, such a session therefore:
  - still loads and shows its history;
  - **still accepts new steps through to completion**, under the normal
    revision and immutability rules.

  The pinned vehicle context is history and is unaffected.

  What is tested: V2G on PostgreSQL ("archiving a vehicle keeps its sessions;
  deleting it for good … removes them",
  `tests/integration/suites/guided-sessions.ts`) shows that archiving keeps
  the sessions and that `store.load` still returns them.

  What is not tested: no service-level test submits to, or loads, a session
  after its vehicle has been archived. The behaviour above comes from the code
  alone.
- **Permanent deletion** (only possible for an archived vehicle) cascades to
  its sessions and revisions (V2G `ON DELETE CASCADE`). See open item 2.

**Unresolved product decision (not made here):** once a vehicle is archived,
should its existing guided sessions stay continuable? Today they do. The
alternatives are read-only (load and history only), or hidden like the vehicle
itself. A related question is whether an unfinished session should block or
warn before archiving. Whichever is chosen, a route-level or service-level
check and tests are needed. Until a person decides, the current behaviour
stands. It must not be read as an approved semantic.

**Load and history.** These go to the V2G store unchanged. History resolves
every content class and review status, so reopening a session never depends
on today's policy:

- a metadata-only content change keeps it loadable;
- a diagnostic change under the same version is `workflow_changed`;
- a missing version is `workflow_unavailable`, even when a newer one exists.

**Specifications.** None by default, since no verified source exists.
Specifications a session has already pinned are reused on every later step.

**No feature flag.** The service is unreachable from production (no importer,
tested), and its default policy offers nothing. A flag would add a switch with
nothing behind it. The enablement decision belongs to the route that will
construct the service (V2J).

## Tests

- **`tests/diagnostic-workflow-v2i.test.ts`:**
  - the shared service contract on the in-memory repository and garage;
  - the content policy (default offers nothing; approved fixture starts;
    test-only policy; hand-made policy refused; exact versions);
  - historical sessions after metadata-only, diagnostic and version changes;
  - unsupported persistence versions;
  - boundaries (no app importer; engine and bridge imports; no AI or network
    in the service; Prisma in one read-only file; no state transitions of its
    own; one policy filter).
- **`tests/helpers/guided-service-contract.ts`:** the contract.
  - It covers start-to-verification equal to the engine alone.
  - It covers contradictory evidence ending inconclusive, and `nextBestTests`
    unchanged.
  - It covers ownership (including a forged owner), garage vehicle rules,
    stale and concurrent submissions, and engine refusals recording nothing.
  - It covers typed and AI-parsed inputs being identical, rejected proposals
    recording nothing, idempotent start, and corrupted rows failing closed.
- **`tests/integration/suites/guided-service.ts`:** the same contract on
  PostgreSQL through the Prisma repository and garage directory, plus the
  garage directory's own rules and the PostgreSQL stale-after-completion race.
  It is registered in `tests/integration/database.db.test.ts`.
- **`tests/diagnostic-workflow-v2i-safety.test.ts`:** pinned specifications
  survive reopening; with no verified specification a reading decides nothing;
  the revision guard runs first; completed sessions are immutable; evidence
  carries the server's time.
- **`tests/diagnostic-workflow-v2i-retry.test.ts`:** retried and racing starts
  and submissions, through the public API only (see the contract above).

### Evidence executed for this update (2026-10-20, at `cb4179e`)

| Command | Result |
| --- | --- |
| `npx vitest run tests/diagnostic-workflow-v2i.test.ts tests/diagnostic-workflow-v2i-safety.test.ts tests/diagnostic-workflow-v2i-retry.test.ts` | pass, 3 files, 61 tests |
| `npx vitest run tests/diagnostic-workflow-v2i-retry.test.ts` | pass, 16 tests |

The following were **not** run for this update:

- the Prisma contract;
- the PostgreSQL race test;
- the V2G archive test;
- the full suite, typecheck, ESLint, build and rollback checks.

### Historical evidence for `cb4179e` (from its commit message, not re-run)

- typecheck;
- ESLint, 0 errors;
- `git diff --check`;
- the full non-DB suite, 808 passing;
- the guided-service suite, 13 tests, on a throwaway real PostgreSQL 17.10.

A known caveat from earlier V2I work: the full legacy `database.db.test.ts`
has hung on embedded-postgres on the development machine, in pre-existing
non-V2I suites. Database suites have been run one at a time.

## Open items before product integration (V2J)

1. **Approved content.** None exists. A qualified reviewer must approve
   content (see the V2H checklist) before anything can start under the
   production policy.
2. **Vehicle and account deletion.** Both cascade to sessions
   (`ON DELETE CASCADE`, an intentional V2G choice, unchanged here). Decide
   before production whether permanent delete should remove sessions
   explicitly and report the count.
3. **Phase 2E rollback harness.** Closed for the migration-shipping gate. The
   harness was added and the default moved to Phase 2E. Both the Phase 2E
   default and `-- phase-2d` passed against a real disposable PostgreSQL on
   2026-10-20 (historical; see "Rollback tooling follow-up" above).
4. **Retried start across time.** This is current, tested fail-closed
   behaviour (contract rule 4), not a defect. A route retry handled later gets
   `create_key_conflict`, never a second session. If later retries should
   succeed, the route needs one of two things:
   - the original start time;
   - a lookup by `createKey`.

   That is a V2J design choice.
5. **Retried submit.** Also current, tested behaviour (contract rule 2). A
   repeat of an applied submit is `conflict`, not `duplicate`. The route and
   UI must reload and show the current state on `conflict`, never resubmit
   blindly.
6. **Archived vehicles.** This is the product decision described in
   "Archived vehicles" above. It is unresolved.
7. **Integrity key.** The service accepts the V2G `integrity` setting.
   Production should use the keyed (HMAC) form; key management is a V2J
   decision.
8. **Concurrency tests need real PostgreSQL**, not `prisma dev`.

## Remaining prerequisites for a meaningful user-facing trial

1. **Reviewed content.**
   - A qualified automotive reviewer completes the checklist in
     [content/generic-gasoline-misfire-review.md](content/generic-gasoline-misfire-review.md),
     recorded against the reviewed fingerprint, so that at least one workflow
     is `approved`. Today the production policy offers nothing.
   - The code identifiers are verified against licensed SAE J2012-DA data, or
     the code routing is removed.
   - A verified specification source exists for
     `fuel_supply_pressure_expected`, or that step is accepted as always
     routing to a professional. (V2H, "Human review requirement".)
2. **A route and UI (V2J).** Neither exists. The route must:
   - construct the service with `ownerFromAuthenticatedUser`;
   - decide enablement;
   - handle `conflict`, `immutable` and `create_key_conflict` as described
     above.
3. **Human decisions:**
   - archived-vehicle session semantics;
   - explicit session deletion and count on permanent delete;
   - the retried-start design;
   - integrity-key (HMAC) management.
4. **Fresh verification of the code to be shipped**, run again rather than
   taken from this document:
   - the guided-service and V2G suites on a real PostgreSQL;
   - the full non-DB suite, typecheck, lint and build;
   - the rollback checks.
5. **Explicit authorization** to merge this research line and apply the V2G
   migration to production. Neither has happened. The migration is additive
   and was rehearsed only on throwaway databases.
