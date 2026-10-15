/**
 * Specification resolution: the only way the engine reaches vehicle-specific
 * values.
 *
 *   workflow → specification id → provider → resolution → engine interpretation
 *
 * RESEARCH PROTOTYPE. The engine calls `resolveSpecification`, never a
 * provider directly, so every answer is checked the same way:
 * - a thrown error becomes `unavailable: provider_error` (never a crash, never a guess);
 * - a malformed or mismatched answer becomes `unavailable` with the reason;
 * - trust is never upgraded: "verified" must be a verified record, and a
 *   verified record must come back as "verified", or the answer is refused;
 * - ambiguous answers keep their candidates for display, and are never picked from.
 *
 * Results are deep-copied and frozen, so nothing the provider holds can change
 * what a session recorded.
 */
import {
  SPEC_TRUST,
  type DiagnosticSpecification,
  type SpecificationId,
  type SpecificationProvider,
  type SpecificationResolution,
  type VehicleContext,
} from "./types";
import { isUnit } from "./units";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Why a specification record cannot be used at all, or null when it is well formed. */
export function specificationProblem(spec: DiagnosticSpecification, requestedId?: SpecificationId): string | null {
  if (!spec || typeof spec !== "object") return "not a specification";
  if (typeof spec.id !== "string" || !spec.id) return "no id";
  if (requestedId !== undefined && spec.id !== requestedId) return `answered "${spec.id}" for "${requestedId}"`;
  if (typeof spec.revision !== "string" || !spec.revision.trim()) return "no revision";
  if (!isUnit(spec.unit)) return "unknown unit";
  const e = spec.expected;
  if (!e || typeof e !== "object") return "no expected range";
  if (e.min === undefined && e.max === undefined) return "expected range has no bound";
  if ((e.min !== undefined && !finite(e.min)) || (e.max !== undefined && !finite(e.max))) return "expected bound is not a finite number";
  if (e.min !== undefined && e.max !== undefined && e.min > e.max) return "expected minimum is above its maximum";
  if (spec.plausible !== undefined && (!finite(spec.plausible?.min) || !finite(spec.plausible?.max) || spec.plausible.min >= spec.plausible.max)) return "invalid plausible range";
  if (spec.conditions !== undefined && (!Array.isArray(spec.conditions) || spec.conditions.some((c) => typeof c !== "string" || !c))) return "invalid conditions";
  if (!spec.source || typeof spec.source.name !== "string" || !spec.source.name.trim()) return "no source";
  if (!(SPEC_TRUST as readonly string[]).includes(spec.trust)) return "unknown trust";
  return null;
}

function frozenCopy(spec: DiagnosticSpecification): DiagnosticSpecification {
  return Object.freeze({
    id: spec.id,
    revision: spec.revision,
    unit: spec.unit,
    expected: Object.freeze({ ...(spec.expected.min !== undefined ? { min: spec.expected.min } : {}), ...(spec.expected.max !== undefined ? { max: spec.expected.max } : {}) }),
    ...(spec.plausible ? { plausible: Object.freeze({ min: spec.plausible.min, max: spec.plausible.max }) } : {}),
    ...(spec.conditions ? { conditions: Object.freeze([...spec.conditions]) as string[] } : {}),
    source: Object.freeze({ name: spec.source.name, ...(spec.source.reference ? { reference: spec.source.reference } : {}) }),
    trust: spec.trust,
    ...(spec.note ? { note: spec.note } : {}),
  });
}

const unavailable = (reason: string): SpecificationResolution => Object.freeze({ status: "unavailable", reason });

