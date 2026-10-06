import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, authMock } = vi.hoisted(() => ({ createMock: vi.fn(), authMock: vi.fn() }));

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    responses = { create: createMock };
  },
}));
vi.mock("../app/lib/auth-config", () => ({ auth: authMock }));

import { POST } from "../app/api/diagnose/route";
import { resetMemoryRateLimits } from "../app/lib/rate-limit";

const GOOD_OUTPUT = {
  output_text: JSON.stringify({
    causes: [{ title: "Worn spark plugs", why: "Old plugs.", severity: "high", difficulty: "DIY Easy", confirm: ["Inspect"], fix: ["Replace"] }],
  }),
};

const VALID = { year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4", code: "P0300", symptoms: "", lang: "en" };

function makeReq(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/diagnose", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ENV_KEYS = [
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "DIAGNOSE_IP_BURST_LIMIT",
  "DIAGNOSE_IP_BURST_WINDOW_SECONDS",
  "DIAGNOSE_GUEST_DAILY_LIMIT",
  "DIAGNOSE_USER_HOURLY_LIMIT",
  "DIAGNOSE_USER_DAILY_LIMIT",
  "DIAGNOSE_GLOBAL_DAILY_LIMIT",
  "DIAGNOSE_MAX_BODY_BYTES",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.OPENAI_API_KEY = "test-key-not-real";
  resetMemoryRateLimits();
  createMock.mockReset();
  createMock.mockResolvedValue(GOOD_OUTPUT);
  authMock.mockReset();
  authMock.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.useRealTimers();
});

describe("POST /api/diagnose — validation", () => {
  it("returns a diagnosis for a valid guest request", async () => {
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.causes).toHaveLength(1);
    expect(data.debug).toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-JSON content types", async () => {
    const res = await POST(makeReq("year=2015", { "content-type": "text/plain" }));
    expect(res.status).toBe(415);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const res = await POST(makeReq("{not json"));
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects bodies over the size limit", async () => {
    process.env.DIAGNOSE_MAX_BODY_BYTES = "300";
    const res = await POST(makeReq({ ...VALID, symptoms: "x".repeat(600) }));
    expect(res.status).toBe(413);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects missing vehicle fields and over-long fields without calling the model", async () => {
    const missing = await POST(makeReq({ ...VALID, make: "" }));
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe("invalid_request");

    const tooLong = await POST(makeReq({ ...VALID, model: "m".repeat(500) }));
    expect(tooLong.status).toBe(400);

    const wrongType = await POST(makeReq({ ...VALID, symptoms: { a: 1 } }));
    expect(wrongType.status).toBe(400);

    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/diagnose — safe errors", () => {
  it("never returns provider error text to the browser", async () => {
    createMock.mockRejectedValue(new Error("401 Incorrect API key provided: sk-secret-123. Find your key at platform.openai.com"));
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toMatch(/sk-secret|API key|openai/i);
    expect(JSON.parse(text).code).toBe("service_unavailable");
  });

  it("hides configuration problems", async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toMatch(/OPENAI_API_KEY/);
  });

  it("returns a generic message, with no raw model output, when the model reply is unusable", async () => {
    vi.useFakeTimers();
    createMock.mockResolvedValue({ output_text: "SECRET-INTERNAL-TEXT this is not json" });
    const pending = POST(makeReq(VALID));
    await vi.runAllTimersAsync();
    const res = await pending;
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("SECRET-INTERNAL-TEXT");
    expect(JSON.parse(text).debug).toBeUndefined();
  });

  it("maps an upstream rate limit to a generic busy message", async () => {
    vi.useFakeTimers();
    createMock.mockRejectedValue(Object.assign(new Error("Rate limit reached for org-abc123"), { status: 429 }));
    const pending = POST(makeReq(VALID));
    await vi.runAllTimersAsync();
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.text()).not.toMatch(/org-abc123/);
  });
});

describe("POST /api/diagnose — rate limits and quotas", () => {
  it("enforces the guest daily quota per IP and tells the client when to retry", async () => {
    process.env.DIAGNOSE_GUEST_DAILY_LIMIT = "2";
    expect((await POST(makeReq(VALID))).status).toBe(200);
    expect((await POST(makeReq(VALID))).status).toBe(200);

    const blocked = await POST(makeReq(VALID));
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).code).toBe("guest_quota");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(createMock).toHaveBeenCalledTimes(2);

    // A different visitor is unaffected.
    expect((await POST(makeReq(VALID, { "x-forwarded-for": "198.51.100.9" }))).status).toBe(200);
  });

  it("does not spend quota on invalid requests", async () => {
    process.env.DIAGNOSE_GUEST_DAILY_LIMIT = "1";
    for (let i = 0; i < 3; i++) {
      expect((await POST(makeReq({ ...VALID, year: "" }))).status).toBe(400);
    }
    expect((await POST(makeReq(VALID))).status).toBe(200);
  });

  it("uses per-user limits for signed-in users instead of the guest quota", async () => {
    process.env.DIAGNOSE_GUEST_DAILY_LIMIT = "1";
    process.env.DIAGNOSE_USER_HOURLY_LIMIT = "2";
    authMock.mockResolvedValue({ user: { id: "user-1" } });

    expect((await POST(makeReq(VALID))).status).toBe(200);
    expect((await POST(makeReq(VALID))).status).toBe(200);
    const blocked = await POST(makeReq(VALID));
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).code).toBe("user_quota");

    // Another signed-in user on the same IP has their own allowance.
    authMock.mockResolvedValue({ user: { id: "user-2" } });
    expect((await POST(makeReq(VALID))).status).toBe(200);
  });

  it("applies the per-IP burst limit to every request, valid or not", async () => {
    process.env.DIAGNOSE_IP_BURST_LIMIT = "3";
    for (let i = 0; i < 3; i++) {
      expect((await POST(makeReq("{bad"))).status).toBe(400);
    }
    const blocked = await POST(makeReq(VALID));
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).code).toBe("rate_limited");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("treats an auth failure as a guest instead of failing the request", async () => {
    authMock.mockRejectedValue(new Error("auth exploded"));
    expect((await POST(makeReq(VALID))).status).toBe(200);
  });
});
