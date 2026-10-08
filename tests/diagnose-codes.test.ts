/**
 * The diagnose endpoint must pass the right trust level for each code to the
 * AI model, report every code back to the page, and never ask the model to
 * guess a manufacturer-specific meaning.
 */
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
    causes: [{ title: "Example cause", why: "Because.", severity: "medium", difficulty: "DIY Easy", confirm: ["Check"], fix: ["Fix"] }],
  }),
};

function makeReq(body: Record<string, unknown>) {
  return new Request("http://localhost/api/diagnose", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.77" },
    body: JSON.stringify({ year: "2016", make: "BMW", model: "328i", engine: "", symptoms: "", lang: "en", ...body }),
  });
}

/** The user message sent to the model on the most recent call. */
function promptSent(): string {
  const args = createMock.mock.calls.at(-1)?.[0] as { input: Array<{ role: string; content: string }> };
  return args.input.map((m) => m.content).join("\n");
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["DATABASE_URL", "OPENAI_API_KEY"]) saved[k] = process.env[k];
  delete process.env.DATABASE_URL;
  process.env.OPENAI_API_KEY = "test-key-not-real";
  resetMemoryRateLimits();
  createMock.mockReset();
  createMock.mockResolvedValue(GOOD_OUTPUT);
  authMock.mockReset();
  authMock.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("POST /api/diagnose — trouble code handling", () => {
  it("sends a definition on file to the model and returns it to the page", async () => {
    const res = await POST(makeReq({ code: "P0300" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.codes).toHaveLength(1);
    expect(data.codes[0]).toMatchObject({ code: "P0300", status: "generic_definition", definition: "Random/Multiple Cylinder Misfire Detected" });
    expect(data.summary_title).toBe("P0300: Random/Multiple Cylinder Misfire Detected");
    expect(promptSent()).toContain('Definition on file: "Random/Multiple Cylinder Misfire Detected"');
  });

  it("no longer refuses a standardized code that has no definition on file", async () => {
    const res = await POST(makeReq({ code: "P2096" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.codes[0]).toMatchObject({ code: "P2096", status: "generic_unverified", definition: null, verified: false });
    expect(data.causes).toHaveLength(1);
    expect(promptSent()).toMatch(/P2096: standardized \(generic\) OBD-II code, but NO verified definition is on file/);
    expect(data.summary_title).toBeUndefined();
  });

  it("processes the known code and flags the unknown one instead of failing the request", async () => {
    const res = await POST(makeReq({ code: "P0300 P9999" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.codes.map((c: { code: string; status: string }) => `${c.code}:${c.status}`)).toEqual(["P0300:generic_definition", "P9999:invalid"]);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(promptSent()).toMatch(/P9999: not a valid trouble code/);
  });

  it("does not ask the model to guess a manufacturer-specific code when there are no symptoms", async () => {
    for (const body of [{ make: "BMW", code: "P1345" }, { make: "Toyota", code: "P1135" }, { make: "BMW", code: "480A12" }, { make: "Ford", code: "U1000" }]) {
      const res = await POST(makeReq(body));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.noDefinition).toBe(true);
      expect(data.causes).toBeUndefined();
      expect(data.codes[0]).toMatchObject({ status: "manufacturer_unavailable", definition: null, verified: false });
      expect(data.message).toMatch(/manufacturer-specific/);
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it("with symptoms, diagnoses from the symptoms and tells the model the OEM meaning is unavailable", async () => {
    const res = await POST(makeReq({ make: "BMW", code: "P1345", symptoms: "rough idle when cold" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.codes[0].status).toBe("manufacturer_unavailable");
    expect(data.summary_title).toBeUndefined();
    const prompt = promptSent();
    expect(prompt).toMatch(/P1345: manufacturer-specific code\. Its exact meaning for BMW is NOT available/);
    expect(prompt).toContain("Symptoms: rough idle when cold");
    expect(prompt).not.toMatch(/Authoritative code definition/i);
  });

  it("uses both the codes and the symptoms when both are given", async () => {
    await POST(makeReq({ code: "P0171", symptoms: "hesitates on acceleration" }));
    const prompt = promptSent();
    expect(prompt).toContain('Definition on file: "System Too Lean (Bank 1)"');
    expect(prompt).toContain("Symptoms: hesitates on acceleration");
  });

  it("reports an unrecognisable entry clearly without calling the model", async () => {
    const res = await POST(makeReq({ code: "hello" }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.noDefinition).toBe(true);
    expect(data.codes[0].status).toBe("invalid");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("gives the same generic definition regardless of make", async () => {
    const definitions = new Set<string>();
    for (const make of ["BMW", "Ford", "Toyota", "Honda", "Chevrolet", "Mercedes-Benz"]) {
      const res = await POST(makeReq({ make, code: "P0420" }));
      definitions.add((await res.json()).codes[0].definition);
    }
    expect([...definitions]).toEqual(["Catalyst System Efficiency Below Threshold (Bank 1)"]);
  });
});
