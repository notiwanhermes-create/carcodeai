/**
 * AI-mentioned specification values (V2F). HARD RULE: a value a model
 * mentions ("normal fuel pressure is 50 psi") never becomes a specification
 * the engine can use. This helper turns it into display-only information:
 * no id, no revision, no trust that could ever be "verified", and a type the
 * SpecificationProvider cannot accept.
 */
import type { ProposalAudit } from "./audit";

export type InformationalNote = {
  kind: "ai_mentioned_value";
  value: number;
  unit: string;
  text?: string;
  trust: "unverified";
  origin: "ai_parser";
  usedByEngine: false;
};

export function informationalNoteOnly(audit: ProposalAudit): InformationalNote | null {
  const s = audit.informationalSpecification;
  if (!s) return null;
  return { kind: "ai_mentioned_value", value: s.value, unit: s.unit, ...(s.text ? { text: s.text } : {}), trust: "unverified", origin: "ai_parser", usedByEngine: false };
}
