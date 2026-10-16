# CarCode AI — Agent Rules

## Project
CarCode AI is an automotive diagnostic application. Reliability, deterministic diagnostic behavior, provenance, safety, and auditability are more important than speed of implementation.

## Guided Diagnostics architecture

Preserve these boundaries:

- `app/lib/diagnostic-workflow/`
  - deterministic core engine
  - no AI SDK
  - no Prisma/database
  - no network access
  - no vehicle communication

- `app/lib/diagnostic-workflow-bridge/`
  - AI parsing/explanation boundary
  - AI proposes; deterministic engine decides

- `app/lib/diagnostic-workflow-persistence/`
  - persistence/repository/codec boundary
  - database state is never diagnostic authority

- reviewed workflow/content layer
  - diagnostic knowledge belongs in validated content, not engine logic

## Diagnostic invariants

Never weaken these rules:

- Only verified/trusted specifications may drive pass/fail, branching, cause effects, or repair verification.
- Missing, ambiguous, unverified, or informational specifications never drive deterministic conclusions.
- Unknown context is not false.
- Partial/unknown scan evidence cannot prove DTC absence.
- Permanent/history DTC state does not automatically mean an active failure or failed repair.
- Freeze-frame evidence is distinct from live measurements.
- AI cannot mutate causes, trusted specifications, workflow transitions, ranking, safety, or verification.
- `nextBestTests` is the canonical recommendation API.
- No invented probabilities, confidence percentages, repair prices, labor times, or AI-generated "safe to drive" conclusions.
- Conflicting evidence under the single-primary-fault assumption ends inconclusive; evidence is preserved.
- Historical sessions use exact workflow versions and pinned specifications.
- Persistence must fail closed on corruption/incompatibility.
- No silent last-write-wins for persisted diagnostic sessions.
- Do not copy proprietary OEM diagnostic procedures or specifications.

## Database safety

Never:
- mutate production data during development/review;
- rewrite existing migrations;
- apply a migration to production unless explicitly authorized;
- touch `backup-before-2d`.

Database migrations must be additive unless an explicitly approved task says otherwise.

## Git safety

Do not merge or deploy unless the user explicitly asks.

Do not force-push.

Do not rewrite published history.

Research branches must not be assumed to be merged into production.

## Codex role

When Codex is invoked for review, Codex is an independent READ-ONLY reviewer.

Codex must:
- inspect the actual diff and relevant surrounding code;
- look for correctness, regressions, security, data-integrity, architecture, concurrency, and test gaps;
- verify the Guided Diagnostics invariants above;
- prefer actionable findings over style commentary;
- report file/line references where possible;
- state CLEAN when no actionable findings remain.

Codex must not:
- edit files;
- commit;
- push;
- merge;
- deploy;
- change database state.

A disagreement with Claude should be reported as a finding with reasoning, not silently resolved by changing code.
