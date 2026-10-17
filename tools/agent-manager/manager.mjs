#!/usr/bin/env node
// CarCode AI local engineering manager.
//
//   OpenAI manager (decides WHAT)  ->  deterministic harness (gates, verifies, commits)
//     -> Claude Code CLI (the only implementer)
//     -> harness verification (fixed, allowlisted checks)
//     -> independent OpenAI reviewer (fresh request; findings go back to Claude, max 3 cycles)
//
// The harness never executes model-generated text. It runs only fixed argv
// commands (git, allowlisted checks, the Claude CLI with a fixed permission set).
// Codex is not part of this path; scripts/codex-review.ps1 stays for manual use.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClaudePrompt, runClaudeTask } from "./claude-adapter.mjs";
import { ConfigError, ManagerApiError, readManagerConfig, requestDecision, requireApiKey, validateDecision } from "./openai-manager.mjs";
import { runIndependentReview } from "./openai-reviewer.mjs";
import { containsLikelySecret, isSecretPath, redact, redactDeep } from "./redact.mjs";
import {
  branchExists,
  buildRepoContext,
  changedPaths,
  diffCheckAll,
  fingerprint,
  git,
  gitInternalsDigest,
  remoteHeads,
  repoRoot,
  runProcess,
  snapshot,
} from "./repo.mjs";
import { CHECKS, isAutomationBranch, isProtectedBranch, planChecks, protectedPathHits, screenDecision, stripSensitiveEnv } from "./safety.mjs";
import { createStateStore } from "./state.mjs";

export const MANAGER_HOME = dirname(fileURLToPath(import.meta.url));
// At most 3 independent review cycles per task, then a person decides.
export const MAX_REVIEW_CYCLES = 3;
export const DEFAULT_GOAL = "Continue CarCode AI development: choose the next small, safe, documented step and see it through review.";
// Checks run for every implement task when the repository can run them; results go to the reviewer.
export const DEFAULT_CHECKS = ["typecheck", "unit-tests", "lint"];
const MODES = ["dry-run", "once", "autonomous", "status", "clear-state"];
// Phases in which a task is waiting for a person; the manager will not send it back to Claude.
const HUMAN_PHASES = ["review_limit", "review_blocked"];

// Exit codes: 0 finished/stopped normally, 2 needs a human, 3 blocked (resumable), 1 error.
const STOP_EXIT = {
  dry_run: 0,
  once_complete: 0,
  task_limit: 0,
  manager_stop: 0,
  require_human: 2,
  retry_limit: 2,
  malformed_decision: 2,
  decision_cap: 2,
  review_blocked: 3,
  manager_api_unavailable: 3,
  push_failed: 3,
};

export function readLimits(env = process.env) {
  const int = (name, def, max) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new ConfigError(`${name} must be an integer between 1 and ${max}.`);
    return n;
  };
  // Automatic push is OFF unless explicitly enabled: unset or "0" = no push, "1" = push allowed
  // (verified, independently reviewed work on non-protected automation branches only).
  const pushRaw = env.CARCODE_MANAGER_PUSH ?? "";
  if (!["", "0", "1"].includes(pushRaw)) throw new ConfigError("CARCODE_MANAGER_PUSH must be unset, 0 (no push) or 1 (push allowed).");
  return {
    maxTasks: int("CARCODE_MANAGER_MAX_TASKS", 3, 20),
    maxRetries: int("CARCODE_MANAGER_MAX_RETRIES", 2, 10),
    claudeTimeoutMs: int("CARCODE_MANAGER_CLAUDE_TIMEOUT_MIN", 90, 600) * 60_000,
    push: pushRaw === "1",
  };
}

export function parseArgs(argv) {
  const opts = { repo: process.cwd(), goal: null, mode: "once", resume: false, readOnly: false, allowPush: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new ConfigError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--repo") opts.repo = next();
    else if (a === "--goal") opts.goal = next();
    else if (a === "--goal-b64") opts.goal = Buffer.from(next(), "base64").toString("utf8");
    else if (a === "--mode") {
      opts.mode = next();
      if (!MODES.includes(opts.mode)) throw new ConfigError(`unknown mode ${opts.mode}`);
    } else if (a === "--resume") opts.resume = true;
    else if (a === "--read-only") opts.readOnly = true;
    else if (a === "--allow-push") opts.allowPush = true;
    else throw new ConfigError(`unknown argument ${a}`);
  }
  if (opts.goal !== null && (opts.goal.length > 4_000 || !opts.goal.trim())) throw new ConfigError("The goal must be 1-4000 characters.");
  return opts;
}

