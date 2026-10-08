import { describe, expect, it } from "vitest";
import {
  buildRegistry,
  classifyCode,
  describeCodesForPrompt,
  hasDefinitionOnFile,
  lookupCode,
  lookupCodes,
  parseCodeInput,
  DEFAULT_REGISTRY,
  PUBLIC_SCOPE_RULES,
  type DtcDataSource,
  type DtcRegistry,
  type GenericDtc,
  type ManufacturerDtc,
  type ScopeRule,
} from "../app/lib/dtc";
import { DTC_SOURCES } from "../app/data/dtc/sources";
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

describe("classification (an assumption from public information, not verified data)", () => {
  const scope = (code: string, rules?: ScopeRule[]) => {
    const c = classifyCode(code, rules);
    return c.valid ? c.scope : "invalid";
  };

  it("treats the ISO/SAE controlled blocks as generic", () => {
    for (const code of ["P0011", "P0016", "P0171", "P0300", "P0420", "P0455", "P0FFF", "P2000", "P2096", "P2187", "P2FFF", "B0001", "C0035", "U0100", "U0073"]) {
      expect(scope(code), code).toBe("generic");
    }
  });

  it("treats hybrid/EV codes with letters as ordinary P0 codes", () => {
    for (const code of ["P0A80", "P0A7F", "P0AA6", "P0B24", "P0C00"]) {
      const c = classifyCode(code);
      expect(c.valid && c.scope, code).toBe("generic");
      expect(c.valid && c.system).toBe("Powertrain");
    }
  });

  it("treats the manufacturer-controlled blocks as manufacturer-specific", () => {
    for (const code of ["P1000", "P1345", "P1A00", "P1FFF", "B1000", "B2000", "B2AAA", "C1201", "C2100", "U1000", "U2100", "U2FFF"]) {
      expect(scope(code), code).toBe("manufacturer");
    }
  });

  it("does not decide by 'P0 vs P1' alone: P2 is generic while B2, C2 and U2 are manufacturer-specific", () => {
    expect(scope("P2000")).toBe("generic");
    expect(scope("B2000")).toBe("manufacturer");
    expect(scope("C2000")).toBe("manufacturer");
    expect(scope("U2000")).toBe("manufacturer");
  });

  it("calls every group-3 code uncertain instead of guessing a sub-range", () => {
    for (const code of ["P3000", "P3190", "P33FF", "P3400", "P3497", "P3A00", "P3FFF", "B3000", "B3FFF", "C3000", "C3123", "U3000", "U3003", "U3FFF"]) {
      expect(scope(code), code).toBe("uncertain");
    }
  });

  it("covers every OBD-II block exactly once, with no gaps or overlaps", () => {
    for (const letter of ["P", "B", "C", "U"] as const) {
      for (let value = 0; value <= 0x3fff; value += 0x100) {
        const matching = PUBLIC_SCOPE_RULES.filter((r) => r.letter === letter && value >= r.from && value <= r.to);
        expect(matching, `${letter}${value.toString(16)}`).toHaveLength(1);
      }
    }
  });

  it("can be replaced by a finer rule table, and falls back to uncertain where no rule applies", () => {
    const licensed: ScopeRule[] = [
      { letter: "P", from: 0x3000, to: 0x33ff, scope: "manufacturer" },
      { letter: "P", from: 0x3400, to: 0x3fff, scope: "generic" },
    ];
    expect(scope("P33FF", licensed)).toBe("manufacturer");
    expect(scope("P3400", licensed)).toBe("generic");
    expect(scope("P0300", licensed)).toBe("uncertain"); // not covered by this table
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
      expect(hasDefinitionOnFile(r)).toBe(true);
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

  it("reports a standard-range code with no definition on file as not verified, and never invents one", () => {
    for (const code of ["P0301", "P2096", "P0234", "U0073", "B0001", "P0999"]) {
      const r = lookupCode(code, "Honda");
      expect(r.status, code).toBe("generic_unverified");
      expect(r.definition, code).toBeNull();
      expect(r.source).toBeNull();
      expect(r.verified).toBe(false);
      expect(r.message).toMatch(/^Definition not verified yet/);
      expect(hasDefinitionOnFile(r)).toBe(false);
    }
  });

  it("reports an uncertain-range code as not verified, without calling it standard or manufacturer-specific", () => {
    for (const code of ["P3400", "P3000", "U3000", "B3000", "C3000"]) {
      const r = lookupCode(code, "Honda");
      expect(r.status, code).toBe("uncertain_unavailable");
      expect(r.scope).toBe("uncertain");
      expect(r.definition, code).toBeNull();
      expect(r.verified).toBe(false);
      expect(r.message).toMatch(/^Definition not verified yet/);
      expect(hasDefinitionOnFile(r)).toBe(false);
    }
  });

  it("does not report hand-entered titles as verified, or as coming from the standard", () => {
    expect(DEFAULT_REGISTRY.generic).toHaveLength(8);
    expect(DEFAULT_REGISTRY.generic.every((g) => g.verification === "curated")).toBe(true);
    expect(DEFAULT_REGISTRY.generic.every((g) => /Entered by hand/.test(g.source) && /Not checked against licensed/.test(g.source))).toBe(true);
    expect(lookupCode("P0300").verified).toBe(false);
  });
});

/** Fixture records for the tests only. The shipped manufacturer store is empty. */
const makerRecord = (
  make: string,
  code: string,
  definition: string,
  verification: ManufacturerDtc["verification"] = "verified",
): ManufacturerDtc => ({ make, code, definition, source: "test fixture", sourceType: "other", verification });

const genericRecord = (code: string, title: string, verification: GenericDtc["verification"] = "verified"): GenericDtc => ({
  code,
  title,
  source: "test fixture",
  verification,
});

describe("manufacturer-specific codes are isolated by make", () => {
  const registry: DtcRegistry = {
    generic: DEFAULT_REGISTRY.generic,
    manufacturer: [
      makerRecord("Ford", "P1000", "FORD-ONLY DEFINITION"),
      makerRecord("BMW", "P1000", "BMW-ONLY DEFINITION"),
      makerRecord("BMW", "480A12", "BMW HEX DEFINITION"),
      makerRecord("Toyota", "P1135", "TOYOTA-ONLY DEFINITION"),
      makerRecord("Mercedes-Benz", "P1999", "UNVERIFIED MERCEDES TEXT", "unverified"),
      makerRecord("Honda", "P1456", "HONDA MEANING ONE"),
      makerRecord("Honda", "P1456", "HONDA MEANING TWO"),
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

  it("serves nothing when one make has two different meanings on file for a code", () => {
    const r = lookupCode("P1456", "Honda", registry);
    expect(r.status).toBe("manufacturer_unavailable");
    expect(r.definition).toBeNull();
  });

  it("ships with no manufacturer definitions, so nothing unverified can leak", () => {
    expect(DEFAULT_REGISTRY.manufacturer).toEqual([]);
    for (const [code, make] of [["P1000", "Ford"], ["480A12", "BMW"], ["480A0C", "BMW"], ["P1345", "Chevrolet"], ["C1201", "Toyota"], ["U1000", "Honda"], ["B1200", "Mercedes-Benz"]]) {
      const r = lookupCode(code, make);
      expect(r.status, `${code} ${make}`).toBe("manufacturer_unavailable");
      expect(r.definition).toBeNull();
      expect(hasDefinitionOnFile(r)).toBe(false);
    }
  });
});

describe("data sources (how licensed data would be added)", () => {
  it("accepts every record that ships today", () => {
    const { registry, rejected } = buildRegistry(DTC_SOURCES);
    expect(rejected).toEqual([]);
    expect(registry.generic).toHaveLength(8);
    expect(registry.manufacturer).toHaveLength(0);
  });

  it("declares one source per provider role", () => {
    expect(DTC_SOURCES.map((s) => s.role).sort()).toEqual(["manufacturer", "standardized"]);
    expect(DTC_SOURCES.every((s) => s.provider && s.licence)).toBe(true);
  });

  it("lets a licensed standardized source be added in front of the hand-entered core, with no lookup changes", () => {
    const licensed: DtcDataSource = {
      id: "licensed-standard",
      role: "standardized",
      provider: "test fixture",
      licence: "test fixture",
      records: [genericRecord("P0300", "LICENSED P0300 TITLE"), genericRecord("P2096", "LICENSED P2096 TITLE"), genericRecord("p3400", "LICENSED P3400 TITLE")],
    };
    const { registry, rejected } = buildRegistry([licensed, ...DTC_SOURCES]);
    // The hand-entered P0300 loses to the licensed one and is reported, not served.
    expect(rejected).toEqual([{ sourceId: "curated-core", code: "P0300", reason: "already defined by a higher-priority source" }]);

    const p0300 = lookupCode("P0300", "Kia", registry);
    expect(p0300).toMatchObject({ status: "generic_definition", definition: "LICENSED P0300 TITLE", verified: true });
    expect(lookupCode("P2096", "Kia", registry)).toMatchObject({ status: "generic_definition", definition: "LICENSED P2096 TITLE", verified: true });
    // A verified record settles a code the range rules leave uncertain.
    expect(lookupCode("P3400", "Kia", registry)).toMatchObject({ status: "generic_definition", scope: "generic", definition: "LICENSED P3400 TITLE" });
    // Codes the licensed source does not cover still come from the core.
    expect(lookupCode("P0420", "Kia", registry).definition).toBe("Catalyst System Efficiency Below Threshold (Bank 1)");
  });

  it("lets a licensed manufacturer source be added, still isolated by make", () => {
    const oem: DtcDataSource = {
      id: "licensed-oem",
      role: "manufacturer",
      provider: "test fixture",
      licence: "test fixture",
      records: [makerRecord("Toyota", "P1135", "TOYOTA-ONLY DEFINITION"), makerRecord("Toyota", "P3190", "TOYOTA P3190 DEFINITION")],
    };
    const { registry, rejected } = buildRegistry([...DTC_SOURCES, oem]);
    expect(rejected).toEqual([]);
    expect(lookupCode("P1135", "Toyota", registry).definition).toBe("TOYOTA-ONLY DEFINITION");
    expect(lookupCode("P1135", "Lexus", registry).definition).toBeNull();
    // An uncertain-range code with a make-specific record is served for that make only.
    expect(lookupCode("P3190", "Toyota", registry)).toMatchObject({ status: "manufacturer_definition", make: "Toyota" });
    expect(lookupCode("P3190", "Ford", registry)).toMatchObject({ status: "uncertain_unavailable", definition: null });
  });

  it("leaves out records that fail a check, and says why", () => {
    const bad: DtcDataSource[] = [
      {
        id: "std",
        role: "standardized",
        provider: "test fixture",
        licence: "test fixture",
        records: [
          genericRecord("P1000", "A MANUFACTURER CODE PRESENTED AS STANDARD"),
          genericRecord("P3400", "HAND-ENTERED TITLE IN AN UNCERTAIN RANGE", "curated"),
          genericRecord("HELLO", "NOT A CODE"),
          genericRecord("P0500", ""),
          { ...genericRecord("P0501", "NO SOURCE"), source: " " },
          { ...genericRecord("P0502", "BAD STATUS"), verification: "official" as GenericDtc["verification"] },
        ],
      },
      {
        id: "oem",
        role: "manufacturer",
        provider: "test fixture",
        licence: "test fixture",
        records: [
          makerRecord("Ford", "P0300", "A STANDARD CODE PRESENTED AS FORD-SPECIFIC"),
          makerRecord("", "P1000", "NO MAKE"),
          makerRecord("Ford", "P1001", ""),
          makerRecord("Ford", "P1002", "NOT VERIFIED", "unverified"),
        ],
      },
    ];
    const { registry, rejected } = buildRegistry(bad);
    expect(registry.generic).toEqual([]);
    expect(registry.manufacturer).toEqual([]);
    expect(rejected.map((r) => `${r.sourceId} ${r.code}: ${r.reason}`)).toEqual([
      "std P1000: manufacturer-specific code in a standardized source",
      "std P3400: range not established as standardized",
      "std HELLO: not a valid code",
      "std P0500: no definition",
      "std P0501: no source recorded",
      "std P0502: unknown verification status",
      "oem P0300: standardized code in a manufacturer source",
      "oem P1000: no make recorded",
      "oem P1001: no definition",
      "oem P1002: not verified",
    ]);
  });

  it("never serves a standardized definition for a manufacturer-specific code, even from a hand-built registry", () => {
    const registry: DtcRegistry = {
      generic: [genericRecord("P1000", "WRONGLY FILED AS STANDARD"), genericRecord("P3400", "HAND-ENTERED", "curated")],
      manufacturer: [],
    };
    expect(lookupCode("P1000", "Ford", registry)).toMatchObject({ status: "manufacturer_unavailable", definition: null });
    expect(lookupCode("P3400", "Ford", registry)).toMatchObject({ status: "uncertain_unavailable", definition: null });
  });
});

describe("several codes at once", () => {
  it("reports every code, including unknown and invalid ones", () => {
    const results = lookupCodes("P0300 P9999, p1234; P0301 p3400", "Honda");
    expect(results.map((r) => `${r.code}:${r.status}`)).toEqual([
      "P0300:generic_definition",
      "P9999:invalid",
      "P1234:manufacturer_unavailable",
      "P0301:generic_unverified",
      "P3400:uncertain_unavailable",
    ]);
    expect(results.filter(hasDefinitionOnFile).map((r) => r.code)).toEqual(["P0300"]);
  });
});

describe("what the AI is told", () => {
  const prompt = describeCodesForPrompt(lookupCodes("P0300, P0301, P1234, P3400, P9999", "BMW"), "BMW");
  const line = (code: string) => prompt.split("\n").find((l) => l.startsWith(`- ${code}:`)) || "";

  it("gives the exact definition only when one is on file", () => {
    expect(line("P0300")).toContain("standardized code");
    expect(line("P0300")).toContain('"Random/Multiple Cylinder Misfire Detected"');
    expect(prompt.match(/Definition on file|Verified definition/g)).toHaveLength(1);
  });

  it("says the definition is unavailable for a standard-range code that is not on file, and forbids supplying one", () => {
    expect(line("P0301")).toMatch(/the exact definition of this code is NOT available/);
    expect(line("P0301")).toMatch(/Do NOT state, guess, invent or imply what this code means/);
    expect(line("P0301")).toMatch(/Base the diagnosis only on the reported symptoms and the vehicle/);
    expect(line("P0301")).not.toMatch(/general knowledge|you may/i);
  });

  it("forbids guessing a manufacturer-specific meaning", () => {
    expect(line("P1234")).toMatch(/manufacturer-specific code\. Its exact meaning for BMW is NOT available/);
    expect(line("P1234")).toMatch(/Do NOT state, guess, invent or imply what this code means/);
    expect(line("P1234")).toMatch(/Do not use the meaning it has on any other make/);
  });

  it("forbids guessing an uncertain code, and does not call it standard or manufacturer-specific", () => {
    expect(line("P3400")).toMatch(/NOT available, and it is not known whether it is a standardized or a manufacturer-specific code/);
    expect(line("P3400")).toMatch(/Do NOT state, guess, invent or imply what this code means/);
  });

  it("tells the model to ignore invalid entries, and never calls missing data verified or authoritative", () => {
    expect(line("P9999")).toMatch(/not a valid trouble code/);
    expect(prompt).not.toMatch(/authoritative/i);
    for (const code of ["P0301", "P1234", "P3400", "P9999"]) expect(line(code)).not.toMatch(/verified/i);
  });
});
