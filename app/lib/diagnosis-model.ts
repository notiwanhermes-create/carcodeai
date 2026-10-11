/**
 * The one place the diagnosis talks to the AI model.
 *
 * Call budget for one diagnosis: the primary request, plus at most ONE retry,
 * and only for a failure that a second try can plausibly fix (a dropped
 * connection, a timeout, a server error, or a reply that is not valid JSON).
 * Everything else ends the diagnosis after one call:
 *  - the provider refusing or rate-limiting us,
 *  - a permanent API error (bad request, bad key, a schema we got wrong),
 *  - a reply that was cut off,
 *  - a reply that is well-formed but that our own checks reject.
 *
 * The SDK's built-in retries are switched off (they default to 2 extra tries
 * per request), so the count here is the real number of paid calls.
 *
 * Nothing in this file returns provider error text, prompts or raw replies to
 * the caller: failures are reduced to a short reason code.
 */
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { DiagnosisModelSchema, normalizeDiagnosis, type Diagnosis } from "./diagnosis-schema";
import type { DiagnosisContext } from "./diagnosis-context";

export const DIAGNOSIS_MODEL = "gpt-4.1-mini";
/** Primary request + one retry. */
export const MAX_MODEL_CALLS = 2;
/** Longest we wait for one reply. */
export const ATTEMPT_TIMEOUT_MS = 25_000;
/** Longest the model step may take in total, retry included. */
export const TOTAL_BUDGET_MS = 48_000;
/** A retry is not started with less time than this left. */
const MIN_RETRY_MS = 8_000;
/** Ceiling for the reply. A normal diagnosis is well under this. */
export const MAX_OUTPUT_TOKENS = 2_000;

/** The strict JSON schema sent with every request, built once from the shared Zod schema. */
const DIAGNOSIS_FORMAT = zodTextFormat(DiagnosisModelSchema, "diagnosis");

export type ModelFailure =
  /** No reply in time. */
  | "timeout"
  /** The provider is rate-limiting us or the account is out of quota. */
  | "rate_limited"
  /** Could not reach the provider, or it answered with a server error. */
  | "unavailable"
  /** The provider rejected the request itself (bad request, authentication, unknown model). */
  | "rejected"
  /** The model declined to answer. */
  | "refused"
  /** The reply was cut off before it finished. */
  | "truncated"
  /** The reply was empty, not valid JSON, or not a usable diagnosis. */
  | "invalid_output";

export type ModelUsage = { inputTokens: number; outputTokens: number };

export type ModelOutcome =
  | { ok: true; diagnosis: Diagnosis; calls: number; usage: ModelUsage | null }
  | { ok: false; failure: ModelFailure; calls: number };

type Attempt =
  | { ok: true; diagnosis: Diagnosis; usage: ModelUsage | null }
  | { ok: false; failure: ModelFailure; retryable: boolean; detail?: string };

type RawResponse = {
  status?: string | null;
  output_text?: string | null;
  output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
};

/** Pull the JSON text out of a Responses API result, or say why there is none. */
function readReply(resp: RawResponse): { ok: true; text: string } | { ok: false; failure: ModelFailure; retryable: boolean } {
  let text = "";
  let refused = false;
  if (Array.isArray(resp.output)) {
    for (const item of resp.output) {
      const message = item as { type?: string; content?: unknown };
      if (message?.type !== "message" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        const b = block as { type?: string; text?: string };
        if (b?.type === "refusal") refused = true;
        else if (b?.type === "output_text" && typeof b.text === "string") text += b.text;
      }
    }
  }
  if (refused) return { ok: false, failure: "refused", retryable: false };
  if (resp.status === "incomplete") return { ok: false, failure: "truncated", retryable: false };
  if (!text && typeof resp.output_text === "string") text = resp.output_text;
  if (!text.trim()) return { ok: false, failure: "invalid_output", retryable: true };
  return { ok: true, text };
}

