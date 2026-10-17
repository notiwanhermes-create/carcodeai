// Secret redaction for everything the manager sends to the OpenAI API, prints,
// or writes to runtime state. Redaction is best-effort pattern matching plus
// exact-value matching of secret-looking environment variables; the primary
// defence is never reading secret files (.env*, keys) in the first place.

// Token shapes that are almost never false positives.
const TOKEN_PATTERNS = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g, "[REDACTED_OPENAI_KEY]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED_GOOGLE_KEY]"],
  [/\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{6,}\b/g, "[REDACTED_RESEND_KEY]"],
  [/\bnpg_[A-Za-z0-9]{8,}\b/g, "[REDACTED_DB_PASSWORD]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]"],
  [/\b(Bearer|Basic)\s+(?!\[REDACTED)[A-Za-z0-9._~+/-]{12,}=*/gi, "$1 [REDACTED]"],
  // user:password@ inside any URL (postgres://, mysql://, https://, ...)
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/[\]]+:[^\s@/]+@/gi, "$1[REDACTED]@"],
];

// NAME=value / "name": "value" where the name looks secret. Broad on purpose,
// so it is used for redaction but not for the commit-blocking secret scan.
const ASSIGNMENT_PATTERN = [
  /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credential|database[_-]?url|auth[_-]?key)s?[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)(?!\[REDACTED)([^\s"'`,;)]{6,})/gi,
  "$1$2$3[REDACTED]",
];

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL|_URL_UNPOOLED|AUTH)/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact values of secret-looking environment variables, longest first. */
export function secretEnvValues(env = process.env) {
  const values = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && value.length >= 8 && SECRET_ENV_NAME.test(name)) {
      values.add(value);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function redactEnvValues(text, env) {
  let out = text;
  for (const value of secretEnvValues(env)) {
    out = out.replace(new RegExp(escapeRegExp(value), "g"), "[REDACTED_ENV_VALUE]");
  }
  return out;
}

export function redact(text, env = process.env) {
  if (text === null || text === undefined) return text;
  let out = redactEnvValues(String(text), env);
  for (const [re, replacement] of TOKEN_PATTERNS) out = out.replace(re, replacement);
  return out.replace(ASSIGNMENT_PATTERN[0], ASSIGNMENT_PATTERN[1]);
}

export function redactDeep(value, env = process.env) {
  if (typeof value === "string") return redact(value, env);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, env));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, env);
    return out;
  }
  return value;
}

/**
 * High-confidence secret scan (token shapes and live env secret values only).
 * Used to refuse automatic commits; deliberately ignores `token: string`-style
 * code so ordinary auth code does not block every commit.
 */
export function containsLikelySecret(text, env = process.env) {
  const original = String(text ?? "");
  let out = redactEnvValues(original, env);
  for (const [re, replacement] of TOKEN_PATTERNS) out = out.replace(re, replacement);
  return out !== original;
}

/** Paths that must never be read into manager context or committed automatically. */
const SECRET_PATH = /(^|[\\/])(\.env(\..*)?|[^\\/]*\.(pem|key|p12|pfx)|id_rsa[^\\/]*|id_ed25519[^\\/]*|credentials(\.[^\\/]*)?|\.npmrc|\.netrc)$/i;

export function isSecretPath(path) {
  return SECRET_PATH.test(path) && !/(^|[\\/])\.env\.example$/i.test(path);
}
