// OpenAI Responses API client shared by the manager and the independent reviewer
// (each call is a separate, stateless request: store:false, no previous_response_id),
// plus strict validation of the manager's decision. The key is read only from
// OPENAI_API_KEY, sent only in the Authorization header, and never printed, logged,
// stored or echoed in errors.

import { redact } from "./redact.mjs";

export const DEFAULT_MODEL = "gpt-6.1-sol";
const API_URL = "https://api.openai.com/v1/responses";

export const DECISIONS = ["assign_task", "continue_task", "task_complete", "require_human", "stop"];
export const TASK_MODES = ["read_only", "implement"];

export const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "summary", "task", "reason", "required_checks", "approval_reason", "mode", "branch"],
  properties: {
    decision: { type: "string", enum: DECISIONS },
    summary: { type: "string" },
    task: { type: "string" },
    reason: { type: "string" },
    required_checks: { type: "array", items: { type: "string" } },
    approval_reason: { type: ["string", "null"] },
    mode: { type: "string", enum: TASK_MODES },
    branch: { type: ["string", "null"] },
  },
};

const LIMITS = { summary: 2_000, task: 8_000, reason: 2_000, approval_reason: 1_000, branch: 100, check: 100, checks: 10 };

export class ConfigError extends Error {}
export class ManagerApiError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export const MISSING_KEY_MESSAGE = [
  "OPENAI_API_KEY is not set, so the OpenAI manager cannot run.",
  "Set it in YOUR local environment only (never in the repository, a chat, or a committed file).",
  "In PowerShell, type the key at a hidden prompt (it is not echoed or saved in command history):",
  "  $s = Read-Host 'OpenAI API key' -AsSecureString",
  "  [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)), 'User')",
  "Then open a NEW terminal so the variable is loaded.",
  "Optional: OPENAI_MANAGER_MODEL (default gpt-6.1-sol) and OPENAI_REVIEW_MODEL (default: the manager model).",
].join("\n");

const MODEL_NAME = /^[A-Za-z0-9._:-]{1,100}$/;

export function readManagerConfig(env = process.env) {
  const apiKey = env.OPENAI_API_KEY?.trim() || null;
  const model = env.OPENAI_MANAGER_MODEL?.trim() || DEFAULT_MODEL;
  const reviewModel = env.OPENAI_REVIEW_MODEL?.trim() || model;
  if (!MODEL_NAME.test(model)) throw new ConfigError("OPENAI_MANAGER_MODEL contains unexpected characters.");
  if (!MODEL_NAME.test(reviewModel)) throw new ConfigError("OPENAI_REVIEW_MODEL contains unexpected characters.");
  return { apiKey, model, reviewModel };
}

export function requireApiKey(config) {
  if (!config.apiKey) throw new ConfigError(MISSING_KEY_MESSAGE);
  return config.apiKey;
}

