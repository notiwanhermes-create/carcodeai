# Agent manager architecture

## Roles

- **OpenAI Manager**: planner and project manager. It reads compact repository context and decides the
  next step (`assign_task`, `continue_task`, `task_complete`, `require_human`, `stop`). It never edits code,
  runs commands, or reviews code quality.
- **Claude Code**: the only implementer. It runs headless with a fixed permission set chosen by the harness.
- **OpenAI Reviewer**: an independent reviewer. Each review is a fresh Responses API request with its own
  prompt (`prompts/reviewer.md`). It sees the real diff and the harness's verification results, never
  Claude's report or reasoning. It returns findings; it cannot edit, run commands, commit, push, merge or deploy.
- **Harness** (`tools/agent-manager/`): deterministic code that gates every decision, verifies every Claude run,
  drives the review/fix loop, and commits only verified, independently reviewed work.

The manager and the reviewer may be the same model (`OPENAI_REVIEW_MODEL` defaults to `OPENAI_MANAGER_MODEL`).
They are still isolated: separate requests (`store: false`, no `previous_response_id`, no shared conversation),
separate system prompts, separate JSON schemas, and separate responsibilities.

**Codex** is not in the autonomous path. Nothing in `tools/agent-manager/` invokes it, and a test runs the full
implement → review → commit flow with no Codex on `PATH`. Claude is denied `codex*` and `*codex-review*` commands
under the manager. `scripts/codex-review.ps1` is unchanged and stays available for manual, interactive use.

## Flow

```
scripts/carcode-manager.ps1  (checks Node 24, passes the goal as base64)
        |
tools/agent-manager/manager.mjs   harness loop
        |-- repo.mjs              git helpers, tree fingerprint, change set (throwaway index), hooks/config digest
        |-- redact.mjs            redaction of everything sent to OpenAI, printed or stored
        |-- openai-manager.mjs    stateless Responses API client + manager decision schema
        |-- openai-reviewer.mjs   independent review: input builder, review schema, validation
        |-- safety.mjs            approval gates, branch policy, protected paths, check allowlist, env stripping
        |-- claude-adapter.mjs    `claude -p` with fixed permissions, task on stdin, strict JSON report
        '-- state.mjs             resumable state outside the repo, atomic writes, single-run lock
```

One implement task:

1. **Manager** decides `assign_task` (validated, then gated).
2. **Claude** implements (fixed permissions, prompt on stdin).
3. **Verification** (harness): HEAD, branch, origin heads, hooks/config unchanged; protected paths untouched; Claude
   neither failed nor asked for a person; `diff-check`, any requested allowlisted checks, and the default `typecheck` /
   `unit-tests` / `lint` when the repository can run them.
4. **Independent review**, cycle n, a fresh request:
   - `clean`: the task is `verified` for this exact tree digest. The manager is asked, and on `task_complete` the
     harness re-checks the digest and commits.
   - `findings`: only the findings are sent to Claude (fenced, as data) → verification → a new fresh review (n+1).
   - `blocked`: stop for a person. Malformed output or an API error: stop (`review_blocked`, resumable).
5. After 3 review cycles without `clean`, stop for a person (phase `review_limit`). Resuming cannot buy more cycles.

If a fix fails verification, the result goes back to the manager model, which may `continue_task` within the retry
limit. The next passing verification resumes the review loop at the next cycle number.

## Decision contract (manager)

```json
{
  "decision": "assign_task | continue_task | task_complete | require_human | stop",
  "summary": "...", "task": "...", "reason": "...",
  "required_checks": [], "approval_reason": null,
  "mode": "read_only | implement", "branch": null
}
```

These are the requested fields plus `mode` and `branch`, which the harness needs to choose Claude's permission set and
branch policy. Validation is exact: no missing or extra keys, known enums only, length limits, `require_human` must
have `approval_reason` and no other decision may. Invalid input stops the run (`malformed_decision`). Sequencing is
enforced: no new task while one is active, no `continue_task` without one, no mode change mid-task, no implement task
in a `-ReadOnly` run, and `task_complete` only when the harness has marked the task `verified`.

## Review contract (reviewer)

```json
{
  "verdict": "clean | findings | blocked",
  "summary": "...",
  "findings": [
    { "severity": "critical | high | medium | low", "file": "...", "location": "...",
      "problem": "...", "reason": "...", "required_fix": "..." }
  ]
}
```

