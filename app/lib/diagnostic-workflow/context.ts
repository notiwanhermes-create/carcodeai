/**
 * Vehicle context, workflow applicability and capabilities (V2C).
 *
 * RESEARCH PROTOTYPE. Deterministic, no lookups: no VIN decoding, no vehicle
 * databases. Unknown facts stay unknown and are never guessed.
 */
import {
  FACILITIES,
  FUELS,
  INSTRUMENTS,
  SCAN_ACCESS,
  SCAN_ORDER,
  SKILL_ORDER,
  type ApplicabilityField,
  type ApplicabilityResult,
  type CapabilityShortfall,
  type DiagnosticCapabilityContext,
  type StepRequirements,
  type VehicleContext,
  type WorkflowApplicability,
} from "./types";

/** Trimmed, single-spaced, lower case. Blank means unknown. */
export const normalizeText = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * A vehicle context in its one canonical form, frozen, or why it cannot be
 * used. Blank strings are dropped (unknown); invalid values are refused, not
 * repaired.
 */
export function normalizeVehicleContext(raw: unknown): { ok: true; vehicle: Readonly<VehicleContext> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, vehicle: Object.freeze({}) };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "vehicle must be an object" };
  const v = raw as Record<string, unknown>;
  const known = ["year", "make", "model", "engine", "fuel", "cylinders", "market"];
  const unknown = Object.keys(v).filter((k) => !known.includes(k));
  if (unknown.length) return { ok: false, error: `vehicle has unsupported fields: ${unknown.join(", ")}` };
  const out: VehicleContext = {};
  if (v.year !== undefined) {
    if (!Number.isInteger(v.year) || (v.year as number) < 1900 || (v.year as number) > 2100) return { ok: false, error: "vehicle year must be a whole year" };
    out.year = v.year as number;
  }
  for (const key of ["make", "model", "engine", "market"] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== "string") return { ok: false, error: `vehicle ${key} must be text` };
    const text = normalizeText(v[key] as string);
    if (text) out[key] = text;
  }
  if (v.fuel !== undefined) {
    const fuel = typeof v.fuel === "string" ? normalizeText(v.fuel) : "";
    if (!(FUELS as readonly string[]).includes(fuel)) return { ok: false, error: `vehicle fuel must be one of ${FUELS.join(", ")}` };
    out.fuel = fuel as VehicleContext["fuel"];
  }
  if (v.cylinders !== undefined) {
    if (!Number.isInteger(v.cylinders) || (v.cylinders as number) < 1 || (v.cylinders as number) > 16) return { ok: false, error: "vehicle cylinders must be a whole number from 1 to 16" };
    out.cylinders = v.cylinders as number;
  }
  return { ok: true, vehicle: Object.freeze(out) };
}

/**
 * Whether a workflow applies to a vehicle. Any stated fact that does not
 * match makes it not applicable; otherwise any fact it needs that is unknown
 * makes the context insufficient (with the missing fields named); otherwise
 * it applies. No applicability declared means any vehicle.
 */
export function checkApplicability(applicability: WorkflowApplicability | undefined, vehicle: Readonly<VehicleContext> | undefined): ApplicabilityResult {
  if (!applicability) return { status: "applicable" };
  const v = vehicle ?? {};
  const missing: ApplicabilityField[] = [];
  const mismatched: ApplicabilityField[] = [];
  const anyOf = (field: "fuel" | "make" | "engine" | "market") => {
    const allowed = applicability[field];
    if (!allowed) return;
    const value = v[field];
    if (value === undefined) missing.push(field);
    else if (!allowed.map((a) => normalizeText(a)).includes(normalizeText(value))) mismatched.push(field);
  };
  anyOf("fuel");
  anyOf("make");
  anyOf("engine");
  anyOf("market");
  if (applicability.years) {
    const { from, to } = applicability.years;
    if (v.year === undefined) missing.push("years");
    else if ((from !== undefined && v.year < from) || (to !== undefined && v.year > to)) mismatched.push("years");
  }
  if (applicability.cylinders) {
    const { min, max } = applicability.cylinders;
    if (v.cylinders === undefined) missing.push("cylinders");
    else if ((min !== undefined && v.cylinders < min) || (max !== undefined && v.cylinders > max)) mismatched.push("cylinders");
  }
  if (mismatched.length) return { status: "not_applicable", mismatched };
  if (missing.length) return { status: "insufficient_context", missing };
  return { status: "applicable" };
}

