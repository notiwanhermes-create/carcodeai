# Consolidating CarCode AI folders on the PC

Cloud sessions cannot see the PC, so this is done by a Claude Code session
running **on the PC**: open the Claude desktop app, or run `claude` in a
terminal, in `%USERPROFILE%\OneDrive\Desktop\carcode-ai`. Paste the prompt
below. `WORKSPACE.md` describes the target layout.

The procedure only adds Git refs, copies files and **moves** folders into an
archive. It never deletes, merges, deploys, force-pushes, stashes or changes a
branch's commits.

## Prompt

```text
Consolidate CarCode AI on this PC into the one canonical checkout,
%USERPROFILE%\OneDrive\Desktop\carcode-ai. Follow docs/project/LOCAL-CONSOLIDATION.md
from branch origin/claude/brave-pascal-qmnmn2 (git fetch origin, then
git show origin/claude/brave-pascal-qmnmn2:docs/project/LOCAL-CONSOLIDATION.md).
Do not change the checked-out branch of any folder. No merge, deploy, production,
push, force-push, stash, reset, clean or delete. Report the inventory table and
the final verification.
```

## Steps

### 1. Inventory

- Folders whose name contains `carcode` (any case) under `%USERPROFILE%`
  (Desktop, OneDrive, Documents, Downloads, source/repos), depth 4, skipping
  `node_modules`, `.next` and `AppData`. Include `../carcodeai-gd-v2-standards`.
- `git worktree list --porcelain` in the canonical checkout.
- Claude Code project folders: `%USERPROFILE%\.claude\projects\*carcode*`.
- Manager state: `%LOCALAPPDATA%\CarCodeAI\agent-manager\repos\*`.

For each folder record: path; Git or not; `git rev-parse --path-format=absolute
--git-dir --git-common-dir`; `origin` URL; current branch and HEAD; `git status
--porcelain` count; `git stash list` count; local branches not on `origin`
(`git branch --format=%(refname:short)` and `git rev-list --count
origin/<b>..<b>` or "no upstream"); newest file time outside `.git` and
`node_modules`.

Classify each one:

| Class | Test |
| --- | --- |
| canonical | it is `%USERPROFILE%\OneDrive\Desktop\carcode-ai` |
| linked worktree | its Git common dir is the canonical checkout's `.git` |
| independent clone | a Git repository with its own `.git` and the CarCode origin |
| plain copy | not a Git repository, but holds CarCode files |
| unrelated | anything else: leave it alone |

### 2. Snapshot uncommitted work first (V2I and manager included)

In **every** Git folder with uncommitted changes, record them as a local ref
without touching the working tree, the index, the branch or the stash:

```powershell
$idx = Join-Path $env:TEMP ("carcode-" + [guid]::NewGuid() + ".idx")
$env:GIT_INDEX_FILE = $idx
git read-tree HEAD
git add -A                       # .gitignore still applies: .env files are not taken
$tree = git write-tree
Remove-Item Env:GIT_INDEX_FILE; Remove-Item $idx
$commit = git commit-tree $tree -p HEAD -m "WIP snapshot of <folder> on <branch>, <date>. Not a real commit."
git update-ref "refs/rescue/<folder>-wip-<yyyyMMdd>" $commit
```

Check first that `git add -A` will not take secrets: list `git status --porcelain
--untracked-files=all` and stop if anything looks like a key, `.env` or a
database dump. Refs under `refs/rescue/` are not pushed.

Also copy each folder that has uncommitted work to
`%USERPROFILE%\CarCodeAI-archive\<yyyyMMdd>\snapshots\<folder>` with
`robocopy <src> <dst> /E /XD node_modules .next /R:1 /W:1` before anything is
moved.

### 3. Bring unique Git work into the canonical repository

For each **independent clone**:

- Stashes: `git -C <clone> branch rescue/<folder>/stash-<n> "stash@{<n>}"` for
  each entry (quoted for PowerShell; this reads the stash, it does not change it).
  Do the same in the canonical checkout and every linked worktree, as
  `rescue/canonical/stash-<n>`: stashes are shared by all of them.
