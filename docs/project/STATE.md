# CarCode AI: project state

The one place a new session learns where CarCode AI stands. Keep it short and
current: update it at the end of every phase, and say "as of" with a commit.

As of 2026-10-17. Production `main` = `7bb5408` (PR #7, Phase 2E).

## What CarCode AI is

An automotive diagnostic web app (PWA). A user enters OBD-II trouble codes or
symptoms for a vehicle (year/make/model/engine, VIN decoding) and gets
structured AI-assisted causes, checks and next steps. Signed-in users keep one
garage: vehicles, mileage, service records, saved diagnoses and confirmed
repairs. Seven languages. Dark-only UI.

Reliability, deterministic behaviour, provenance, safety and auditability come
before speed. See `AGENTS.md` for the invariants.

## Architecture (production, `main`)

- Next.js 16 App Router, React 19, TypeScript, Tailwind 4. `app/page.tsx` is
  large (~2,700 lines): search, then read ranges.
- Auth.js / NextAuth v5 (email + password, Google).
- Postgres on Neon through Prisma 7 (`app/lib/prisma.ts`, one pool).
  `prisma/schema.prisma` is the one definition; only migrations change it.
  Rules and deploy steps: `docs/database.md`.
- Diagnosis: `app/api/diagnose` → OpenAI, structured and validated output
  (`app/lib/diagnosis-*.ts`, `app/lib/dtc.ts`).
- Hosted on Vercel. **A Vercel production build runs `scripts/db-migrate.mjs
  --vercel`, which applies pending migrations to the production database.**
  Merging into `main` is therefore a production database change whenever a
  migration is included.
- Production migrations (3, all additive): `20260101000000_baseline`,
  `20261011010000_converge_and_expand`, `20261012180000_garage_history`.
- `replit.md` is a legacy overview from the Replit era. Where it disagrees with
  this file or the code, it is out of date.

## Completed and in production

| Phase | What | PR |
| --- | --- | --- |
| 0 + 1 | Critical fixes | #3 |
| 2A | Reliable vehicle data | #4 |
| 2B | Trustworthy trouble-code handling | #5 (with 2C) |
| 2C | Structured, reliable diagnosis | #5 |
| 2D | Database foundation (migrations, rules, rollback check) | #6 |
| 2E | One garage, with history | #7 |

Details: `CHANGELOG.md`.

Still pending from 2D/2E: the clean-up of leftovers from older versions, as its
own migration and pull request, only when asked. Keep the Neon branch
`backup-before-2d` until then.

## Guided Diagnostics V2 (research, NOT in production)

A deterministic diagnostic workflow engine with an AI bridge around it. None of
it is wired into the app. Each stage is a branch stacked on the previous one:

| Stage | Branch | Head |
| --- | --- | --- |
| Prototype | `research/guided-diagnostics` | `ccc2aa9` |
| Standards research (docs only, separate from the stack) | `research/guided-diagnostics-v2-standards` | `df5bf2a` |
| V2A honest outcomes | `feat/guided-diagnostics-v2a` | `34e89c4` |
| V2B specification provider | `feat/guided-diagnostics-v2b-specifications` | `862fb83` |
| V2C vehicle context, capabilities | `feat/guided-diagnostics-v2c-context-capabilities` | `f71e53e` |
| V2D DTC + freeze frame | `feat/guided-diagnostics-v2d-dtc-freeze-frame` | `f71c55e` |
| V2E next best test | `feat/guided-diagnostics-v2e-next-best-test` | `cde7f40` |
| V2F AI bridge | `feat/guided-diagnostics-v2f-ai-bridge` | `2caaade` |
| V2G persisted sessions | `feat/guided-diagnostics-v2g-persistence` | `0b03ad0` |
| V2H reviewed content | `feat/guided-diagnostics-v2h-reviewed-content` | `085b959` |

- Code: `app/lib/diagnostic-workflow/` (engine), `-bridge/` (AI),
  `-persistence/`, `-content/`. Design notes: `docs/research/guided-diagnostics/`.
- V2G adds migration `20261016120000_guided_diagnostic_sessions`. It has not
  been applied to production. Merging V2G or later into `main` would apply it.
- V2H's generic gasoline misfire workflow is a DRAFT. No human has reviewed it.
  Production use needs the review steps in `v2h-reviewed-content.md`.
- Open verification: production build and the V2G real migration were pending
  local verification at V2H.

### Approved V2 decisions

- Unverified specifications are informational only, never pass/fail.
- Workflow review is internal/manual at first.
- Licensed service data is deferred.
- Capability presets: Basic / DIY / Advanced DIY / Workshop.
- The single-primary-fault assumption is accepted and disclosed.
- Confirmed-repair statistics do not affect ranking yet.
- The synthetic misfire workflow stays the primary development fixture.
- Not to build: standard-style data models, a scripting language, ECU
  sessions/security access, percentages, free reordering of reviewed workflows.

## Unfinished work

- **V2I**: in progress on the owner's PC, **uncommitted**, on top of V2H. It
  exists only in a local worktree; GitHub has no copy. Its scope is recorded
  there, not here. Do not merge it into `main`. When a session picks it up,
  write its scope and branch into this file.
- **Agent manager**: `chore/openai-claude-codex-manager` (`56fc9d1`), not
  merged. The PC may hold newer uncommitted manager changes.
- **Canonical-workspace guard** for the manager:
  `docs/project/manager-canonical-workspace.patch`, ready to apply to the
  manager branch (see `WORKSPACE.md`).

## Agents and the manager

- `CLAUDE.md`: Claude is the lead implementer. In interactive sessions, run
  the Codex review loop (`scripts/codex-review.ps1`, on the manager and collab
  branches) before committing.
- `AGENTS.md`: architecture boundaries, diagnostic invariants, database and
  Git safety. Codex reviews read-only.
- Agent manager (`tools/agent-manager/`, on `chore/openai-claude-codex-manager`):
  an OpenAI model plans, Claude Code CLI implements, a separate OpenAI request
  reviews the diff. It commits and pushes only reviewed work on
  `research/ feature/ fix/ chore/ docs/ test/` branches, and never merges,
  deploys or force-pushes. Launch with `scripts/carcode-manager.ps1`. Docs:
  `docs/agent-manager/README.md`. State lives outside the repo in
  `%LOCALAPPDATA%\CarCodeAI\agent-manager`.
- Workspace layout and which folder is canonical: `docs/project/WORKSPACE.md`.

## Standing rules

- No merge, deploy, pull request or production change unless the owner says so
  in the current task.
- Never mutate production data; never rewrite existing migrations; migrations
  are additive; never touch `backup-before-2d`.
- No force-push, no history rewrite. Research branches are not production.
- No `git stash` (it hides work from other worktrees and sessions). Commit to a
  branch instead, or leave changes in the worktree.
- No secrets or production details in the repository.
- No invented data, probabilities, prices, labour times or "safe to drive"
  conclusions.

## Verification

- While developing: only the affected test files (`npx vitest run <file>`).
- End of a phase: `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run build`. Database suites and `npm run db:rollback-check` only when
  database code changes (they need a throwaway database).
- Manager: `node --test "tools/agent-manager/test/*.test.mjs"`.
- Send long output to a file; read the summary and failures only.

## Working cheaply

Search first, then read small ranges. No whole-repo rereads. Targeted tests
while working, the full suite once per phase. Avoid browser automation unless
the layout is the point. Start a fresh session per phase, after updating this
file. Keep progress updates short.

## Next task

1. On the PC, consolidate the folders (`docs/project/LOCAL-CONSOLIDATION.md`).
2. Continue V2I in its linked worktree. Record its scope here first.
