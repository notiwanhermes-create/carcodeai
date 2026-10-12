# Changelog

## Phase 2D — database foundation — 2026-10-11

Branch `fix/phase-2d-database-foundation`. **This release changes the
production database, by adding to it only.** Nothing is dropped or deleted.
Read `docs/database.md` ("First production deployment of Phase 2D") before
merging. New optional settings: `DIRECT_URL`, `DATABASE_POOL_MAX`,
`SKIP_DB_MIGRATE`, `DB_MIGRATE_RETRY`. No change to what users see.

- **One definition of the database.** `prisma/schema.prisma` now describes
  every table the app uses, and SQL migrations in `prisma/migrations` are the
  only thing that changes the structure.
- **The app no longer creates or alters tables while serving requests.** The
  start-up routine `ensureDB()` is gone, and so is the table check inside the
  feedback route. The structure no longer depends on which page was opened
  first after a deployment.
- **One connection pool instead of five.** Everything goes through the Prisma
  client in `app/lib/prisma.ts`. The four separate `pg` pools are removed, and
  with them every `rejectUnauthorized: false`: the database's TLS certificate
  is now always verified.
- **Two migrations, both additive.** `baseline` (the six tables the app uses,
  as they stood; recorded on production, not run) and `converge_and_expand`
  (missing columns, typed copies, indexes, constraints, counter expiry,
  backfills). `converge_and_expand` runs as one transaction with a 15-second
  lock timeout. A test reads the SQL and fails if a drop, delete, rename or
  column type change ever appears in it.
- **Destructive clean-up is postponed to a later release.** The tables, column
  and indexes left over from older versions (`sessions`, `auth_pending`,
  `auth_tokens`, `feedback_auto_reply_log`, `oem_fault_codes`, `feedback.page`,
  `users_email_unique`, `users_google_id_unique`, `garage_vehicles.is_active`)
  all stay exactly as they are. They will be removed by a separate migration,
  in a separate pull request, after this release has run in production. See
  "Left for a later clean-up" in `docs/database.md`.
- **Rollback to Phase 2C stays possible without touching the database.**
  `npm run db:rollback-check` runs the real Phase 2C code against a database
  migrated by this release: it builds and fills a database with that version,
  applies these migrations, then starts that version again and exercises
  accounts, garage, service records, feedback and counters. It also runs as
  part of the database tests.
- **Rehearsed on a copy of production (2026-10-12).** The migrations were
  applied to a Neon branch copied from production: no blockers, every table
  kept every row, nothing left over from older versions was touched, and both
  the new version and the real Phase 2C code worked against the result. The
  rehearsal showed that production's `feedback.id` is 64-bit, so
  `schema.prisma` and the baseline now say `BigInt` / `BIGSERIAL`; the
  migration that runs on production was not changed. Production's real
  structure is now a test fixture. See "Rehearsal on a copy of production" in
  `docs/database.md`.
- **`db:migrate` always uses the direct host.** Given a Neon pooled address,
  even in `DIRECT_URL`, it switches to the same address without `-pooler` and
  says so.
- **Typed values next to the text users type.** Vehicle year, service date,
  odometer and cost keep their text exactly as entered and gain a typed copy
  (`model_year`, `service_date`, `odometer_value` + `odometer_unit`,
  `cost_amount`), filled in only when the text is unambiguous. Nothing is
  guessed and nothing a user entered is altered.
- **Feedback uses one page column, `page_url`.** The form, the admin page and
  the admin API read and write the same field. Values that existed only in the
  old `page` column are copied into `page_url`; the old column and its values
  remain until the clean-up.
- **Counters expire.** Each `rate_limits` row carries `expires_at`. Expired rows
  are cleared as the app runs and by `npm run db:prune`, so the table cannot
  grow without limit.
- **The database enforces more:** one account per lower-case email, one per
  Google identity, `created_at` always present, sensible ranges for the typed
  values, and reviewed delete behaviour (deleting a vehicle deletes its service
  records; deleting an account deletes its vehicles, records and tokens;
  nothing else cascades).
- **Deploying:** `npm run build` now starts with the migration step, which
  acts only on a Vercel production build. Preview builds and local builds never
  migrate. A failed migration fails the build and leaves the live site as it was.
- **Tools:** `npm run db:inspect` (read-only report, including what older
  versions left behind), `db:status`, `db:migrate`, `db:prune`,
  `db:rollback-check`.
- **Removed from the repository:** the stale copy `app/page.tsx.backup`; the
  dead cookie-session module `app/lib/auth.ts`; and eight packages that nothing
  imported: `connect-pg-simple`, `express-session`, `passport`, `memoizee` and
  their type packages `@types/connect-pg-simple`, `@types/express-session`,
  `@types/passport`, `@types/memoizee`.
