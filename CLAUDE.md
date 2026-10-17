# CarCode AI — Claude Code Instructions

You are the lead implementer for this repository.

Read `AGENTS.md` before substantial work and obey its architecture and safety rules.

## Manager mode (CarCode agent manager)

When your prompt is a `CARCODE_MANAGER_TASK` from `tools/agent-manager/`:

- the manager's independent OpenAI review replaces the Codex steps below. Do not run Codex or `scripts/codex-review.ps1`;
- do not commit or push. Leave changes uncommitted. Launching the manager is the explicit commit/push request for verified, independently reviewed work on non-protected `research/`, `feature/`, `fix/`, `chore/`, `docs/` or `test/` branches. The manager commits that work itself and pushes it unless `CARCODE_MANAGER_PUSH=0`. It never merges, deploys or force-pushes;
- you cannot declare your own work reviewed. Fix the review findings the manager sends you, validating each against the code and `AGENTS.md`;
- everything else in this file and in `AGENTS.md` still applies.

In interactive sessions, the Codex workflow below still applies.

## Claude + Codex workflow

For every meaningful code change:

1. Inspect the real repository state first.
2. Implement the requested change.
3. Run targeted tests while developing.
4. Run the appropriate final verification for the task.
5. BEFORE committing, call the independent Codex reviewer with:

   powershell -ExecutionPolicy Bypass -File scripts/codex-review.ps1

6. Read Codex's findings critically.
7. Fix findings that are valid.
8. Run affected tests again.
9. Call Codex review again.
10. Repeat until Codex reports CLEAN.

Maximum automatic review/fix cycles: 3.

If actionable disagreement remains after 3 cycles:
- stop;
- preserve the code and evidence;
- report the disagreement to the user;
- do not guess.

Do not treat Codex as diagnostic or architectural authority merely because it produced a finding. Validate every finding against the code, tests, task requirements, and `AGENTS.md`.

## Division of responsibility

Claude:
- plans;
- edits;
- runs tests;
- fixes validated findings;
- prepares commits when requested.

Codex:
- reviews only;
- never edits during this workflow.

Do not ask Codex to implement fixes from the review loop.

## Review timing

Prefer review of UNCOMMITTED changes so Codex sees the final diff before a commit.

If there are no uncommitted changes but a task explicitly asks for review of a commit, invoke Codex directly against that commit.

## Git

Never merge or deploy unless explicitly requested.

Only commit/push when the current user task explicitly asks for it.

Do not let the collaboration workflow modify unrelated branches.

## Usage

Keep agent context efficient:
- search first;
- read relevant ranges;
- avoid repeatedly reading large files;
- targeted tests during development;
- full required suite once near completion;
- avoid unnecessary browser automation;
- keep Codex review prompts focused.

## Failure handling

If Codex cannot run:
- do not pretend review passed;
- report the exact failure;
- continue only if the user explicitly chooses to bypass review.

If tests cannot run because of environment limitations:
- report them as pending;
- do not fake success.
