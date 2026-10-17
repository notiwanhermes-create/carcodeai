# CarCode agent manager

A local orchestrator for CarCode AI development:

| Role | Who | Does |
| --- | --- | --- |
| Manager / planner | OpenAI model via the Responses API (`OPENAI_MANAGER_MODEL`, default `gpt-6.1-sol`) | Decides **what** happens next. Never edits code, never runs commands, never judges code quality. |
| Implementer | Claude Code CLI, headless (`claude -p`) | The **only** agent that changes files. Follows `AGENTS.md` and `CLAUDE.md` (manager-mode section). |
| Independent reviewer | OpenAI model via a **separate, fresh** Responses API request (`OPENAI_REVIEW_MODEL`, default: the manager model) | Reviews the actual diff and the harness's own verification results. Returns findings only. |
| Harness | `tools/agent-manager/` | Enforces gates, runs verification, runs the review/fix loop, commits only verified + independently reviewed work, keeps resumable state. |

The manager and the reviewer may use the same model family, but they never share a conversation.
They are separate, stateless requests (`store: false`, no `previous_response_id`), with separate
prompts (`prompts/manager.md`, `prompts/reviewer.md`) and separate responsibilities.

**Codex is not required.** The manager does not need the Codex CLI, a Codex login, Codex usage or
`scripts/codex-review.ps1`. That script stays in the repository for optional manual use in interactive
sessions only.

See [architecture.md](architecture.md) for how the pieces fit and why.

## One-time setup

1. **Node.js 24+** on `PATH`.
2. **Claude Code CLI** signed in (`claude auth status` shows `loggedIn: true`). The manager starts
   `%USERPROFILE%\.local\bin\claude.exe` directly (override with `CARCODE_CLAUDE_BIN`; `.cmd` shims are refused).
3. **OpenAI API key** in your *local* environment only. Do not paste it into a chat or a file.
   In PowerShell, type it at a hidden prompt:

   ```powershell
   $s = Read-Host 'OpenAI API key' -AsSecureString
   [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)), 'User')
   ```

   Then open a **new** terminal. For a single session only, use `$env:OPENAI_API_KEY = ...` instead.
   The key is read only from `OPENAI_API_KEY`. It is sent only in the HTTPS `Authorization` header,
   and never printed, logged, stored, or passed to Claude or any check.

## Running

```powershell
# Plan only: one manager decision, printed. Claude and the reviewer are not run, Git is not changed, no state is written.
powershell -ExecutionPolicy Bypass -File scripts/carcode-manager.ps1 -DryRun -Goal "Continue building CarCode"

# At most one task (the default when no mode switch is given).
powershell -ExecutionPolicy Bypass -File scripts/carcode-manager.ps1 -Once -Goal "Continue building CarCode"

# Keep going within the task/retry limits, stopping at every approval gate.
powershell -ExecutionPolicy Bypass -File scripts/carcode-manager.ps1 -Autonomous

# Resume after a stop (review API outage, reboot, approval given...).
powershell -ExecutionPolicy Bypass -File scripts/carcode-manager.ps1 -Resume

# Inspection and housekeeping (no API key needed).
powershell -ExecutionPolicy Bypass -File scripts/carcode-manager.ps1 -Status
powershell -ExecutionPolicy Bypass -File scripts/carcode-manager.ps1 -ClearState   # sets saved state aside; Git untouched
```

Other switches:

- `-ReadOnly`: the manager may assign only read-only tasks, and a saved implement task is never resumed.
- `-AllowPush`: allow pushing verified, reviewed work on non-protected branches for this run (off by default).
- `-Repo <path>`: manage a different CarCode checkout. The default is the checkout that holds the script.