/** Check one provider answer for `id`, and return a frozen copy the engine can record. */
export function normalizeResolution(id: SpecificationId, raw: unknown): SpecificationResolution {
  const r = raw as SpecificationResolution | null;
  if (!r || typeof r !== "object" || typeof r.status !== "string") return unavailable("invalid_resolution");
  switch (r.status) {
    case "verified":
    case "informational": {
      const problem = specificationProblem(r.specification, id);
      if (problem) return unavailable(`invalid_specification: ${problem}`);
      // Trust is never upgraded, and a status that disagrees with its record is refused rather than corrected.
      const expected = r.specification.trust === "verified" ? "verified" : "informational";
      if (r.status !== expected) return unavailable(`inconsistent_trust: status "${r.status}" for a "${r.specification.trust}" specification`);
      return Object.freeze({ status: r.status, specification: frozenCopy(r.specification) });
    }
    case "not_found":
      return Object.freeze({ status: "not_found" });
    case "ambiguous": {
      if (!Array.isArray(r.candidates) || r.candidates.length < 2) return unavailable("invalid_resolution: ambiguous needs two or more candidates");
      // Candidates are kept for display only, so a malformed one is dropped rather than failing the whole answer.
      const candidates = r.candidates.filter((c) => specificationProblem(c, id) === null).map(frozenCopy);
      return Object.freeze({ status: "ambiguous", candidates: Object.freeze(candidates) as DiagnosticSpecification[] });
    }
    case "unavailable":
      return unavailable(typeof r.reason === "string" && r.reason ? r.reason : "unavailable");
    default:
      return unavailable("invalid_resolution");
  }
}

/** Ask the provider, safely. No provider configured is an honest "unavailable", not a guess. */
export function resolveSpecification(provider: SpecificationProvider | undefined, id: SpecificationId, vehicle?: Readonly<VehicleContext>): SpecificationResolution {
  if (!provider || typeof provider.resolve !== "function") return unavailable("no_provider");
  let raw: unknown;
  try {
    // A frozen copy: a provider can read the pinned vehicle context but never change it.
    raw = provider.resolve({ id, ...(vehicle ? { vehicle: Object.freeze({ ...vehicle }) } : {}) });
  } catch {
    return unavailable("provider_error");
  }
  return normalizeResolution(id, raw);
}

/** Only a verified resolution may drive pass or fail, causes or routes. */
export const isTrustedResolution = (r: SpecificationResolution | undefined): boolean => r?.status === "verified";

/**
 * A provider that answers only with resolutions a session already recorded.
 * Used to replay a saved session exactly as it happened; anything it did not
 * record is "unavailable: not_recorded".
 */
export function pinnedSpecificationProvider(recorded: Readonly<Record<SpecificationId, SpecificationResolution>>): SpecificationProvider {
  return {
    resolve: ({ id }) => (Object.prototype.hasOwnProperty.call(recorded, id) ? recorded[id] : { status: "unavailable", reason: "not_recorded" }),
  };
}

/** A stable comparison key for a resolution: status, and for a match the revision and every value that judges a reading. */
function resolutionKey(r: SpecificationResolution): string {
  if (r.status === "verified" || r.status === "informational") {
    const s = r.specification;
    return JSON.stringify([r.status, s.revision, s.unit, s.expected.min ?? null, s.expected.max ?? null, s.plausible?.min ?? null, s.plausible?.max ?? null, s.trust, [...(s.conditions ?? [])].sort()]);
  }
  if (r.status === "ambiguous") return JSON.stringify([r.status, r.candidates.map((c) => `${c.id}@${c.revision}`).sort()]);
  if (r.status === "unavailable") return JSON.stringify([r.status, r.reason]);
  return JSON.stringify([r.status]);
}

/**
 * Specifications whose current answer differs from what the session recorded.
 * Explicit by design: the session's history is never rewritten, and a caller
 * that wants the new values has to start a new session.
 */
export function specificationDrift(
  session: { specifications: Readonly<Record<SpecificationId, SpecificationResolution>>; facts?: { vehicle?: Readonly<VehicleContext> } },
  provider: SpecificationProvider | undefined,
) {
  const out: Array<{ id: SpecificationId; recorded: SpecificationResolution; current: SpecificationResolution }> = [];
  for (const id of Object.keys(session.specifications).sort()) {
    const recorded = session.specifications[id];
    const current = resolveSpecification(provider, id, session.facts?.vehicle);
    if (resolutionKey(recorded) !== resolutionKey(current)) out.push({ id, recorded, current });
  }
  return out;
}

/** A short, stable description of a resolution for the evidence log. */
export function describeResolution(id: SpecificationId, r: SpecificationResolution): string {
  if (r.status === "verified" || r.status === "informational") return `${r.status} ${id}@${r.specification.revision}`;
  if (r.status === "ambiguous") return `ambiguous ${id} (${r.candidates.length} candidates)`;
  if (r.status === "unavailable") return `unavailable ${id}: ${r.reason}`;
  return `not_found ${id}`;
}