/** Strictly validate a decision (object or JSON string). Fails closed. */
export function validateDecision(raw) {
  const errors = [];
  let d = raw;
  if (typeof raw === "string") {
    try {
      d = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ["response is not valid JSON"] };
    }
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) return { ok: false, errors: ["response is not a JSON object"] };

  const keys = Object.keys(d).sort();
  const expected = [...DECISION_SCHEMA.required].sort();
  if (keys.join(",") !== expected.join(",")) errors.push(`fields must be exactly: ${expected.join(", ")}`);

  if (!DECISIONS.includes(d.decision)) errors.push("unknown decision");
  if (!TASK_MODES.includes(d.mode)) errors.push("unknown mode");
  for (const f of ["summary", "task", "reason"]) {
    if (typeof d[f] !== "string") errors.push(`${f} must be a string`);
    else if (d[f].length > LIMITS[f]) errors.push(`${f} too long`);
  }
  if (!Array.isArray(d.required_checks) || d.required_checks.length > LIMITS.checks) errors.push("required_checks must be an array of at most 10 strings");
  else if (d.required_checks.some((c) => typeof c !== "string" || c.length > LIMITS.check)) errors.push("required_checks entries must be short strings");
  if (!(d.approval_reason === null || (typeof d.approval_reason === "string" && d.approval_reason.length <= LIMITS.approval_reason))) {
    errors.push("approval_reason must be null or a short string");
  }
  if (!(d.branch === null || (typeof d.branch === "string" && d.branch.length <= LIMITS.branch))) errors.push("branch must be null or a short string");

  if (["assign_task", "continue_task"].includes(d.decision) && !(typeof d.task === "string" && d.task.trim())) {
    errors.push(`${d.decision} requires a task`);
  }
  if (d.decision === "require_human" && !(typeof d.approval_reason === "string" && d.approval_reason.trim())) {
    errors.push("require_human requires approval_reason");
  }
  if (d.decision !== "require_human" && typeof d.approval_reason === "string" && d.approval_reason.trim()) {
    // A non-null approval reason on any other decision is itself a request for a human.
    errors.push("approval_reason is set but decision is not require_human");
  }
  return errors.length ? { ok: false, errors } : { ok: true, decision: d };
}

function extractOutputText(body, label) {
  if (body?.status && body.status !== "completed") {
    throw new ManagerApiError(`${label} response status ${body.status}${body.incomplete_details?.reason ? ` (${body.incomplete_details.reason})` : ""}`);
  }
  const parts = [];
  for (const item of body?.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c.type === "refusal") throw new ManagerApiError(`${label} model refused to answer`);
      if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  if (!parts.length) throw new ManagerApiError(`${label} response contained no output text`);
  return parts.join("");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One stateless Responses API call with a strict JSON-schema output. Returns
 * { raw, usage, responseId }. Transient failures (429/5xx/network) are retried a
 * bounded number of times; anything else throws ManagerApiError.
 */
export async function callResponses({
  apiKey,
  model,
  instructions,
  input,
  schema,
  schemaName,
  label = "manager",
  fetchImpl = globalThis.fetch,
  timeoutMs = 180_000,
  attempts = 3,
  backoffMs = [2_000, 8_000],
  maxOutputTokens = 16_000,
}) {
  if (!apiKey) throw new ConfigError(MISSING_KEY_MESSAGE);
  const body = JSON.stringify({
    model,
    instructions,
    input,
    store: false,
    max_output_tokens: maxOutputTokens,
    text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
  });
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetchImpl(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = new ManagerApiError(`${label} API request failed: ${redact(error?.name === "TimeoutError" ? "timeout" : error?.message ?? "network error")}`, { retryable: true });
    }
    if (res) {
      let parsed = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      if (res.ok) {
        const raw = extractOutputText(parsed, label);
        const u = parsed?.usage ?? {};
        return {
          raw,
          responseId: parsed?.id ?? null,
          usage: {
            input_tokens: u.input_tokens ?? null,
            output_tokens: u.output_tokens ?? null,
            reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? null,
            total_tokens: u.total_tokens ?? null,
          },
        };
      }
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      const detail = redact(String(parsed?.error?.code ?? parsed?.error?.type ?? "")).slice(0, 80);
      lastError = new ManagerApiError(`${label} API returned HTTP ${res.status}${detail ? ` (${detail})` : ""}`, { status: res.status, retryable });
      if (res.status === 401 || res.status === 403) {
        lastError = new ManagerApiError(`${label} API rejected the credentials (HTTP ${res.status}). Check OPENAI_API_KEY in your local environment.`, { status: res.status });
      }
    }
    if (!lastError.retryable || attempt === attempts) break;
    await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
  }
  throw lastError;
}

/** Ask the manager model for one decision. */
export function requestDecision(args) {
  return callResponses({ ...args, schema: DECISION_SCHEMA, schemaName: "carcode_manager_decision", label: "manager" });
}
