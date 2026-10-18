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
3. **Verification** (harness): HEAD, branch, origin heads, hooks/config and verification tooling unchanged; protected
   paths untouched; no credential-like file in the change; Claude neither failed nor asked for a person; `diff-check`,
   any requested allowlisted checks, and the default `typecheck` / `unit-tests` / `lint` when the repository can run them.
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
`git -c`, and ref/remote mutation (`git remote/fetch/pull/update-ref/symbolic-ref/update-index/worktree/cherry-pick/revert/am/apply/notes/replace/reflog/gc/prune/fast-import/bundle`),
`gh`, `vercel`, `prisma migrate/db`, `npm run db:*`, `npm run build` (it runs the migration script),
`npm install/ci/publish`, `curl`/`Invoke-WebRequest`, `codex`, `scripts/codex-review.ps1`, plus WebFetch and
WebSearch. It also denies:

- `git … --output=<file>`, so inspection commands cannot write files;
- `.env*`, `*.pem` and `*.key` files, for Read/Edit/Write and for any shell command naming `.env`;
- home-directory sign-in stores (`~/.codex`, `~/.claude/.credentials.json`, `~/.ssh`, `~/.aws`, `~/.azure`,
  `~/.config/gh`, `~/.git-credentials`);
- Edit/Write anywhere under `.git/`;
- Edit/Write to installed dependencies and caches (`node_modules`, `.pnp`, `.yarn`, `.pnpm-store`, `.npm`,
  `.turbo`, `.cache`), so Claude cannot alter the tooling the harness runs to verify its work.

The file tools are scoped to the repository (`Read(./**)`, `Edit(./**)`, `Write(./**)`).

- `read_only`: Read/Grep/Glob, read-only git inspection, and Claude Code's built-in read-only shell commands.
- `implement`: adds Edit/Write and test runners. Claude must leave its changes uncommitted.

Live probes in throwaway repositories confirmed these rules:

- `.env` reads were refused (Read, Bash, PowerShell), and Grep skipped those files;
- writes and edits inside the repo succeeded;
- writes to `.git/hooks` were refused, as were reads and writes outside the repo;
- `git … --output=` was refused.

**Claude is an untrusted implementer, and nothing Claude can modify is trusted as evidence that its work is
correct.** The allowed test runners execute code that Claude can write, so the harness establishes an integrity
baseline at the start of each task — a digest of Git hooks, `core.hooksPath`, config, attributes and info files;
origin's branch heads; and the verification tooling (the check entrypoints and `node_modules/.bin`) — and re-checks
it at every stage: after the Claude run, around verification (including after the checks have run), around the
independent review, and around the commit and push. Any drift stops the run fail-closed; it cannot undo what it
detects. The manager's own Git operations run with repository hooks disabled (via `core.hooksPath`), so a planted
hook cannot execute with the manager's credentials, while the on-disk digest still detects that the hook was planted.
The write-deny on `node_modules` and the caches is the primary boundary for the tooling; the digest is the second line.

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
- verification configuration: lint (`eslint.config.*`, `.eslintrc*`, `.eslintignore`), TypeScript (`tsconfig*.json`),
  and test/build runners (`vitest`/`vite`/`jest`/`playwright`/`cypress`/`webpack`/`rollup`/`babel`/`tsup`/`swc`
  config, `.mocharc*`, `.babelrc*`, `.swcrc`, `jest.setup.*`), so Claude cannot make a check pass by editing it;
- `.gitattributes` (it can blind the reviewer's diff) and `.gitconfig`/`.gitmodules`;
- installed dependencies and caches (`node_modules`, `.pnp`, `.yarn`, `.npm`, `.turbo`, `.cache`);
- any file under `prisma/migrations/`. Existing migrations must never be rewritten, and nothing deterministic checks
  that a new one is additive;
- any **new** file under `app/api/`.

A protected-path hit stops the run before the reviewer is called.

## Sensitive-file gate

Independently of path protection, a fail-closed gate runs over the complete changed set (tracked, staged, untracked,
new, and both sides of a rename). It matches credential/secret-like **filenames** — `.env`/`.env.*`/`.envrc`,
`*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.keystore`/`*.jks`, `id_rsa`/`id_ed25519`/`id_dsa`/`id_ecdsa`, `.netrc`/`.npmrc`/`.pgpass`/`.htpasswd`,
and the stems `credentials*`/`secret*`/`token*`/`auth*`/`service-account*`/`private-key*`/`api-key*` on **data** files
only (recognised code/test/doc extensions such as `.ts` are never matched, so `auth-service.ts` and `tokenizer.ts`
pass). A non-allow-listed match stops the run before anything is committed; the file's contents are never read,
committed, or sent to Claude or the reviewer. Documented placeholders (`.env.example`, `*.example`/`*.sample`/`*.template`)
are allow-listed and may be committed; the reviewer is told the gate ran and which filenames had their contents withheld.

## Commit and push

At `task_complete` the harness:

1. re-checks the branch and HEAD;
2. re-checks that the latest review is `clean` and its digest equals the current tree;
3. re-checks protected paths;
4. re-runs the sensitive-file gate over the complete changed set and re-checks the integrity baseline;
5. stages everything (the tree was clean when the task started, so every change belongs to the task);
6. refuses credential/secret-like paths or tokens in the staged diff;
7. runs `git diff --cached --check`;
8. commits with a fixed-format message naming the task, the review cycle and model, and the checks, then
   re-checks the integrity baseline immediately after the commit.

The commit runs with repository hooks disabled via `core.hooksPath` (not `--no-verify`), so a planted hook cannot
run with the manager's credentials.

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
