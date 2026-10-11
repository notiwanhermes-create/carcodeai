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
  for (const k of ["DATABASE_URL", "OPENAI_API_KEY", "DIAGNOSE_GUEST_DAILY_LIMIT"]) saved[k] = process.env[k];
  delete process.env.DATABASE_URL;
  process.env.OPENAI_API_KEY = "test-key-not-real";
  // These tests are about codes, not allowances.
  process.env.DIAGNOSE_GUEST_DAILY_LIMIT = "100";
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
  it("local-reference code alone: shows the title and its status, asks for symptoms, and makes no model call", async () => {
    for (const code of ["P0300", "P0011", "P0016", "P0171", "P0420", "P0455", "P0A80", "U0100", "P0300 P0420"]) {
      const res = await POST(makeReq({ code }));
      expect(res.status, code).toBe(200); // not an error: the title is shown
      const data = await res.json();
      expect(data.noDefinition, code).toBe(true);
      expect(data.diagnosis).toBeUndefined();
      expect(data.codes[0]).toMatchObject({ status: "generic_definition", trust: "local_reference", verified: false });
      expect(data.codes[0].definition, code).toBeTruthy();
      expect(data.message, code).toMatch(/commonly published titles? for (this code|these codes), but (it has|they have) not been verified/);
      expect(data.message).toMatch(/Describe the symptoms as well/);
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it("local-reference code alone does not use any allowance", async () => {
    process.env.DIAGNOSE_GUEST_DAILY_LIMIT = "1";
    for (let i = 0; i < 4; i++) expect((await POST(makeReq({ code: "P0300" }))).status).toBe(200);
    // The one diagnosis the visitor is allowed is still available.
    const res = await POST(makeReq({ code: "P0300", symptoms: "rough idle" }));
    expect(res.status).toBe(200);
    expect((await res.json()).diagnosis.causes).toHaveLength(1);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("local-reference code + symptoms: one model call, with the title marked as a non-authoritative local reference", async () => {
    const res = await POST(makeReq({ code: "P0171", symptoms: "hesitates on acceleration" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.diagnosis.causes).toHaveLength(1);
    expect(data.codes[0]).toMatchObject({ code: "P0171", trust: "local_reference", verified: false });
    expect(createMock).toHaveBeenCalledTimes(1);

    const { context, instructions } = sentToModel(createMock);
    expect(context.trouble_codes).toEqual([
      {
        code: "P0171",
        definition: "System Too Lean (Bank 1)",
        definition_status: "local_reference",
        scope: "standardized",
        note: "Reference title entered locally. It is not verified and not authoritative.",
      },
    ]);
    expect(context.symptoms).toBe("hesitates on acceleration");
    expect(instructions).toMatch(/"local_reference" is only a commonly published title entered by hand: it is not verified and not authoritative/);
  });

  it("a mix of local-reference and unsupported codes, no symptoms: still no model call", async () => {
    const res = await POST(makeReq({ code: "P0300 P2096 P1345" }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.noDefinition).toBe(true);
    expect(data.codes.map((c: { trust: string }) => c.trust)).toEqual(["local_reference", "none", "none"]);
    expect(data.message).toMatch(/does not have a verified definition for these codes yet, so the codes alone are not enough/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("several codes + symptoms: all of them are sent together", async () => {
    await POST(makeReq({ code: "P0300, P0171; P0420", symptoms: "rough idle around 1200 RPM, hesitation under light throttle" }));
    const { context } = sentToModel(createMock);
    expect((context.trouble_codes as Array<{ code: string }>).map((c) => c.code)).toEqual(["P0300", "P0171", "P0420"]);
    expect(context.symptoms).toBe("rough idle around 1200 RPM, hesitation under light throttle");
    expect(context.unidentified_codes).toBeUndefined();
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
      const res = await POST(makeReq({ make, code: "P0420", symptoms: "sulphur smell" }));
      definitions.add((await res.json()).codes[0].definition);
    }
    expect([...definitions]).toEqual(["Catalyst System Efficiency Below Threshold (Bank 1)"]);
  });

  it("never tells the model a hand-entered title is verified", async () => {
    await POST(makeReq({ code: "P0300 P0420 U0100", symptoms: "rough idle" }));
    const { context, userContent } = sentToModel(createMock);
    for (const c of context.trouble_codes as Array<{ definition_status: string }>) expect(c.definition_status).toBe("local_reference");
    expect(userContent).not.toMatch(/"verified"|SAE|official/);
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
      expect(context.unidentified_codes).toMatchObject({ count: 1, manufacturer_specific: c.manufacturer });
      expect((context.unidentified_codes as { note: string }).note).toMatch(/Its identifier and meaning are intentionally not provided and must not be inferred\./);
      // Nothing the model reads uses the app's internal handling terms.
      expect(everything).not.toMatch(/withheld|unsupported|redact/i);
    });
  }

  it("the number is withheld even when it is repeated in the symptoms", async () => {
    await POST(makeReq({ make: "Honda", code: "P2096", symptoms: "p2096 keeps returning; rough idle when cold" }));
    const { everything, context } = sentToModel(createMock);
    expect(everything).not.toMatch(/p-?\s?2096/i);
    expect(context.symptoms).toBe("[unidentified trouble code] keeps returning; rough idle when cold");
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
    expect(context.unidentified_codes).toMatchObject({ count: 3, manufacturer_specific: 1 });
  });

  it("the definition of a code is never sent in the same breath as an unsupported number", async () => {
    const res = await POST(makeReq({ code: "P0300 P2096", symptoms: "stalls when warm" }));
    expect(res.status).toBe(200);
    expect(createMock).toHaveBeenCalledTimes(1);
    const { context, everything } = sentToModel(createMock);
    expect((context.trouble_codes as Array<{ code: string }>).map((c) => c.code)).toEqual(["P0300"]);
    expect(everything).not.toContain("P2096");
  });
});
