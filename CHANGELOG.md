# Changelog

## Phase 0 and Phase 1 — 2026-10-05

Branch `fix/phase-0-1-critical` (9 commits on top of `main`, not pushed).
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
