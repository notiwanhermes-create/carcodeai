// Independent OpenAI reviewer. Every review is a FRESH, stateless Responses API
// request (store:false, no previous_response_id) with its own prompt. The reviewer
// sees the actual change and the harness's own verification results, never
// Claude's report or reasoning, so the implementer cannot vouch for itself.
// The reviewer only returns findings; it cannot edit, run commands, commit or push.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callResponses, ManagerApiError } from "./openai-manager.mjs";
import { redactDeep } from "./redact.mjs";
import { changeSet, fingerprint, snapshot } from "./repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const VERDICTS = ["clean", "findings", "blocked"];
export const SEVERITIES = ["critical", "high", "medium", "low"];
export const MAX_REVIEW_DIFF_CHARS = 150_000;
const MAX_FINDINGS = 30;
const FINDING_FIELDS = ["severity", "file", "location", "problem", "reason", "required_fix"];

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: FINDING_FIELDS,
        properties: {
          severity: { type: "string", enum: SEVERITIES },
          file: { type: "string" },
          location: { type: "string" },
          problem: { type: "string" },
          reason: { type: "string" },
          required_fix: { type: "string" },
        },
      },
    },
  },
};

/** Strictly validate a review (object or JSON string). Anything unexpected fails closed. */
export function validateReview(raw) {
  let r = raw;
  if (typeof raw === "string") {
    try {
      r = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ["review is not valid JSON"] };
    }
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, errors: ["review is not a JSON object"] };
  const errors = [];
  if (Object.keys(r).sort().join(",") !== "findings,summary,verdict") errors.push("fields must be exactly: verdict, summary, findings");
  if (!VERDICTS.includes(r.verdict)) errors.push("unknown verdict");
  if (typeof r.summary !== "string" || !r.summary.trim() || r.summary.length > 4_000) errors.push("summary must be a non-empty string (max 4000)");
  if (!Array.isArray(r.findings) || r.findings.length > MAX_FINDINGS) {
    errors.push(`findings must be an array of at most ${MAX_FINDINGS}`);
  } else {
    r.findings.forEach((f, i) => {
      if (!f || typeof f !== "object" || Object.keys(f).sort().join(",") !== [...FINDING_FIELDS].sort().join(",")) errors.push(`finding ${i} has the wrong fields`);
      else if (!SEVERITIES.includes(f.severity)) errors.push(`finding ${i} has an unknown severity`);
      else if (FINDING_FIELDS.some((k) => typeof f[k] !== "string" || f[k].length > 4_000)) errors.push(`finding ${i} has a non-string or oversized field`);
      else if (!f.problem.trim() || !f.required_fix.trim()) errors.push(`finding ${i} must state the problem and the required fix`);
    });
    // "clean" with findings, or "findings" without any, is contradictory: fail closed.
    if (r.verdict === "clean" && r.findings.length) errors.push("a clean verdict cannot list findings");
    if (r.verdict === "findings" && !r.findings.length) errors.push("a findings verdict must list at least one finding");
  }
  return errors.length ? { ok: false, errors } : { ok: true, review: r };
}

function capped(text, max) {
  if (text === null || text === undefined) return null;
  return text.length > max ? `${text.slice(0, max)}\n[... truncated ${text.length - max} chars]` : text;
}

/**
 * Build the reviewer's input from the REAL repository state. Returns
 * { ok, input, digest, files } or { ok:false, reason } when the change cannot be
 * reviewed faithfully (e.g. too large), which callers treat as blocked.
 */
export async function buildReviewInput(repo, { task, checks = [], previousFindings = [], env = process.env }) {
  const digest = await fingerprint(repo);
  const snap = await snapshot(repo);
  const { files, diff } = await changeSet(repo, task.startHead);
  if (!files.length) return { ok: false, reason: "there is no change to review", digest };
  if (diff.length > MAX_REVIEW_DIFF_CHARS) {
    return { ok: false, reason: `the change is too large for one independent review (${diff.length} chars > ${MAX_REVIEW_DIFF_CHARS}); split the task`, digest };
  }
  const read = (name) => {
    try {
      return capped(readFileSync(join(repo, name), "utf8"), 12_000);
    } catch {
      return null;
    }
  };
  const doc = {
    request: "Independent review of an uncommitted change to CarCode AI.",
    repository: { branch: snap.branch, baseCommit: task.startHead },
    rules: { agentsMd: read("AGENTS.md"), claudeMd: read("CLAUDE.md") },
    task: {
      summary: task.summary ?? "",
      requirements: task.originalTask ?? task.task ?? "",
      latestInstruction: task.task !== task.originalTask ? task.task : null,
    },
    changedFiles: files,
    migrationFiles: files.filter((f) => /^prisma\/(migrations\/|schema\.prisma$)/i.test(f.path)).map((f) => f.path),
    diff,
    harnessVerification: checks.map((c) => ({ check: c.id, status: c.status, output: capped(String(c.output ?? ""), 3_000) })),
    previousReviewFindings: previousFindings,
  };
  return { ok: true, input: JSON.stringify(redactDeep(doc, env)), digest, files };
}

export function reviewerInstructions() {
  return readFileSync(join(HERE, "prompts", "reviewer.md"), "utf8");
}

/**
 * Run one independent review. Never throws for review-side problems.
 * status: "clean" | "findings" | "blocked" (reviewer said so, or the change is unreviewable)
 *       | "invalid" (malformed output) | "error" (API failure). Only "clean" may complete a task.
 */
export async function runIndependentReview({ repo, task, checks, previousFindings, apiKey, model, fetchImpl, env = process.env, backoffMs }) {
  const built = await buildReviewInput(repo, { task, checks, previousFindings, env });
  if (!built.ok) return { status: "blocked", reason: built.reason, digest: built.digest, model, review: null, usage: null };
  let response;
  try {
    response = await callResponses({
      apiKey,
      model,
      instructions: reviewerInstructions(),
      input: built.input,
      schema: REVIEW_SCHEMA,
      schemaName: "carcode_independent_review",
      label: "review",
      fetchImpl,
      ...(backoffMs ? { backoffMs } : {}),
    });
  } catch (error) {
    if (error instanceof ManagerApiError) return { status: "error", reason: error.message, digest: built.digest, model, review: null, usage: null };
    throw error;
  }
  const checked = validateReview(response.raw);
  if (!checked.ok) return { status: "invalid", reason: `malformed review output: ${checked.errors.join("; ")}`, digest: built.digest, model, review: null, usage: response.usage, responseId: response.responseId };
  // The tree must be exactly what was reviewed.
  const after = await fingerprint(repo);
  if (after !== built.digest) return { status: "blocked", reason: "the working tree changed during the review", digest: built.digest, model, review: checked.review, usage: response.usage };
  return {
    status: checked.review.verdict,
    reason: checked.review.summary,
    digest: built.digest,
    model,
    review: checked.review,
    usage: response.usage,
    responseId: response.responseId,
    inputChars: built.input.length,
  };
}
