/**
 * The diagnosis result: one schema, shared by the server and the page.
 *
 *  - The server sends `DiagnosisModelSchema` to the AI model as a strict JSON
 *    schema (OpenAI Structured Outputs), so the reply is structured data, not
 *    free text that has to be picked apart.
 *  - The server then checks and tidies that reply with `normalizeDiagnosis`
 *    before anything reaches the browser.
 *  - The page imports the TYPES from here (type-only, so none of this code is
 *    shipped to the browser) and renders the fields as they are.
 *
 * Every value the app makes a decision on is an enum with a stable English
 * identifier. Only the free-text fields are written in the user's language, and
 * the app never reads meaning out of them.
 *
 * Deliberately absent: confidence percentages, prices, labour hours. Ranking
 * plus a likelihood category is all the model is asked for.
 */
import { z } from "zod";
import type { DtcResult } from "./dtc";

/** How likely a cause is, as a category. Never a percentage. */
export const LIKELIHOODS = ["very_likely", "likely", "possible", "unlikely"] as const;
/**
 * Safety level, used for each cause and for the overall drive guidance.
 * "unknown" is the honest default whenever a level cannot be justified.
 */
export const URGENCY_LEVELS = ["normal", "caution", "stop", "unknown"] as const;
/** Who can safely carry out a check. */
export const CHECK_LEVELS = ["owner", "diy", "professional"] as const;
/** Who can realistically carry out the repair. */
export const REPAIR_LEVELS = ["diy_easy", "diy_moderate", "professional"] as const;
/** How a follow-up question is answered. */
export const ANSWER_TYPES = ["yes_no", "single_choice", "free_text"] as const;
/**
 * What a limitation note is about. The model tags a note about a trouble code
 * it was not given, so that note can be left out in any language: the page
 * tells the user about such a code in its own fixed wording instead.
 */
export const LIMITATION_TOPICS = ["evidence", "unidentified_code"] as const;

export type Likelihood = (typeof LIKELIHOODS)[number];
export type Urgency = (typeof URGENCY_LEVELS)[number];
export type CheckLevel = (typeof CHECK_LEVELS)[number];
export type RepairLevel = (typeof REPAIR_LEVELS)[number];
export type AnswerType = (typeof ANSWER_TYPES)[number];

// Note: no minItems/maxItems or string-length keywords. Sizes are stated in the
// descriptions and enforced by normalizeDiagnosis, which keeps the schema
// within what strict Structured Outputs accepts.
const CheckSchema = z.object({
  instruction: z.string().describe("One concrete check in plain words."),
  level: z
    .enum(CHECK_LEVELS)
    .describe(
      "owner = no tools, no lifting, nothing hot, pressurised, high-voltage or fuel-related. diy = basic tools and some experience. professional = needs a mechanic or shop equipment.",
    ),
});

const CauseSchema = z.object({
  rank: z.number().describe("1 = most likely. Whole numbers, no ties."),
  title: z.string().describe("Short name of the suspected cause."),
  explanation: z.string().describe("What this problem is, in one plain sentence."),
  why_it_fits: z.array(z.string()).describe("1-2 short points tying this cause to the evidence given."),
  likelihood: z.enum(LIKELIHOODS),
  urgency: z
    .enum(URGENCY_LEVELS)
    .describe("If this is the cause: normal = no rush, caution = limit driving and fix soon, stop = do not drive, unknown = cannot be judged."),
  checks: z.array(CheckSchema).describe("1-3 checks that would confirm or rule out this cause."),
  recommended_action: z.string().describe("The next step for this cause, in one or two sentences. No prices or labour times."),
  repair_level: z.enum(REPAIR_LEVELS).describe("Who can realistically do the repair."),
});

const FollowUpSchema = z.object({
  id: z.string(),
  question: z.string(),
  answer_type: z.enum(ANSWER_TYPES),
  options: z
    .array(z.object({ id: z.string(), label: z.string() }))
    .describe("2-5 choices for single_choice. Empty for yes_no and free_text."),
  why_it_matters: z.string().describe("One sentence on how the answer would change the diagnosis."),
});

const LimitationSchema = z.object({
  text: z.string().describe("One short note on what cannot be known from the evidence."),
  topic: z
    .enum(LIMITATION_TOPICS)
    .describe('"unidentified_code" if the note is about a trouble code that was supplied without a usable definition. Otherwise "evidence".'),
});

