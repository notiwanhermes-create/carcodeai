/**
 * Reviewed diagnostic content: the shapes (Guided Diagnostics V2H).
 *
 * RESEARCH PROTOTYPE. Nothing in the app imports this yet.
 *
 * A workflow is DATA that the deterministic engine consumes unchanged. Around
 * it, content metadata records what kind of content it is, where its claims
 * come from, and how far it has been reviewed. The engine never reads this
 * metadata; it cannot make a workflow behave differently. It decides whether
 * a workflow may be offered, and lets a human reviewer check every claim.
 *
 * See docs/research/guided-diagnostics/v2h-reviewed-content.md.
 */
import type { CauseId, NodeId, WorkflowDefinition } from "../diagnostic-workflow";

/**
 * What kind of content a workflow is.
 * - synthetic_test: written to exercise the engine. Never shown to users as
 *   diagnosis. Id starts with "synthetic." and provenance with "SYNTHETIC".
 * - generic_source_backed: generic (not manufacturer-specific) diagnostic
 *   structure whose technical claims cite public, lawfully accessible sources.
 * - oem_licensed: RESERVED for manufacturer content used under a licence.
 *   Needs licensing metadata and a licensed source; none exists yet.
 */
export const CONTENT_CLASSES = ["synthetic_test", "generic_source_backed", "oem_licensed"] as const;
export type ContentClass = (typeof CONTENT_CLASSES)[number];

/**
 * How far the content has been reviewed.
 * - draft: written or assembled, not reviewed by a qualified person. The most
 *   AI-generated or AI-assembled content can ever be on its own.
 * - source_reviewed: a named human reviewer checked every cited claim against
 *   its source.
 * - approved: a named, qualified human reviewer approved the workflow as a
 *   whole (technical correctness, safety, applicability), for exactly this
 *   content fingerprint.
 */
export const REVIEW_STATUSES = ["draft", "source_reviewed", "approved"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * What a source is. Only these kinds can be cited. Forums, SEO repair
 * articles, unsourced code lists, anonymous content and AI output are not
 * source kinds at all.
 */
export const SOURCE_TYPES = [
  /** Government or regulator documentation (a regulation, an official guidance document). */
  "regulation",
  /** A standards body's public page or summary (catalogue entry, abstract). The normative text itself may be paywalled. */
  "standard_summary",
  /** A standard's normative text, consulted under a licence. */
  "standard_licensed",
  /** Manufacturer technical information that is lawfully public. */
  "manufacturer_public",
  /** Manufacturer information used under a licence (oem_licensed content only). */
  "manufacturer_licensed",
  /** An established technical institution or publication (a certification body, a peer-reviewed or professional publication). */
  "technical_institution",
  /** Reputable automotive technical education material. */
  "technical_education",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Authoritative sources outrank secondary ones. Derived from the type, never declared, so it cannot be inflated. */
export type SourceTier = "primary" | "secondary";
export const SOURCE_TIER: Record<SourceType, SourceTier> = {
  regulation: "primary",
  standard_summary: "primary",
  standard_licensed: "primary",
  manufacturer_public: "primary",
  manufacturer_licensed: "primary",
  technical_institution: "primary",
  technical_education: "secondary",
};

/** How much of the source was actually read. A catalogue page is not the standard. */
export const CONSULTED = ["full_text", "partial_text", "catalogue_only"] as const;
export type Consulted = (typeof CONSULTED)[number];

/** A citable public source. Citation and concise facts only: no copied passages. */
export type ContentSource = {
  /** Stable id, unique within the workflow's metadata, e.g. "carb-1968.2-fro". */
  id: string;
  title: string;
  /** The publisher or organization. */
  publisher: string;
  type: SourceType;
  /** A public URL, or another precise reference (catalogue number, document id). At least one. */
  url?: string;
  reference?: string;
  /** Publication, edition, version or date, as the source states it. Say so when it states none. */
  edition: string;
  /** When CarCode consulted it (YYYY-MM-DD). */
  accessed: string;
  consulted: Consulted;
  /** What the source does NOT support, and anything that limits its use. Required. */
  limitations: string;
};

/**
 * How well a claim is supported.
 * - supported: the cited sources state it (at the cited locations).
 * - partially_supported: the sources support part of it; `note` says which part is not.
 * - author_judgement: CarCode's own design or diagnostic reasoning. Cites
 *   nothing and is never presented as sourced. A reviewer must check it.
 */
export const CLAIM_SUPPORT = ["supported", "partially_supported", "author_judgement"] as const;
export type ClaimSupport = (typeof CLAIM_SUPPORT)[number];

/** One concise statement, in CarCode's own words, and what in the workflow rests on it. */
export type ContentClaim = {
  id: string;
  statement: string;
  support: ClaimSupport;
  /** The sources behind it, each with where in the source (section, task number, page). */
  sources: Array<{ source: string; locator: string }>;
  /** The parts of the workflow it justifies. */
  covers: { nodes?: NodeId[]; causes?: CauseId[]; regions?: string[]; codes?: string[]; specifications?: string[] };
  note?: string;
};

/** One human review. Never invented: the absence of a review is recorded as an empty list. */
export type ContentReview = {
  decision: "source_reviewed" | "approved";
  reviewer: { kind: "human"; name: string; qualification: string };
  /** YYYY-MM-DD. */
  date: string;
  notes: string;
  /** The content fingerprint the reviewer looked at. A review covers that exact diagnostic content only. */
  reviewedFingerprint: string;
};

export type ContentReviewRecord = {
  status: ReviewStatus;
  /** Increases with every change to the content or its metadata. Administrative only. */
  contentRevision: number;
  /** Who prepared it. AI-assisted content without a human review can only be a draft. */
  preparedBy: { kind: "ai_assisted" | "human"; note: string };
  reviews: ContentReview[];
};

/** RESERVED for oem_licensed content: the licence that allows its use. */
export type ContentLicensing = { licensor: string; licence: string; reference: string; permittedUse: string };

export type WorkflowContent = {
  workflow: WorkflowDefinition;
  contentClass: ContentClass;
  review: ContentReviewRecord;
  sources: ContentSource[];
  claims: ContentClaim[];
  /** Vehicle-specific information this content deliberately does not contain. */
  excludes: string[];
  licensing?: ContentLicensing;
};
