/**
 * Deterministic FAKE adapters for tests and development. SYNTHETIC / TEST
 * ONLY. No model, no network: simple keyword rules that stand in for an AI
 * model so the bridge can be exercised end to end. Real adapters (any vendor)
 * implement the same interfaces later.
 */
import type { ExplanationAdapter } from "../explanation";
import type { ParserAdapter, WorkflowSuggestionAdapter } from "../parser";

const UNIT_WORDS: Record<string, string> = { psi: "psi", kpa: "kPa", bar: "bar", v: "V", volts: "V", volt: "V" };

/** Reads yes/no, a number with a unit, P/B/C/U codes, and option labels. Ambiguous when it sees two different numbers. */
export function createKeywordParser(): ParserAdapter {
  return {
    async parse({ expected, userText }) {
      const t = userText.toLowerCase();
      if (expected.kind === "choice" && expected.step === null) {
        const codes = [...userText.matchAll(/\b[pbcu][0-3][0-9a-f]{3}\b/gi)].map((m) => m[0]);
        const symptoms = expected.options.map((o) => o.id).filter((id) => t.includes(id.replace(/_/g, " ")));
        return codes.length || symptoms.length ? { status: "parsed", codes, symptoms } : { status: "unsupported", reason: "no codes or known symptoms mentioned" };
      }
      if (expected.kind === "yes_no" || expected.kind === "prerequisite") {
        const yes = /\b(yes|yeah|yep|it is|it was|correct)\b/.test(t);
        const no = /\b(no|nope|not)\b/.test(t);
        if (yes === no) return { status: "ambiguous", understood: userText.slice(0, 100), unclear: "whether the answer is yes or no" };
        return expected.kind === "yes_no" ? { status: "parsed", proposal: { kind: "yes_no", answer: yes ? "yes" : "no" } } : { status: "parsed", proposal: { kind: "prerequisite", met: yes } };
      }
      if (expected.kind === "measurement") {
        const found = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(psi|kpa|bar|volts?|v)\b/g)].map((m) => ({ value: Number(m[1]), unit: UNIT_WORDS[m[2]] }));
        const distinct = found.filter((f, i) => found.findIndex((g) => g.value === f.value && g.unit === f.unit) === i);
        if (distinct.length === 1) return { status: "parsed", proposal: { kind: "measurement", ...distinct[0] } };
        if (distinct.length > 1)
          return { status: "ambiguous", understood: "a reading", unclear: "which of several values was measured", interpretations: distinct.map((d) => ({ kind: "measurement", ...d })) };
        return { status: "ambiguous", understood: "a reading was mentioned", unclear: "the value or its unit" };
      }
      if ("options" in expected) {
        const hit = expected.options.filter((o) => t.includes(o.label.toLowerCase()) || t.includes(o.id.replace(/_/g, " ")));
        if (hit.length === 1) return { status: "parsed", proposal: { kind: expected.kind, ...(expected.kind === "select_test" ? { test: hit[0].id } : expected.kind === "actuator_result" || expected.kind === "service_result" ? { result: hit[0].id } : { choice: hit[0].id }) } };
        return { status: "ambiguous", understood: userText.slice(0, 100), unclear: "which option was meant" };
      }
      return { status: "unsupported", reason: "this step takes no typed input" };
    },
  };
}

/** Suggests catalog workflows whose title shares a word with the complaint. */
export function createKeywordSuggester(): WorkflowSuggestionAdapter {
  return {
    async suggest({ userText, catalog }) {
      const words = userText.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      return { workflowIds: catalog.filter((w) => words.some((word) => w.title.toLowerCase().includes(word))).map((w) => w.id) };
    },
  };
}

/** Rewords the deterministic facts it is given, nothing more. */
export function createTemplateExplainer(): ExplanationAdapter {
  return {
    async explain({ context }) {
      const r = context.nextBestTests.status === "region" ? context.nextBestTests.recommended : null;
      return {
        summary: r ? `Next, try: ${r.title}.` : context.currentStep ? `Next step: ${context.currentStep.title}.` : `The session is ${context.status}.`,
        why: r ? r.preferredOver.map((p) => `It comes before ${p.step} because of ${p.because}.`) : [],
        whatToDoNext: r ? [r.title] : context.currentStep ? [context.currentStep.title] : [],
        warnings: [...context.safety.warnings],
      };
    },
  };
}
