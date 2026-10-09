/**
 * POST /api/diagnose
 *
 * Path of one request:
 *   rate limit → size-capped JSON body → field validation → trouble-code lookup
 *   → decide what the AI model may see → (allowance) → one model call, or two
 *   if the first failed in a retryable way → checked, structured diagnosis.
 *
 * The AI model is not called at all when the input is invalid, when the caller
 * is over a limit, or when there is nothing safe to reason from (only codes
 * with no definition on file, and no symptoms).
 */
import { lookupCodes, type DtcResult } from "../../lib/dtc";
import { DIAGNOSE_LIMITS, parseDiagnoseBody } from "../../lib/diagnose-input";
import { checkBurst, consumeDiagnosisQuota, diagnoseLimits, type DiagnoseCaller } from "../../lib/diagnose-guard";
import { buildDiagnosisContext, buildInstructions, planCodes, symptomsForModel } from "../../lib/diagnosis-context";
import { requestDiagnosis, type ModelFailure } from "../../lib/diagnosis-model";
import type { DiagnoseNoDefinition, DiagnoseOk } from "../../lib/diagnosis-schema";
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

function noDefinitionMessage(codes: DtcResult[]): string {
  const recognised = codes.filter((r) => r.status !== "invalid");
  if (recognised.length === 0) {
    return "We couldn't recognise that as a trouble code. Check it and try again, or describe the symptoms instead.";
  }
  if (recognised.every((r) => r.status === "manufacturer_unavailable")) {
    return "This code is manufacturer-specific and CarCode AI does not currently have a verified definition for this vehicle. Describe the symptoms as well and we can still help narrow it down.";
  }
  const one = recognised.length === 1;
  return `CarCode AI does not have a verified definition for ${one ? "this code" : "these codes"} yet, so we won't guess what ${one ? "it means" : "they mean"}. Describe the symptoms as well and we can still help narrow it down.`;
}

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

    // 4) Nothing safe to reason from: no code has a definition on file and there
    //    are no usable symptoms. Say so. No AI call is made and no allowance is used.
    if (plan.supported.length === 0 && !symptoms) {
      if (plan.results.length > 0) {
        const body: DiagnoseNoDefinition = { noDefinition: true, codes: plan.results, message: noDefinitionMessage(plan.results) };
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
    const quota = await consumeDiagnosisQuota(caller);
    if (!quota.allowed) {
      return jsonResponse({ error: quota.error, code: quota.code }, quota.status, {
        "Retry-After": String(quota.retryAfterSeconds),
      });
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
    // check by eye that withheld code numbers are absent. Never runs in production.
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
    };
    return jsonResponse(body, 200);
  } catch (e: unknown) {
    // The real cause goes to the server log only (Vercel logs). The browser
    // gets a generic message: no provider errors, keys, prompts or stack details.
    console.error("[POST /api/diagnose]", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    return jsonResponse({ error: FAILURE_RESPONSES.unavailable.error, code: "service_unavailable" }, 503);
  }
}
