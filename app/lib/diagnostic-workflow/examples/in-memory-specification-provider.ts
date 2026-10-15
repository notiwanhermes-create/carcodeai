/**
 * A deterministic in-memory SpecificationProvider, for TESTS AND DEVELOPMENT
 * ONLY. It is not a model of the eventual production data store: it has no
 * vehicle matching, no versions beyond each record's `revision`, and no I/O.
 *
 * Every record with the requested id is a match:
 * - none: not_found
 * - one: verified when its trust is "verified", otherwise informational
 * - several: ambiguous, with all of them as candidates (never one picked)
 *
 * `unavailable` and `throwFor` simulate a failing lookup.
 */
import type { DiagnosticSpecification, SpecificationProvider, SpecificationResolution } from "../types";

export function createInMemorySpecificationProvider(
  records: readonly DiagnosticSpecification[],
  simulate: { unavailable?: Record<string, string>; throwFor?: string[] } = {},
): SpecificationProvider {
  const copy = (r: DiagnosticSpecification): DiagnosticSpecification => JSON.parse(JSON.stringify(r));
  const stored = records.map(copy);
  return {
    resolve({ id }): SpecificationResolution {
      if (simulate.throwFor?.includes(id)) throw new Error(`simulated provider failure for ${id}`);
      const reason = simulate.unavailable?.[id];
      if (reason) return { status: "unavailable", reason };
      const matches = stored.filter((r) => r.id === id);
      if (matches.length === 0) return { status: "not_found" };
      if (matches.length > 1) return { status: "ambiguous", candidates: matches.map(copy) };
      const [only] = matches;
      return only.trust === "verified" ? { status: "verified", specification: copy(only) } : { status: "informational", specification: copy(only) };
    },
  };
}