Exit codes: `0` finished or stopped normally, `2` needs a human, `3` blocked but resumable, `1` error.

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | (required except `-Status`/`-ClearState`) | Key for the manager and reviewer requests. |
| `OPENAI_MANAGER_MODEL` | `gpt-6.1-sol` | Manager model. |
| `OPENAI_REVIEW_MODEL` | same as the manager model | Independent reviewer model. |
| `CARCODE_MANAGER_MAX_TASKS` | `3` | Tasks per invocation (`-Once` is always 1). |
| `CARCODE_MANAGER_MAX_RETRIES` | `2` | Manager-driven fix attempts per task (e.g. failing checks). Resuming after an interruption does not count. |
| `CARCODE_MANAGER_CLAUDE_TIMEOUT_MIN` | `90` | Per Claude run. |
| `CARCODE_MANAGER_PUSH` | unset = **off** | Unset or `0`: never push; verified commits stay local. `1`: push verified work to `origin` under the same branch name, never forced, only for non-protected automation branches. Any other value is an error. The launcher's `-AllowPush` switch enables it for one run. `main` and protected branches are never pushed. |
| `CARCODE_MANAGER_STATE_DIR` | `%LOCALAPPDATA%\CarCodeAI\agent-manager` | Runtime state and logs. Refused if inside the repository. |
| `CARCODE_CLAUDE_BIN` | auto | Path to `claude.exe`. |

## The implement loop

1. The manager assigns a task. The harness gates it, creates the branch from a clean tree, and runs Claude.
2. The harness verifies: Git state unchanged (HEAD, branch, origin, hooks/config), protected paths untouched,
   Claude did not report failure or ask for a person, `diff-check` plus any requested checks pass.
   `typecheck`, `unit-tests` and `lint` also run when the repository can run them.
3. The **independent reviewer** gets a fresh request with the real diff (new files included), the rules,
   the task requirements and the harness's check results. It never sees Claude's report.
4. `clean`: the manager may mark the task complete, and the harness commits exactly the reviewed tree.
   `findings`: the harness sends only the findings to Claude, re-verifies, and runs a **new** review.
   `blocked`, malformed output, or an API error: never clean. The run stops.
5. At most **3 review cycles per task**. If none is clean, the run stops for a person.

Claude's report has no review field. Claude cannot mark its own work reviewed.

## What it will and will not do on its own

**Automatic** (only after harness verification **and** a clean independent review of the exact tree):
create a `research/`, `feature/`, `fix/`, `chore/`, `docs/` or `test/` branch from a clean tree;
have Claude edit and test; commit the reviewed diff; then start the next task.
Launching the manager is the explicit commit request that CLAUDE.md asks for, limited to that verified work.
**Pushing is off by default.** Only with `CARCODE_MANAGER_PUSH=1` or `-AllowPush` does the manager push the task
branch (never forced, never `main` or a protected branch).

**Never committed automatically**, even when the review is clean: changes to the agent rules, the
review/manager machinery, dependencies, deploy/security configuration, database tooling, migrations
(new or existing), or new `app/api/` routes. The run stops so a person can review and commit them.
See [architecture.md](architecture.md#protected-paths).

**Always stops for you** before: merges or pull requests, deploys, production systems or data,
migrations against a real database, shared or destructive database operations, deleting user data,
force pushes, history rewrites, authentication or security policy changes, paid services or licensed data,
new public APIs, secrets or credentials, publishing, new dependencies, weakening any `AGENTS.md` invariant,
or anything the manager model is unsure about. For read-only tasks only the action gates apply: a
read-only task may inspect and report on topics such as security or production, because it cannot change anything.
It also stops when Claude reports `needs_human` or `blocked`, when it finds uncommitted changes it did not
make, when Git moved under a saved task, when origin's branches or Git hooks/config changed during a Claude
run, when the reviewed tree changed before commit, and on any malformed or unexpected decision.

Never: push to `main` or any protected branch, merge, deploy, force-push, or run text produced by a model.

## Runtime state

`%LOCALAPPDATA%\CarCodeAI\agent-manager\repos\<repo>-<hash>\`:

- `state.json`: active task with phase, review cycles (model, verdict, findings, reviewed tree digest),
  pending fixes, last Claude result, verification results, pending decision, stop reason.
- `history.jsonl`: decisions, verifications, reviews and completions, with token usage.
- `runs/<run>/`: each manager request, review result and Claude result.

Everything is redacted before it is written. Git is authoritative: on every start the saved task is reconciled
against the real branch, HEAD and tree. If the tree changed after a review, that verdict is invalid and the
run stops for a person.

## Tests

```powershell
node --test "tools/agent-manager/test/*.test.mjs"
```

No network, API key, Claude or Codex is needed. The tests use throwaway Git repositories, a fake Responses API
(manager and reviewer routed separately), and a fake Claude runner.
