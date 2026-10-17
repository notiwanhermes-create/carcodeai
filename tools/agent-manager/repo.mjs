// Git and process helpers. Every command is spawned with an argv array and
// shell:false; nothing here ever passes model-generated text to a shell.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isSecretPath } from "./redact.mjs";

const MAX_CAPTURE = 64 * 1024 * 1024;

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

/** Run a program (never through a shell). Resolves; does not throw on non-zero exit. */
export function runProcess(cmd, args, { cwd, env, input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolvePromise({ code: -1, stdout: "", stderr: String(error?.message ?? error), timedOut: false, spawnError: true });
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs)
      : null;
    child.stdout.on("data", (d) => {
      if (outBytes < MAX_CAPTURE) out.push(d);
      outBytes += d.length;
    });
    child.stderr.on("data", (d) => {
      if (errBytes < MAX_CAPTURE) err.push(d);
      errBytes += d.length;
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: -1, stdout: "", stderr: String(error?.message ?? error), timedOut, spawnError: true });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    });
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function gitEnv(env = process.env) {
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
}

/** Run git in a repository; throws on failure unless allowFailure. */
export async function git(repo, args, { allowFailure = false, input, timeoutMs = 120_000, env } = {}) {
  const r = await runProcess("git", ["-C", repo, ...args], { env: gitEnv(env), input, timeoutMs });
  if (r.code !== 0 && !allowFailure) {
    throw new Error(`git ${args[0]} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 500)}`);
  }
  return r;
}

export async function repoRoot(path) {
  const r = await runProcess("git", ["-C", path, "rev-parse", "--show-toplevel"], { env: gitEnv() });
  if (r.code !== 0) throw new Error(`Not a Git repository: ${path}`);
  return resolve(r.stdout.trim());
}

export async function snapshot(repo) {
  const branch = (await git(repo, ["branch", "--show-current"])).stdout.trim();
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const status = (await git(repo, ["status", "--porcelain=v1"])).stdout.split("\n").filter(Boolean);
  return { repo, branch, head, status, clean: status.length === 0 };
}

/**
 * Content fingerprint of the working tree relative to HEAD: HEAD, the full
 * tracked diff, and the path + blob hash of every untracked (non-ignored) file.
 * codex-review.ps1 records this so the manager can prove the reviewed diff is
 * exactly the diff it is about to commit.
 */
export async function fingerprint(repo) {
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const diff = (await git(repo, ["diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--no-renames"], { timeoutMs: 300_000 })).stdout;
  const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout
    .split("\0")
    .filter(Boolean)
    .sort();
  let hashes = [];
  if (untracked.length) {
    const r = await git(repo, ["hash-object", "--stdin-paths"], { input: untracked.join("\n") + "\n", timeoutMs: 300_000 });
    hashes = r.stdout.split("\n").filter(Boolean);
  }
  const h = createHash("sha256");
  h.update(`head\0${head}\0diff\0`);
  h.update(diff);
  h.update("\0untracked\0");
  untracked.forEach((p, i) => h.update(`${p}\0${hashes[i] ?? ""}\0`));
  return h.digest("hex");
}

/**
 * Run fn(env) with a throwaway index that holds every working-tree change (tracked
 * and untracked, ignored files excluded). The real index is never touched.
 */
