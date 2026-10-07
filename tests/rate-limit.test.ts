import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeRateLimit, envInt, resetMemoryRateLimits } from "../app/lib/rate-limit";

describe("consumeRateLimit (in-memory store)", () => {
  const savedDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL; // force the in-memory store
    resetMemoryRateLimits();
  });
  afterEach(() => {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  it("allows up to the limit, then blocks", async () => {
    const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let i = 1; i <= 3; i++) {
      const r = await consumeRateLimit("k", 3, 60, t0 + i);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i);
      expect(r.store).toBe("memory");
    }
    const blocked = await consumeRateLimit("k", 3, 60, t0 + 10);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("starts fresh in the next window", async () => {
    const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
    await consumeRateLimit("k", 1, 60, t0);
    expect((await consumeRateLimit("k", 1, 60, t0 + 1000)).allowed).toBe(false);
    expect((await consumeRateLimit("k", 1, 60, t0 + 61_000)).allowed).toBe(true);
  });

  it("keeps separate counters per key", async () => {
    const t0 = Date.UTC(2026, 0, 1);
    await consumeRateLimit("a", 1, 60, t0);
    expect((await consumeRateLimit("b", 1, 60, t0)).allowed).toBe(true);
    expect((await consumeRateLimit("a", 1, 60, t0)).allowed).toBe(false);
  });

  it("treats a limit of 0 as disabled", async () => {
    for (let i = 0; i < 50; i++) {
      const r = await consumeRateLimit("k", 0, 60);
      expect(r.allowed).toBe(true);
      expect(r.store).toBe("disabled");
    }
  });
});

describe("envInt", () => {
  afterEach(() => {
    delete process.env.TEST_LIMIT;
  });

  it("uses the default when unset or invalid", () => {
    expect(envInt("TEST_LIMIT", 7)).toBe(7);
    process.env.TEST_LIMIT = "abc";
    expect(envInt("TEST_LIMIT", 7)).toBe(7);
    process.env.TEST_LIMIT = "-3";
    expect(envInt("TEST_LIMIT", 7)).toBe(7);
  });

  it("reads a configured value, including 0", () => {
    process.env.TEST_LIMIT = "12";
    expect(envInt("TEST_LIMIT", 7)).toBe(12);
    process.env.TEST_LIMIT = "0";
    expect(envInt("TEST_LIMIT", 7)).toBe(0);
  });
});