- Fetch every branch, rescue branch and rescue ref into the canonical
  checkout under its own namespace, so nothing collides with or overwrites an
  existing branch:
  `git fetch <clone> "refs/heads/*:refs/heads/rescue/<folder>/*" "refs/rescue/*:refs/rescue/<folder>/*"`
- A fetched branch whose tip is already in a canonical branch adds nothing;
  note it. One with commits not on any canonical branch is unique: keep it and
  list it in the report. Do not merge it anywhere.

### 4. Bring unique files from plain copies, and ignored files from clones

Compare file by file (SHA-256) with the canonical checkout, skipping
`node_modules`, `.next`, `.git`. For clones, look only at ignored files
(`git status --ignored --porcelain`) such as `.env.local`, `CLAUDE.local.md`,
notes or exports.

- Same hash in the canonical checkout or in any branch's history
  (`git log --all --find-object=<blob>`, after `git hash-object <file>`): not
  unique.
- Otherwise unique. Do **not** copy it over a canonical file. Leave it in the
  archived folder and list it in the report. Never print the contents of
  `.env` files; compare hashes only.

### 5. Claude Code context

- Auto memory is shared by all worktrees of the canonical repository
  (`%USERPROFILE%\.claude\projects\C--Users-notiw-OneDrive-Desktop-carcode-ai\memory`).
  Folders for other CarCode paths belong to clones or copies.
- Copy each other folder's `memory\*.md` into the canonical memory folder
  under a `from-<folder>-` prefix, never overwriting. Fold anything still true
  into the canonical `carcode-handoff.md`, and make its first line point to
  `docs/project/STATE.md` on `origin/claude/brave-pascal-qmnmn2`, until that
  branch is merged.
- Rewrite `carcode-handoff.md` from `docs/project/STATE.md`, so a session on
  any branch has it, and add V2I's actual branch, worktree and scope.
- Chat history cannot be merged between sessions or apps. Leave old sessions
  as they are; the handoff and `STATE.md` replace them.

### 6. Manager

- Apply `manager-canonical-workspace.patch` in the manager worktree as
  `WORKSPACE.md` describes, and set `CARCODE_CANONICAL_REPO` at user level.
- In `%LOCALAPPDATA%\CarCodeAI\agent-manager\repos\`, a state folder for a
  non-canonical path with an `activeTask` is unfinished manager work: report it
  and leave it in place. Never `-ClearState` it.
- Run `scripts\carcode-manager.ps1 -Status` from the canonical checkout and
  from each linked worktree: each must name the canonical repository.

### 7. Tidy

- **Linked worktrees** stay. If a name is unclear, move it with `git worktree
  move <old> ..\carcode-ai-worktrees\<task>`. Never move a worktree that has
  uncommitted work without first doing step 2 and asking the owner.
- **Independent clones and plain copies** that steps 2 to 4 proved fully
  represented: move (not delete) to `%USERPROFILE%\CarCodeAI-archive\<yyyyMMdd>\<folder>`.
  Then run `git worktree prune --dry-run` in the canonical checkout; prune only
  entries that point at archived folders.
- Anything not proven redundant stays where it is, and goes into the report.
- Do not delete the archive. The owner does that, later, if they want.

### 8. Verify and report

- `git worktree list` and `git status --short --branch` in each worktree.
- `git for-each-ref refs/heads refs/rescue` in the canonical checkout.
- Uncommitted V2I and manager files are still in their worktrees (same
  `git status` counts as in step 1) and in `refs/rescue/`.
- `git log -1 origin/main` is still `7bb5408` or newer only by someone else's
  push, and `git reflog -n 20` shows no merge, reset or rebase.
- Nothing deployed, no production command run.

Report: the canonical location; each folder with its class and what happened
(kept / moved worktree / archived to path); rescue branches and refs created;
unique files left in the archive; what could not be merged.