export async function withTempIndex(repo, fn) {
  const indexPath = resolve(repo, (await git(repo, ["rev-parse", "--git-path", "index"])).stdout.trim());
  const dir = mkdtempSync(join(tmpdir(), "carcode-mgr-index-"));
  const tmpIndex = join(dir, "index");
  try {
    if (existsSync(indexPath)) copyFileSync(indexPath, tmpIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    await git(repo, ["add", "-A"], { env });
    return await fn(env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** git diff --check over tracked AND untracked changes. */
export async function diffCheckAll(repo) {
  return withTempIndex(repo, async (env) => {
    const r = await git(repo, ["diff", "--cached", "--check"], { env, allowFailure: true });
    return { id: "diff-check", status: r.code === 0 ? "passed" : "failed", output: r.stdout.slice(0, 2_000) };
  });
}

/**
 * The complete change against `base` (new files included), for the independent
 * reviewer. Secret-looking paths are excluded and never read.
 */
export async function changeSet(repo, base, { unified = 15 } = {}) {
  return withTempIndex(repo, async (env) => {
    const scope = ["--", ".", ...EXCLUDE_SECRET_PATHS];
    const files = (await git(repo, ["diff", "--cached", "--name-status", "--no-renames", base, ...scope], { env })).stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split("\t");
        return { status, path: rest.join("\t") };
      });
    const diff = (await git(repo, ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-renames", `--unified=${unified}`, base, ...scope], { env, timeoutMs: 300_000 })).stdout;
    return { files, diff };
  });
}

/** Changed paths vs HEAD, including untracked files: [{ status, path }]. Renames report both sides. */
export async function changedPaths(repo) {
  const out = (await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])).stdout.split("\0");
  const entries = [];
  for (const item of out) {
    if (item.length < 4) continue;
    entries.push({ status: item.slice(0, 2), path: item.slice(3) });
  }
  return entries;
}

/**
 * Digest of Git internals that can run code or redirect Git (hooks, config, attributes) and that
 * the tree fingerprint does not cover. Compared before and after every Claude run.
 */
export async function gitInternalsDigest(repo) {
  const at = async (args) => resolve(repo, (await git(repo, args)).stdout.trim());
  const common = await at(["rev-parse", "--git-common-dir"]);
  const gitDir = await at(["rev-parse", "--git-dir"]);
  const hooksPath = (await git(repo, ["config", "--get", "core.hooksPath"], { allowFailure: true })).stdout.trim();
  const hooksDir = hooksPath ? resolve(repo, hooksPath) : join(common, "hooks");
  const h = createHash("sha256");
  h.update(`hooksPath\0${hooksPath}\0`);
  const addFile = (path) => {
    h.update(`${path}\0`);
    if (existsSync(path) && statSync(path).isFile()) h.update(readFileSync(path));
    h.update("\0");
  };
  for (const f of [join(common, "config"), join(gitDir, "config.worktree"), join(common, "info", "attributes"), join(common, "info", "exclude")]) addFile(f);
  if (existsSync(hooksDir) && statSync(hooksDir).isDirectory()) for (const name of readdirSync(hooksDir).sort()) addFile(join(hooksDir, name));
  return h.digest("hex");
}

/** Digest of origin's branch heads, to detect a push during a Claude run. ok:false when unknown. */
export async function remoteHeads(repo) {
  const remote = await git(repo, ["remote", "get-url", "origin"], { allowFailure: true });
  if (remote.code !== 0) return { ok: false, reason: "no origin remote" };
  const r = await git(repo, ["ls-remote", "--heads", "origin"], { allowFailure: true, timeoutMs: 60_000 });
  if (r.code !== 0) return { ok: false, reason: "ls-remote failed" };
  return { ok: true, digest: createHash("sha256").update(r.stdout).digest("hex") };
}

export async function branchExists(repo, branch) {
  const local = await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true });
  if (local.code === 0) return { local: true, remote: false };
  const remote = await git(repo, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], { allowFailure: true, timeoutMs: 60_000 });
  return { local: false, remote: remote.code === 0 && remote.stdout.trim().length > 0 };
}

// --- compact manager context ------------------------------------------------

const EXCLUDE_SECRET_PATHS = [
  ":(exclude,glob)**/.env*",
  ":(exclude,glob)**/*.pem",
  ":(exclude,glob)**/*.key",
  ":(exclude,glob)**/*.p12",
  ":(exclude,glob)**/*.pfx",
  ":(exclude,glob)**/.npmrc",
  ":(exclude,glob)**/credentials*",
];

function readCapped(path, max) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  return text.length > max ? `${text.slice(0, max)}\n[... truncated ${text.length - max} chars]` : text;
}

function cap(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n[... truncated ${text.length - max} chars]` : text;
}

/** Repository facts for the manager model. Never reads secret files. */
export async function buildRepoContext(repo, { maxDiffChars = 12_000 } = {}) {
  const snap = await snapshot(repo);
  const log = (await git(repo, ["log", "--oneline", "-15"])).stdout.trim();
  const diffStat = (await git(repo, ["diff", "HEAD", "--stat", "--", ".", ...EXCLUDE_SECRET_PATHS])).stdout.trim();
  const diff = (await git(repo, ["diff", "HEAD", "--no-color", "--no-ext-diff", "--", ".", ...EXCLUDE_SECRET_PATHS])).stdout;
  const docs = (await git(repo, ["ls-files", "--", "docs"])).stdout.split("\n").filter((p) => p.endsWith(".md"));
  const recentDocs = [
    ...new Set(
      (await git(repo, ["log", "-n", "10", "--name-only", "--format=", "--", "docs"])).stdout
        .split("\n")
        .filter((p) => p.endsWith(".md") && docs.includes(p)),
    ),
  ].slice(0, 2);
  let scripts = [];
  try {
    scripts = Object.keys(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts ?? {});
  } catch {
    scripts = [];
  }
  return {
    branch: snap.branch || "(detached)",
    head: snap.head,
    clean: snap.clean,
    status: snap.status.filter((l) => !isSecretPath(l.slice(3))).slice(0, 80),
    recentCommits: log,
    diffStat: cap(diffStat, 4_000),
    diff: cap(diff, maxDiffChars),
    agentsMd: readCapped(join(repo, "AGENTS.md"), 12_000),
    claudeMd: readCapped(join(repo, "CLAUDE.md"), 12_000),
    docsIndex: docs.slice(0, 80),
    recentDocExcerpts: recentDocs.map((p) => ({ path: p, excerpt: readCapped(join(repo, p), 2_500) })),
    packageScripts: scripts,
  };
}
