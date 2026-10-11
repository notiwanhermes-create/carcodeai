/**
 * POST /api/diagnose
 *
 * Path of one request:
 *   rate limit → size-capped JSON body → field validation → trouble-code lookup
 *   → decide what the AI model may see → (allowance) → one model call, or two
 *   if the first failed in a retryable way → checked, structured diagnosis.
 *
 * The AI model is not called at all when the input is invalid, when the caller
 * is over a limit, or when there is nothing safe to reason from: no symptoms,
 * and no code with a VERIFIED definition. A hand-entered reference title is
 * shown to the user but is not enough to diagnose from on its own.
 *
 * Allowance: a new diagnosis uses one unit of the caller's allowance and comes
 * back with a signed ticket. An update with follow-up answers presents that
 * ticket instead, and each ticket allows a small fixed number of updates.
 */
import { lookupCodes, type DtcResult } from "../../lib/dtc";
import { DIAGNOSE_LIMITS, parseDiagnoseBody } from "../../lib/diagnose-input";
import { checkBurst, consumeDiagnosisQuota, consumeFollowUp, diagnoseLimits, type DiagnoseCaller } from "../../lib/diagnose-guard";
import { buildDiagnosisContext, buildInstructions, planCodes, symptomsForModel } from "../../lib/diagnosis-context";
import { requestDiagnosis, type ModelFailure } from "../../lib/diagnosis-model";
import type { DiagnoseNoDefinition, DiagnoseOk } from "../../lib/diagnosis-schema";
import { issueTicket, requestFingerprint, verifyTicket } from "../../lib/diagnosis-ticket";
import { vinAttributesForVehicle } from "../../lib/vin-lookup";
import { clientIpKey } from "../../lib/client-ip";
import { readJsonBody } from "../../lib/http";
import { auth } from "../../lib/auth-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The model step is capped at 48 s (see diagnosis-model.ts); this leaves room around it. */
export const maxDuration = 60;

/** Messages that are safe to show to anyone. Internal details are only ever logged. */
const FAILURE_RESPONSES: Record<ModelFailure, { status: number; code: string; error: string; retryAfter?: number }> = {
  timeout: { status: 504, code: "timeout", error: "The diagnosis took too long. Please try again." },
  rate_limited: { status: 503, code: "busy", error: "CarCode AI is very busy right now. Please try again in a minute.", retryAfter: 30 },
  unavailable: { status: 503, code: "service_unavailable", error: "Diagnosis is temporarily unavailable. Please try again in a moment." },
  rejected: { status: 503, code: "service_unavailable", error: "Diagnosis is temporarily unavailable. Please try again in a moment." },
  refused: {
    status: 422,
    code: "refused",
    error: "We couldn't produce a diagnosis for that request. Try describing the vehicle problem in different words.",
  },
  truncated: {
    status: 502,
    code: "bad_result",
    error: "We couldn't complete that diagnosis. Please try again, or add a bit more detail (e.g. when it happens, where it seems to come from).",
  },
  invalid_output: {
    status: 502,
    code: "bad_result",
    error: "We couldn't complete that diagnosis. Please try again, or add a bit more detail (e.g. when it happens, where it seems to come from).",
  },
};