/** Problems with an applicability declaration (for the workflow checker). */
export function applicabilityProblems(a: WorkflowApplicability): string[] {
  const out: string[] = [];
  const list = (field: "fuel" | "make" | "engine" | "market") => {
    const value = a[field];
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length === 0 || value.some((x) => typeof x !== "string" || !x.trim())) out.push(`${field} must be a non-empty list`);
  };
  list("fuel");
  list("make");
  list("engine");
  list("market");
  if (a.fuel?.some((f) => !(FUELS as readonly string[]).includes(f))) out.push(`fuel must be among ${FUELS.join(", ")}`);
  const range = (field: "years" | "cylinders", lo?: number, hi?: number) => {
    if (lo === undefined && hi === undefined) out.push(`${field} needs a lower or upper end`);
    if ((lo !== undefined && !Number.isInteger(lo)) || (hi !== undefined && !Number.isInteger(hi))) out.push(`${field} ends must be whole numbers`);
    if (lo !== undefined && hi !== undefined && lo > hi) out.push(`${field} lower end is above its upper end`);
  };
  if (a.years) range("years", a.years.from, a.years.to);
  if (a.cylinders) range("cylinders", a.cylinders.min, a.cylinders.max);
  const allowed = ["fuel", "make", "engine", "market", "years", "cylinders"];
  const extra = Object.keys(a).filter((k) => !allowed.includes(k));
  if (extra.length) out.push(`unsupported fields: ${extra.join(", ")}`);
  return out;
}

/** Whether a capability context is well formed. */
export function capabilityProblem(c: unknown): string | null {
  const x = c as DiagnosticCapabilityContext | null;
  if (!x || typeof x !== "object") return "capabilities are required";
  if (!(x.skill in SKILL_ORDER)) return "capabilities need a skill level";
  if (!(SCAN_ACCESS as readonly string[]).includes(x.scanAccess)) return `capabilities need a scan access level (${SCAN_ACCESS.join(", ")})`;
  if (!Array.isArray(x.instruments) || x.instruments.some((i) => !(INSTRUMENTS as readonly string[]).includes(i))) return "capabilities list unknown instruments";
  if (!Array.isArray(x.facilities) || x.facilities.some((f) => !(FACILITIES as readonly string[]).includes(f))) return "capabilities list unknown facilities";
  return null;
}

/**
 * Whether the person can do a step, and if not, the first reason (skill,
 * then scan access, then instruments, then facilities) with everything that
 * is missing. Only declared capabilities count.
 */
export function capabilityShortfall(
  needs: StepRequirements | undefined,
  caps: DiagnosticCapabilityContext,
): { ok: true } | { ok: false; reason: CapabilityShortfall; missing: string[] } {
  if (!needs) return { ok: true };
  const missing: string[] = [];
  let reason: CapabilityShortfall | null = null;
  const note = (r: CapabilityShortfall, item: string) => {
    reason ??= r;
    missing.push(item);
  };
  if (SKILL_ORDER[needs.level] > SKILL_ORDER[caps.skill]) note("level", `level:${needs.level}`);
  if (needs.scan && SCAN_ORDER[needs.scan] > SCAN_ORDER[caps.scanAccess]) note("scan_access", `scan_access:${needs.scan}`);
  for (const i of needs.instruments ?? []) if (!caps.instruments.includes(i)) note("instruments", `instrument:${i}`);
  for (const f of needs.facilities ?? []) if (!caps.facilities.includes(f)) note("facilities", `facility:${f}`);
  return reason ? { ok: false, reason, missing } : { ok: true };
}
