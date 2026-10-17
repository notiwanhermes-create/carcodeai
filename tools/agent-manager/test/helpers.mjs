// Shared fixtures: throwaway Git repositories, a fake OpenAI endpoint (manager and
// reviewer routed separately), and a fake Claude runner. Nothing here touches the
// real repository, the network, Claude, or Codex.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fake credentials are assembled at runtime so no token-shaped literal is committed
// (keeps secret scanners quiet on a public repository). None of these are real.
export const tok = (...parts) => parts.join("");
export const FAKE_KEY = tok("sk-", "proj-", "TESTKEY", "abcdefghijklmnopqrstuvwxyz0123456789");
export const FAKE_GH = tok("gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789");
export const FAKE_DB_PASSWORD = tok("np", "g_", "realpassword99");
export const fakeDbUrl = (password = "p") => tok("postgres", "ql://", "u:", password, "@db.example.invalid/db");
export const MANAGER_SCHEMA = "carcode_manager_decision";
export const REVIEW_SCHEMA_NAME = "carcode_independent_review";

export function gitSync(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function makeRepo({ branch = "research/base" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "carcode-mgr-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", branch, repo]);
  gitSync(repo, "config", "user.name", "Test");
  gitSync(repo, "config", "user.email", "test@example.invalid");
  gitSync(repo, "config", "core.autocrlf", "false");
  gitSync(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "AGENTS.md"), "# Agent rules\n\n- AI proposes, engine decides.\n");
  writeFileSync(join(repo, "CLAUDE.md"), "# Claude instructions\n");
  writeFileSync(join(repo, ".gitignore"), ".env*\n!.env.example\n");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "plan.md"), "# Plan\n\nNext: tests.\n");
  gitSync(repo, "add", "-A");
  gitSync(repo, "commit", "-q", "-m", "init");
  const stateDir = join(root, "state");
  const env = {
    ...process.env,
    OPENAI_API_KEY: FAKE_KEY,
    OPENAI_MANAGER_MODEL: "",
    OPENAI_REVIEW_MODEL: "",
    CARCODE_MANAGER_STATE_DIR: stateDir,
    CARCODE_MANAGER_PUSH: "",
    CARCODE_MANAGER_MAX_TASKS: "",
    CARCODE_MANAGER_MAX_RETRIES: "",
  };
  return { root, repo, stateDir, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function dec(overrides = {}) {
  return {
    decision: "assign_task",
    summary: "Inspect the repository",
    task: "Read AGENTS.md and report the rules.",
    reason: "Next step.",
    required_checks: [],
    approval_reason: null,
    mode: "read_only",
    branch: null,
    ...overrides,
  };
}

export function finding(overrides = {}) {
  return {
    severity: "medium",
    file: "a.md",
    location: "line 1",
    problem: "The change is missing a test.",
    reason: "AGENTS.md requires tests for changed behaviour.",
    required_fix: "Add a test covering the new behaviour.",
    ...overrides,
  };
}

/** A review result object. verdict "clean" has no findings; "findings" has at least one. */
export function rev(verdict = "clean", findings = verdict === "findings" ? [finding()] : []) {
  return { verdict, summary: verdict === "clean" ? "No actionable problems." : `Review verdict: ${verdict}.`, findings };
}

function okResponse(id, text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id,
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, output_tokens_details: { reasoning_tokens: 5 } },
    }),
  };
}

/**
 * Fake Responses API. Manager and reviewer requests are routed by their
 * json_schema name to separate queues. Each entry is an object (sent as JSON),
 * a raw string, { httpStatus } for an HTTP error, or a function (body) => entry.
 */
export function fakeOpenAI(managerSeq = [], reviewerSeq = []) {
  const calls = [];
  const queues = { [MANAGER_SCHEMA]: [...managerSeq], [REVIEW_SCHEMA_NAME]: [...reviewerSeq] };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const kind = body.text.format.name;
    calls.push({ url, init, body, kind });
    const queue = queues[kind];
    if (!queue) throw new Error(`fake OpenAI: unknown schema ${kind}`);
    if (!queue.length) throw new Error(`fake OpenAI: nothing queued for ${kind}`);
    let next = queue.shift();
    if (typeof next === "function") next = await next(body);
    if (next && typeof next === "object" && next.httpStatus) {
      return { ok: false, status: next.httpStatus, json: async () => ({ error: { code: next.code ?? "error" } }) };
    }
    return okResponse(`resp_${calls.length}`, typeof next === "string" ? next : JSON.stringify(next));
  };
  return {
    fetch,
    calls,
    managerCalls: () => calls.filter((c) => c.kind === MANAGER_SCHEMA),
    reviewCalls: () => calls.filter((c) => c.kind === REVIEW_SCHEMA_NAME),
    remaining: () => queues[MANAGER_SCHEMA].length,
    reviewsRemaining: () => queues[REVIEW_SCHEMA_NAME].length,
  };
}

export function report(overrides = {}) {
  return {
    status: "done",
    summary: "Done.",
    files_changed: [],
    tests: [],
    blockers: [],
    limitations: [],
    needs_human: false,
    ...overrides,
  };
}

export function claudeResult(rep = report(), extra = {}) {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    interrupted: false,
    errors: [],
    report: rep,
    envelope: { session_id: "s", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.01, usage: null, permission_denials: 0 },
    resultText: "",
    stderr: "",
    ...extra,
  };
}

/** Fake Claude runner. Each handler gets the call and returns a result (or throws). */
export function fakeClaude(handlers) {
  const calls = [];
  const queue = [...handlers];
  const run = async (call) => {
    calls.push(call);
    const h = queue.shift();
    if (!h) throw new Error("fake Claude: unexpected call");
    return h(call);
  };
  return { run, calls };
}

/** A Claude handler that writes files (path -> content) and reports done. */
export function writes(files, rep = report()) {
  return async ({ repo }) => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(repo, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    return claudeResult(rep);
  };
}

export const quietLog = () => {};
export const passCheck = async (_repo, id) => ({ id, status: "passed", output: "" });
