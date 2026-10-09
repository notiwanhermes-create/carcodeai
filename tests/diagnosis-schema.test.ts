import { describe, expect, it } from "vitest";
import { zodTextFormat } from "openai/helpers/zod";
import {
  ANSWER_TYPES,
  CHECK_LEVELS,
  DIAGNOSIS_LIMITS,
  DiagnosisModelSchema,
  LIKELIHOODS,
  REPAIR_LEVELS,
  URGENCY_LEVELS,
  normalizeDiagnosis,
} from "../app/lib/diagnosis-schema";
import { modelCause, modelDiagnosis } from "./helpers/diagnosis-fixture";

describe("the schema sent to the AI model", () => {
  const format = zodTextFormat(DiagnosisModelSchema, "diagnosis") as unknown as {
    type: string;
    name: string;
    strict: boolean;
    schema: Record<string, unknown>;
  };

  /** Every object node in the JSON schema. */
  function objects(node: unknown, found: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    if (Array.isArray(node)) node.forEach((n) => objects(n, found));
    else if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (o.type === "object") found.push(o);
      Object.values(o).forEach((v) => objects(v, found));
    }
    return found;
  }

  it("is a strict JSON schema, not free-form JSON mode", () => {
    expect(format.type).toBe("json_schema");
    expect(format.strict).toBe(true);
    expect(format.name).toBe("diagnosis");
  });

  it("closes every object and requires every field, as strict mode demands", () => {
    const all = objects(format.schema);
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (const o of all) {
      expect(o.additionalProperties, JSON.stringify(o).slice(0, 80)).toBe(false);
      expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as object).sort());
    }
  });

  it("uses only keywords strict mode is known to accept", () => {
    const text = JSON.stringify(format.schema);
    for (const keyword of ["minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "format"]) {
      expect(text, keyword).not.toContain(`"${keyword}"`);
    }
  });

  it("carries the enums as stable English identifiers", () => {
    const text = JSON.stringify(format.schema);
    for (const value of [...LIKELIHOODS, ...URGENCY_LEVELS, ...CHECK_LEVELS, ...REPAIR_LEVELS, ...ANSWER_TYPES]) {
      expect(text).toContain(`"${value}"`);
    }
  });

  it("has no field for a percentage, a price or labour time", () => {
    const names = objects(format.schema).flatMap((o) => Object.keys(o.properties as object));
    expect(names.join(" ")).not.toMatch(/percent|confidence|score|price|cost|labou?r|hours/i);
  });
});

