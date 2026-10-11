# CarCode AI database

How the database is defined, changed, backed up and tested. Written in Phase 2D
(October 2026).

## The rules

1. **`prisma/schema.prisma` is the one definition of the database.**
2. **Only migrations change the structure.** A migration is a plain SQL file in
   `prisma/migrations/`. Each is applied once, in name order, and recorded in
   the `_prisma_migrations` table.
3. **The running app never creates or alters a table.** There is no start-up
   routine and no "create the table if it is missing" in any route. If a table
   is missing, the request fails and says so in the log; it does not improvise.
4. **One connection pool.** Every read and write goes through the Prisma client
   in `app/lib/prisma.ts`. The `pg` package is used only by the command-line
   scripts in `scripts/` and by the tests.
5. **`prisma db push`, `prisma migrate dev` and `prisma migrate reset` are never
   run against production.** `tests/database-rules.test.ts` fails the build if
   any of rules 2 to 5 is broken in the source.

## Tables

| Table | Prisma model | Holds | Removed when |
| --- | --- | --- | --- |
| `users` | `User` | Accounts: email, password hash, Google identity, verification state | never automatically |
| `email_verification_tokens` | `EmailVerificationToken` | Hashes of emailed sign-up links (24-hour life) | the account is deleted; a new link is issued; `db:prune` after 7 days |
| `garage_vehicles` | `Vehicle` | A signed-in user's vehicles | the user deletes the vehicle; the account is deleted |
| `maintenance_records` | `MaintenanceRecord` | Service entries for a vehicle | the user deletes the entry; its vehicle or account is deleted |
| `rate_limits` | `RateLimit` | Short-lived counters (see below) | automatically, after `expires_at` |
| `feedback` | `Feedback` | Messages from the feedback form | never automatically |
| `_prisma_migrations` | (Prisma's own) | Which migrations have been applied | never |

An existing database also still holds a few things older versions created and
nothing uses (see "Left for a later clean-up"). They are not listed above
because the app does not use them.

Diagnosis history is **not** in the database. It is kept in the visitor's
browser. Moving it to the server is Phase 2E.

### Values users type

Year, service date, odometer and cost are typed by the user as free text, and
the app shows them back exactly as typed. Each now also has a typed copy:

| Text column (as typed, unchanged) | Typed copy | Filled in when the text is |
| --- | --- | --- |
| `garage_vehicles.year` | `model_year` integer | four digits, 1900 to 2099 |
| `maintenance_records.date` | `service_date` date | `YYYY-MM-DD` and a real calendar day |
| `maintenance_records.mileage` | `odometer_value` integer, `odometer_unit` (`km`, `mi` or empty) | whole digits, optional thousands commas, optional unit |
| `maintenance_records.cost` | `cost_amount` decimal(12,2) | a plain amount, optional leading `$`, optional thousands commas |

Anything else ("about 90k", "120.000", "120,50", "last tuesday") keeps its text
and gets an **empty** typed copy. Nothing is guessed. The rules are in
`app/lib/maintenance-values.ts`; the migration applied the same rules to rows
that already existed, and a test checks the two agree value by value.

### What the database itself enforces

- One account per email address, stored in lower case (`users_email_key`,
  `users_email_lowercase`). One account per Google identity (`users_google_id_key`).
- A vehicle belongs to an account; a service record belongs to an account and a
  vehicle; a verification token belongs to an account (foreign keys).
- Deleting an account deletes its vehicles, service records and tokens.
  Deleting a vehicle deletes that vehicle's service records. Nothing else
  cascades. Feedback and counters are not linked to accounts.
- `model_year` is 1900 to 2100; `odometer_value` and `cost_amount` are not
  negative; `odometer_unit` is `km`, `mi` or empty.
- `created_at` is always present on accounts, vehicles, service records and feedback.

### Counters (`rate_limits`)

One row is one counter for one window of time:

| Column | Meaning |
| --- | --- |
| `key` | What is being counted, for example `diag:guest:day:ip:<hash>` or `diag:followup:<diagnosis id>` |
| `window_start` | When the window began |
| `count` | Requests counted so far |
| `expires_at` | When the row stops mattering: two windows after it began |

Used for: sign-in attempts, sign-ups, confirmation emails, feedback, the
diagnosis request flood limit, the daily diagnosis allowance (guests and
signed-in users), and the two follow-up updates allowed per diagnosis (keyed by
the id inside the signed ticket, pinned to the time the ticket was issued).
IP addresses are stored only as salted hashes.

The table cannot grow without limit: about 1 write in 50 also deletes every
expired row, and `npm run db:prune` does the same on demand. Deleting an
expired counter can never loosen a limit.

### Hand-written SQL in the app

Exactly one statement, in `app/lib/rate-limit.ts`:

```sql
INSERT INTO rate_limits (key, window_start, count, expires_at) VALUES ($1, $2, 1, $3)
ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
RETURNING count
```

It must add one and return the new total as a single atomic statement, which
the Prisma query API cannot guarantee. It is sent with Prisma's tagged
`$queryRaw`, so every value is a bound parameter. Everything else uses the
Prisma query API.

## Commands

| Command | What it does | Changes the database? |
| --- | --- | --- |
| `npm run db:inspect` | Report: tables, columns, indexes, migration history, counts of rows a migration must be careful with, and what older versions left behind. Add `-- --json` for JSON. | No. Runs inside a read-only transaction. Prints structure and counts, never row contents. |
| `npm run db:status` | Which migrations are applied and which are pending. | No |
| `npm run db:migrate` | Apply pending migrations. | Yes |
| `npm run db:prune` | Delete expired counters, and verification tokens that expired more than 7 days ago. Add `-- --dry-run` to only count. | Deletes expired rows only |
| `npm run db:rollback-check` | Run the previous version of the app, for real, against a database migrated by this release (see "Rollback check"). | Only a local test database, which it empties |

Each uses `DIRECT_URL` if set, then `DATABASE_URL_UNPOOLED`, then `DATABASE_URL`.

To point a command at a particular database for one run, set the address in
your own terminal (never paste it into a chat or commit it):

```powershell
$env:DIRECT_URL = "<address>"; npm run db:inspect; Remove-Item Env:DIRECT_URL
```

## The migrations

This release has two, and **neither removes anything**. Each file runs as **one
transaction**: if any statement in it fails, nothing in that file is applied.
`converge_and_expand` also sets a 15-second lock timeout, so it stops instead of
queueing behind a busy table.

The approach is expand → backfill → switch → clean up, with the clean-up held
back for a later release (see "Left for a later clean-up").

### 1. `20260101000000_baseline`

The six tables the app uses, as the old start-up code created them (Phase 2C).

- **Production:** it is **not run**. The tables already exist, so it is only
  recorded as applied (`prisma migrate resolve --applied`). `db:migrate` does
  this by itself when it finds the app's tables and no migration history.
- **An empty database** (a test database, a new environment): it runs and
  creates the same starting point.
- It deliberately leaves out what older versions created and nothing uses any
  more (the `sessions` table, `feedback.page`, two superseded indexes). An
  existing database keeps those; a new database never gets them.
- Creates 6 tables. Changes nothing. Drops nothing. No data-loss risk.

### 2. `20261011010000_converge_and_expand`

Brings any existing database, whichever version of the app last touched it, to
one known shape, and adds what the app needs next. **It only adds.** Every
statement does nothing if its work is already done.

- **Creates:** any app table or column an older database lacks; the typed copy
  columns; `rate_limits.expires_at`; unique indexes `users_email_key` and
  `users_google_id_key`; seven lookup indexes; four check constraints; any
  missing foreign key.
- **Changes:** `created_at` (accounts, vehicles, service records, feedback) and
  `garage_vehicles.is_active` become "always present, with a default".
- **Backfills:**
  - account emails are trimmed and lower-cased; an empty email becomes "none";
  - a missing `created_at` becomes the time of the migration (the real time is unknown);
  - typed copies are filled in where the text converts cleanly (rules above);
  - `feedback.page_url` receives the value of the old `page` column where it was
    empty. The `page` column itself, and every value in it, stays;
  - existing counters get `expires_at` = window start + 2 days;
  - **only on a database that never had email verification** (not production):
    Google-only accounts are marked verified and password accounts are marked
    "legacy". No password is changed.
- **Drops:** nothing. No table, column, index, constraint or row. A test reads
  the SQL and fails if a `DROP TABLE`, `DROP COLUMN`, `DROP INDEX`, `DELETE`,
  `TRUNCATE`, `RENAME` or a column type change ever appears in it.
- **Data-loss risk:** none. Text values stay exactly as they are.
- **It refuses to guess:** if two accounts share an email address (ignoring
  letter case), or two accounts share a Google identity, it stops and changes
  nothing. Production cannot be in that state unless the old uniqueness index
  was removed by hand, but the check is there.
- **Locks:** brief exclusive locks, one table at a time. The tables are small,
  so this is milliseconds. For a table of millions of rows the indexes would be
  built concurrently in their own migration instead.

### Order

`baseline` (recorded) → `converge_and_expand` → new app code goes live →
(later, separately) clean-up.

The previous version of the app keeps working against the migrated database, so
it does not matter that the old code is still serving for a minute or two after
the migration finishes, and rolling the app back needs no database change. See
"Rollback check".

## Left for a later clean-up

On an existing database, this release leaves the following in place, untouched.
The app does not use any of it. `npm run db:inspect` lists what a given database
actually has under **LEFT FROM OLDER VERSIONS**.

| Left in place | What it is |
| --- | --- |
| table `sessions` | Cookie log-ins from the first prototype. The app has used Auth.js tokens since. |
| tables `auth_pending`, `auth_tokens` | Temporary sign-in state from the prototype (may not exist). |
| table `feedback_auto_reply_log` | A log for an auto-reply removed in Phase 1 (may not exist). |
| table `oem_fault_codes` | The old manufacturer-code table, unused since Phase 2B (may not exist). |
| column `feedback.page` | The older of the two page columns. Its values are copied to `page_url` where that was empty; the originals stay. |
| indexes `users_email_unique`, `users_google_id_unique` | Superseded by `users_email_key` and `users_google_id_key`. Both sets exist for now. |
| column `garage_vehicles.is_active` | Never read or written, but the previous version's queries still select it. Hidden from the Prisma client with `@ignore`. |
| expired rows in `rate_limits` | No migration deletes them. The running app clears expired counters itself. |

The clean-up will be its own migration in its own pull request, written **after**
this release has run in production and `db:inspect` has shown what production
really contains. Conditions for it:

- this release has been live long enough that rolling back to Phase 2C is no
  longer wanted (the previous version's schema still names `sessions`,
  `feedback.page` and `is_active`);
- `oem_fault_codes` is dropped only if it holds nothing but the four BMW rows
  the old code inserted by itself (saved in
  `data/quarantine/oem-bmw-seed.unverified.json`); anything else is kept;
- `feedback.page` is dropped only after every value in it is in `page_url`
  (a row with two different values keeps both);
- a fresh backup first.

The text columns (`year`, `date`, `mileage`, `cost`) are **not** on this list and
never will be. They are what the user typed and what the app shows.

## Rollback check

`npm run db:rollback-check` answers one question with the real code: after this
release's migrations, does the previous version of the app (Phase 2C, commit
`e79758c`) still work, as it would after a Vercel Instant Rollback?