- **Smaller changes made on the way:** deleting a vehicle is one statement
  instead of three (the database removes its service records with it); service
  records now check field types and lengths before saving (notes up to 2,000
  characters, other fields 40 to 80).
- **Tests:** a database test suite (`tests/integration/`) that rebuilds three
  older database shapes with sample data and proves every row survives the
  migrations and that nothing older versions left behind is touched, plus
  source checks that fail if runtime table creation, a second pool or disabled
  certificate checks ever come back.

Not changed, on purpose: the text columns stay for good; the odometer display
on the dashboard ("km miles") is left for Phase 2E, which can now use the
stored unit.

## Phase 2C — diagnosis quality — 2026-10-08

Branch `fix/phase-2c-diagnosis-quality`, built on top of the Phase 2B branch.
No database changes. New optional settings: `DIAGNOSE_FOLLOWUPS_PER_DIAGNOSIS`,
`DIAGNOSE_TICKET_SECRET` and the development-only `DIAGNOSE_LOG_CONTEXT`.
`zod` is now a direct dependency (it was already installed as part of the
OpenAI SDK).

- **Structured output:** the diagnosis is requested with OpenAI Structured
  Outputs (a strict JSON schema), not free text that the server then picked
  apart. One schema, `app/lib/diagnosis-schema.ts`, is shared by the server and
  the page. The server checks every reply before it is sent on.
- **What a diagnosis contains:** a summary, driving guidance, ranked causes,
  follow-up questions and limits. Each cause has a rank, a likelihood category
  (very likely, likely, possible, unlikely), an urgency (normal, caution, stop,
  unknown), why it fits, checks labelled by who can safely do them, a
  recommended next step and a repair level. No percentages, prices or labour
  times exist anywhere in the schema.
- **Driving guidance and urgency** come only from the structured result.
  "Unknown" is shown when the model cannot justify a level. Nothing is inferred
  from words such as "fire" or "leak".
- **Safety-consistency check:** the server compares the overall guidance with
  the causes. A likely or very likely "stop" cause makes the overall level
  "stop". If the model said "normal" but a cause says "stop" at any likelihood,
  or a likely cause says "caution", the overall level becomes "caution". If the
  urgency of a likely cause could not be judged, "normal" becomes "unknown".
  The level is never lowered and "unknown" is never shown as safe.
- **Unsupported code numbers are kept from the AI model.** A code number
  reaches the model only when a definition for it is on file. Otherwise the
  model is told, in plain words, that an additional code could not be reliably
  verified, and nothing more, including when the user repeats the code in the
  symptoms box. The page tells the user the same thing in its own wording.
- **Three levels of trust for a code:** verified, locally entered reference
  title, or unavailable. The 8 hand-entered titles are labelled as a commonly
  published title, to the user and to the model, and are never called verified.
- **A code needs symptoms unless it is verified.** A hand-entered reference
  code on its own shows its title and asks for symptoms, with no AI call. Only
  a code with a verified definition can be diagnosed alone.
- **Codes and symptoms are used together**, with vehicle details: year, make,
  model, engine, optional mileage, and details decoded from the saved VIN
  (trim, drive type, fuel, transmission, engine code, turbo). The VIN itself is
  never sent to the model.
- **User text is data:** the model receives fixed rules in one message and a
  single JSON document in another. Quotes, braces and line breaks in what the
  user typed cannot change the structure of the request.
- **Follow-up questions come from the diagnosis.** Answering them and pressing
  "Update diagnosis" asks the server again with the answers; nothing is
  re-ranked in the browser.
- **Allowance:** a new diagnosis uses one unit of the daily allowance and comes
  with a signed ticket good for 2 updates. Updates do not use the allowance,
  cannot be chained, and are refused without a genuine ticket for the same
  vehicle, codes and symptoms. The guest default is now 5 new diagnoses a day
  (was 20). All limits remain configurable.
- **At most two AI calls per diagnosis:** the request, plus one retry only for
  a dropped connection, a timeout, a server error or an unreadable reply. The
  SDK's own hidden retries are switched off. Before this, one diagnosis could
  trigger up to 15 calls (5 app attempts, each retried twice by the SDK).
- **No queue:** the one-request-at-a-time lock is gone, so visitors no longer
  wait behind each other. Each attempt has a 25 second timeout, the model step
  48 seconds in total, and the route 60 seconds.
- **Failures are clean:** timeout, rate limit, outage, refusal, cut-off or
  invalid reply each return a short generic message. No provider text, prompt
  or raw reply reaches the browser, and no diagnosis is ever made up.
- **Removed from the browser:** keyword scoring of causes, the hard-coded
  follow-up questions, the hard-coded quick checks, "why likely" text built
  from the user's own input, likelihood tags based on list position, and
  leftover debug logging.
