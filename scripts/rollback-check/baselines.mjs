/**
 * The releases a rollback can return to, and the harness that checks each one.
 *
 * Each release has its own harness, because it exercises that release's own
 * modules. A release that is not listed here is REFUSED: there is no fallback
 * to another release's harness, because that harness would check the wrong
 * code (a Phase 2D harness pointed at Phase 2E fails on 2E's extra tables, and
 * one that happened to pass would prove nothing).
 *
 * Adding a release: write `harness.<name>.mjs` for it, add it here with its
 * full commit id, and move DEFAULT_BASELINE when it reaches production.
 */

export const BASELINES = Object.freeze([
  Object.freeze({ name: "phase-2c", label: "Phase 2C", commit: "e79758c5e5b157d36d6b655d8f2a198f902e42d5", harness: "harness.phase-2c.mjs" }),
  Object.freeze({ name: "phase-2d", label: "Phase 2D", commit: "bdf96deb70dd24e22664dbd3d908f401f80b91cf", harness: "harness.phase-2d.mjs" }),
  Object.freeze({ name: "phase-2e", label: "Phase 2E", commit: "7bb5408581cecbf9060d764ff086a898a99aa7fe", harness: "harness.phase-2e.mjs" }),
]);

/** The release now in production (Phase 2E, `main` at 7bb5408): what a rollback returns to. */
export const DEFAULT_BASELINE = "phase-2e";

/**
 * True only for a connection URL that unambiguously points at THIS machine.
 * The authority host must be local AND there must be no `host`/`hostaddr` query
 * parameter: `pg` honours those and they can redirect the real connection away
 * from a local-looking authority, which would slip past a naive hostname check
 * and let this check's callers run a destructive DROP SCHEMA against another host.
 */
export function isLocalTestDbUrl(url) {
  let u;
  try {
    u = new URL(String(url ?? ""));
  } catch {
    return false;
  }
  // URL.hostname brackets IPv6 (e.g. "[::1]"); strip them so ::1 is recognised.
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) return false;
  return !u.searchParams.has("host") && !u.searchParams.has("hostaddr");
}

/**
 * Pick the baseline for the argument given on the command line: a baseline
 * name (`phase-2d`), or a git ref that resolves to a listed release commit
 * (`bdf96de`). No argument means DEFAULT_BASELINE.
 *
 * `resolveCommit(ref)` returns the full commit id the ref names in this copy of
 * the repository, or null when it names no commit here.
 *
 * Returns `{ ok: true, baseline }` or `{ ok: false, reason, message }`. It never
 * guesses: anything that is not exactly a listed release is refused.
 */
export function selectBaseline(arg, resolveCommit) {
  const supported = BASELINES.map((b) => `${b.name} (${b.commit.slice(0, 7)})`).join(", ");
  const wanted = arg === undefined || arg === null || arg === "" ? DEFAULT_BASELINE : String(arg).trim();

  if (!wanted || wanted.startsWith("-")) {
    return { ok: false, reason: "unsupported", message: `"${arg}" is not a release. Supported baselines: ${supported}.` };
  }

  const named = BASELINES.find((b) => b.name === wanted);
  const resolved = resolveCommit(named ? named.commit : wanted);
  if (!resolved) {
    return {
      ok: false,
      reason: "missing",
      message: `${named ? `${named.label} (${named.commit.slice(0, 7)})` : `"${wanted}"`} is not in this copy of the repository. Run "git fetch origin" and try again.`,
    };
  }

  const baseline = BASELINES.find((b) => b.commit === resolved);
  if (!baseline) {
    return {
      ok: false,
      reason: "unsupported",
      message: `"${wanted}" (${resolved.slice(0, 7)}) has no rollback harness. Supported baselines: ${supported}. No other release's harness is used in its place.`,
    };
  }
  return { ok: true, baseline };
}