It copies the previous version's source out of git into a temporary folder and
runs it for real:

1. the previous version builds its own database and stores accounts, vehicles,
   service records, feedback and counters in it;
2. this release's migrations are applied on top, and every row is compared;
3. the previous version is started again and must find all its data and keep
   working: its start-up routine (which must find nothing to create or change),
   Google sign-in, sign-up, garage, service records, feedback through its own
   connection pool, the admin list, the daily allowance and follow-up counters;
4. the migration command is run again and must find nothing to do.

It empties the database it uses, so it only accepts `TEST_DATABASE_URL` on this
machine. It also runs as part of the database tests whenever that commit is
present in the local copy of the repository.

Two further tests in `tests/integration` check the same thing structurally:
every column the previous version's database client names still exists with the
type it expects, and every column this release added is optional or has a
default.

## How a deployment applies migrations

The `build` script is:

```
node scripts/db-migrate.mjs --vercel && prisma generate && next build
```

The `--vercel` flag means "only when Vercel says this build is for production"
(`VERCEL_ENV=production`, which Vercel sets itself).

- On a **production** build, pending migrations are applied first. If one
  fails, the build fails, the new version does not go live, and the current
  version keeps running.
- On a **preview** build the script does nothing at all, whatever variables are
  present. A preview can never migrate production.
