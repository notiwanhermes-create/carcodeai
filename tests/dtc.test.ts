import { describe, expect, it } from "vitest";
import {
  classifyCode,
  describeCodesForPrompt,
  isUsableForDiagnosis,
  lookupCode,
  lookupCodes,
  parseCodeInput,
  DEFAULT_REGISTRY,
  type DtcRegistry,
  type ManufacturerDtc,
} from "../app/lib/dtc";
import { parseDiagnoseBody } from "../app/lib/diagnose-input";

describe("parsing what the user typed", () => {
  it("normalises a single code", () => {
    expect(parseCodeInput("P0300")).toEqual(["P0300"]);
    expect(parseCodeInput("  p0300 ")).toEqual(["P0300"]);
    expect(parseCodeInput("P0016")).toEqual(["P0016"]);
    expect(parseCodeInput("p0a80")).toEqual(["P0A80"]);
    expect(parseCodeInput("U0100")).toEqual(["U0100"]);
  });

  it("accepts commas, spaces, semicolons and new lines in any mix", () => {
    const expected = ["P0300", "P0171"];
    expect(parseCodeInput("P0300, P0171")).toEqual(expected);
    expect(parseCodeInput("P0300 P0171")).toEqual(expected);
    expect(parseCodeInput("P0300;P0171")).toEqual(expected);
    expect(parseCodeInput("P0300\nP0171")).toEqual(expected);
    expect(parseCodeInput("P0300 ,; \r\n  P0171")).toEqual(expected);
  });

  it("removes duplicates, keeping the first occurrence", () => {
    expect(parseCodeInput("P0300, p0300 P0171 P0300")).toEqual(["P0300", "P0171"]);
  });

  it("tolerates common typing styles", () => {
    expect(parseCodeInput("P-0300")).toEqual(["P0300"]);
    expect(parseCodeInput("P 0300")).toEqual(["P0300"]);
    expect(parseCodeInput("480A-12")).toEqual(["480A12"]);
  });

  it("separates codes that were pasted from several lines into a one-line field", () => {
    // Browsers strip the line breaks, leaving the codes run together.
    expect(parseCodeInput("P0300P0171")).toEqual(["P0300", "P0171"]);
    expect(parseCodeInput("p1345P9999u0100")).toEqual(["P1345", "P9999", "U0100"]);
    expect(parseCodeInput("480A12")).toEqual(["480A12"]); // a single maker-format code is left alone
  });

  it("keeps unknown and invalid entries so they can be reported", () => {
    expect(parseCodeInput("P0300 P9999 hello")).toEqual(["P0300", "P9999", "HELLO"]);
    expect(parseCodeInput("")).toEqual([]);
    expect(parseCodeInput(null)).toEqual([]);
  });

  it("is what request validation uses (space-separated codes count individually)", () => {
    const base = { year: "2015", make: "Toyota", model: "Camry", symptoms: "" };
    const ok = parseDiagnoseBody({ ...base, code: "p0300 P0171\nP0A80;u0100" });
    expect(ok.ok && ok.value.code).toBe("P0300, P0171, P0A80, U0100");
    const tooMany = parseDiagnoseBody({ ...base, code: "P0301 P0302 P0303 P0304 P0305 P0306 P0307 P0308 P0309" });
    expect(tooMany.ok).toBe(false);
  });
});