describe("checking the model's reply", () => {
  it("accepts a correct reply and keeps its content", () => {
    const d = normalizeDiagnosis(modelDiagnosis());
    expect(d).not.toBeNull();
    expect(d!.summary).toMatch(/not confirmed/);
    expect(d!.drive_guidance).toEqual({ level: "caution", reason: "A misfire can damage the catalytic converter if ignored." });
    expect(d!.causes).toHaveLength(1);
    expect(d!.causes[0]).toMatchObject({ id: "c1", rank: 1, title: "Worn spark plugs", likelihood: "likely", urgency: "caution", repair_level: "diy_moderate" });
    expect(d!.causes[0].checks).toEqual([{ instruction: "Look at the service record for the last plug change.", level: "owner" }]);
    expect(d!.limitations).toEqual(["The vehicle has not been inspected."]);
  });

  it("passes every likelihood value through unchanged", () => {
    const d = normalizeDiagnosis(modelDiagnosis({ causes: LIKELIHOODS.map((likelihood, i) => modelCause({ rank: i + 1, title: `Cause ${i + 1}`, likelihood })) }));
    expect(d!.causes.map((c) => c.likelihood)).toEqual([...LIKELIHOODS]);
  });

  it("passes every urgency value through unchanged, for causes and for drive guidance", () => {
    const d = normalizeDiagnosis(modelDiagnosis({ causes: URGENCY_LEVELS.map((urgency, i) => modelCause({ rank: i + 1, title: `Cause ${i + 1}`, urgency })) }));
    expect(d!.causes.map((c) => c.urgency)).toEqual([...URGENCY_LEVELS]);
    for (const level of URGENCY_LEVELS) {
      expect(normalizeDiagnosis(modelDiagnosis({ drive_guidance: { level, reason: "" } }))!.drive_guidance.level).toBe(level);
    }
  });

  it("never upgrades 'unknown' drive guidance to something that sounds safe", () => {
    const d = normalizeDiagnosis(modelDiagnosis({ drive_guidance: { level: "unknown", reason: "Not enough detail to judge." } }));
    expect(d!.drive_guidance.level).toBe("unknown");
  });

  it("allows zero follow-up questions and zero limitations", () => {
    const d = normalizeDiagnosis(modelDiagnosis({ follow_up_questions: [], limitations: [] }));
    expect(d!.follow_up_questions).toEqual([]);
    expect(d!.limitations).toEqual([]);
  });

  it("keeps several follow-up questions, typed, with ids the page can key on", () => {
    const d = normalizeDiagnosis(
      modelDiagnosis({
        follow_up_questions: [
          { id: "x", question: "Is the check engine light flashing?", answer_type: "yes_no", options: [{ id: "a", label: "ignored" }], why_it_matters: "A flashing light points to an active misfire." },
          { id: "x", question: "When is it worst?", answer_type: "single_choice", options: [{ id: "1", label: "Cold start" }, { id: "1", label: "Hot engine" }, { id: "", label: " " }], why_it_matters: "Narrows the cause." },
          { id: "", question: "What was repaired most recently?", answer_type: "free_text", options: [], why_it_matters: "Recent work can introduce faults." },
        ],
      }),
    );
    expect(d!.follow_up_questions.map((q) => `${q.id}:${q.answer_type}:${q.options.length}`)).toEqual(["q1:yes_no:0", "q2:single_choice:2", "q3:free_text:0"]);
    expect(d!.follow_up_questions[1].options).toEqual([{ id: "o1", label: "Cold start" }, { id: "o2", label: "Hot engine" }]);
  });

  it("drops a choice question that has no usable choices instead of showing it broken", () => {
    const d = normalizeDiagnosis(
      modelDiagnosis({ follow_up_questions: [{ id: "q", question: "Which one?", answer_type: "single_choice", options: [{ id: "a", label: "Only one" }], why_it_matters: "" }] }),
    );
    expect(d!.follow_up_questions).toEqual([]);
  });

  it("orders causes by the model's rank and renumbers them, without touching likelihood", () => {
    const d = normalizeDiagnosis(
      modelDiagnosis({
        causes: [
          modelCause({ rank: 3, title: "Third", likelihood: "possible" }),
          modelCause({ rank: 1, title: "First", likelihood: "very_likely" }),
          modelCause({ rank: 2, title: "Second", likelihood: "likely" }),
        ],
      }),
    );
    expect(d!.causes.map((c) => `${c.rank}:${c.id}:${c.title}:${c.likelihood}`)).toEqual(["1:c1:First:very_likely", "2:c2:Second:likely", "3:c3:Third:possible"]);
  });

  it("caps list sizes rather than trusting the model to", () => {
    const many = Array.from({ length: 12 }, (_, i) => modelCause({ rank: i + 1, title: `Cause ${i + 1}`, why_it_fits: ["a", "b", "c", "d", "e"], checks: Array.from({ length: 9 }, () => ({ instruction: "Check", level: "diy" as const })) }));
    const d = normalizeDiagnosis(modelDiagnosis({ causes: many, limitations: ["1", "2", "3", "4", "5"] }));
    expect(d!.causes).toHaveLength(DIAGNOSIS_LIMITS.causes);
    expect(d!.causes[0].why_it_fits).toHaveLength(DIAGNOSIS_LIMITS.whyItFits);
    expect(d!.causes[0].checks).toHaveLength(DIAGNOSIS_LIMITS.checks);
    expect(d!.limitations).toHaveLength(DIAGNOSIS_LIMITS.limitations);
  });

  it("rejects a malformed reply instead of repairing it", () => {
    const base = modelDiagnosis();
    const bad: unknown[] = [
      null,
      "text",
      {},
      { ...base, causes: "none" },
      { ...base, causes: [{ ...modelCause(), likelihood: "32%" }] },
      { ...base, causes: [{ ...modelCause(), likelihood: 0.32 }] },
      { ...base, causes: [{ ...modelCause(), urgency: "safe" }] },
      { ...base, drive_guidance: { level: "drive", reason: "" } },
      { ...base, causes: [{ title: "Only a title" }] },
      { ...base, follow_up_questions: [{ question: "No type?" }] },
    ];
    for (const reply of bad) expect(normalizeDiagnosis(reply), JSON.stringify(reply)?.slice(0, 60)).toBeNull();
  });

  it("rejects a reply with no usable cause rather than inventing one", () => {
    expect(normalizeDiagnosis(modelDiagnosis({ causes: [] }))).toBeNull();
    expect(normalizeDiagnosis(modelDiagnosis({ causes: [modelCause({ title: "   " })] }))).toBeNull();
  });

  it("returns only the documented fields: nothing numeric that could pass for confidence", () => {
    const d = normalizeDiagnosis({ ...modelDiagnosis(), confidence: 0.9, causes: [{ ...modelCause(), confidence: 87, cost: "$200", labor_hours: 2 }] });
    expect(d).not.toBeNull();
    expect(Object.keys(d!).sort()).toEqual(["causes", "drive_guidance", "follow_up_questions", "limitations", "summary"]);
    expect(Object.keys(d!.causes[0]).sort()).toEqual(
      ["checks", "explanation", "id", "likelihood", "rank", "recommended_action", "repair_level", "title", "urgency", "why_it_fits"].sort(),
    );
  });
});