- On your own computer, `npm run build` prints
  `skipped: not a production build` and `npm run dev` does not run it at all.
- With no database address configured, it does nothing.

Check once in Vercel → Settings → Build & Development that **Build Command is
not overridden** (or is `npm run build`). If it were set to `next build`
directly, the migration step would be skipped.

## First production deployment of Phase 2D

Do these in order. Steps 1 to 3 change nothing in production.

1. **Make a backup.** Neon console → the project → Branches → *Create branch*
   from `main` (production), named for example `backup-before-2d`. A branch is a
   complete copy at that moment. Leave it alone; it is the way back.
2. **Rehearse on a copy.** Create a second branch, for example `rehearse-2d`.
   Copy its **direct** connection string (Neon → Connect → switch off
   "Connection pooling"). In your own terminal, in the project folder:

   ```powershell
   $env:DIRECT_URL = "<rehearse-2d direct address>"
   npm run db:inspect      # the "before" report; read the sections at the bottom
   npm run db:migrate      # applies the migrations to the COPY
   npm run db:inspect      # the "after" report
   Remove-Item Env:DIRECT_URL
   ```

   Expected in the "before" report: `MIGRATION HISTORY: none` and
   `NEEDS A DECISION BEFORE MIGRATING: nothing`. Expected after: two migrations
   applied; the same row counts as before for **every** table; and the same
   list under `LEFT FROM OLDER VERSIONS` as before (nothing was removed). Then
   delete the `rehearse-2d` branch.
