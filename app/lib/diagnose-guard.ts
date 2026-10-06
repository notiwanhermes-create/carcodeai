/**
 * Abuse protection for /api/diagnose: who is calling, and how much they may use.
 *
 * All numbers can be changed with environment variables (0 disables a limit):
 *   DIAGNOSE_IP_BURST_LIMIT / DIAGNOSE_IP_BURST_WINDOW_SECONDS  every request, per IP
 *   DIAGNOSE_GUEST_DAILY_LIMIT                                 AI diagnoses per day, per IP, not signed in
 *   DIAGNOSE_USER_HOURLY_LIMIT / DIAGNOSE_USER_DAILY_LIMIT      AI diagnoses per signed-in user
 *   DIAGNOSE_GLOBAL_DAILY_LIMIT                                safety cap across all callers (off by default)
 *   DIAGNOSE_MAX_BODY_BYTES                                    largest request body accepted
 */
import { consumeRateLimit, envInt } from "./rate-limit";

export type DiagnoseCaller = {
  /** Hashed client IP (never the raw address). */
  ipKey: string;
  /** Signed-in user id, or null for guests. */
  userId: string | null;
};

export type GuardResult =
  | { allowed: true }
  | { allowed: false; status: 429 | 503; code: string; error: string; retryAfterSeconds: number };

const DAY_SECONDS = 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;

export function diagnoseLimits() {
  return {
    burstLimit: envInt("DIAGNOSE_IP_BURST_LIMIT", 20),
    burstWindowSeconds: envInt("DIAGNOSE_IP_BURST_WINDOW_SECONDS", 600),
    guestDaily: envInt("DIAGNOSE_GUEST_DAILY_LIMIT", 20),
    userHourly: envInt("DIAGNOSE_USER_HOURLY_LIMIT", 30),
    userDaily: envInt("DIAGNOSE_USER_DAILY_LIMIT", 100),
    globalDaily: envInt("DIAGNOSE_GLOBAL_DAILY_LIMIT", 0),
    maxBodyBytes: envInt("DIAGNOSE_MAX_BODY_BYTES", 16 * 1024) || 16 * 1024,
  };
}

/** Counts every request from an IP, valid or not, to stop floods early. */
export async function checkBurst(caller: DiagnoseCaller): Promise<GuardResult> {
  const { burstLimit, burstWindowSeconds } = diagnoseLimits();
  const r = await consumeRateLimit(`diag:burst:ip:${caller.ipKey}`, burstLimit, burstWindowSeconds);
  if (r.allowed) return { allowed: true };
  return {
    allowed: false,
    status: 429,
    code: "rate_limited",
    error: "Too many requests. Please wait a few minutes and try again.",
    retryAfterSeconds: r.retryAfterSeconds,
  };
}

/**
 * Counts one AI diagnosis. Call this only when a request is about to reach the
 * AI model, so typos and unknown codes do not use up anyone's allowance.
 */
export async function consumeDiagnosisQuota(caller: DiagnoseCaller): Promise<GuardResult> {
  const limits = diagnoseLimits();

  const global = await consumeRateLimit("diag:global:day", limits.globalDaily, DAY_SECONDS);
  if (!global.allowed) {
    return {
      allowed: false,
      status: 503,
      code: "capacity",
      error: "CarCode AI is very busy right now. Please try again later.",
      retryAfterSeconds: Math.min(global.retryAfterSeconds, HOUR_SECONDS),
    };
  }

  if (caller.userId) {
    const hourly = await consumeRateLimit(`diag:user:hour:${caller.userId}`, limits.userHourly, HOUR_SECONDS);
    if (!hourly.allowed) {
      return {
        allowed: false,
        status: 429,
        code: "user_quota",
        error: "You've run a lot of diagnoses in the last hour. Please try again a little later.",
        retryAfterSeconds: hourly.retryAfterSeconds,
      };
    }
    const daily = await consumeRateLimit(`diag:user:day:${caller.userId}`, limits.userDaily, DAY_SECONDS);
    if (!daily.allowed) {
      return {
        allowed: false,
        status: 429,
        code: "user_quota",
        error: "You've reached today's diagnosis limit. Please try again tomorrow.",
        retryAfterSeconds: daily.retryAfterSeconds,
      };
    }
    return { allowed: true };
  }

  const guest = await consumeRateLimit(`diag:guest:day:ip:${caller.ipKey}`, limits.guestDaily, DAY_SECONDS);
  if (!guest.allowed) {
    return {
      allowed: false,
      status: 429,
      code: "guest_quota",
      error: "You've reached today's free diagnosis limit. Sign in to keep going, or try again tomorrow.",
      retryAfterSeconds: guest.retryAfterSeconds,
    };
  }
  return { allowed: true };
}