- **Languages:** the structure and identifiers are the same in all 7
  languages; only the text differs. New interface labels are translated.
- Tests: 315 (was 146), including 8 database-backed tests (7 account tests and the follow-up counter).

## Phase 2B — trouble-code reliability — 2026-10-08

Branch `fix/phase-2b-dtc-reliability`. No database or environment changes.

Rule introduced: **a missing answer is better than a wrong one.** An exact code
definition is only ever shown from data on file; manufacturer-specific
definitions are tied to a make; nothing is marked verified without a source.

- **One module for codes:** `app/lib/dtc.ts` replaces five older files. It parses
  what the user typed, classifies each code, looks it up and writes the note
  the AI model receives. It has no database or network access.
- **Classification by block, not "P0 vs P1":** standardized are P0, P2, B0, C0,
  U0; manufacturer-specific are P1, B1, B2, C1, C2, U1, U2. Hybrid/EV codes
  with letters (P0A80) are ordinary P0 codes. Every P3, B3, C3 and U3 code is
  **uncertain**: public descriptions of the standard do not settle those
  ranges, so the app does not call them either kind.
- **The classification is an assumption, not verified data.** It restates
  public block-level descriptions of SAE J2012 and was not taken from the
  standard or its Digital Annex. The rules are a replaceable table, documented
  in the code.
- **Parser:** codes can be separated by spaces, commas, semicolons or new
  lines; case, dashes, "P 0300" and duplicates are normalised; codes run
  together by a multi-line paste are separated. Unknown or invalid entries are
  reported, never dropped, and never fail the whole request.
- **Every code gets a result** with one of six statuses: standard definition
  on file, standard range but definition not verified, manufacturer definition
  (for that make), manufacturer-specific with no verified definition,
  uncertain with no definition, or invalid.
- **Diagnosis:** the model receives a per-code note. It gets an exact
  definition only when one is on file. For every other code it is told the
  definition is unavailable and that it must not state, guess or imply one.
  Codes and symptoms are sent together.
- **No definition, no guess:** if no entered code has a definition on file and
  there are no symptoms, the app says "definition not verified yet" and does
  not call the model or use the visitor's allowance. This applies to standard
  codes as well as manufacturer-specific ones. With symptoms, the diagnosis is
  based on the symptoms and the vehicle only.
- **An unknown code no longer fails the request** with an error; it is reported
  alongside the others.
- **Data sources are pluggable:** `app/data/dtc/sources.ts` lists where
  definitions come from, and every record is checked before it can be served.
  Two future provider roles are documented (SAE J2012-DA for standardized
  codes; a licensed OEM provider such as MOTOR for manufacturer codes).
  Neither has been purchased or integrated.
- **Data cleanup:** the old 3,082-entry database was quarantined in full
  (`data/quarantine/`). 2,589 entries were manufacturer-range codes with no
  manufacturer recorded, served to every make as SAE data. The 493 entries in
  standardized ranges contained runs of definitions shifted by one code
  (P0234, P0401, P0136–P0141 and others). The four hard-coded BMW codes were
  quarantined too: no source is recorded and they are inconsistent.
- **Data on file now:** 8 hand-entered standard codes (P0011, P0016, P0171,
  P0300, P0420, P0455, P0A80, U0100), shown as "standard code", not "verified".
  They are recorded as entered by hand and not checked against licensed SAE
  data, and the set is not to be extended by hand. The manufacturer store is
  empty.
- **UI:** each code shows a short plain-language note on how far its definition
  can be trusted (7 languages).
- Removed `/api/dtc/verify` (a public self-test for the old data) and the
  database pool used only for the BMW codes. The `oem_fault_codes` table is
  left untouched in the database but is no longer read.
- Tests: 146 (was 87), including the 7 database-backed account tests.

## Phase 2A — vehicle data — 2026-10-06

Branch `fix/phase-2a-vehicle-data`. No database or environment changes.

- **Makes (H7):** suggestions come from a curated list of 64 car and light-truck
  makes (`app/data/vehicle-makes.ts`) instead of NHTSA’s 12,000-entry
  manufacturer registry. Typing "for" now offers Ford, not trailer builders.
  Leaving the field uses the listed spelling ("chev" → Chevrolet). Unlisted
  makes can still be typed.
- **Models (H8):** cars, SUVs/minivans and pickups are looked up together and
  merged, other manufacturers that NHTSA matches loosely are dropped, and
  motorcycles/ATVs no longer appear. The Model field is now free text with
  suggestions, so a missing model or an NHTSA outage no longer blocks adding a
  vehicle. Results are cached and upstream calls time out after 8 seconds.
- **VIN (H9):** only a complete 17-character VIN is decoded (partial VINs used
  to fill the form with guesses). The form shows what was found, or why not. A
  VIN whose check digit does not match is decoded with a warning.