3. **Stop if** the "before" report lists anything under *NEEDS A DECISION*, or
   the migration fails on the copy. Production has not been touched.
4. **Set the direct address in Vercel** (recommended): Settings → Environment
   Variables → add `DIRECT_URL`, **Production only**, value = the production
   **direct** connection string. If it is not set and `DATABASE_URL` is a Neon
   pooled address, the script uses the same address without `-pooler`.
5. **Deploy at a quiet time:** merge the pull request. The production build
   applies the migrations, then builds. In the build log look for
   `[db:migrate] existing database with no migration history: recording the
   baseline as already applied.` followed by `All migrations have been
   successfully applied.` and `[db:migrate] done.`
6. **Check the live site:** sign in; open the garage (vehicles and service
   records are there); add and delete a test vehicle; send feedback and see it
   on the admin page; run one diagnosis.
7. Keep `backup-before-2d` until the clean-up release has also gone out.

## Backup and rollback

Migrations are **not automatically reversible**. Prisma has no "undo". The way
back is the backup, so step 1 above is not optional.

| Situation | What to do |
| --- | --- |
| The build failed on a migration | Nothing is live and nothing in that migration was applied. See "If a migration fails". |
| The new version is live but misbehaves, data is fine | Vercel → Deployments → the previous deployment → *Instant Rollback* (or *Promote*). **No database change is needed:** the previous version works against the migrated database, and nothing it uses was removed (see "Rollback check"). |
| Data looks wrong after the migration | Roll the app back as above first. Then compare with the backup branch. To return the database to the backup, use Neon's restore feature to restore the production branch from the branch `backup-before-2d` (Neon console → *Restore*; the exact labels change from time to time, so follow Neon's "Instant restore" guide). **This discards everything written since the backup** (new accounts, vehicles, feedback), so check what would be lost first. |

What stays in the database after an application rollback: the columns and
indexes this release added. They are harmless to the previous version, which
ignores them, and they are already in place when the new version is deployed
again (the migration command then finds nothing to do).

Confirming success after a deployment: `npm run db:status` says
`Database schema is up to date!`, and `npm run db:inspect` shows two applied
migrations and no table marked `[unknown]`.

## If a migration fails

Because each file is one transaction, the failed migration changed nothing.
Migrations before it stay applied (they are complete and the app works with
them). Prisma records the failure and refuses to continue until told to.

1. Read the error in the build log. The two expected causes:
   - `CarCode migration stopped: … used by more than one account` — a person
     must decide which account is the real one (do not delete either without
     looking at both).
   - `canceling statement due to lock timeout` — something held a table for
     more than 15 seconds. Nothing is wrong; try again at a quieter moment.
2. Fix the cause.
3. In Vercel add the environment variable `DB_MIGRATE_RETRY` (Production) with
   the failed migration's name, exactly as the log printed it, for example
   `20261011010000_converge_and_expand`. Redeploy. The script marks that one
   failed attempt as rolled back and applies it again. With any other value, or
   none, it stops with the same message.