describe("generic vs manufacturer-specific classification", () => {
  const scope = (code: string) => {
    const c = classifyCode(code);
    return c.valid ? c.scope : "invalid";
  };

  it("treats the standardized ranges as generic", () => {
    for (const code of ["P0011", "P0016", "P0171", "P0300", "P0420", "P0455", "P2096", "P2187", "P3400", "P34FF", "P3FFF", "B0001", "C0035", "U0100", "U0073", "U3000"]) {
      expect(scope(code), code).toBe("generic");
    }
  });

  it("treats hybrid/EV codes with letters as standardized P0 codes", () => {
    for (const code of ["P0A80", "P0A7F", "P0AA6", "P0B24", "P0C00"]) {
      const c = classifyCode(code);
      expect(c.valid && c.scope, code).toBe("generic");
      expect(c.valid && c.system).toBe("Powertrain");
    }
  });

  it("treats the manufacturer-controlled ranges as manufacturer-specific", () => {
    for (const code of ["P1000", "P1345", "P1A00", "P3000", "P33FF", "B1000", "B2AAA", "C1201", "C2100", "U1000", "U2100"]) {
      expect(scope(code), code).toBe("manufacturer");
    }
  });

  it("does not decide by 'P0 vs P1' alone: P2 is generic and P3 is split", () => {
    expect(scope("P2000")).toBe("generic");
    expect(scope("P33FF")).toBe("manufacturer");
    expect(scope("P3400")).toBe("generic");
  });

  it("identifies the system from the first letter", () => {
    const sys = (code: string) => {
      const c = classifyCode(code);
      return c.valid ? c.system : null;
    };
    expect(sys("P0300")).toBe("Powertrain");
    expect(sys("B0001")).toBe("Body");
    expect(sys("C0035")).toBe("Chassis");
    expect(sys("U0100")).toBe("Network");
  });

  it("treats maker-format codes as manufacturer-specific and rejects everything else", () => {
    expect(scope("480A12")).toBe("manufacturer");
    expect(scope("2A82")).toBe("manufacturer");
    for (const bad of ["P9999", "P4000", "X0300", "P030", "P03000", "HELLO", "", "P0G00"]) {
      expect(classifyCode(bad).valid, bad).toBe(false);
    }
  });
});

describe("generic codes", () => {
  it("returns the definition on file for the codes the product must support", () => {
    for (const code of ["P0011", "P0016", "P0171", "P0300", "P0420", "P0455", "P0A80", "U0100"]) {
      const r = lookupCode(code, "Toyota");
      expect(r.status, code).toBe("generic_definition");
      expect(r.definition, code).toBeTruthy();
      expect(r.source).toMatch(/SAE J2012/);
    }
    expect(lookupCode("P0300").definition).toBe("Random/Multiple Cylinder Misfire Detected");
    expect(lookupCode("P0A80").definition).toBe("Replace Hybrid Battery Pack");
  });

  it("gives the same answer for every make", () => {
    const makes = ["BMW", "Ford", "Toyota", "Honda", "Chevrolet", "Mercedes-Benz", "", null];
    for (const code of ["P0300", "P0420", "U0100", "P0A80"]) {
      const answers = makes.map((m) => {
        const r = lookupCode(code, m);
        return `${r.status}|${r.definition}|${r.scope}`;
      });
      expect(new Set(answers).size, code).toBe(1);
    }
  });

  it("does not refuse a standardized code that has no definition on file, and does not invent one", () => {
    for (const code of ["P0301", "P2096", "P0234", "U0073", "B0001", "P0999"]) {
      const r = lookupCode(code, "Honda");
      expect(r.status, code).toBe("generic_unverified");
      expect(r.definition, code).toBeNull();
      expect(r.verified).toBe(false);
      expect(isUsableForDiagnosis(r)).toBe(true);
    }
  });

  it("does not report hand-curated titles as verified", () => {
    expect(DEFAULT_REGISTRY.generic.every((g) => g.verification === "curated")).toBe(true);
    expect(lookupCode("P0300").verified).toBe(false);
  });
});