Validation is strict and fails closed. Exact keys, known enums, a non-empty summary, at most 30 findings, and each
finding must state a problem and a required fix. `clean` with findings, or `findings` without any, is rejected as
contradictory. Malformed output, a refusal, an incomplete response, or an HTTP/network failure is never clean.

**Reviewer input** is built from the real repository, not from anyone's claims:

- `AGENTS.md`, `CLAUDE.md`;
- the task summary and requirements (from the manager), plus the latest fix instruction;
- the changed files and the complete diff against the task's start commit. This is computed through a throwaway
  index, so new files are included, the real index is untouched, and secret paths are excluded;
- migration files touched;
- the harness's own check results;
- on later cycles, the previous review's findings, so the reviewer can check each one.

Claude's report, summary and reasoning are deliberately excluded. A change larger than 150,000 characters of diff is
not sent at all: the review is `blocked`, because the reviewer cannot review what it cannot see. The whole document is
redacted value by value before serialisation.

**Digest binding.** Each review record stores the tree fingerprint it saw: a SHA-256 of HEAD, the full tracked diff,
and the path and blob hash of every untracked file. If the tree changes during a review, the review is `blocked`. A
clean verdict is valid only while the tree still has that fingerprint. The harness re-checks it at commit time and on
every resume, and any difference invalidates the verdict and stops for a person.

## Why no model can run commands

No code path hands model text to a shell. Every process is spawned with an argv array and `shell:false`, and a test
enforces this. The manager's `task` reaches Claude only as a fenced block on stdin, under harness rules and
`AGENTS.md`/`CLAUDE.md`. Reviewer findings reach Claude the same way, as fenced data. `required_checks` entries are
matched against a fixed allowlist (`diff-check`, `typecheck`, `unit-tests`, `lint`, `manager-tests`) that maps to
fixed argv. Anything else is passed to Claude as text and never executed by the harness.

## Claude permissions (set by the harness, not by a model)

All runs: `--permission-mode dontAsk`, `--permission-prompts none`, `--strict-mcp-config`,
`--disable-slash-commands`, `--no-session-persistence`, `--json-schema <report>`. The report has no review field, and
unknown fields are rejected.

The deny list (Bash and PowerShell) covers `git push/merge/rebase/reset/stash/checkout/switch/commit/tag/clean/config`,
`gh`, `vercel`, `prisma migrate/db`, `npm run db:*`, `npm run build` (it runs the migration script),
`npm install/ci/publish`, `curl`/`Invoke-WebRequest`, `codex`, `scripts/codex-review.ps1`, plus WebFetch and
WebSearch. It also denies:

- `git … --output=<file>`, so inspection commands cannot write files;
- `.env*`, `*.pem` and `*.key` files, for Read/Edit/Write and for any shell command naming `.env`;
- home-directory sign-in stores (`~/.codex`, `~/.claude/.credentials.json`, `~/.ssh`, `~/.aws`, `~/.azure`,
  `~/.config/gh`, `~/.git-credentials`);
- Edit/Write anywhere under `.git/`.

The file tools are scoped to the repository (`Read(./**)`, `Edit(./**)`, `Write(./**)`).

- `read_only`: Read/Grep/Glob, read-only git inspection, and Claude Code's built-in read-only shell commands.
- `implement`: adds Edit/Write and test runners. Claude must leave its changes uncommitted.

Live probes in throwaway repositories confirmed these rules:

- `.env` reads were refused (Read, Bash, PowerShell), and Grep skipped those files;
- writes and edits inside the repo succeeded;
- writes to `.git/hooks` were refused, as were reads and writes outside the repo;
- `git … --output=` was refused.

**This is a guard rail, not a sandbox.** The allowed test runners execute code that Claude can write. Claude is the
trusted implementer; the rules stop accidents and injected instructions, and the harness checks the outcome
deterministically. Before and after every Claude run it compares origin's branch heads (to detect a push) and a
digest of Git hooks, `core.hooksPath`, config and info files. It cannot undo what it detects; it stops for a person.