/** Exactly what the AI model is asked to return. */
export const DiagnosisModelSchema = z.object({
  summary: z.string().describe("One or two sentences on the most likely explanation, worded as a hypothesis."),
  drive_guidance: z.object({
    level: z
      .enum(URGENCY_LEVELS)
      .describe("normal = no urgent safety concern identified, caution = drive carefully and get it checked soon, stop = do not drive, unknown = cannot be judged from the evidence."),
    reason: z.string().describe("One sentence explaining the level."),
  }),
  causes: z.array(CauseSchema).describe("3-5 causes, most likely first."),
  follow_up_questions: z.array(FollowUpSchema).describe("0-3 questions whose answers would change the ranking. Empty if none would."),
  limitations: z.array(LimitationSchema).describe("0-2 notes."),
});

export type ModelDiagnosis = z.infer<typeof DiagnosisModelSchema>;
export type DiagnosisCheck = z.infer<typeof CheckSchema>;
/** A cause as the page receives it: ranked 1..n with an id the page can key on. */
export type DiagnosisCause = z.infer<typeof CauseSchema> & { id: string };
export type FollowUpQuestion = z.infer<typeof FollowUpSchema>;
/** Drive guidance as the page receives it, after the server's safety check. */
export type DriveGuidance = {
  level: Urgency;
  /**
   * The model's own explanation. Empty when the server changed the level, so
   * the text shown can never argue against the level shown.
   */
  reason: string;
  /** Set when the safety check changed the level: what the model said, and the cause that triggered it. */
  adjusted: null | { from: Urgency; cause_id: string };
};
/** The diagnosis as the page receives it, after the server's checks. */
export type Diagnosis = Omit<ModelDiagnosis, "causes" | "drive_guidance" | "limitations"> & {
  causes: DiagnosisCause[];
  drive_guidance: DriveGuidance;
  /** The model's notes about the evidence, as plain text. Notes about a code it was not given are not included. */
  limitations: string[];
};

/** What /api/diagnose returns for a completed diagnosis. */
export type DiagnoseOk = {
  diagnosis: Diagnosis;
  /** One entry per code the user supplied, saying how far its definition can be trusted. */
  codes: DtcResult[];
  /** True when the user's answers to follow-up questions were part of this diagnosis. */
  refined: boolean;
  /**
   * What the page needs to ask for an update with follow-up answers: a signed
   * ticket tied to this diagnosis, and how many updates it still allows.
   * Null when updates are not available.
   */
  followUp: { token: string; remaining: number } | null;
};

/** Returned, without calling the model, when the codes supplied are not enough to diagnose from and there are no symptoms. */
export type DiagnoseNoDefinition = { noDefinition: true; message: string; codes: DtcResult[] };

export const DIAGNOSIS_LIMITS = {
  causes: 5,
  whyItFits: 3,
  checks: 4,
  followUps: 4,
  options: 6,
  limitations: 3,
} as const;

/**
 * What stands in for a trouble-code number the model is not shown, in text the
 * user typed. Worded so that it reads naturally if the model repeats it.
 */
export const CODE_PLACEHOLDER = "[unidentified trouble code]";

/**
 * Words that describe how the app handles a request, not the vehicle. A
 * limitation that uses them is dropped: the page tells the user about a code it
 * could not identify in its own plain wording.
 */
const INTERNAL_WORDING = /withh[eo]ld|redact|unsupported[ _]code|unidentified_codes|not provided to (me|the model)|intentionally not provided/i;

