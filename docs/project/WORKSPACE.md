# CarCode AI: one workspace

CarCode AI is one project, in one Git repository, with one canonical checkout.

## Canonical checkout

`%USERPROFILE%\OneDrive\Desktop\carcode-ai` on the owner's PC, with remote
`origin` = `github.com/notiwanhermes-create/carcodeai`.

Everything else is either a **linked worktree** of that checkout (created with
`git worktree add` from it, and listed by `git worktree list` there) or it is
not CarCode and must not be worked in. An independent clone or a copied folder
is never a second CarCode project: its unique work is moved into the canonical
repository as a branch, and then the copy is archived.

Cloud sessions (claude.ai/code) work on a fresh clone of the same GitHub
repository. They see branches only after they are pushed, never the PC's
uncommitted work.

## Linked worktrees

Use one only when a task needs a second branch checked out at the same time.
Name it for the task and keep it beside the canonical checkout:

```
%USERPROFILE%\OneDrive\Desktop\carcode-ai                      canonical (main or the current branch)
%USERPROFILE%\OneDrive\Desktop\carcode-ai-worktrees\v2i        branch for V2I
%USERPROFILE%\OneDrive\Desktop\carcode-ai-worktrees\manager    chore/openai-claude-codex-manager
```

```powershell
cd $env:USERPROFILE\OneDrive\Desktop\carcode-ai
git worktree add ..\carcode-ai-worktrees\<task> <branch>     # create
git worktree list                                             # what exists
git worktree remove ..\carcode-ai-worktrees\<task>            # only when it is clean and pushed
```

Moving an existing worktree: `git worktree move <old> <new>` (Git refuses if
it is locked or has submodules). Never move or rename a worktree folder in
Explorer: Git loses track of it.

Claude Code shares one auto-memory folder across all worktrees of the
repository, so context written in any of them is seen in all of them. A
separate clone gets its own, which is one more reason not to keep clones.

## Branches on GitHub (as of 2026-10-17)

Production and its history (merged, kept for reference):
`main` `7bb5408`; `fix/phase-0-1-critical`, `fix/phase-2a-vehicle-data`,
`fix/phase-2b-dtc-reliability`, `fix/phase-2c-diagnosis-quality`,
`fix/phase-2d-database-foundation`, `fix/phase-2e-one-garage`,
`hotfix/restore-dropdown`, `feat/dropdown-portal-fix`.

Active research, not merged, each stacked on the previous:
`research/guided-diagnostics` → `feat/guided-diagnostics-v2a` → `-v2b-specifications`
→ `-v2c-context-capabilities` → `-v2d-dtc-freeze-frame` → `-v2e-next-best-test`
→ `-v2f-ai-bridge` → `-v2g-persistence` → `-v2h-reviewed-content`.

Docs only, not in the stack, unique (keep): `research/guided-diagnostics-v2-standards`.

Agent tooling, not merged:
- `chore/openai-claude-codex-manager` (`56fc9d1`): the manager. Current.
- `chore/claude-codex-collab-main` (`a58046e`): CLAUDE.md, AGENTS.md and
  `scripts/codex-review.ps1` on top of `main`. The manager branch contains it.
- `chore/claude-codex-collab` (`fc99144`): the same three files, committed on
  top of V2H. Same content as `chore/claude-codex-collab-main`.

Old and unmerged, from February 2026 (keep until someone decides):
`feat/dropdown-portal`, `vercel/install-vercel-web-analytics-f-ltm3a9` (PR #1),
`vercel/install-vercel-speed-insights-1i72dd` (PR #2).

Session branches: `claude/*`, one per cloud session.

No branch is to be deleted or merged as part of tidying the folders.

## The manager and the workspace

The agent manager works on whichever checkout launches it (or `-Repo`). It
keeps state per checkout path. So it must only ever be launched from the
canonical checkout or one of its linked worktrees.

`docs/project/manager-canonical-workspace.patch` makes this enforced and
visible: with `CARCODE_CANONICAL_REPO` set, it refuses any other copy, and every
run, `-Status`, the task record and the prompt to Claude name the canonical
repository and the linked worktree in use. The manager tests pass with it
(66 passed, 3 Windows-only skipped, on Linux). Apply it on the PC, in the
manager worktree, after any uncommitted manager work there is committed. Take
the patch straight from Git (a PowerShell `>` would re-encode it):

```powershell
git fetch origin claude/brave-pascal-qmnmn2
cmd /c "git show origin/claude/brave-pascal-qmnmn2:docs/project/manager-canonical-workspace.patch > %TEMP%\carcode-manager.patch"
git am -3 "$env:TEMP\carcode-manager.patch"
node --test "tools/agent-manager/test/*.test.mjs"
[Environment]::SetEnvironmentVariable('CARCODE_CANONICAL_REPO', "$env:USERPROFILE\OneDrive\Desktop\carcode-ai", 'User')
```

Then run the Codex review that `CLAUDE.md` requires before pushing it.