/** Always return JSON (no HTML). */
function jsonResponse(body: object, status: number, extraHeaders?: Record<string, string>) {
  return Response.json(body, {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

/** Signed-in user id, or null. Never throws: an auth hiccup just means "guest". */
async function getSignedInUserId(): Promise<string | null> {
  try {
    const session = await auth();
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Shown when the codes supplied are not enough to diagnose from and no symptoms were given. */
function needsSymptomsMessage(codes: DtcResult[]): string {
  const recognised = codes.filter((r) => r.status !== "invalid");
  const one = recognised.length === 1;
  if (recognised.length === 0) {
    return "We couldn't recognise that as a trouble code. Check it and try again, or describe the symptoms instead.";
  }
  if (recognised.every((r) => r.trust === "local_reference")) {
    return one
      ? "CarCode AI has a commonly published title for this code, but it has not been verified, so the code alone is not enough for a diagnosis. Describe the symptoms as well and we can help narrow it down."
      : "CarCode AI has commonly published titles for these codes, but they have not been verified, so the codes alone are not enough for a diagnosis. Describe the symptoms as well and we can help narrow it down.";
  }
  if (recognised.every((r) => r.status === "manufacturer_unavailable")) {
    return "This code is manufacturer-specific and CarCode AI does not currently have a verified definition for this vehicle. Describe the symptoms as well and we can still help narrow it down.";
  }
  if (recognised.some((r) => r.trust === "local_reference")) {
    return "CarCode AI does not have a verified definition for these codes yet, so the codes alone are not enough for a diagnosis. Describe the symptoms as well and we can still help narrow it down.";
  }
  return `CarCode AI does not have a verified definition for ${one ? "this code" : "these codes"} yet, so we won't guess what ${one ? "it means" : "they mean"}. Describe the symptoms as well and we can still help narrow it down.`;
}

const FOLLOWUP_INVALID = "This diagnosis can no longer be updated. Start a new diagnosis to continue.";

export async function POST(req: Request) {
  try {
    const limits = diagnoseLimits();
    const caller: DiagnoseCaller = { ipKey: clientIpKey(req), userId: await getSignedInUserId() };

    // 1) Flood protection: every request from an IP counts, valid or not.
    const burst = await checkBurst(caller);
    if (!burst.allowed) {
      return jsonResponse({ error: burst.error, code: burst.code }, burst.status, {
        "Retry-After": String(burst.retryAfterSeconds),
      });
    }

    // 2) Size-capped JSON body, then strict validation of every field.
    const rawBody = await readJsonBody(req, limits.maxBodyBytes);
    if (!rawBody.ok) {
      return jsonResponse({ error: rawBody.error, code: rawBody.code }, rawBody.status);
    }
    const parsedBody = parseDiagnoseBody(rawBody.data);
    if (!parsedBody.ok) {
      return jsonResponse({ error: parsedBody.error, code: "invalid_request", field: parsedBody.field }, 400);
    }
    const input = parsedBody.value;

    // 3) Trouble codes. Every code gets an explicit result, nothing is guessed,
    //    and one bad code never fails the whole request. Codes the user wrote in
    //    the symptoms are treated the same way as codes typed in the code box.
    const entered: DtcResult[] = input.code ? lookupCodes(input.code, input.make) : [];
    const plan = planCodes(
      entered,
      [input.symptoms, ...input.followUps.map((f) => f.answer)],
      { make: input.make, model: input.model },
      DIAGNOSE_LIMITS.maxCodes,
    );
    const symptoms = symptomsForModel(input.symptoms, plan.withheld);

    // 4) Nothing safe to reason from: there are no usable symptoms, and no code
    //    with a verified definition. A hand-entered reference title is not enough
    //    on its own. Say so, show what we have, and ask for symptoms. No AI call
    //    is made and no allowance is used.
    const hasVerifiedCode = plan.supported.some((r) => r.trust === "verified");
    if (!symptoms && !hasVerifiedCode) {
      if (plan.results.length > 0) {
        const body: DiagnoseNoDefinition = { noDefinition: true, codes: plan.results, message: needsSymptomsMessage(plan.results) };
        return jsonResponse(body, 200);
      }
      return jsonResponse(
        { error: "Describe the symptoms in a few words, or enter a trouble code.", code: "invalid_request", field: "symptoms" },
        400,
      );
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      console.error("[POST /api/diagnose] OPENAI_API_KEY is not set");
      return jsonResponse({ error: FAILURE_RESPONSES.unavailable.error, code: "service_unavailable" }, 503);
    }

    // 5) Usage allowance. Counted only now, when the request will reach the AI model.
    //    A new diagnosis uses the caller's allowance. An update with follow-up
    //    answers uses the ticket of the diagnosis it belongs to instead: it must
    //    be a genuine, unexpired ticket for this same vehicle, codes and symptoms,
    //    and each ticket allows only a fixed number of updates.
    const fingerprint = requestFingerprint(input);
    let followUp: DiagnoseOk["followUp"];
    if (input.followUps.length > 0) {
      const check = verifyTicket(input.diagnosisToken, fingerprint);
      if (!check.ok) {
        return jsonResponse({ error: FOLLOWUP_INVALID, code: "followup_invalid" }, 400);
      }
      const allowance = await consumeFollowUp(check.ticket);
      if (!allowance.allowed) {
        return jsonResponse(
          { error: allowance.error, code: allowance.code },
          allowance.status,
          allowance.retryAfterSeconds > 0 ? { "Retry-After": String(allowance.retryAfterSeconds) } : undefined,
        );
      }
      followUp = { token: input.diagnosisToken, remaining: allowance.remaining ?? 0 };
    } else {
      const quota = await consumeDiagnosisQuota(caller);
      if (!quota.allowed) {
        return jsonResponse({ error: quota.error, code: quota.code }, quota.status, {
          "Retry-After": String(quota.retryAfterSeconds),
        });
      }
      const issued = limits.followUpsPerDiagnosis > 0 ? issueTicket(fingerprint) : null;
      followUp = issued ? { token: issued.token, remaining: limits.followUpsPerDiagnosis } : null;
    }

    // 6) What the model may see. The VIN is used here to look up vehicle details
    //    and goes no further; a failed lookup simply means fewer details.
    const vinAttributes = await vinAttributesForVehicle(input.vin, { year: input.year, make: input.make });
    const context = buildDiagnosisContext({
      year: input.year,
      make: input.make,
      model: input.model,
      engine: input.engine,
      mileage: input.mileage,
      symptoms: input.symptoms,
      followUps: input.followUps,
      vinAttributes,
      plan,
    });

    // Local debugging only: print exactly what the model is about to be sent, to
    // check by eye that no unidentified code number is in it. Never runs in production.
    if (process.env.NODE_ENV !== "production" && process.env.DIAGNOSE_LOG_CONTEXT === "1") {
      console.log(`[diagnose] model input: ${JSON.stringify(context)}`);
    }

    // 7) One model call, or two if the first failed in a way a retry can fix.
    const started = Date.now();
    const outcome = await requestDiagnosis({ apiKey, instructions: buildInstructions(input.lang), context });

    if (!outcome.ok) {
      const failure = FAILURE_RESPONSES[outcome.failure];
      console.error(`[POST /api/diagnose] no diagnosis: ${outcome.failure} after ${outcome.calls} model call(s)`);
      return jsonResponse(
        { error: failure.error, code: failure.code },
        failure.status,
        failure.retryAfter ? { "Retry-After": String(failure.retryAfter) } : undefined,
      );
    }

    // Sizes only, for cost tracking. No user content is logged.
    console.log(
      `[diagnose] ok calls=${outcome.calls} input_tokens=${outcome.usage?.inputTokens ?? "?"} output_tokens=${outcome.usage?.outputTokens ?? "?"} ms=${Date.now() - started}`,
    );

    const body: DiagnoseOk = {
      diagnosis: outcome.diagnosis,
      codes: plan.results,
      refined: context.follow_up_answers !== undefined,
      followUp,
    };
    return jsonResponse(body, 200);
  } catch (e: unknown) {
    // The real cause goes to the server log only (Vercel logs). The browser
    // gets a generic message: no provider errors, keys, prompts or stack details.
    console.error("[POST /api/diagnose]", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    return jsonResponse({ error: FAILURE_RESPONSES.unavailable.error, code: "service_unavailable" }, 503);
  }
}
