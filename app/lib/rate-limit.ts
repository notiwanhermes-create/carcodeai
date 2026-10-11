/**
 * Fixed-window rate limiting.
 *
 * Counters live in Postgres (table `rate_limits`) so limits hold across
 * serverless instances. If no database is configured, or the database is
 * unreachable, an in-memory counter is used instead so the app keeps working
 * (limits then apply per server instance).
 *
 * Each row is one counter for one window, with the time it stops mattering
 * (`expires_at`). Expired rows are deleted (see pruneExpiredCounters), so the
 * table holds only live counters and does not grow without limit.
 *
 * RAW SQL: the increment below is the one hand-written statement in the app.
 * It has to add one and return the new total as a single atomic statement
 * (INSERT ... ON CONFLICT DO UPDATE ... RETURNING), which the Prisma query API
 * cannot guarantee. It goes through Prisma's tagged-template `$queryRaw`, so
 * every value is sent as a bound parameter, never spliced into the SQL text.
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

/** How often a write also clears out expired counters (1 in 50). */
const PRUNE_CHANCE = 0.02;

/**
 * When a counter row can be deleted. A row matters for one window from its
 * start. A caller may pin `nowMs` to an earlier moment (the follow-up counter
 * pins it to the time its ticket was issued), so the row is kept for a second
 * window to be sure it outlives whatever it is counting.
 */
function counterExpiry(startMs: number, windowSeconds: number): Date {
  return new Date(startMs + 2 * windowSeconds * 1000);
}

async function incrementDatabase(key: string, startMs: number, windowSeconds: number): Promise<number> {
  // Loaded on demand so that code paths without a database never load the client.
  const { default: prisma } = await import("./prisma");
  const windowStart = new Date(startMs);
  const expiresAt = counterExpiry(startMs, windowSeconds);
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limits (key, window_start, count, expires_at)
    VALUES (${key}, ${windowStart}, 1, ${expiresAt})
    ON CONFLICT (key, window_start)
    DO UPDATE SET count = rate_limits.count + 1
    RETURNING count
  `;
  if (Math.random() < PRUNE_CHANCE) {
    pruneExpiredCounters().catch(() => {});
  }
  return Number(rows[0]?.count ?? 1);
}

/**
 * Delete counters whose time has passed. Runs occasionally as a side effect of
 * normal traffic, and on demand with `npm run db:prune`. Returns how many rows
 * were removed. Deleting an expired counter can never loosen a limit.
 */
export async function pruneExpiredCounters(now: Date = new Date()): Promise<number> {
  const { default: prisma } = await import("./prisma");
  const { count } = await prisma.rateLimit.deleteMany({ where: { expiresAt: { lt: now } } });
  return count;
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
      count = await incrementDatabase(key, startMs, windowSeconds);
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
