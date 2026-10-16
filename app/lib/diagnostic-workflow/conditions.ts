/**
 * Evaluating declarative conditions (shared by the engine and the
 * next-best-test selector). Three-valued: true, false, or null when the
 * evidence or the pinned vehicle context cannot tell. RESEARCH PROTOTYPE.
 */
import { normalizeText } from "./context";
import { matchDtc, type Tri } from "./dtc";
import type { Condition, DiagnosticSession, Evidence } from "./types";

/** Evidence kinds that are not an answer to a step. */
const NOT_ANSWERS = new Set<Evidence["kind"]>(["scan", "code", "snapshot", "symptom", "specification", "test_selection"]);

/**
 * A condition: true, false or null (cannot tell). A branch rule fires only on
 * true. Code conditions are honest about absence (see matchDtc); the rest are
 * plain facts about the session.
 */
export function holds(condition: Condition, session: DiagnosticSession): Tri {
  if ("dtc" in condition) return matchDtc(session.evidence, condition.dtc);
  if ("noDtc" in condition) {
    const present = matchDtc(session.evidence, condition.noDtc);
    return present === null ? null : !present;
  }
  if ("symptomAny" in condition) return (session.facts.symptoms ?? []).some((s) => condition.symptomAny.includes(s));
  if ("vehicle" in condition) {
    // Three-valued: a fact the pinned context does not hold (missing, or blank before normalization) is unknown, never "no".
    const actual = session.facts.vehicle?.[condition.vehicle];
    if (actual === undefined) return null;
    // The pinned context is normalized (lower case text), so compare against the normalized value.
    const expected = typeof condition.equals === "string" ? normalizeText(condition.equals) : condition.equals;
    return actual === expected;
  }
  if ("established" in condition) return session.establishedConditions.includes(condition.established);
  if ("answered" in condition) {
    const last = [...session.evidence].reverse().find((e) => e.nodeId === condition.answered && !NOT_ANSWERS.has(e.kind));
    return last?.value === condition.is;
  }
  if ("all" in condition) {
    const parts = condition.all.map((c) => holds(c, session));
    return parts.includes(false) ? false : parts.includes(null) ? null : true;
  }
  if ("any" in condition) {
    const parts = condition.any.map((c) => holds(c, session));
    return parts.includes(true) ? true : parts.includes(null) ? null : false;
  }
  const inner = holds(condition.not, session);
  return inner === null ? null : !inner;
}

/** The vehicle facts a condition asks about that the pinned context does not hold. */
export function unknownVehicleFacts(condition: Condition, session: DiagnosticSession): string[] {
  if ("vehicle" in condition) return session.facts.vehicle?.[condition.vehicle] === undefined ? [condition.vehicle] : [];
  if ("all" in condition) return condition.all.flatMap((c) => unknownVehicleFacts(c, session));
  if ("any" in condition) return condition.any.flatMap((c) => unknownVehicleFacts(c, session));
  if ("not" in condition) return unknownVehicleFacts(condition.not, session);
  return [];
}