- **Engine (H10/C3):** the VIN-decoded engine now reads like
  "3.0L V6 (J30A4) Gasoline": displacement, layout, turbo, engine code and fuel,
  using only what NHTSA returned. Hybrids and EVs are labelled.
- Removed `/api/vehicles/engines` (its CarQuery upstream no longer exists).
- Dropdowns close when their field loses focus (they used to stay open over the
  fields below when leaving with the Tab key).
- Tests: 87 (was 72).

## Phase 0 and Phase 1 — 2026-10-05

Branch `fix/phase-0-1-critical` (on top of `main`, not pushed).
Finding numbers (C1, H13, …) refer to the pre-launch audit.

### Before deploying this branch

1. **Email sender (required for password sign-up).** Set `RESEND_API_KEY` and
   `AUTH_EMAIL_FROM` (or `FEEDBACK_FROM`) in the hosting environment, with the
   sender on a domain verified in Resend. Without them, new email/password
   sign-ups are refused with a clear message; Google sign-in and existing
   accounts keep working.
2. **`NEXTAUTH_URL`** must be the real site address (for example
   `https://www.carcodeai.com`). Confirmation links are built from it.
3. **Database:** no manual step. New tables and columns are created
   automatically on the first request (same mechanism the app already used).
   Do not run `prisma db push` yet — that is Phase 2.
4. **OpenAI spend cap:** set one in the OpenAI dashboard as a backstop.

See `.env.example` for every variable, including optional rate-limit settings.

### Phase 0 — one project copy

- Removed the accidental nested clone and its submodule entry; `main` now
  matches GitHub and there is a single copy of the project on disk.
- Work found only in the nested clone was kept as local branches:
  `archive/mileage-units` and `archive/nested-stash-wip-before-push`.
- An uncommitted local change (deriving the auth URL from `VERCEL_URL`) was
  not applied; it is kept as a git stash.
- Pinned the Next.js workspace root in `next.config.ts`.
- Restored the missing `updatedBasedOnAnswers` translation.

### Phase 1 — critical fixes

**1. Second diagnosis no longer crashes (C1)**
- `LikelyCausesPanel` split into a hook-free wrapper and `LikelyCausesResults`.
- Added `app/error.tsx` (message, Try again, reload, home).

**2. `/api/diagnose` protected (C2)**
- Per-IP burst limit, guest daily quota, per-user hourly/daily limits, optional
  global cap — all configurable (`DIAGNOSE_*`).
- Strict validation and size cap; generic errors only; provider errors are
  logged, never returned.
- New `rate_limits` table (in-memory fallback when no database is reachable).

**3. Feedback cannot be used to send email to strangers (H13)**
- Rate limited per IP. Confirmation emails go only to the signed-in user's own
  address and contain fixed text. Every field validated.

**4. Dependencies (C10)**
- next 16.3.8, next-auth 5.0.0-beta.32, jspdf 4.2.1, prisma 7.10.0; removed
  unused `@auth/prisma-adapter`. Production audit: 5 critical → 0.

**5. Readable sign-in / sign-up errors (H1)**
- Specific messages for wrong password, existing account, Google-only account,
  unconfirmed email, expired link, rate limit and server trouble. Raw codes
  such as "Configuration" are never shown.

**6. Account linking made safe (C9)**
- New password accounts must confirm their email (emailed link **and**
  password) before they can sign in.
- Google sign-in requires a Google-verified email. If the matching account is
  not verified, Google claims it: its password is removed and existing sessions
  are signed out. Verified accounts are linked and keep their password.
- Existing users are not locked out. One behaviour change: an existing account
  that has **both** a password and Google attached must now sign in with
  Google (its password is retired the next time Google is used).
- New: `users.email_verified`, `users.session_version`,
  `users.legacy_unverified`, table `email_verification_tokens`,
  `POST /api/account/register`, `POST /api/account/resend-verification`.

**7. Invented numbers removed from results (C5/C6)**
- Removed the confidence percentage, cost/labour/tools estimates and the
  Drive/Caution/Stop badge. Ranking and its labels are unchanged.

**8. Guest data is kept (C7)**
- Signing in no longer deletes the guest garage or history. Signed-in users are
  offered "Import vehicles from this device"; duplicates are reported and
  skipped, never merged. Service records and saved diagnoses follow an imported
  vehicle.

**9. Engine is free text (C3)**
- The garage form no longer depends on the defunct CarQuery API. VIN-decoded
  engine text is kept and offered as a suggestion.
- Fixed suggestion lists re-opening over the fields below them.

### Tooling

- `npm test` (Vitest): 72 tests. Database-backed tests run when
  `TEST_DATABASE_URL` points at a local database.
- `npm run typecheck`; `npm run lint` now passes (46 errors → 0).
- `.env.example` added.
