# Changelog

## Phase 2C — diagnosis quality — 2026-10-08

Branch `fix/phase-2c-diagnosis-quality`, built on top of the Phase 2B branch.
No database changes. One optional, development-only setting
(`DIAGNOSE_LOG_CONTEXT`). `zod` is now a direct dependency (it was already
installed as part of the OpenAI SDK).

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
- **Unsupported code numbers are withheld from the AI model.** A code number
  reaches the model only when a definition for it is on file. Otherwise the
  model is told that a code with no available definition was supplied, and
  nothing more, including when the user repeats the code in the symptoms box.
  A code alone with no usable symptoms still makes no AI call.
- **Three levels of trust for a code:** verified, locally entered reference
  title, or unavailable. The 8 hand-entered titles are labelled as a commonly
  published title, to the user and to the model, and are never called verified.
- **Codes and symptoms are used together**, with vehicle details: year, make,
  model, engine, optional mileage, and details decoded from the saved VIN
  (trim, drive type, fuel, transmission, engine code, turbo). The VIN itself is
  never sent to the model.
- **User text is data:** the model receives fixed rules in one message and a
  single JSON document in another. Quotes, braces and line breaks in what the
  user typed cannot change the structure of the request.
- **Follow-up questions come from the diagnosis.** Answering them and pressing
  "Update diagnosis" asks the server again with the answers; nothing is
  re-ranked in the browser. Each update counts as one diagnosis.
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
- Tests: 266 (was 146), including the 7 database-backed account tests.

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