Child environment: every variable whose name looks like a database connection or a credential is removed. Matching
is by pattern, so `DATABASE_URL_UNPOOLED`, `*_CLIENT_SECRET`, `*_TOKEN`, `PG*` and `OPENAI_*` are all caught. Claude's
own sign-in (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) is kept, and only for the Claude process. Harness-run
checks get the stripped environment. When the manager itself runs inside a Claude Code host session, the host's
session variables (`CLAUDECODE`, `CLAUDE_CODE_*`, its local `ANTHROPIC_BASE_URL`) are removed, so the child uses the
CLI's own stored login. `CLAUDE_CODE_SIMPLE`, which forces bare mode, is always removed. No credentials are copied or
read.

## Protected paths

Changes to these are verified like any other, but they always stop for a person to review and commit:

- `AGENTS.md`, `CLAUDE.md`, including `AGENTS.override.md` and nested instruction files at any depth;
- `scripts/codex-review.ps1`, `scripts/carcode-manager.ps1`, `tools/agent-manager/**`;
- `.claude/`, `.codex/`, `.github/`, `.vscode/`;
- `package.json`, `package-lock.json`, `.npmrc`;
- deploy/security config (`next.config.*`, `proxy.*`, `middleware.*`, `vercel.json`, `prisma.config.*`);
- database tooling (`scripts/db-*`, `scripts/rollback-check/`) and the database schema (`prisma/schema.prisma`);
- any file under `prisma/migrations/`. Existing migrations must never be rewritten, and nothing deterministic checks
  that a new one is additive;
- any **new** file under `app/api/`.

A protected-path hit stops the run before the reviewer is called.

## Commit and push

At `task_complete` the harness:

1. re-checks the branch and HEAD;
2. re-checks that the latest review is `clean` and its digest equals the current tree;
3. re-checks protected paths;
4. stages everything (the tree was clean when the task started, so every change belongs to the task);
5. refuses secret-looking paths or tokens in the staged diff;
6. runs `git diff --cached --check`;
7. commits with a fixed-format message naming the task, the review cycle and model, and the checks.

It never uses `--no-verify`.

**Automatic push is OFF by default.** With `CARCODE_MANAGER_PUSH` unset or `0`, verified commits stay local.
Only `CARCODE_MANAGER_PUSH=1`, or the launcher's `-AllowPush` for one run, enables pushing; any other value is a
configuration error. When enabled, the push sends exactly the recorded commit, `<commit-sha>:refs/heads/<branch>`, to
`origin`. It is never forced, and only goes to allowed automation branches. `main` and protected branches are refused
regardless of configuration. A resumed push requires HEAD to still be that commit.

CLAUDE.md says to commit or push only when the current task explicitly asks. Under the manager, the person who
launches it authorises commits of verified, independently reviewed work on non-protected branches. Pushing needs the
separate opt-in above. Merging, pull requests and deploys always stay manual.

## Resume

State phases: `starting → (creating_branch) → claude_running → verification_failed | awaiting_review → reviewing →
verified | review_blocked | review_limit → committing → committed → pushing → complete`.

On start the saved task must match the real branch and HEAD; otherwise the run stops for a person. For `verified` and
review phases, the tree must still match what the manager last verified, or any earlier verdict is invalid.

- `awaiting_review` / `reviewing` (API outage, malformed review, crash): re-run the review on the same tree, without
  re-running Claude.
- `committed` / `pushing`: retry only the push.
- `review_blocked` / `review_limit`: wait for a person; the manager will not send the task back to Claude.

State is version 2. Codex-era version-1 state is rejected (`-ClearState` sets it aside).

## Known limits

- The OpenAI manager and reviewer cannot be exercised live until `OPENAI_API_KEY` is set locally. Their HTTP client,
  schemas, validation and loop are covered by tests with a fake Responses API.
- A full implement task through the real Claude CLI has been exercised only in a throwaway repository, with the
  manager and reviewer stubbed. It has not been run against CarCode itself.
- Claude cannot start throwaway databases or install packages under the implement permission set. Such tasks report
  `blocked` and stop for a person.
- There is no "adopt existing changes" mode. A tree with uncommitted work the manager did not create (such as the V2I
  work) cannot be taken over by implement tasks; a person commits it first.
- The approval gates are keyword-based and deliberately over-match. False positives stop the run for a person; they
  never let an action through. For `read_only` tasks only the action gates apply.
- Guided Diagnostics invariants in application code are enforced by `AGENTS.md`, the Claude prompt and the independent
  review, not by a deterministic check in the harness.