/** Reduce a thrown SDK/network error to a reason and whether one retry is justified. */
export function classifyModelError(err: unknown): { failure: ModelFailure; retryable: boolean } {
  const e = (err ?? {}) as { status?: unknown; name?: unknown; code?: unknown; message?: unknown; constructor?: { name?: string } };
  const status = typeof e.status === "number" ? e.status : null;
  const kind = `${e.constructor?.name || ""} ${typeof e.name === "string" ? e.name : ""}`;
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";

  if (status === 429) return { failure: "rate_limited", retryable: false };
  if (status === 408 || status === 409 || (status !== null && status >= 500)) return { failure: "unavailable", retryable: true };
  if (status !== null) return { failure: "rejected", retryable: false };

  if (/Timeout/i.test(kind) || code === "ETIMEDOUT" || /timed out|timeout/i.test(message)) return { failure: "timeout", retryable: true };
  if (/APIConnectionError/.test(kind) || /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_)/.test(code) || /fetch failed|connection error|network/i.test(message)) {
    return { failure: "unavailable", retryable: true };
  }
  // Anything unrecognised is treated as permanent: we never pay twice on a guess.
  return { failure: "rejected", retryable: false };
}

async function attempt(client: OpenAI, instructions: string, context: DiagnosisContext, timeoutMs: number): Promise<Attempt> {
  let resp: RawResponse;
  try {
    resp = (await client.responses.create(
      {
        model: DIAGNOSIS_MODEL,
        input: [
          { role: "developer", content: instructions },
          // One JSON document. JSON.stringify keeps user text inside its own string.
          { role: "user", content: JSON.stringify(context) },
        ],
        text: { format: DIAGNOSIS_FORMAT },
        temperature: 0.2,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
      },
      { timeout: timeoutMs, maxRetries: 0 },
    )) as RawResponse;
  } catch (err) {
    const c = classifyModelError(err);
    const e = err as { status?: number; message?: string; constructor?: { name?: string } };
    return { ok: false, ...c, detail: `${e?.constructor?.name || "Error"} ${e?.status ?? ""} ${e?.message || ""}`.trim() };
  }

  const reply = readReply(resp);
  if (!reply.ok) return reply;

  let json: unknown;
  try {
    json = JSON.parse(reply.text);
  } catch {
    return { ok: false, failure: "invalid_output", retryable: true, detail: `unparseable reply (${reply.text.length} chars)` };
  }

  // The model was given this exact schema, so a mismatch is a glitch on its side: worth one retry.
  if (!DiagnosisModelSchema.safeParse(json).success) {
    return { ok: false, failure: "invalid_output", retryable: true, detail: "reply does not match the schema" };
  }
  // Well-formed, but not a usable diagnosis by our own rules. Asking again would
  // be paying twice for our own validation, so this is final.
  const diagnosis = normalizeDiagnosis(json);
  if (!diagnosis) return { ok: false, failure: "invalid_output", retryable: false, detail: "reply has no usable causes" };

  const usage =
    resp.usage && typeof resp.usage.input_tokens === "number" && typeof resp.usage.output_tokens === "number"
      ? { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens }
      : null;
  return { ok: true, diagnosis, usage };
}

/**
 * Ask the model for a diagnosis. Makes one call, or two if the first failed in
 * a way a retry can fix. Never more.
 */
export async function requestDiagnosis(args: { apiKey: string; instructions: string; context: DiagnosisContext }): Promise<ModelOutcome> {
  const client = new OpenAI({ apiKey: args.apiKey, maxRetries: 0, timeout: ATTEMPT_TIMEOUT_MS });
  const started = Date.now();
  let calls = 0;
  let failure: ModelFailure = "unavailable";

  while (calls < MAX_MODEL_CALLS) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
    if (calls > 0 && remaining < MIN_RETRY_MS) break;

    calls += 1;
    const result = await attempt(client, args.instructions, args.context, Math.max(1_000, Math.min(ATTEMPT_TIMEOUT_MS, remaining)));
    if (result.ok) return { ok: true, diagnosis: result.diagnosis, calls, usage: result.usage };

    failure = result.failure;
    // Server log only. Never sent to the browser.
    console.error(`[diagnose] model call ${calls} failed: ${result.failure}${result.detail ? ` (${result.detail})` : ""}`);
    if (!result.retryable) break;
  }

  return { ok: false, failure, calls };
}
