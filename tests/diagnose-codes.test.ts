/**
 * The diagnose endpoint and trouble codes, end to end with a fake AI client.
 *
 * It must report every code back to the page, show the model only the codes
 * that have a definition on file, and never call the model when there is
 * nothing but an unsupported code to go on.
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
import { modelDiagnosis, modelReply, sentToModel } from "./helpers/diagnosis-fixture";

function makeReq(body: Record<string, unknown>) {
  return new Request("http://localhost/api/diagnose", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.77" },
    body: JSON.stringify({ year: "2016", make: "BMW", model: "328i", engine: "", symptoms: "", lang: "en", ...body }),
  });
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["DATABASE_URL", "OPENAI_API_KEY"]) saved[k] = process.env[k];
  delete process.env.DATABASE_URL;
  process.env.OPENAI_API_KEY = "test-key-not-real";
  resetMemoryRateLimits();
  createMock.mockReset();
  createMock.mockResolvedValue(modelReply(modelDiagnosis()));
  authMock.mockReset();
  authMock.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("POST /api/diagnose: codes with a definition on file", () => {
  it("code only: sends the definition to the model and reports it to the page", async () => {
    const res = await POST(makeReq({ code: "P0300" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.codes).toHaveLength(1);
    expect(data.codes[0]).toMatchObject({ code: "P0300", status: "generic_definition", trust: "local_reference", verified: false, definition: "Random/Multiple Cylinder Misfire Detected" });
    expect(data.diagnosis.causes).toHaveLength(1);
    expect(createMock).toHaveBeenCalledTimes(1);

    const { context } = sentToModel(createMock);
    expect(context.trouble_codes).toEqual([
      { code: "P0300", definition: "Random/Multiple Cylinder Misfire Detected", definition_status: "local_reference", scope: "standardized" },
    ]);
    expect(context.symptoms).toBeNull();
  });

  it("code + symptoms: the model receives both", async () => {
    await POST(makeReq({ code: "P0171", symptoms: "hesitates on acceleration" }));
    const { context } = sentToModel(createMock);
    expect(context.trouble_codes).toEqual([{ code: "P0171", definition: "System Too Lean (Bank 1)", definition_status: "local_reference", scope: "standardized" }]);
    expect(context.symptoms).toBe("hesitates on acceleration");
  });

  it("several codes + symptoms: all of them are sent together", async () => {
    await POST(makeReq({ code: "P0300, P0171; P0420", symptoms: "rough idle around 1200 RPM, hesitation under light throttle" }));
    const { context } = sentToModel(createMock);
    expect((context.trouble_codes as Array<{ code: string }>).map((c) => c.code)).toEqual(["P0300", "P0171", "P0420"]);
    expect(context.symptoms).toBe("rough idle around 1200 RPM, hesitation under light throttle");
    expect(context.unsupported_codes).toBeUndefined();
  });

  it("symptoms only: no codes are mentioned at all", async () => {
    const res = await POST(makeReq({ symptoms: "grinding noise when braking" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.codes).toEqual([]);
    const { context } = sentToModel(createMock);
    expect(context).toEqual({
      vehicle: { year: "2016", make: "BMW", model: "328i" },
      trouble_codes: [],
      symptoms: "grinding noise when braking",
    });
  });

  it("gives the same standard definition regardless of make", async () => {
    const definitions = new Set<string>();
    for (const make of ["BMW", "Ford", "Toyota", "Honda", "Chevrolet", "Mercedes-Benz"]) {
      const res = await POST(makeReq({ make, code: "P0420" }));
      definitions.add((await res.json()).codes[0].definition);
    }
    expect([...definitions]).toEqual(["Catalyst System Efficiency Below Threshold (Bank 1)"]);
  });

  it("never tells the model a hand-entered title is verified", async () => {
    await POST(makeReq({ code: "P0300 P0420 U0100" }));
    const { context, userContent } = sentToModel(createMock);
    for (const c of context.trouble_codes as Array<{ definition_status: string }>) expect(c.definition_status).toBe("local_reference");
    expect(userContent).not.toMatch(/"verified"|SAE/);
  });
});

describe("POST /api/diagnose: codes with NO definition on file", () => {
  it("unsupported standard code alone: no model call", async () => {
    for (const code of ["P2096", "P0301", "U0073", "P2096 P0301"]) {
      const res = await POST(makeReq({ code }));
      expect(res.status, code).toBe(200); // reported, not an error
      const data = await res.json();
      expect(data.noDefinition).toBe(true);
      expect(data.diagnosis).toBeUndefined();
      expect(data.codes[0]).toMatchObject({ status: "generic_unverified", trust: "none", definition: null, verified: false });
      expect(data.message).toMatch(/does not have a verified definition for (this code|these codes) yet/);
      expect(data.message).not.toMatch(/manufacturer-specific/);
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it("unsupported manufacturer code alone: no model call", async () => {
    for (const body of [{ make: "BMW", code: "P1345" }, { make: "Toyota", code: "P1135" }, { make: "BMW", code: "480A12" }, { make: "Ford", code: "U1000" }]) {
      const res = await POST(makeReq(body));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.noDefinition).toBe(true);
      expect(data.diagnosis).toBeUndefined();
      expect(data.codes[0]).toMatchObject({ status: "manufacturer_unavailable", trust: "none", definition: null, verified: false });
      expect(data.message).toMatch(/manufacturer-specific/);
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it("uncertain-range code alone: no model call", async () => {
    for (const code of ["P3400", "U3000", "B3000"]) {
      const res = await POST(makeReq({ code }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.noDefinition).toBe(true);
      expect(data.codes[0]).toMatchObject({ code, status: "uncertain_unavailable", definition: null, verified: false });
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it("an unsupported code typed into the symptoms box instead is still not a reason to call the model", async () => {
    const res = await POST(makeReq({ symptoms: "P2096" }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.noDefinition).toBe(true);
    expect(data.codes[0]).toMatchObject({ code: "P2096", status: "generic_unverified" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("an unrecognisable entry is reported clearly without calling the model", async () => {
    const res = await POST(makeReq({ code: "hello" }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.noDefinition).toBe(true);
    expect(data.codes[0].status).toBe("invalid");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("uses one clear message when unsupported codes of different kinds are entered together", async () => {
    const res = await POST(makeReq({ make: "BMW", code: "P1345 P2096 hello" }));
    const data = await res.json();
    expect(data.noDefinition).toBe(true);
    expect(data.codes.map((c: { status: string }) => c.status)).toEqual(["manufacturer_unavailable", "generic_unverified", "invalid"]);
    expect(data.message).toMatch(/does not have a verified definition for these codes yet/);
    expect(createMock).not.toHaveBeenCalled();
  });

  const withSymptoms: Array<{ name: string; make: string; code: string; status: string; manufacturer: number }> = [
    { name: "unsupported standard code", make: "Honda", code: "P2096", status: "generic_unverified", manufacturer: 0 },
    { name: "unsupported manufacturer code", make: "BMW", code: "P1345", status: "manufacturer_unavailable", manufacturer: 1 },
    { name: "maker-format code", make: "BMW", code: "480A12", status: "manufacturer_unavailable", manufacturer: 1 },
    { name: "uncertain-range code", make: "Honda", code: "P3400", status: "uncertain_unavailable", manufacturer: 0 },
  ];
  for (const c of withSymptoms) {
    it(`${c.name} + symptoms: diagnoses the symptoms and withholds the code number from the model`, async () => {
      const res = await POST(makeReq({ make: c.make, code: c.code, symptoms: "rough idle when cold" }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.diagnosis.causes).toHaveLength(1);
      // The page still gets the code and its status.
      expect(data.codes[0]).toMatchObject({ code: c.code, status: c.status, definition: null, verified: false });
      expect(createMock).toHaveBeenCalledTimes(1);

      const { context, everything } = sentToModel(createMock);
      expect(everything.toUpperCase()).not.toContain(c.code);
      expect(context.trouble_codes).toEqual([]);
      expect(context.symptoms).toBe("rough idle when cold");
      expect(context.unsupported_codes).toMatchObject({ count: 1, manufacturer_specific: c.manufacturer });
      expect((context.unsupported_codes as { notice: string }).notice).toMatch(/withheld\. Do not infer its meaning\./);
    });
  }

  it("the number is withheld even when it is repeated in the symptoms", async () => {
    await POST(makeReq({ make: "Honda", code: "P2096", symptoms: "p2096 keeps returning; rough idle when cold" }));
    const { everything, context } = sentToModel(createMock);
    expect(everything).not.toMatch(/p-?\s?2096/i);
    expect(context.symptoms).toBe("[code withheld] keeps returning; rough idle when cold");
  });

  it("one supported and several unsupported codes: the model gets the definition on file and none of the other numbers", async () => {
    const res = await POST(makeReq({ code: "P0300 P2096 P1345 P3400 P9999", symptoms: "misfire at idle" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.codes.map((c: { code: string; status: string }) => `${c.code}:${c.status}`)).toEqual([
      "P0300:generic_definition",
      "P2096:generic_unverified",
      "P1345:manufacturer_unavailable",
      "P3400:uncertain_unavailable",
      "P9999:invalid",
    ]);
    expect(createMock).toHaveBeenCalledTimes(1);
    const { context, everything } = sentToModel(createMock);
    expect((context.trouble_codes as Array<{ code: string }>).map((c) => c.code)).toEqual(["P0300"]);
    for (const hidden of ["P2096", "P1345", "P3400", "P9999"]) expect(everything, hidden).not.toContain(hidden);
    expect(context.unsupported_codes).toMatchObject({ count: 3, manufacturer_specific: 1 });
  });

  it("one supported code and an unsupported one, no symptoms: still diagnoses from the supported code only", async () => {
    const res = await POST(makeReq({ code: "P0300 P2096" }));
    expect(res.status).toBe(200);
    expect(createMock).toHaveBeenCalledTimes(1);
    const { context, everything } = sentToModel(createMock);
    expect((context.trouble_codes as Array<{ code: string }>).map((c) => c.code)).toEqual(["P0300"]);
    expect(everything).not.toContain("P2096");
  });
});
