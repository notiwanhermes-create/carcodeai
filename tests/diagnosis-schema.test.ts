import { describe, expect, it } from "vitest";
import { zodTextFormat } from "openai/helpers/zod";
import {
  ANSWER_TYPES,
  CHECK_LEVELS,
  LIMITATION_TOPICS,
  DIAGNOSIS_LIMITS,
  DiagnosisModelSchema,
  LIKELIHOODS,
  REPAIR_LEVELS,
  URGENCY_LEVELS,
  normalizeDiagnosis,
  reconcileDriveGuidance,
  type Likelihood,
  type Urgency,
} from "../app/lib/diagnosis-schema";
import { limitation, modelCause, modelDiagnosis } from "./helpers/diagnosis-fixture";

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
    for (const value of [...LIKELIHOODS, ...URGENCY_LEVELS, ...CHECK_LEVELS, ...REPAIR_LEVELS, ...ANSWER_TYPES, ...LIMITATION_TOPICS]) {
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
    expect(d!.drive_guidance).toEqual({ level: "caution", reason: "A misfire can damage the catalytic converter if ignored.", adjusted: null });
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
    // With no cause that calls for more care, the model's overall level is kept as it is.
    for (const level of URGENCY_LEVELS) {
      const calm = modelDiagnosis({ drive_guidance: { level, reason: "Because." }, causes: [modelCause({ urgency: "normal" })] });
      expect(normalizeDiagnosis(calm)!.drive_guidance).toEqual({ level, reason: "Because.", adjusted: null });
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
    const d = normalizeDiagnosis(modelDiagnosis({ causes: many, limitations: ["1", "2", "3", "4", "5"].map((t) => limitation(t)) }));
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

describe("drive guidance safety check", () => {
  type C = [Likelihood, Urgency];
  const causes = (...list: C[]) => list.map(([likelihood, urgency], i) => ({ id: `c${i + 1}`, likelihood, urgency }));
  const check = (overall: Urgency, ...list: C[]) => reconcileDriveGuidance({ level: overall, reason: "model reason" }, causes(...list));

  it("a likely or very likely 'stop' cause can never sit under an overall 'normal'", () => {
    for (const likelihood of ["very_likely", "likely"] as const) {
      expect(check("normal", [likelihood, "stop"])).toEqual({ level: "stop", reason: "", adjusted: { from: "normal", cause_id: "c1" } });
    }
  });

  it("a credible 'stop' cause makes the overall level 'stop', whatever the model said", () => {
    for (const overall of ["normal", "caution", "unknown"] as const) {
      const r = check(overall, ["possible", "normal"], ["likely", "stop"]);
      expect(r.level, overall).toBe("stop");
      expect(r.adjusted).toEqual({ from: overall, cause_id: "c2" });
      expect(r.reason).toBe(""); // the model's sentence argued for a different level
    }
    // Already "stop": nothing to change, and the model's reason is kept.
    expect(check("stop", ["very_likely", "stop"])).toEqual({ level: "stop", reason: "model reason", adjusted: null });
  });

  it("a possible or unlikely 'stop' cause justifies 'caution', not an order to stop", () => {
    for (const likelihood of ["possible", "unlikely"] as const) {
      const r = check("normal", ["likely", "normal"], [likelihood, "stop"]);
      expect(r, likelihood).toEqual({ level: "caution", reason: "", adjusted: { from: "normal", cause_id: "c2" } });
      // The model already said "caution": that stands, and is not escalated to "stop".
      expect(check("caution", ["likely", "normal"], [likelihood, "stop"])).toEqual({ level: "caution", reason: "model reason", adjusted: null });
    }
  });

  it("a likely 'caution' cause lifts an overall 'normal' to 'caution'", () => {
    expect(check("normal", ["very_likely", "caution"]).level).toBe("caution");
    expect(check("normal", ["likely", "caution"]).level).toBe("caution");
    // A merely possible or unlikely "caution" cause does not.
    expect(check("normal", ["possible", "caution"], ["unlikely", "caution"])).toEqual({ level: "normal", reason: "model reason", adjusted: null });
  });

  it("'normal' cannot be claimed when the urgency of a likely cause could not be judged", () => {
    expect(check("normal", ["likely", "unknown"])).toEqual({ level: "unknown", reason: "", adjusted: { from: "normal", cause_id: "c1" } });
    expect(check("normal", ["very_likely", "unknown"]).level).toBe("unknown");
    expect(check("normal", ["possible", "unknown"]).level).toBe("normal");
  });

  it("never lowers a level, and never turns 'unknown' into something that sounds safe", () => {
    const every: C[][] = [];
    for (const l of LIKELIHOODS) for (const u of URGENCY_LEVELS) every.push([[l, u]]);
    every.push([["likely", "normal"], ["possible", "stop"]], [["unlikely", "stop"], ["very_likely", "caution"]], []);
    const rank: Record<Urgency, number> = { normal: 0, unknown: 1, caution: 2, stop: 3 };

    for (const list of every) {
      for (const overall of URGENCY_LEVELS) {
        const r = check(overall, ...list);
        const label = `${overall} + ${JSON.stringify(list)}`;
        expect(rank[r.level], label).toBeGreaterThanOrEqual(rank[overall]);
        if (overall === "unknown") expect(["unknown", "stop"], label).toContain(r.level);
        if (overall === "stop") expect(r.level, label).toBe("stop");
        expect(r.adjusted === null, label).toBe(r.level === overall);
        if (r.adjusted) expect(r.reason, label).toBe("");
      }
    }
  });

  it("leaves a consistent result exactly as the model gave it", () => {
    expect(check("normal", ["likely", "normal"], ["possible", "normal"], ["unlikely", "caution"])).toEqual({ level: "normal", reason: "model reason", adjusted: null });
    expect(check("caution", ["very_likely", "caution"], ["possible", "stop"])).toEqual({ level: "caution", reason: "model reason", adjusted: null });
    expect(check("unknown", ["likely", "caution"], ["possible", "stop"])).toEqual({ level: "unknown", reason: "model reason", adjusted: null });
  });

  it("is applied to every diagnosis, and never changes the causes themselves", () => {
    const reply = modelDiagnosis({
      drive_guidance: { level: "normal", reason: "Fine to keep driving." },
      causes: [modelCause({ rank: 1, title: "Brake fluid leak", likelihood: "likely", urgency: "stop" }), modelCause({ rank: 2, title: "Worn pads", likelihood: "possible", urgency: "caution" })],
    });
    const d = normalizeDiagnosis(reply)!;
    expect(d.drive_guidance).toEqual({ level: "stop", reason: "", adjusted: { from: "normal", cause_id: "c1" } });
    expect(JSON.stringify(d)).not.toContain("Fine to keep driving");
    expect(d.causes.map((c) => `${c.title}:${c.likelihood}:${c.urgency}`)).toEqual(["Brake fluid leak:likely:stop", "Worn pads:possible:caution"]);
  });

  it("resolves the contradiction seen in live testing: overall 'caution' with a merely possible 'stop' cause stays 'caution'", () => {
    const d = normalizeDiagnosis(
      modelDiagnosis({
        drive_guidance: { level: "caution", reason: "Fuel smell suggests a possible leak." },
        causes: [
          modelCause({ rank: 1, title: "EVAP leak", likelihood: "very_likely", urgency: "caution" }),
          modelCause({ rank: 2, title: "Loose gas cap", likelihood: "likely", urgency: "caution" }),
          modelCause({ rank: 3, title: "Fuel line leak", likelihood: "possible", urgency: "stop" }),
        ],
      }),
    )!;
    expect(d.drive_guidance).toEqual({ level: "caution", reason: "Fuel smell suggests a possible leak.", adjusted: null });
    // Had that cause been likely, the overall level would be "stop".
    const worse = normalizeDiagnosis(
      modelDiagnosis({ drive_guidance: { level: "caution", reason: "x" }, causes: [modelCause({ title: "Fuel line leak", likelihood: "likely", urgency: "stop" })] }),
    )!;
    expect(worse.drive_guidance.level).toBe("stop");
  });
});

describe("internal wording never reaches the user", () => {
  it("drops limitation notes written in the app's own handling terms", () => {
    const d = normalizeDiagnosis(
      modelDiagnosis({
        limitations: [
          limitation("The withheld diagnostic trouble code meaning is unknown and may affect diagnosis."),
          limitation("One code was redacted from the request."),
          limitation("An unsupported code was supplied."),
          limitation("Its identifier and meaning are intentionally not provided."),
          limitation("The vehicle has not been inspected."),
        ],
      }),
    )!;
    expect(d.limitations).toEqual(["The vehicle has not been inspected."]);
    expect(JSON.stringify(d)).not.toMatch(/withheld|redact|unsupported|intentionally not provided/i);
  });

  it("leaves out the model's own note about a code it was not given, in any language, so the app's wording is the only one shown", () => {
    const d = normalizeDiagnosis(
      modelDiagnosis({
        limitations: [
          limitation("Unidentified additional trouble code may affect diagnosis but is not considered here.", "unidentified_code"),
          limitation("No se pudo identificar un código de avería adicional.", "unidentified_code"),
          limitation("تعذّر التعرّف على رمز عطل إضافي.", "unidentified_code"),
          limitation("No live sensor data was available.", "evidence"),
        ],
      }),
    )!;
    expect(d.limitations).toEqual(["No live sensor data was available."]);
  });

  it("does not leave the stand-in for a code number, brackets and all, in text the user reads", () => {
    const d = normalizeDiagnosis(
      modelDiagnosis({
        summary: "You said [unidentified trouble code] keeps coming back.",
        causes: [modelCause({ why_it_fits: ["[unidentified trouble code] returned after clearing."] })],
      }),
    )!;
    expect(JSON.stringify(d)).not.toContain("[unidentified trouble code]");
    expect(d.summary).toBe("You said a trouble code keeps coming back.");
  });
});
