/**
 * Test helpers for structured scan evidence (Guided Diagnostics V2D).
 * Everything here is SYNTHETIC / TEST ONLY.
 */
import type { DiagnosticScanInput, SessionStartFacts } from "../../app/lib/diagnostic-workflow";

/** The pre-V2D shorthand the older tests use: a list of typed codes. */
export type TypedCodes = { dtcs?: string[]; dtcSource?: string };

/**
 * Turn the shorthand into what it honestly is: one scan of codes typed in (or
 * read by a tool), with UNKNOWN completeness and unknown status, so nothing
 * can be concluded from a code not being listed.
 */
export function withCodes<T extends TypedCodes & Partial<SessionStartFacts>>(f: T): SessionStartFacts {
  const { dtcs, dtcSource, ...rest } = f;
  if (dtcs === undefined && dtcSource === undefined) return rest as SessionStartFacts;
  const scan = { id: "start", source: (dtcSource ?? "person") as DiagnosticScanInput["source"], completeness: "unknown" as const, codes: (dtcs ?? []).map((code) => ({ code })) };
  return { ...rest, scans: [...(rest.scans ?? []), scan] } as SessionStartFacts;
}

/** A complete post-repair scan from a tool that lists the given codes (none: a clean scan). */
export function afterScan(codes: DiagnosticScanInput["codes"] = [], over: Partial<DiagnosticScanInput> = {}): DiagnosticScanInput {
  return { id: "after", source: "scan_tool", completeness: "complete", reportsStatus: ["pending", "confirmed", "permanent"], codes, ...over };
}
