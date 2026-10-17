// Resumable runtime state, stored OUTSIDE the repository
// (default %LOCALAPPDATA%\CarCodeAI\agent-manager). Git remains authoritative:
// the manager reconciles this state against the real repository on every start.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { redactDeep } from "./redact.mjs";

// v2: generic independent-review state (task.reviews, lastReview) replaced the Codex-era fields.
export const STATE_VERSION = 2;
const HISTORY_IN_STATE = 30;
const STALE_UNREADABLE_LOCK_MS = 10 * 60_000;

export function stateRoot(env = process.env) {
  if (env.CARCODE_MANAGER_STATE_DIR) return resolve(env.CARCODE_MANAGER_STATE_DIR);
  const local = env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(local, "CarCodeAI", "agent-manager");
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function repoKey(repo) {
  const norm = resolve(repo).replace(/\\/g, "/").toLowerCase();
  const safeName = basename(repo).replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safeName}-${createHash("sha256").update(norm).digest("hex").slice(0, 12)}`;
}

export class StateError extends Error {}

export function createStateStore(repo, { env = process.env, now = () => new Date() } = {}) {
  const root = stateRoot(env);
  if (isInside(resolve(root), resolve(repo))) {
    throw new StateError(`Refusing to store manager state inside the repository (${root}). Set CARCODE_MANAGER_STATE_DIR outside it.`);
  }
  const dir = join(root, "repos", repoKey(repo));
  const statePath = join(dir, "state.json");
  const historyPath = join(dir, "history.jsonl");
  const lockPath = join(dir, "manager.lock");
  const ensureDir = () => mkdirSync(dir, { recursive: true });

  function initial() {
    return {
      version: STATE_VERSION,
      repo: resolve(repo),
      activeTask: null,
      phase: "idle",
      lastClaudeResult: null,
      // Latest independent review: { cycle, model, verdict, summary, findings, digest, at }.
      // The full per-task list (max 3) lives in activeTask.reviews; pending fixes in activeTask.pendingFixes.
      lastReview: null,
      verification: null,
      pendingDecision: null,
      stopReason: null,
      counters: { tasksCompleted: 0 },
      history: [],
      updatedAt: now().toISOString(),
    };
  }

  function load() {
    if (!existsSync(statePath)) return initial();
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      const aside = join(dir, `state.corrupt-${Date.now()}.json`);
      renameSync(statePath, aside);
      throw new StateError(`Manager state was unreadable and has been set aside at ${aside}. Inspect it before running again.`);
    }
    if (parsed?.version !== STATE_VERSION || resolve(parsed.repo ?? "") !== resolve(repo)) {
      throw new StateError(`Manager state at ${statePath} is from an incompatible version or another repository. Run with -ClearState to set it aside.`);
    }
    return parsed;
  }

  function save(state) {
    ensureDir();
    const clean = redactDeep({ ...state, history: (state.history ?? []).slice(-HISTORY_IN_STATE), updatedAt: now().toISOString() }, env);
    const tmp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n", "utf8");
    renameSync(tmp, statePath);
    return clean;
  }

  function appendHistory(entry) {
    ensureDir();
    appendFileSync(historyPath, JSON.stringify(redactDeep({ at: now().toISOString(), ...entry }, env)) + "\n", "utf8");
  }

  function writeRunFile(runId, name, data) {
    const runDir = join(dir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, name);
    writeFileSync(path, JSON.stringify(redactDeep(data, env), null, 2) + "\n", "utf8");
    return path;
  }

  /** Move the state file aside (never deletes); Git is not touched. */
  function clear() {
    if (!existsSync(statePath)) return null;
    const aside = join(dir, `state.cleared-${Date.now()}.json`);
    renameSync(statePath, aside);
    return aside;
  }

  // The lock is published atomically: its content is written to a private file
  // first and then hard-linked into place, so a lock file never exists without
  // its owner. An unreadable lock is treated as held unless it is clearly stale.
  function acquireLock() {
    ensureDir();
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = JSON.stringify({ pid: process.pid, token, at: now().toISOString() });
    for (let attempt = 0; attempt < 2; attempt++) {
      const tmp = `${lockPath}.${token}.tmp`;
      writeFileSync(tmp, body, "utf8");
      let linked = false;
      try {
        linkSync(tmp, lockPath);
        linked = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      } finally {
        unlinkSync(tmp);
      }
      if (linked) {
        return () => {
          try {
            if (JSON.parse(readFileSync(lockPath, "utf8")).token === token) unlinkSync(lockPath);
          } catch {
            /* already gone */
          }
        };
      }
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        owner = null;
      }
      if (owner?.pid && pidAlive(owner.pid)) throw new StateError(`Another manager process (pid ${owner.pid}) is running for this repository.`);
      if (!owner) {
        let ageMs = 0;
        try {
          ageMs = Date.now() - statSync(lockPath).mtimeMs;
        } catch {
          continue; // vanished; try again
        }
        if (ageMs < STALE_UNREADABLE_LOCK_MS) throw new StateError(`The manager lock at ${lockPath} is held (unreadable, ${Math.round(ageMs / 1000)}s old).`);
      }
      unlinkSync(lockPath);
    }
    throw new StateError("Could not acquire the manager lock.");
  }

  return { dir, statePath, historyPath, load, save, appendHistory, writeRunFile, clear, acquireLock, initial };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