4. Remove `DB_MIGRATE_RETRY` afterwards. (Leaving it does nothing.)

From a terminal the same thing is
`npx prisma migrate resolve --rolled-back <name>` followed by `npm run db:migrate`.

To get a build out without touching the database at all (an emergency only),
set `SKIP_DB_MIGRATE=1`. The new code needs the migrated database, so this is
only for redeploying a version whose migrations are already applied.

## Environment

| Variable | Where | Value |
| --- | --- | --- |
| `DATABASE_URL` | Vercel Production; local `.env.local` if you run against a database | The app's address. On Neon use the **pooled** one (host contains `-pooler`). |
| `DIRECT_URL` | Vercel Production (recommended) | Migrations only. On Neon the **direct** one (no `-pooler`). |
| `DATABASE_URL_UNPOOLED` | set automatically by the Vercel–Neon integration, if used | Accepted as an alternative name for the direct address. |
| `DATABASE_POOL_MAX` | optional | Connections per server instance, default 5. |
| `SKIP_DB_MIGRATE` | optional | `1` builds without migrating. |
| `DB_MIGRATE_RETRY` | only after a failure | Name of the failed migration to retry. |

Why two addresses: the pooled address shares a small number of real connections
between many short-lived serverless requests, which is what the app needs.
Migrations take a session-wide lock so that two cannot run at once, and that
needs a real, direct connection.

TLS: the connection string decides (`sslmode=require` on Neon) and the server's
certificate is verified. No code switches certificate checks off.

Preview deployments have no database configured in this project, and would not
migrate even if they had (see above). If previews are ever given a database, it
must be a separate Neon branch, never the production address.

Secrets live in Vercel and in git-ignored `.env*` files. `.env.example` lists
names only.

## Making a schema change later

1. Start a throwaway local database and build it:

   ```powershell
   npx prisma dev --detach --name carcode
   $env:DATABASE_URL = "postgres://postgres:postgres@localhost:51214/template1?sslmode=disable"
   npm run db:migrate
   ```

   (Use the address and port that `npx prisma dev ls` prints for it.)

2. Edit `prisma/schema.prisma`.
3. Generate the SQL for the difference into a new, later-named folder:

   ```powershell
   mkdir prisma/migrations/20261101000000_describe_the_change
   npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --output prisma/migrations/20261101000000_describe_the_change/migration.sql
   ```

4. Read every line of it. Add a header saying what it creates, changes,
   backfills and drops, the data-loss risk, the locks and the deploy order. Add
   `SET LOCAL lock_timeout = '15s';`. If it drops or rewrites anything, split
   it: add first, switch the app, remove in a later release.
5. `npm run db:migrate`, then run the database tests (below). The tests check
   that the migrations and `schema.prisma` describe the same database.
6. Never edit a migration that has been applied to production. Add a new one.

## Running the database tests

They empty the database they are pointed at, so they refuse to run unless
`TEST_DATABASE_URL` is a database on this machine. Without it they are skipped
and the rest of `npm test` runs as usual.

```powershell
npx prisma dev --detach --name carcode-test
$env:TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:51214/template1?sslmode=disable"
npm test
npx prisma dev stop carcode-test; npx prisma dev rm carcode-test
```

(The port is printed by `npx prisma dev ls`.)

What they cover (`tests/integration/`):

- **Migrations** — an empty database built by the real command matches
  `schema.prisma`; three older database shapes (the February 2026 prototype, the
  database before Phase 1, and production as of Phase 2C) are filled with sample
  accounts, vehicles, service records, feedback, counters and tokens, migrated,
  and compared row by row; the app's own tables all end with the identical
  structure; **everything older versions left behind is still there, row for
  row**; a second run changes nothing; duplicate accounts stop the migration
  with nothing changed; a failure is retried only when named; previews never
  migrate.
- **Rollback** — the previous version's real code is run against the migrated
  database (`db:rollback-check`), and its schema is checked column by column.
- **Database rules** — foreign keys, cascades, uniqueness, check constraints,
  required values, indexes, column types.
- **Accounts** — Google linking and claiming, registration.
- **The app** — sign-up, emailed link, sign-in, garage, service records,
  feedback and the admin view, the diagnosis allowance and follow-up counters,
  and that no request changes the database structure.
