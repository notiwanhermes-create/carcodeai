/**
 * Test data in the shape the AI model is asked to return, plus small helpers
 * for the mocked OpenAI client.
 */
import type { ModelDiagnosis } from "../../app/lib/diagnosis-schema";

type Cause = ModelDiagnosis["causes"][number];

export function modelCause(overrides: Partial<Cause> = {}): Cause {
  return {
    rank: 1,
    title: "Worn spark plugs",
    explanation: "Old plugs can misfire under load.",
    why_it_fits: ["Matches the rough idle that was described."],
    likelihood: "likely",
    urgency: "caution",
    checks: [{ instruction: "Look at the service record for the last plug change.", level: "owner" }],
    recommended_action: "Have the spark plugs inspected and replaced if worn.",
    repair_level: "diy_moderate",
    ...overrides,
  };
}

/** A limitation note as the model returns it. */
export function limitation(text: string, topic: ModelDiagnosis["limitations"][number]["topic"] = "evidence") {
  return { text, topic };
}

export function modelDiagnosis(overrides: Partial<ModelDiagnosis> = {}): ModelDiagnosis {
  return {
    summary: "The most likely explanation is an ignition problem, but this is not confirmed.",
    drive_guidance: { level: "caution", reason: "A misfire can damage the catalytic converter if ignored." },
    causes: [modelCause()],
    follow_up_questions: [],
    limitations: [limitation("The vehicle has not been inspected.")],
    ...overrides,
  };
}

/** A Responses API result carrying the given object as its structured reply. */
export function modelReply(body: unknown, usage = { input_tokens: 900, output_tokens: 600 }) {
  return { status: "completed", output_text: JSON.stringify(body), usage };
}

/** What the mocked client was sent on its most recent (or nth) call. */
export function sentToModel(createMock: { mock: { calls: unknown[][] } }, callIndex = -1) {
  const call = callIndex < 0 ? createMock.mock.calls[createMock.mock.calls.length + callIndex] : createMock.mock.calls[callIndex];
  const [params, options] = call as [
    { model: string; input: Array<{ role: string; content: string }>; text: { format: Record<string, unknown> }; max_output_tokens: number; store?: boolean },
    { timeout?: number; maxRetries?: number } | undefined,
  ];
  const instructions = params.input.find((m) => m.role === "developer")?.content ?? "";
  const userContent = params.input.find((m) => m.role === "user")?.content ?? "";
  return {
    params,
    options,
    instructions,
    /** The JSON document of user data, exactly as sent. */
    userContent,
    context: JSON.parse(userContent) as Record<string, unknown>,
    /** Everything the model could read: instructions, data and the schema. */
    everything: JSON.stringify(params),
  };
}
