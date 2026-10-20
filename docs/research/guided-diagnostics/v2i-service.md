# Guided Diagnostics V2I: integration readiness

Research prototype, still not wired into the app. Builds on V2H (`085b959`,
[v2h-reviewed-content.md](v2h-reviewed-content.md)).

- **No route, no UI, no change to `/api/diagnose`.** Nothing in the app
  imports the new service (tested).
- **No engine, bridge, persistence or content change.**
- **No migration, no schema change, no AI calls.**

V2I had two gates: first verify the V2A–V2H line for real, then add a
server-only service.

## Gate A: verification of the V2A–V2H line

Run on a Windows machine against throwaway local databases only.

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

**Rollback tooling follow-up (2026-10-19, branch
`test/phase2e-rollback-compatibility`):**

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

**Environment findings, not defects:**

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

- The vehicle must be in the owner's garage and not archived.
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
   see.
3. The engine's `submitStep`, or for a proposal the bridge's `acceptProposal`,
   which refuses non-valid and stale proposals and otherwise calls
   `submitStep`.
4. V2G `store.advance` (compare-and-set). An AI-parsed input is recorded with
   its text hash only.
5. A refused input or proposal records nothing.

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
  garage directory's own rules. It is registered in
  `tests/integration/database.db.test.ts`.

## Open items before product integration (V2J)

1. **Approved content.** None exists. A qualified reviewer must approve
   content (see the V2H checklist) before anything can start under the
   production policy.
2. **Vehicle and account deletion.** Both cascade to sessions
   (`ON DELETE CASCADE`, an intentional V2G choice, unchanged here). Decide
   before production whether permanent delete should remove sessions
   explicitly and report the count.
3. **Phase 2E rollback harness.** Added, the default moved to Phase 2E, and
   rehearsed against a real disposable PostgreSQL on 2026-10-20 — both the
   Phase 2E default and `-- phase-2d` passed (see "Rollback tooling follow-up"
   above). This item is closed for the migration-shipping gate.
4. **Retried start across time.** A retried start is a duplicate only when it
   is the same start, including the evidence time. The service stamps the
   time when it handles the request, so a route retry seconds later gets
   `create_key_conflict`. That fails closed, never as a second session. A
   route needs either the original start time or a lookup by `createKey`.
5. **Integrity key.** The service accepts the V2G `integrity` setting.
   Production should use the keyed (HMAC) form; key management is a V2J
   decision.
6. **Concurrency tests need real PostgreSQL**, not `prisma dev`.
