import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, authMock } = vi.hoisted(() => ({ sendMock: vi.fn(), authMock: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class FakeResend {
    emails = { send: sendMock };
  },
}));
vi.mock("../app/lib/auth-config", () => ({ auth: authMock }));
// No database in tests: the route falls back to a file write, which we stub out.
vi.mock("fs/promises", () => ({ appendFile: vi.fn(async () => {}), mkdir: vi.fn(async () => {}) }));

import { NextRequest } from "next/server";
import { POST } from "../app/api/feedback/route";
import { resetMemoryRateLimits } from "../app/lib/rate-limit";

const OWNER = "owner@carcode.test";
const USER_TEXT = "UNIQUE-USER-TEXT buy cheap pills at http://spam.example";

function makeReq(body: unknown, ip = "203.0.113.7") {
  return new NextRequest("http://localhost/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type SentEmail = { to: string[]; subject: string; text?: string; html?: string };
const sent = () => sendMock.mock.calls.map((c) => c[0] as SentEmail);

const ENV_KEYS = ["DATABASE_URL", "RESEND_API_KEY", "FEEDBACK_TO", "FEEDBACK_FROM", "FEEDBACK_IP_HOURLY_LIMIT", "FEEDBACK_IP_DAILY_LIMIT", "FEEDBACK_REPLY_DAILY_LIMIT"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.RESEND_API_KEY = "test-resend-key";
  process.env.FEEDBACK_TO = OWNER;
  process.env.FEEDBACK_FROM = "CarCode AI <no-reply@carcode.test>";
  resetMemoryRateLimits();
  sendMock.mockReset();
  sendMock.mockResolvedValue({ error: null });
  authMock.mockReset();
  authMock.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("POST /api/feedback — not an email relay", () => {
  it("accepts guest feedback and emails only the site owner", async () => {
    const res = await POST(makeReq({ message: USER_TEXT, email: "victim@example.com", name: "Guest", rating: 4 }));
    expect(res.status).toBe(200);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].to).toEqual([OWNER]);
    // Nothing is ever sent to an address a guest typed in.
    expect(sent().some((e) => e.to.includes("victim@example.com"))).toBe(false);
  });

  it("sends a fixed-text confirmation only to the signed-in user's own address", async () => {
    authMock.mockResolvedValue({ user: { id: "u1", email: "Me@Example.com" } });
    const res = await POST(makeReq({ message: USER_TEXT, email: "me@example.com" }));
    expect(res.status).toBe(200);

    const toUser = sent().filter((e) => e.to.includes("me@example.com"));
    expect(toUser).toHaveLength(1);
    const content = `${toUser[0].subject}\n${toUser[0].text ?? ""}\n${toUser[0].html ?? ""}`;
    expect(content).not.toContain("UNIQUE-USER-TEXT");
    expect(content).not.toContain("spam.example");
  });

  it("does not email a different address even when signed in", async () => {
    authMock.mockResolvedValue({ user: { id: "u1", email: "me@example.com" } });
    await POST(makeReq({ message: USER_TEXT, email: "someone-else@example.com" }));
    expect(sent().every((e) => e.to.length === 1 && e.to[0] === OWNER)).toBe(true);
  });

  it("caps confirmation emails per user per day", async () => {
    process.env.FEEDBACK_REPLY_DAILY_LIMIT = "1";
    authMock.mockResolvedValue({ user: { id: "u1", email: "me@example.com" } });
    await POST(makeReq({ message: "one", email: "me@example.com" }));
    await POST(makeReq({ message: "two", email: "me@example.com" }));
    expect(sent().filter((e) => e.to.includes("me@example.com"))).toHaveLength(1);
  });

  it("still succeeds when email is not configured", async () => {
    delete process.env.RESEND_API_KEY;
    const res = await POST(makeReq({ message: "works without email", email: "a@b.co" }));
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/feedback — rate limiting and validation", () => {
  it("rate-limits per IP", async () => {
    process.env.FEEDBACK_IP_HOURLY_LIMIT = "2";
    expect((await POST(makeReq({ message: "a" }))).status).toBe(200);
    expect((await POST(makeReq({ message: "b" }))).status).toBe(200);
    const blocked = await POST(makeReq({ message: "c" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another visitor can still send feedback.
    expect((await POST(makeReq({ message: "d" }, "198.51.100.20"))).status).toBe(200);
    // The blocked request did not email anyone.
    expect(sent()).toHaveLength(3);
  });

  it("validates every field", async () => {
    process.env.FEEDBACK_IP_HOURLY_LIMIT = "100"; // this test sends more than the default 5/hour
    expect((await POST(makeReq({ message: "   " }))).status).toBe(400);
    expect((await POST(makeReq({ message: "x".repeat(2001) }))).status).toBe(400);
    expect((await POST(makeReq({ message: "ok", name: "n".repeat(101) }))).status).toBe(400);
    expect((await POST(makeReq({ message: "ok", email: "not-an-email" }))).status).toBe(400);
    expect((await POST(makeReq({ message: "ok", rating: 3.5 }))).status).toBe(400);
    expect((await POST(makeReq({ message: "ok", rating: 9 }))).status).toBe(400);
    expect((await POST(makeReq({ message: { $gt: "" } }))).status).toBe(400);
    expect((await POST(makeReq("[1,2,3]"))).status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies", async () => {
    const res = await POST(makeReq({ message: "ok", name: "x".repeat(20_000) }));
    expect(res.status).toBe(413);
  });

  it("drops the query string from the page URL", async () => {
    await POST(makeReq({ message: "hi", pageUrl: "https://www.example.com/admin/feedback?token=SECRET#frag" }));
    expect(sent()[0].text).toContain("Page URL: https://www.example.com/admin/feedback");
    expect(sent()[0].text).not.toContain("SECRET");
  });
});
