/**
 * Fixed-window rate limiting.
 *
 * Counters live in Postgres (table `rate_limits`) so limits hold across
 * serverless instances. If no database is configured, or the database is
 * unreachable, an in-memory counter is used instead so the app keeps working
 * (limits then apply per server instance).
 */

export type RateLimitResult = {
  allowed: boolean;
  /** Requests counted in the current window, including this one. */
  count: number;
  limit: number;
  /** Seconds until the current window ends. */
  retryAfterSeconds: number;
  /** Where the counter was kept. */
  store: "database" | "memory" | "disabled";
};

type MemoryEntry = { count: number; expiresAt: number };

const memory = new Map<string, MemoryEntry>();
const MEMORY_MAX_ENTRIES = 10_000;
let lastDbWarningAt = 0;

/** Read a non-negative integer from the environment, falling back to a default. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function windowStartMs(nowMs: number, windowSeconds: number): number {
  const w = windowSeconds * 1000;
  return Math.floor(nowMs / w) * w;
}

function pruneMemory(nowMs: number) {
  if (memory.size < MEMORY_MAX_ENTRIES) return;
  for (const [k, v] of memory) {
    if (v.expiresAt <= nowMs) memory.delete(k);
  }
  // Still too big (many live keys): drop the oldest entries.
  if (memory.size >= MEMORY_MAX_ENTRIES) {
    let toDrop = memory.size - Math.floor(MEMORY_MAX_ENTRIES / 2);
    for (const k of memory.keys()) {
      if (toDrop-- <= 0) break;
      memory.delete(k);
    }
  }
}

function incrementMemory(key: string, startMs: number, windowSeconds: number, nowMs: number): number {
  pruneMemory(nowMs);
  const k = `${key}|${startMs}`;
  const existing = memory.get(k);
  if (existing && existing.expiresAt > nowMs) {
    existing.count += 1;
    return existing.count;
  }
  memory.set(k, { count: 1, expiresAt: startMs + windowSeconds * 1000 });
  return 1;
}

async function incrementDatabase(key: string, startMs: number): Promise<number> {
  const [{ ensureDB }, { default: prisma }] = await Promise.all([import("./db"), import("./prisma")]);
  await ensureDB();
  const windowStart = new Date(startMs);
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limits (key, window_start, count)
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key, window_start)
    DO UPDATE SET count = rate_limits.count + 1
    RETURNING count
  `;
  // Occasionally clear out old windows so the table stays small.
  if (Math.random() < 0.01) {
    prisma.$executeRaw`DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '2 days'`.catch(() => {});
  }
  return Number(rows[0]?.count ?? 1);
}

/**
 * Count one request against `key` and report whether it is within `limit`
 * for the current window. A limit of 0 (or less) disables the check.
 */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  nowMs: number = Date.now(),
): Promise<RateLimitResult> {
  if (!(limit > 0) || !(windowSeconds > 0)) {
    return { allowed: true, count: 0, limit, retryAfterSeconds: 0, store: "disabled" };
  }

  const startMs = windowStartMs(nowMs, windowSeconds);
  const retryAfterSeconds = Math.max(1, Math.ceil((startMs + windowSeconds * 1000 - nowMs) / 1000));

  let count: number;
  let store: RateLimitResult["store"] = "memory";

  if (process.env.DATABASE_URL) {
    try {
      count = await incrementDatabase(key, startMs);
      store = "database";
    } catch (err) {
      if (nowMs - lastDbWarningAt > 60_000) {
        lastDbWarningAt = nowMs;
        console.error("[rate-limit] database unavailable, using in-memory counters:", (err as Error)?.message);
      }
      count = incrementMemory(key, startMs, windowSeconds, nowMs);
    }
  } else {
    count = incrementMemory(key, startMs, windowSeconds, nowMs);
  }

  return { allowed: count <= limit, count, limit, retryAfterSeconds, store };
}

/** Test helper: forget all in-memory counters. */
export function resetMemoryRateLimits() {
  memory.clear();
}