function shortId(now) {
  return `t-${now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
}

function commitMessage(task, review, checks) {
  const clean = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  let subject = clean(task.summary).split("\n")[0].trim();
  if (!subject) subject = `Manager task ${task.id}`;
  if (subject.length > 72) subject = `${subject.slice(0, 69)}...`;
  return [
    subject,
    "",
    `CarCode manager task ${task.id} (${task.mode}).`,
    clean(task.originalTask ?? task.task).slice(0, 600),
    "",
    `Independent review: clean (cycle ${review.cycle} of at most ${MAX_REVIEW_CYCLES}, model ${clean(review.model)}).`,
    `Harness checks: ${checks.map((c) => `${c.id} ${c.status}`).join(", ") || "none"}.`,
    "",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
  ].join("\n");
}

function checkAvailable(repo, id) {
  const spec = CHECKS[id];
  return Boolean(spec) && (!spec.needs || existsSync(join(repo, spec.needs)));
}

async function defaultRunCheck(repo, id, env) {
  if (id === "diff-check") return diffCheckAll(repo);
  const spec = CHECKS[id];
  if (!spec) return { id, status: "unavailable", output: "not an allowlisted check" };
  if (!checkAvailable(repo, id)) return { id, status: "unavailable", output: `${spec.needs} is missing` };
  const r = await runProcess(spec.cmd, spec.args, { cwd: repo, env: stripSensitiveEnv(env), timeoutMs: spec.timeoutMs });
  return { id, status: r.code === 0 ? "passed" : "failed", output: redact(`${r.stdout}\n${r.stderr}`).slice(-2_000) };
}

/** Why the saved task no longer matches the real repository, or null. */
export function reconcileTask(task, snap) {
  if (!task) return null;
  if (snap.branch !== task.branch) {
    return `The repository is on "${snap.branch || "(detached)"}" but saved task ${task.id} belongs to "${task.branch}". The manager will not switch branches.`;
  }
  const allowed = [task.startHead, task.commit].filter(Boolean);
  if (!allowed.includes(snap.head)) {
    return `HEAD moved since saved task ${task.id} (expected ${allowed.join(" or ")}, found ${snap.head}). Git is authoritative: inspect it, then use -ClearState if the task is obsolete.`;
  }
  if ((task.phase === "committed" || task.phase === "pushing") && (!task.commit || snap.head !== task.commit)) {
    return `Saved task ${task.id} recorded commit ${task.commit ?? "(none)"} but HEAD is ${snap.head}.`;
  }
  if (task.phase === "creating_branch") return `Task ${task.id} was interrupted while creating branch ${task.branch}; check the branch manually.`;
  return null;
}

function summarizeClaude(result) {
  if (!result) return null;
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    errors: result.errors,
    report: result.report,
    envelope: result.envelope,
    resultText: result.resultText?.slice(0, 3_000) ?? "",
  };
}

function fixInstruction(task) {
  return [
    "Address the independent review findings listed below for this task.",
    "Fix each valid finding in the code and tests, then re-run the affected tests.",
    "If you are confident a finding is wrong, do not change code for it; explain why in blockers.",
    "",
    `Original task: ${task.originalTask ?? task.task}`,
  ].join("\n");
}

export async function runManager(opts, deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((m) => console.log(`[manager] ${m}`));
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const runClaude = deps.runClaude ?? runClaudeTask;
  const runCheck = deps.runCheck ?? defaultRunCheck;
  const retry = deps.apiBackoffMs ? { backoffMs: deps.apiBackoffMs } : {};

  const repo = await repoRoot(opts.repo);
  const mode = opts.mode;
  const dryRun = mode === "dry-run";
  const limits = readLimits(env);
  if (opts.allowPush) limits.push = true;
  const maxTasks = mode === "once" ? 1 : limits.maxTasks;
  const store = createStateStore(repo, { env, now });

  if (mode === "clear-state") {
    const aside = store.clear();
    log(aside ? `Saved state moved aside to ${aside}. Git was not changed.` : "No saved state.");
    return { stopReason: "manager_stop", exitCode: 0 };
  }
  if (mode === "status") {
    const state = store.load();
    const snap = await snapshot(repo);
    const report = {
      repo,
      branch: snap.branch,
      head: snap.head,
      clean: snap.clean,
      stateFile: store.statePath,
      phase: state.activeTask?.phase ?? "idle",
      activeTask: state.activeTask,
      reviewCycles: state.activeTask?.reviews?.length ?? 0,
      lastReview: state.lastReview,
      stopReason: state.stopReason,
      pendingDecision: state.pendingDecision,
      reconcile: reconcileTask(state.activeTask, snap) ?? "ok",
    };
    log(JSON.stringify(report, null, 2));
    return { stopReason: "manager_stop", exitCode: 0, status: report };
  }

  const config = readManagerConfig(env);
  const apiKey = requireApiKey(config);
  const instructions = readFileSync(join(MANAGER_HOME, "prompts", "manager.md"), "utf8");
  const runId = `run-${now().toISOString().replace(/[-:.]/g, "")}`;
  const release = dryRun ? () => {} : store.acquireLock();

  const state = store.load();
  const persist = () => {
    if (!dryRun) store.save(state);
  };
  const history = (entry) => {
    state.history = [...(state.history ?? []), { at: now().toISOString(), ...entry }];
    if (!dryRun) store.appendHistory({ runId, ...entry });
  };
  const stop = (stopReason, message, extra = {}) => {
    state.stopReason = { reason: stopReason, message, at: now().toISOString() };
    if (extra.pendingDecision !== undefined) state.pendingDecision = extra.pendingDecision;
    persist();
    log(`STOP (${stopReason}): ${message}`);
    return { stopReason, message, exitCode: STOP_EXIT[stopReason] ?? 1, state, decisions, claudeRuns, reviewRuns, tasksCompleted };
  };

  const decisions = [];
  let claudeRuns = 0;
  let reviewRuns = 0;
  let tasksCompleted = 0;
  let tasksStarted = 0;

  try {
    const goal = opts.goal ?? state.goal ?? DEFAULT_GOAL;
    if (!dryRun) {
      state.goal = goal;
      state.pendingDecision = null;
      state.stopReason = null;
    }
    const snap0 = await snapshot(repo);

    if (state.activeTask) {
      if (!opts.resume && !dryRun) {
        return stop(
          "require_human",
          `Manager task ${state.activeTask.id} is unfinished (phase ${state.activeTask.phase}). Re-run with -Resume to continue it, or -ClearState to set the saved state aside (Git is not changed).`,
        );
      }
      const problem = reconcileTask(state.activeTask, snap0);
      if (problem) return stop("require_human", problem);
      // A read-only invocation must never commit or push a saved implement task.
      if (opts.readOnly && state.activeTask.mode !== "read_only") {
        return stop("require_human", `Saved task ${state.activeTask.id} is an implement task; a -ReadOnly run will not resume it. Use -Status to inspect it.`);
      }
      // A clean verdict is only valid for the exact tree that was reviewed.
      const t = state.activeTask;
      if (t.mode === "implement" && ["verified", "awaiting_review", "reviewing"].includes(t.phase) && t.ownedFingerprint) {
        if ((await fingerprint(repo)) !== t.ownedFingerprint) {
          return stop("require_human", `The working tree changed outside the manager since task ${t.id} was last verified; any earlier review verdict is invalid.`);
        }
      }
      tasksStarted = 1;
      log(`Resuming task ${t.id} (phase ${t.phase}) on ${snap0.branch} @ ${snap0.head.slice(0, 7)}.`);
    } else if (opts.resume) {
      log("No saved task to resume; planning from the goal.");
    }

    const finishTask = (task, outcome) => {
      task.phase = "complete";
      history({ event: "task_complete", taskId: task.id, mode: task.mode, branch: task.branch, commit: task.commit ?? null, pushed: task.pushed ?? null, outcome });
      state.counters.tasksCompleted = (state.counters.tasksCompleted ?? 0) + 1;
      state.activeTask = null;
      state.verification = null;
      tasksCompleted++;
      persist();
      log(`Task ${task.id} complete${task.commit ? ` (commit ${task.commit.slice(0, 7)}${task.pushed === true ? ", pushed" : ""})` : ""}.`);
    };

    const pushTask = async (task) => {
      if (!limits.push) {
        task.pushed = "skipped (automatic push is off; enable with CARCODE_MANAGER_PUSH=1 or -AllowPush)";
        return true;
      }
      // Never auto-push main or any protected branch, whatever the configuration says.
      if (isProtectedBranch(task.branch)) return false;
      const remote = await git(repo, ["remote", "get-url", "origin"], { allowFailure: true });
      if (remote.code !== 0) {
        task.pushed = "skipped (no origin remote)";
        return true;
      }
      if (!isAutomationBranch(task.branch) || !/^[0-9a-f]{40}$/.test(task.commit ?? "")) return false;
      task.phase = "pushing";
      persist();
      // Push exactly the recorded commit, never whatever the branch points at now.
      const r = await git(repo, ["push", "--porcelain", "origin", `${task.commit}:refs/heads/${task.branch}`], { allowFailure: true, timeoutMs: 300_000 });
      if (r.code !== 0) {
        task.phase = "committed";
        persist();
        return false;
      }
      task.pushed = true;
      return true;
    };

    // Resume a task that was committed but not pushed: finish the push only.
    if (state.activeTask?.phase === "committed" || state.activeTask?.phase === "pushing") {
      const task = state.activeTask;
      if (dryRun) return stop("dry_run", `Would push ${task.branch} (commit ${task.commit}) and complete task ${task.id}.`);
      if (!(await pushTask(task))) return stop("push_failed", `Push of ${task.branch} failed; the commit is kept locally. Run again with -Resume.`);
      finishTask(task, "committed");
      if (tasksCompleted >= maxTasks) return stop(mode === "once" ? "once_complete" : "task_limit", "Task limit reached.");
    }

    // Resume a task whose independent review was interrupted or unavailable: review the same tree again.
    if (state.activeTask && ["awaiting_review", "reviewing"].includes(state.activeTask.phase)) {
      if (dryRun) return stop("dry_run", `Would re-run the independent review for task ${state.activeTask.id}.`);
      const halted = await reviewLoop(state.activeTask);
      if (halted) return halted;
    }

    const decisionCap = maxTasks * (limits.maxRetries + 3) + 2;

    for (;;) {
      if (decisions.length >= decisionCap) return stop("decision_cap", `Stopped after ${decisions.length} manager decisions in one run.`);
      const task = state.activeTask;

      const repoContext = await buildRepoContext(repo);
      const { agentsMd, claudeMd, ...repository } = repoContext;
      // Redact string values before serialising, so redaction can never corrupt the JSON.
      const input = JSON.stringify(
        redactDeep(
          {
            goal,
            runMode: opts.readOnly ? "read_only" : mode,
            limits: { maxTasks, maxRetries: limits.maxRetries, maxReviewCycles: MAX_REVIEW_CYCLES, tasksStartedThisRun: tasksStarted, tasksCompletedThisRun: tasksCompleted },
            repository,
            agentsMd,
            claudeMd,
            manager: {
              activeTask: task,
              lastClaudeResult: task ? state.lastClaudeResult : null,
              verification: task ? state.verification : null,
              lastReview: task ? state.lastReview : null,
              recentHistory: (state.history ?? []).slice(-6),
            },
          },
          env,
        ),
      );

      let response;
      try {
        response = await requestDecision({ apiKey, model: config.model, instructions, input, fetchImpl, ...retry });
      } catch (error) {
        if (error instanceof ManagerApiError) return stop("manager_api_unavailable", `${error.message}. State saved; run again with -Resume.`);
        throw error;
      }
      const u = response.usage;
      log(`OpenAI manager ${config.model} usage: input ${u.input_tokens ?? "?"}, output ${u.output_tokens ?? "?"} (reasoning ${u.reasoning_tokens ?? "?"}), total ${u.total_tokens ?? "?"} tokens.`);

      const checked = validateDecision(response.raw);
      decisions.push(checked.ok ? checked.decision : { invalid: checked.errors });
      if (!dryRun) {
        store.writeRunFile(runId, `decision-${decisions.length}.json`, { model: config.model, inputChars: input.length, input, raw: response.raw, validation: checked, usage: u });
      }
      if (!checked.ok) return stop("malformed_decision", `Manager response rejected (fail closed): ${checked.errors.join("; ")}`);
      const d = checked.decision;
      history({ event: "decision", decision: d.decision, mode: d.mode, summary: d.summary, taskId: task?.id ?? null, usage: u });
      log(`Decision: ${d.decision} [${d.mode}] ${d.summary}`);

      if (d.decision === "stop") return stop("manager_stop", d.reason || d.summary);
      if (d.decision === "require_human") return stop("require_human", d.approval_reason, { pendingDecision: d });

      if (d.decision === "task_complete") {
        if (!task) return stop("manager_stop", `Manager reports nothing left to do: ${d.reason || d.summary}`);
        if (task.phase !== "verified") {
          return stop("require_human", `Manager judged task ${task.id} complete, but harness verification and independent review have not passed (phase ${task.phase}).`, { pendingDecision: d });
        }
        if (dryRun) return stop("dry_run", `Would complete task ${task.id}${task.mode === "implement" ? " and commit it" : ""}.`);
        if (task.mode === "implement" && !state.verification?.noChanges) {
          const committed = await commitTask(task);
          if (committed.stop) return stop(committed.stop, committed.message);
          if (!(await pushTask(task))) return stop("push_failed", `Push of ${task.branch} failed; commit ${task.commit} is kept locally. Run again with -Resume.`);
        }
        finishTask(task, d.summary);
        if (tasksCompleted >= maxTasks) return stop(mode === "once" ? "once_complete" : "task_limit", `Completed ${tasksCompleted} task(s); limit for this run reached.`);
        continue;
      }

      // assign_task / continue_task
      const isNew = d.decision === "assign_task";
      if (isNew && task) return stop("require_human", `Manager tried to start a new task while task ${task.id} is unfinished.`, { pendingDecision: d });
      if (!isNew && !task) return stop("require_human", "Manager asked to continue a task, but no task is active.", { pendingDecision: d });
      if (opts.readOnly && d.mode !== "read_only") return stop("require_human", "This run is read-only but the manager requested an implement task.", { pendingDecision: d });
      if (!isNew && d.mode !== task.mode) return stop("require_human", `Manager changed task ${task.id} from ${task.mode} to ${d.mode}.`, { pendingDecision: d });

      const screen = screenDecision(d, { readOnly: d.mode === "read_only" });
      if (!screen.allowed) {
        return stop("require_human", `Safety gate: ${screen.hits.map((h) => `${h.label} ("${h.match}")`).join("; ")}.`, { pendingDecision: { ...d, gates: screen.hits } });
      }
      if (isNew && tasksStarted >= maxTasks) return stop("task_limit", `Task limit (${maxTasks}) reached for this run.`);
      // Resuming after an interruption is not a fix attempt.
      const isRetry = !isNew && !["starting", "claude_running", "awaiting_review", "reviewing"].includes(task.phase);
      if (isRetry && (task.attempts ?? 0) + 1 > limits.maxRetries) {
        return stop("retry_limit", `Task ${task.id} reached the retry limit (${limits.maxRetries}). Work is preserved uncommitted.`);
      }
      if (!isNew && (HUMAN_PHASES.includes(task.phase) || state.verification?.protectedPaths?.length || state.verification?.claudeNeedsHuman)) {
        return stop("require_human", `Task ${task.id} is waiting for a person (phase ${task.phase}); the manager will not send it back to Claude.`);
      }

      const checks = planChecks(d.required_checks);
      const snap = await snapshot(repo);
      let targetBranch = snap.branch;
      let createBranch = false;

      if (isNew) {
        if (d.mode === "implement") {
          if (!snap.clean) {
            return stop("require_human", "The working tree has uncommitted changes the manager did not create. A person must commit, adopt, or set them aside before implement work.", { pendingDecision: d });
          }
          targetBranch = d.branch ?? snap.branch;
          if (!isAutomationBranch(targetBranch)) {
            return stop("require_human", `Branch "${targetBranch}" is not an allowed automation branch (research/, feature/, fix/, chore/, docs/, test/; never protected).`, { pendingDecision: d });
          }
          if (targetBranch !== snap.branch) {
            const exists = await branchExists(repo, targetBranch);
            if (exists.local || exists.remote) return stop("require_human", `Branch ${targetBranch} already exists; the manager will not reuse it automatically.`, { pendingDecision: d });
            createBranch = true;
          }
        } else if (d.branch && d.branch !== snap.branch) {
          log(`Ignoring branch "${d.branch}" for a read-only task; read-only tasks never switch branches.`);
        }
      } else {
        const problem = reconcileTask(task, snap);
        if (problem) return stop("require_human", problem);
        if (task.mode === "implement" && !snap.clean && task.ownedFingerprint && (await fingerprint(repo)) !== task.ownedFingerprint) {
          return stop("require_human", `The working tree changed outside the manager since Claude's last run on task ${task.id}.`);
        }
      }

      if (dryRun) {
        const plan = {
          decision: d.decision,
          mode: d.mode,
          branch: createBranch ? `create ${targetBranch} from ${snap.branch}` : targetBranch,
          harnessChecks: checks.run,
          textOnlyChecks: checks.textOnly,
          claude: `would run \`claude -p\` headless with the fixed ${d.mode} permission set (not invoked in dry-run)`,
          review: d.mode === "implement" ? `independent OpenAI review with ${config.reviewModel} in a fresh request, up to ${MAX_REVIEW_CYCLES} cycles` : "none (read-only)",
          task: d.task,
        };
        log(`DRY RUN plan:\n${JSON.stringify(plan, null, 2)}`);
        return stop("dry_run", "Dry run: Claude and the reviewer were not invoked and Git was not changed.");
      }

      let current = task;
      if (isNew) {
        tasksStarted++;
        current = {
          id: shortId(now()),
          mode: d.mode,
          summary: d.summary,
          task: d.task,
          originalTask: d.task,
          branch: targetBranch,
          baseBranch: snap.branch,
          startHead: snap.head,
          startedAt: now().toISOString(),
          attempts: 0,
          phase: "starting",
          checks: checks.run,
          reviews: [],
          pendingFixes: [],
          ownedFingerprint: null,
          commit: null,
        };
        state.activeTask = current;
        state.lastReview = null;
        history({ event: "task_assigned", taskId: current.id, mode: current.mode, branch: current.branch, summary: current.summary });
        persist();
        if (createBranch) {
          current.phase = "creating_branch";
          persist();
          await git(repo, ["switch", "-c", targetBranch]);
          current.createdBranch = true;
          current.phase = "starting";
          persist();
          log(`Created branch ${targetBranch} from ${snap.branch} @ ${snap.head.slice(0, 7)}.`);
        }
      } else {
        if (isRetry) current.attempts = (current.attempts ?? 0) + 1;
        current.task = d.task;
        current.checks = [...new Set([...(current.checks ?? []), ...checks.run])];
      }

      const notes = isNew
        ? ""
        : JSON.stringify({
            attempt: current.attempts,
            reviewCyclesUsed: current.reviews?.length ?? 0,
            reviewCyclesAllowed: MAX_REVIEW_CYCLES,
            previousReport: state.lastClaudeResult?.report ?? null,
            harnessVerification: state.verification ?? null,
          });
      const halted = await claudeStep(current, d.task, { textChecks: checks.textOnly, context: notes });
      if (halted) return halted;
      if (current.phase === "awaiting_review") {
        const stopped = await reviewLoop(current);
        if (stopped) return stopped;
      }
      // Loop: the manager model interprets the result next.
    }
  } finally {
    release();
  }

  /** One Claude run plus deterministic verification. Returns a stop result, or null to carry on. */
  async function claudeStep(task, instruction, { textChecks = [], context = "", findings = null } = {}) {
    task.phase = "claude_running";
    task.claudeStartedAt = now().toISOString();
    persist();
    const before = await fingerprint(repo);
    const remoteBefore = await remoteHeads(repo);
    const internalsBefore = await gitInternalsDigest(repo);
    const prompt = buildClaudePrompt({
      taskId: task.id,
      mode: task.mode,
      task: instruction,
      branch: task.branch,
      harnessChecks: task.checks,
      textChecks,
      context,
      findings,
    });
    log(`Running Claude Code (${task.mode}) for task ${task.id}${findings ? ` to address ${findings.length} review finding(s)` : task.attempts ? `, fix attempt ${task.attempts}` : ""}...`);
    claudeRuns++;
    const result = await runClaude({ repo, mode: task.mode, prompt, env, timeoutMs: limits.claudeTimeoutMs, extraEnv: { CARCODE_MANAGER_TASK_ID: task.id } });
    store.writeRunFile(runId, `claude-${claudeRuns}.json`, result);
    state.lastClaudeResult = summarizeClaude(result);
    if (result.envelope) {
      log(`Claude finished: ${result.ok ? "ok" : "not ok"}, turns ${result.envelope.num_turns ?? "?"}, cost-equivalent $${result.envelope.total_cost_usd ?? "?"}.`);
    } else {
      log(`Claude did not return a result: ${result.errors.join("; ")}`);
    }

    const verification = await verifyTask(task, result, before, remoteBefore, internalsBefore);
    state.verification = verification;
    task.phase = verification.passed ? (task.mode === "implement" && !verification.noChanges ? "awaiting_review" : "verified") : "verification_failed";
    if (task.mode === "implement") task.ownedFingerprint = await fingerprint(repo);
    history({ event: "verification", taskId: task.id, passed: verification.passed, reasons: verification.reasons });
    persist();
    log(`Verification ${verification.passed ? "passed" : `failed: ${verification.reasons.join("; ")}`}`);

    if (verification.headMoved || verification.branchChanged || verification.remoteChanged || verification.gitInternalsChanged) {
      return stop("require_human", `Claude changed Git state during task ${task.id} (${verification.reasons.join("; ")}). The manager will not continue automatically.`);
    }
    if (task.mode === "read_only" && !verification.treeUnchanged) {
      return stop("require_human", `Read-only task ${task.id} changed the working tree. Inspect the changes; nothing was committed.`);
    }
    if (verification.protectedPaths?.length) {
      return stop(
        "require_human",
        `Task ${task.id} changed protected paths (${verification.protectedPaths.map((h) => `${h.path}: ${h.label}`).join("; ")}). A person must review and commit these; the manager will not.`,
      );
    }
    if (verification.claudeNeedsHuman) {
      const blockers = (result.report?.blockers ?? []).join("; ");
      return stop("require_human", `Claude asked for a person on task ${task.id}${blockers ? `: ${blockers}` : ` (status ${result.report?.status})`}. Work is preserved uncommitted.`);
    }
    return null;
  }

  /**
   * Independent review / fix loop for a verified implement change. Each cycle is a
   * fresh OpenAI review of the real diff; findings go back to Claude, the change is
   * re-verified and reviewed again. Returns a stop result, or null to carry on
   * (clean, or a fix that failed verification and goes back to the manager model).
   */
  async function reviewLoop(task) {
    for (;;) {
      const done = task.reviews ?? [];
      const cycle = done.length + 1;
      if (cycle > MAX_REVIEW_CYCLES) {
        task.phase = "review_limit";
        persist();
        return stop("require_human", `Task ${task.id} used all ${MAX_REVIEW_CYCLES} independent review cycles without a clean verdict. A person decides; work is preserved uncommitted.`);
      }
      task.phase = "reviewing";
      persist();
      log(`Independent review, cycle ${cycle}/${MAX_REVIEW_CYCLES}, with ${config.reviewModel} (fresh request)...`);
      reviewRuns++;
      const r = await runIndependentReview({
        repo,
        task,
        checks: state.verification?.checks ?? [],
        previousFindings: done.at(-1)?.findings ?? [],
        apiKey,
        model: config.reviewModel,
        fetchImpl,
        env,
        ...retry,
      });
      store.writeRunFile(runId, `review-${reviewRuns}.json`, r);
      if (r.usage) log(`OpenAI reviewer ${config.reviewModel} usage: input ${r.usage.input_tokens ?? "?"}, output ${r.usage.output_tokens ?? "?"}, total ${r.usage.total_tokens ?? "?"} tokens.`);
      const record = {
        cycle,
        model: r.model,
        verdict: r.status,
        summary: r.review?.summary ?? r.reason,
        findings: r.review?.findings ?? [],
        digest: r.digest,
        at: now().toISOString(),
        responseId: r.responseId ?? null,
        usage: r.usage ?? null,
      };
      state.lastReview = record;

      if (r.status === "error" || r.status === "invalid") {
        task.phase = "awaiting_review";
        history({ event: "review", taskId: task.id, cycle, verdict: r.status, counted: false });
        persist();
        return stop("review_blocked", `Independent review unavailable for task ${task.id} (${r.reason}). This is NOT clean; the work is preserved uncommitted. Run again with -Resume.`);
      }
      if (r.status === "blocked") {
        task.phase = "review_blocked";
        history({ event: "review", taskId: task.id, cycle, verdict: "blocked", counted: false });
        persist();
        return stop("require_human", `The independent reviewer blocked task ${task.id}: ${record.summary}. Work is preserved uncommitted.`);
      }

      task.reviews = [...done, record];
      history({ event: "review", taskId: task.id, cycle, verdict: r.status, findings: record.findings.length, model: r.model });
      log(`Independent review cycle ${cycle}: ${r.status}${record.findings.length ? ` (${record.findings.length} finding(s))` : ""}.`);
      if (r.status === "clean") {
        task.phase = "verified";
        task.reviewedDigest = r.digest;
        task.pendingFixes = [];
        persist();
        return null;
      }

      // findings
      if (cycle >= MAX_REVIEW_CYCLES) {
        task.phase = "review_limit";
        task.pendingFixes = record.findings;
        persist();
        return stop("require_human", `Independent review still reports findings after ${MAX_REVIEW_CYCLES} cycles on task ${task.id}. A person decides; work is preserved uncommitted.`);
      }
      task.pendingFixes = record.findings;
      persist();
      const halted = await claudeStep(task, fixInstruction(task), { findings: record.findings });
      if (halted) return halted;
      if (task.phase !== "awaiting_review") return null; // fix failed verification (or removed every change)
    }
  }

  async function verifyTask(task, result, before, remoteBefore, internalsBefore) {
    const reasons = [];
    const out = {
      passed: false,
      reasons,
      checks: [],
      treeUnchanged: null,
      headMoved: false,
      branchChanged: false,
      remoteChanged: false,
      gitInternalsChanged: false,
      protectedPaths: [],
      claudeNeedsHuman: false,
      noChanges: false,
    };
    const snap = await snapshot(repo);
    // Allowed test runners can execute code, so a push is detected rather than assumed impossible.
    const remoteAfter = await remoteHeads(repo);
    if (remoteBefore?.ok && remoteAfter.ok && remoteBefore.digest !== remoteAfter.digest) {
      out.remoteChanged = true;
      reasons.push("branches on origin changed during the Claude run");
    }
    // Hooks/config run code at commit time and are outside the tree fingerprint.
    if (internalsBefore && internalsBefore !== (await gitInternalsDigest(repo))) {
      out.gitInternalsChanged = true;
      reasons.push("Git hooks or config changed during the Claude run");
    }
    if (snap.branch !== task.branch) {
      out.branchChanged = true;
      reasons.push(`branch is now ${snap.branch || "(detached)"}`);
    }
    if (snap.head !== task.startHead) {
      out.headMoved = true;
      reasons.push(`HEAD moved to ${snap.head.slice(0, 7)}`);
    }
    const after = await fingerprint(repo);
    out.treeUnchanged = after === before;
    if (!result.ok) reasons.push(`Claude run not ok: ${result.errors.join("; ")}`);
    const report = result.report;
    if (report?.status && report.status !== "done") reasons.push(`Claude reported ${report.status}`);
    if (report?.needs_human) reasons.push("Claude reported needs_human");
    // An explicit request for a person (or a blocked task) stops the run; it is not a retryable failure.
    out.claudeNeedsHuman = Boolean(report?.needs_human || report?.status === "blocked");
    const failedTests = (report?.tests ?? []).filter((t) => t.result === "failed").map((t) => t.command);
    if (failedTests.length) reasons.push(`Claude reported failing tests: ${failedTests.join(", ")}`);

    if (task.mode === "read_only") {
      if (!out.treeUnchanged) reasons.push("read-only task changed the working tree");
      out.passed = reasons.length === 0;
      return out;
    }

    out.noChanges = snap.clean && !out.headMoved;
    out.protectedPaths = protectedPathHits(await changedPaths(repo));
    if (out.protectedPaths.length) reasons.push(`protected paths changed: ${out.protectedPaths.map((h) => h.path).join(", ")}`);

    if (reasons.length === 0 && !out.noChanges) {
      const required = task.checks ?? ["diff-check"];
      for (const id of required) {
        const c = await runCheck(repo, id, env);
        out.checks.push({ ...c, required: true });
        if (c.status !== "passed") reasons.push(`check ${id} ${c.status}`);
      }
      // Best-effort defaults: run when this repository can run them; a failure still fails verification.
      for (const id of DEFAULT_CHECKS) {
        if (required.includes(id) || !checkAvailable(repo, id)) continue;
        const c = await runCheck(repo, id, env);
        out.checks.push({ ...c, required: false });
        if (c.status === "failed") reasons.push(`check ${id} failed`);
      }
    }
    out.passed = reasons.length === 0;
    return out;
  }

  async function commitTask(task) {
    const snap = await snapshot(repo);
    if (snap.branch !== task.branch || snap.head !== task.startHead || !isAutomationBranch(task.branch)) {
      return { stop: "require_human", message: `Refusing to commit: branch/HEAD no longer match task ${task.id}.` };
    }
    // Only an independent clean verdict for this exact tree may be committed.
    const review = task.reviews?.at(-1);
    if (!review || review.verdict !== "clean") return { stop: "require_human", message: `Refusing to commit task ${task.id}: there is no clean independent review.` };
    if ((task.reviews?.length ?? 0) > MAX_REVIEW_CYCLES) return { stop: "require_human", message: `Refusing to commit task ${task.id}: review-cycle limit exceeded.` };
    if ((await fingerprint(repo)) !== review.digest) {
      task.phase = "awaiting_review";
      persist();
      return { stop: "require_human", message: `Refusing to commit task ${task.id}: the change differs from what the independent reviewer approved, so that clean verdict is invalid.` };
    }
    const guarded = protectedPathHits(await changedPaths(repo));
    if (guarded.length) return { stop: "require_human", message: `Refusing to commit protected paths: ${guarded.map((h) => h.path).join(", ")}.` };

    task.phase = "committing";
    persist();
    const unstage = async (message) => {
      await git(repo, ["reset", "-q"], { allowFailure: true });
      task.phase = "verification_failed";
      persist();
      return { stop: "require_human", message };
    };
    await git(repo, ["add", "-A"]);
    const names = (await git(repo, ["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean);
    const secretFiles = names.filter(isSecretPath);
    if (secretFiles.length) return unstage(`Refusing to commit secret-looking files: ${secretFiles.join(", ")}.`);
    const staged = (await git(repo, ["diff", "--cached", "--no-color", "--no-ext-diff"], { timeoutMs: 300_000 })).stdout;
    if (containsLikelySecret(staged, env)) return unstage("Refusing to commit: the staged diff contains something that looks like a credential.");
    const check = await git(repo, ["diff", "--cached", "--check"], { allowFailure: true });
    if (check.code !== 0) return unstage("Refusing to commit: git diff --check failed on the staged changes.");

    const commit = await git(repo, ["commit", "-q", "-F", "-"], { input: commitMessage(task, review, state.verification?.checks ?? []), allowFailure: true, timeoutMs: 600_000 });
    if (commit.code !== 0) return unstage(`git commit failed (exit ${commit.code}); changes were unstaged and kept: ${redact(commit.stderr).slice(0, 300)}`);
    task.commit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    task.phase = "committed";
    persist();
    log(`Committed ${task.commit.slice(0, 7)} on ${task.branch}.`);
    return {};
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const opts = parseArgs(argv);
    const result = await runManager(opts);
    return result.exitCode ?? 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[manager] ${error.message}`);
      return 2;
    }
    console.error(`[manager] ERROR: ${redact(error?.message ?? String(error))}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
