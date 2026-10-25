# Guided Diagnostics V2J: product-integration contract

Status: **approved by the product owner on 2026-10-24** for a feature-gated
LOCAL/INTERNAL preview. Not for production. This document closes the open V2J
items listed in [v2i-service.md](v2i-service.md), "Open items before product
integration (V2J)". `AGENTS.md` remains binding and wins on any conflict.

## Goal

A signed-in user can, on a local/internal build only:

1. choose one of their garage vehicles;
2. open a clearly labelled **Guided Diagnostics preview** for it;
3. start the **synthetic demo workflow** (never presented as real diagnostic
   advice);
4. answer the current step and see the next test or question the engine
   chooses (`nextBestTests` stays the canonical recommendation API);
5. refresh or come back later and continue the same persisted session;
6. see the vehicle's guided sessions, each session's history, and its completion
   or inconclusive state.

## Decisions

### 1. Feature gate: env flag and never production

- The preview exists only when `GUIDED_DIAGNOSTICS_PREVIEW=1` **and** the build
  is not production. It is refused when `NODE_ENV === "production"` or when
  `VERCEL_ENV === "production"`, whatever the flag says.
- When the preview is off, every preview page and server action behaves as if
  it does not exist: 404 / `notFound()`, no data access, no hint in the UI.
- The check lives in one server-only module and is unit-tested for each
  combination. Nothing client-side decides enablement.
- No new public `app/api/*` route. The preview uses server components and
  server actions under the garage pages. `/api/diagnose` is not touched.

### 2. Content: approved-only for real content; synthetic demo is labelled

- `PRODUCTION_CONTENT_POLICY` (approved only) is unchanged and still offers
  nothing today.
- The preview may additionally offer **only** the synthetic demo workflow
  fixture, through an explicit preview policy. It is constructed only behind the
  gate, never reachable from production, and tested so.
- Every preview screen shows a persistent banner: "Preview: synthetic demo
  workflow. Not real diagnostic advice." Real content appears only once
  approved through the V2H review; nothing here approves content.
- No unverified specification drives pass/fail. With no verified source, a
  reading decides nothing, as the engine already guarantees.

### 3. Archived vehicles: read-only

- No new session can start on an archived vehicle (already the V2I behaviour).
- An existing session whose vehicle has been archived **loads and shows its
  history and completion state, but accepts no new step**. The service refuses
  with a distinct outcome (for example `vehicle_archived`) before the engine or
  store run, and records nothing. The UI shows the session as read-only.
- This is enforced in the service (not only the UI) and tested on the
  in-memory and Prisma implementations through the shared contract.

### 4. Permanent delete: explicit cleanup with a count

- Permanently deleting an archived vehicle deletes its guided sessions (and
  their revisions) **explicitly inside the same transaction** as the rest of the
  cleanup, and the result reports how many were removed
  (`deleted.guidedSessions`). The `ON DELETE CASCADE` stays as a safety net.
- The existing confirmation (`{ "confirm": "DELETE" }`), ownership and
  archived-only checks are unchanged. The existing route only gains the count.
- Covered by tests, including the PostgreSQL suite.

### 5. Session integrity: HMAC from an env var, fail closed

- When the preview constructs the service, it uses the keyed `hmac-sha256`
  integrity form. The key comes from `GUIDED_SESSION_INTEGRITY_KEY`, which must be
  at least 32 bytes.
- Missing or too short means the preview refuses to run (clear server-side error,
  no fallback to unkeyed `sha256`). The key is never logged, returned to the
  client, committed, or included in error messages.
- `.env.example` documents the variable name with an empty value. The value
  stays local.

### 6. Start idempotency: retries return the same session

- The preview generates a stable `createKey` for each start intent. A retry of
  that start at any later time (double click, refresh, network retry)
  **returns the session it already created**, never a second one, by looking the
  session up by `(owner, createKey)` rather than depending on the original start
  time.
- The same key used for a different start request stays `create_key_conflict`.
- Submit retries keep the V2I contract: a repeat of an applied submit is
  `conflict`, and the UI reloads and shows the current state; it never resubmits
  blindly. `immutable` (completed session) is shown as completed.

## Out of scope

- Production enablement, merging, deployment, production database migrations.
- `/api/diagnose` and the existing AI diagnosis flow.
- Approving real content, licensed data, verified specifications.
- New dependencies.

## Local testing (for the person)

The preview needs a local PostgreSQL with this branch's migrations applied (a
throwaway database, never a shared or production one), and these environment
variables set locally: `DATABASE_URL`, `AUTH_SECRET`,
`GUIDED_DIAGNOSTICS_PREVIEW=1` and `GUIDED_SESSION_INTEGRITY_KEY`.
