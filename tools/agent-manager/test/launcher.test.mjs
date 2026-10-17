// PowerShell launcher and review-script checks (Windows only).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeRepo } from "./helpers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const launcher = join(root, "scripts", "carcode-manager.ps1");
const review = join(root, "scripts", "codex-review.ps1");
const windows = process.platform === "win32";

function ps(args, env = process.env) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], { encoding: "utf8", env, timeout: 120_000 });
}

test("PowerShell scripts parse without syntax errors", { skip: !windows }, () => {
  for (const file of [launcher, review]) {
    const cmd = `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`;
    const r = ps(["-Command", cmd]);
    assert.equal(r.status, 0, `${file}: ${r.stdout}${r.stderr}`);
  }
});

test("launcher: -Status needs no API key; missing key fails safely; modes are exclusive", { skip: !windows }, () => {
  const fx = makeRepo();
  try {
    const env = { ...fx.env, OPENAI_API_KEY: "" };
    const status = ps(["-File", launcher, "-Status", "-Repo", fx.repo], env);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /"phase": "idle"/);

    const noKey = ps(["-File", launcher, "-DryRun", "-Goal", 'Plan "next" step', "-Repo", fx.repo], env);
    assert.equal(noKey.status, 2);
    assert.match(noKey.stderr, /OPENAI_API_KEY is not set/);

    const both = ps(["-File", launcher, "-Once", "-Autonomous", "-Repo", fx.repo], env);
    assert.notEqual(both.status, 0);
    assert.match(both.stderr + both.stdout, /at most one/);
  } finally {
    fx.cleanup();
  }
});