function text(value: string, max: number): string {
  const s = value.split(CODE_PLACEHOLDER).join("a trouble code").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

function textList(values: string[], maxItems: number, maxLength: number): string[] {
  return values.map((v) => text(v, maxLength)).filter(Boolean).slice(0, maxItems);
}

const CREDIBLE: ReadonlySet<Likelihood> = new Set<Likelihood>(["very_likely", "likely"]);

/**
 * Safety-consistency check for drive guidance.
 *
 * The model does the diagnostic reasoning and proposes the overall level. This
 * only stops the result from contradicting itself in an unsafe direction. It
 * compares that level with the urgency and likelihood of the causes:
 *
 *  1. A cause marked "stop" that is very likely or likely makes the overall
 *     level "stop", whatever the model said.
 *  2. Otherwise, if the model said "normal" but any cause is marked "stop"
 *     (even a possible or unlikely one), or a very likely or likely cause is
 *     marked "caution", the overall level becomes "caution". A remote severe
 *     cause justifies care, not an order to stop.
 *  3. Otherwise, if the model said "normal" but a very likely or likely cause
 *     has an urgency of "unknown", the overall level becomes "unknown": no
 *     urgent concern cannot be claimed when the main suspect could not be judged.
 *  4. In every other case the model's level stands.
 *
 * The level is never lowered, and "unknown" is never turned into "normal" or
 * "caution": it can only become "stop".
 */
export function reconcileDriveGuidance(
  model: { level: Urgency; reason: string },
  causes: ReadonlyArray<Pick<DiagnosisCause, "id" | "likelihood" | "urgency">>,
): DriveGuidance {
  const credible = (c: { likelihood: Likelihood }) => CREDIBLE.has(c.likelihood);
  const credibleStop = causes.find((c) => c.urgency === "stop" && credible(c));
  const needsCare = causes.find((c) => c.urgency === "stop" || (c.urgency === "caution" && credible(c)));
  const unjudged = causes.find((c) => c.urgency === "unknown" && credible(c));

  let level: Urgency = model.level;
  let because: { id: string } | undefined;
  if (credibleStop) {
    if (level !== "stop") {
      level = "stop";
      because = credibleStop;
    }
  } else if (level === "normal" && needsCare) {
    level = "caution";
    because = needsCare;
  } else if (level === "normal" && unjudged) {
    level = "unknown";
    because = unjudged;
  }

  if (!because) return { level, reason: model.reason, adjusted: null };
  return { level, reason: "", adjusted: { from: model.level, cause_id: because.id } };
}

/**
 * Check and tidy the model's reply. Returns null when it is not a usable
 * diagnosis; the caller reports an error and never fills the gap with made-up
 * content.
 *
 * What this does: validates the shape, trims text, drops empty items, caps the
 * list sizes, orders causes by the model's own rank and renumbers them 1..n,
 * and gives causes, questions and options ids that are safe to use as keys.
 * It also runs the drive-guidance safety check (see reconcileDriveGuidance) and
 * drops limitation notes about a code the model was not given, or written in
 * the app's internal terms.
 * What it never does: add a cause, change a cause's likelihood or urgency, or
 * derive anything about the vehicle from the wording.
 */
export function normalizeDiagnosis(raw: unknown): Diagnosis | null {
  const parsed = DiagnosisModelSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;

  const causes: DiagnosisCause[] = d.causes
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => text(c.title, 140).length > 0)
    .sort((a, b) => {
      const ra = Number.isFinite(a.c.rank) ? a.c.rank : Number.MAX_SAFE_INTEGER;
      const rb = Number.isFinite(b.c.rank) ? b.c.rank : Number.MAX_SAFE_INTEGER;
      return ra - rb || a.index - b.index;
    })
    .slice(0, DIAGNOSIS_LIMITS.causes)
    .map(({ c }, i) => ({
      id: `c${i + 1}`,
      rank: i + 1,
      title: text(c.title, 140),
      explanation: text(c.explanation, 500),
      why_it_fits: textList(c.why_it_fits, DIAGNOSIS_LIMITS.whyItFits, 300),
      likelihood: c.likelihood,
      urgency: c.urgency,
      checks: c.checks
        .map((k) => ({ instruction: text(k.instruction, 400), level: k.level }))
        .filter((k) => k.instruction)
        .slice(0, DIAGNOSIS_LIMITS.checks),
      recommended_action: text(c.recommended_action, 500),
      repair_level: c.repair_level,
    }));

  if (causes.length === 0) return null;

  const follow_up_questions: FollowUpQuestion[] = [];
  for (const q of d.follow_up_questions) {
    if (follow_up_questions.length >= DIAGNOSIS_LIMITS.followUps) break;
    const question = text(q.question, 240);
    if (!question) continue;
    const options =
      q.answer_type === "single_choice"
        ? q.options
            .map((o) => text(o.label, 80))
            .filter(Boolean)
            .slice(0, DIAGNOSIS_LIMITS.options)
            .map((label, i) => ({ id: `o${i + 1}`, label }))
        : [];
    // A choice question nobody can answer is dropped rather than shown broken.
    if (q.answer_type === "single_choice" && options.length < 2) continue;
    follow_up_questions.push({
      id: `q${follow_up_questions.length + 1}`,
      question,
      answer_type: q.answer_type,
      options,
      why_it_matters: text(q.why_it_matters, 240),
    });
  }

  return {
    summary: text(d.summary, 600),
    drive_guidance: reconcileDriveGuidance({ level: d.drive_guidance.level, reason: text(d.drive_guidance.reason, 400) }, causes),
    causes,
    follow_up_questions,
    limitations: textList(
      d.limitations.filter((l) => l.topic !== "unidentified_code" && !INTERNAL_WORDING.test(l.text)).map((l) => l.text),
      DIAGNOSIS_LIMITS.limitations,
      300,
    ),
  };
}