describe("manufacturer-specific codes are isolated by make", () => {
  // Fixture data for the test only. The shipped manufacturer store is empty.
  const record = (make: string, code: string, definition: string, verification: ManufacturerDtc["verification"] = "verified"): ManufacturerDtc => ({
    make,
    code,
    definition,
    source: "test fixture",
    sourceType: "other",
    verification,
  });
  const registry: DtcRegistry = {
    generic: DEFAULT_REGISTRY.generic,
    manufacturer: [
      record("Ford", "P1000", "FORD-ONLY DEFINITION"),
      record("BMW", "P1000", "BMW-ONLY DEFINITION"),
      record("BMW", "480A12", "BMW HEX DEFINITION"),
      record("Toyota", "P1135", "TOYOTA-ONLY DEFINITION"),
      record("Mercedes-Benz", "P1999", "UNVERIFIED MERCEDES TEXT", "unverified"),
    ],
  };

  it("returns a Ford definition only for Ford", () => {
    const ford = lookupCode("P1000", "Ford", registry);
    expect(ford.status).toBe("manufacturer_definition");
    expect(ford.definition).toBe("FORD-ONLY DEFINITION");
    expect(ford.make).toBe("Ford");
    expect(ford.verified).toBe(true);
  });

  it("never shows a Ford definition for BMW, or a BMW definition for Ford", () => {
    expect(lookupCode("P1000", "BMW", registry).definition).toBe("BMW-ONLY DEFINITION");
    expect(lookupCode("P1000", "Ford", registry).definition).toBe("FORD-ONLY DEFINITION");
    expect(lookupCode("480A12", "Ford", registry).definition).toBeNull();
    expect(lookupCode("480A12", "BMW", registry).definition).toBe("BMW HEX DEFINITION");
  });

  it("returns 'unavailable' with no definition for unrelated makes", () => {
    for (const make of ["Toyota", "Honda", "Chevrolet", "GMC", "Mercedes-Benz", "Lincoln", "Mini"]) {
      const r = lookupCode("P1000", make, registry);
      expect(r.status, make).toBe("manufacturer_unavailable");
      expect(r.definition, make).toBeNull();
      expect(r.verified).toBe(false);
      expect(r.message).toContain(make);
      expect(JSON.stringify(r)).not.toMatch(/FORD-ONLY|BMW-ONLY/);
    }
    expect(lookupCode("P1135", "Honda", registry).definition).toBeNull();
    expect(lookupCode("P1135", "toyota", registry).definition).toBe("TOYOTA-ONLY DEFINITION");
  });

  it("needs a make: without one, a manufacturer code has no definition", () => {
    for (const make of ["", null, undefined]) {
      const r = lookupCode("P1000", make, registry);
      expect(r.status).toBe("manufacturer_unavailable");
      expect(r.definition).toBeNull();
    }
  });

  it("never serves a record that is not marked verified", () => {
    const r = lookupCode("P1999", "Mercedes-Benz", registry);
    expect(r.status).toBe("manufacturer_unavailable");
    expect(r.definition).toBeNull();
  });

  it("ships with no manufacturer definitions, so nothing unverified can leak", () => {
    expect(DEFAULT_REGISTRY.manufacturer).toEqual([]);
    for (const [code, make] of [["P1000", "Ford"], ["480A12", "BMW"], ["480A0C", "BMW"], ["P1345", "Chevrolet"], ["C1201", "Toyota"], ["U1000", "Honda"], ["B1200", "Mercedes-Benz"]]) {
      const r = lookupCode(code, make);
      expect(r.status, `${code} ${make}`).toBe("manufacturer_unavailable");
      expect(r.definition).toBeNull();
      expect(isUsableForDiagnosis(r)).toBe(false);
    }
  });
});

describe("several codes at once", () => {
  it("reports every code, including unknown and invalid ones", () => {
    const results = lookupCodes("P0300 P9999, p1234; P0301", "Honda");
    expect(results.map((r) => `${r.code}:${r.status}`)).toEqual([
      "P0300:generic_definition",
      "P9999:invalid",
      "P1234:manufacturer_unavailable",
      "P0301:generic_unverified",
    ]);
    expect(results.filter(isUsableForDiagnosis).map((r) => r.code)).toEqual(["P0300", "P0301"]);
  });
});

describe("what the AI is told", () => {
  const prompt = describeCodesForPrompt(lookupCodes("P0300, P0301, P1234, P9999", "BMW"), "BMW");

  it("gives the exact definition only when one is on file", () => {
    expect(prompt).toContain('P0300: standardized code');
    expect(prompt).toContain('"Random/Multiple Cylinder Misfire Detected"');
    expect(prompt).toMatch(/P0301: standardized \(generic\) OBD-II code, but NO verified definition is on file/);
  });

  it("forbids guessing a manufacturer-specific meaning", () => {
    expect(prompt).toMatch(/P1234: manufacturer-specific code\. Its exact meaning for BMW is NOT available/);
    expect(prompt).toMatch(/Do NOT state, guess or imply what this code means/);
    expect(prompt).toMatch(/do not use the meaning it has on any other make/);
  });

  it("tells the model to ignore invalid entries, and never calls unverified data authoritative", () => {
    expect(prompt).toMatch(/P9999: not a valid trouble code/);
    expect(prompt).not.toMatch(/authoritative/i);
  });
});
