/**
 * Provenance for AI-derived proposals (V2F). Kept SEPARATE from diagnostic
 * evidence: rejected guesses never enter the session, and accepted ones enter
 * only through the engine's normal input path.
 */

/** A deterministic, non-cryptographic reference to the user's text (FNV-1a, 32 bit), so the text itself need not be stored. */
export function textReference(text: string): { hash: string; length: number } {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return { hash: `fnv1a32:${h.toString(16).padStart(8, "0")}`, length: text.length };
}

export type BridgeOutcome = "valid" | "ambiguous" | "unsupported" | "invalid";

export type ProposalAudit = {
  source: "ai_parser";
  textRef: { hash: string; length: number };
  /** What the engine was asking when the text was parsed. */
  forStep: string | null;
  expected: string;
  outcome: BridgeOutcome;
  reason?: string;
  /** The schema-valid proposal, if there was one (kept even when the engine refused it). */
  proposal?: unknown;
  /** A specification value the model mentioned: information only, never used by the engine. */
  informationalSpecification?: { value: number; unit: string; text?: string; trust: "unverified"; origin: "ai_parser"; usedByEngine: false };
};
