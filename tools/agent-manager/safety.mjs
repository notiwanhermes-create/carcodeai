// Deterministic safety gates. The OpenAI manager decides WHAT Claude should do;
// these rules decide whether the harness is allowed to act on it without a
// human. Everything here fails closed: a match means "stop and ask".

// Human-approval gates. The manager prompt tells the model not to restate
// prohibitions in task text (the harness adds them to every Claude prompt), so
// any mention of these actions is treated as a request to perform them.
export const APPROVAL_GATES = [
  {
    id: "merge",
    label: "merge or pull request",
    re: /\bgit merge\b|\bmerg\w*\b[^.\n]{0,40}\b(main|master|branch(es)?|PRs?|pull requests?)\b|\bpull[- ]requests?\b|\bopen (a )?PR\b|\bgh pr\b/i,
  },
  { id: "deploy", label: "deploy", re: /\bdeploy\w*\b|\bvercel\b|\brelease to\b|\bpromot\w* to\b/i },
  { id: "production", label: "production system or data", re: /\bproduction\b|\bprod\b|\blive (site|database|db|data)\b|\bneon\b/i },
  {
    id: "migration",
    label: "database migration against a real database",
    re: /\bmigrate (deploy|reset|resolve)\b|\bdb:migrate\b|\bdb push\b|\bapply\w* (the )?migrations?\b|\brun\w* (the )?migrations?\b|--accept-data-loss/i,
  },
  {
    id: "destructive_db",
    label: "destructive or shared database operation",
    re: /\b(drop|truncate)\s+(table|database|schema|column|index)\b|\bdelete\s+from\b|\bdb:prune\b|\bshared (database|db)\b|\bbackup-before-2d\b/i,
  },
  {
    id: "data_deletion",
    label: "deleting user or production data",
    re: /\b(delete|wipe|purge|erase|remove)\w*\b[^.\n]{0,40}\b(user|customer|account|production|real)\b[^.\n]{0,20}\b(data|records?|rows?)\b/i,
  },
  { id: "force_push", label: "force push", re: /\bforce[- ]?push\w*\b|\bpush\b[^\n]{0,40}(\s-f\b|--force)/i },
  {
    id: "history_rewrite",
    label: "rewriting Git history",
    re: /\brebas\w*\b|--amend\b|\bfilter-(branch|repo)\b|\breset --hard\b|\brewrit\w*\b[^.\n]{0,20}\bhistory\b|\bsquash\w*\b/i,
  },
  { id: "push_main", label: "pushing to main", re: /\bpush\w*\b[^.\n]{0,40}\b(main|master)\b/i },
  {
    id: "auth_security",
    label: "authentication or security policy",
    re: /\b(auth(entication|orization)?|security|cookie|csp|cors|content[- ]security[- ]policy)\b[^.\n]{0,30}\b(policy|policies|config\w*|settings?|rules?)\b|\bnext-?auth\b|\brate[- ]limit\w*\b/i,
  },
  {
    id: "paid_service",
    label: "paid third-party service or licensed data",
    re: /\b(paid|subscription|pricing plan|purchas\w*|buy|billing|licen[cs]ed? data|licen[cs]e (fee|purchase))\b/i,
  },
  { id: "public_api", label: "new public API", re: /\b(public|external)\s+(api|endpoint|route)s?\b|\bexpos\w*\b[^.\n]{0,30}\b(api|endpoint|route)s?\b|\bapp\/api\//i },
  {
    id: "secrets",
    label: "secrets or credentials",
    re: /\b(secrets?|credentials?|api[ _-]?keys?|access[ _-]?tokens?|passwords?|oauth (client|token)s?)\b|\.env\b/i,
  },
  { id: "publish", label: "publishing externally", re: /\bpublish\w*\b|\bnpm publish\b|\bpost\w* (to|on)\b|\btweet\b|\bannounce\w*\b/i },
  {
    id: "invariant",
    label: "abandoning an architecture or safety invariant",
    re: /\b(remove|weaken|relax|bypass|disable|abandon|drop|skip|ignore)\w*\b[^.\n]{0,40}\b(invariants?|safety|guards?|validation|validators?|review|codex|tests?|checks?|fail[- ]closed)\b/i,
  },
  { id: "dependency", label: "adding a production dependency", re: /\b(npm|pnpm|yarn) (install|add|i)\b|\bnew dependenc(y|ies)\b|\badd\w* (a |the )?dependenc(y|ies)\b/i },
];

// Gates about a TOPIC rather than an action. A read-only task may inspect and
// report on these subjects: its tools cannot change anything and the harness
// verifies the tree, HEAD and branch are untouched afterwards.
const TOPIC_GATES = new Set(["production", "auth_security", "secrets", "public_api", "invariant", "dependency"]);

export function screenText(text, { readOnly = false } = {}) {
  const hits = [];
  const value = String(text ?? "");
  for (const gate of APPROVAL_GATES) {
    if (readOnly && TOPIC_GATES.has(gate.id)) continue;
    const m = value.match(gate.re);
    if (m) hits.push({ id: gate.id, label: gate.label, match: m[0].slice(0, 80) });
  }
  return hits;
}

/** Screen every free-text field of a validated manager decision. */
export function screenDecision(decision, { readOnly = false } = {}) {
  const text = [decision.summary, decision.task, decision.reason, ...(decision.required_checks ?? [])].join("\n");
  const hits = screenText(text, { readOnly });
  if (decision.branch && isProtectedBranch(decision.branch)) {
    hits.push({ id: "protected_branch", label: "protected branch", match: decision.branch });
  }
  return { allowed: hits.length === 0, hits };
}

// --- protected paths --------------------------------------------------------
// Changes here are never committed automatically: they are the rules, the review
// machinery, dependencies, deploy/security configuration, existing migrations,
// or public API surface. A person reviews and commits them.

const PROTECTED_PATHS = [
  // Instruction files at ANY depth, including overrides that take precedence over the root files.
  { re: /(^|\/)(AGENTS(\.override)?|CLAUDE(\.local)?)\.md$/i, label: "agent rules" },
  { re: /^scripts\/(codex-review|carcode-manager)\.ps1$/i, label: "review/manager machinery" },
  { re: /^tools\/agent-manager\//i, label: "review/manager machinery" },
  { re: /(^|\/)\.(claude|codex)\//i, label: "agent configuration" },
  { re: /^\.(github|vscode)\//i, label: "CI/editor configuration" },
  { re: /^package(-lock)?\.json$|^\.npmrc$/i, label: "dependencies" },
  { re: /^(vercel\.json|next\.config\.[cm]?[jt]s|proxy\.[jt]s|middleware\.[jt]s|prisma\.config\.[jt]s)$/i, label: "deploy/security configuration" },
  { re: /^scripts\/(db-|rollback-check)/i, label: "database tooling" },
  { re: /^prisma\/schema\.prisma$/i, label: "database schema" },
  // Verification configuration: Claude could otherwise make the harness's own typecheck/tests/lint
  // pass trivially by editing the config they run under, so a person reviews and commits these.
  { re: /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?|\.eslintignore)$/i, label: "lint configuration" },
  { re: /(^|\/)tsconfig(\.[a-z0-9.-]+)?\.json$/i, label: "typescript configuration" },
  { re: /(^|\/)(vitest|vite|jest|playwright|cypress|karma|ava|mocha|webpack|rollup|babel|tsup|swc)\.config\.[cm]?[jt]s$/i, label: "test/build runner configuration" },
  { re: /(^|\/)(\.mocharc(\.[a-z]+)?|\.babelrc(\.[a-z]+)?|\.swcrc|jest\.setup\.[cm]?[jt]s)$/i, label: "test/build runner configuration" },
  // Git metadata that can redirect Git or blind the reviewer's diff (e.g. a `-diff`/binary attribute).
  { re: /(^|\/)\.gitattributes$/i, label: "git attributes (affect diff/review)" },
  { re: /(^|\/)(\.gitconfig|\.gitmodules)$/i, label: "git configuration" },
  // Installed dependencies and package-manager caches the harness trusts when it runs verification.
  { re: /(^|\/)(node_modules|\.pnp|\.yarn|\.pnpm-store|\.npm|\.turbo|\.cache)(\/|$)/i, label: "installed dependencies / verification tooling" },
];

/** Protected-path hits for [{status, path}] from `git status --porcelain`. */
export function protectedPathHits(changes = []) {
  const hits = [];
  for (const { status, path } of changes) {
    const p = String(path).replace(/\\/g, "/");
    const isNew = status === "??" || status.startsWith("A");
    const rule = PROTECTED_PATHS.find((r) => r.re.test(p));
    if (rule) hits.push({ path: p, label: rule.label });
    // Existing migrations must never be rewritten, and nothing checks a new one is additive, so a person reviews both.
    else if (/^prisma\/migrations\//i.test(p)) hits.push({ path: p, label: isNew ? "new migration (additive check needs a person)" : "existing migration (must not be rewritten)" });
    else if (/^app\/api\//i.test(p) && isNew) hits.push({ path: p, label: "new public API route" });
  }
  return hits;
}

// --- branches ---------------------------------------------------------------

const PROTECTED = /^(main|master|production|prod|staging|release|develop|backup-before-2d|gh-pages)$|^(release|hotfix|prod|production)\//i;
const ALLOWED_BRANCH = /^(research|feature|feat|fix|chore|docs|test)\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

export function isProtectedBranch(name) {
  return PROTECTED.test(String(name ?? "").replace(/^refs\/heads\//, ""));
}

/** Branches the manager may create, commit to, and push (never force). */
export function isAutomationBranch(name) {
  const b = String(name ?? "");
  return (
    b.length <= 100 &&
    ALLOWED_BRANCH.test(b) &&
    !isProtectedBranch(b) &&
    !b.includes("..") &&
    !b.endsWith(".lock") &&
    !b.endsWith(".")
  );
}

// --- verification checks ----------------------------------------------------
// The model may request checks by ID only. IDs map to fixed argv arrays here;
// anything else is passed to Claude as text and never executed by the harness.

export const CHECKS = {
  "diff-check": { cmd: "git", args: ["diff", "--check", "HEAD"], timeoutMs: 60_000 },
  typecheck: { cmd: "node", args: ["node_modules/typescript/bin/tsc", "--noEmit"], timeoutMs: 15 * 60_000, needs: "node_modules/typescript/bin/tsc" },
  "unit-tests": { cmd: "node", args: ["node_modules/vitest/vitest.mjs", "run"], timeoutMs: 30 * 60_000, needs: "node_modules/vitest/vitest.mjs" },
  lint: { cmd: "node", args: ["node_modules/eslint/bin/eslint.js"], timeoutMs: 15 * 60_000, needs: "node_modules/eslint/bin/eslint.js" },
  "manager-tests": { cmd: "node", args: ["--test", "tools/agent-manager/test/*.test.mjs"], timeoutMs: 10 * 60_000, needs: "tools/agent-manager/test" },
};

/** Split requested check names into executable allowlisted IDs and text-only ones. */
export function planChecks(requested = []) {
  const run = new Set(["diff-check"]);
  const textOnly = [];
  for (const raw of requested) {
    const id = String(raw).trim().toLowerCase();
    if (Object.hasOwn(CHECKS, id)) run.add(id);
    else textOnly.push(String(raw));
  }
  return { run: [...run], textOnly };
}

// Environment for harness-run checks and for Claude: anything that looks like a
// database connection or a credential is removed (by pattern, so aliases such as
// DATABASE_URL_UNPOOLED or *_CLIENT_SECRET are caught), so a local check can never
// reach a real database or service.
const SENSITIVE_ENV =
  /DATABASE|POSTGRES|_URL_UNPOOLED|SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|^PG[A-Z]+$|^NEON_|^VERCEL_|^AUTH_|^NEXTAUTH_|^OPENAI_|^RESEND_|^GH_|^GITHUB_/i;
// Claude's own sign-in, kept only for the Claude child process.
const CLAUDE_AUTH = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);

export function stripSensitiveEnv(env, { keepClaudeAuth = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (SENSITIVE_ENV.test(k) && !(keepClaudeAuth && CLAUDE_AUTH.has(k.toUpperCase()))) continue;
    out[k] = v;
  }
  return out;
}
