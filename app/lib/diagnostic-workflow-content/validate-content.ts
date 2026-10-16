/**
 * Checks content metadata (V2H). RESEARCH PROTOTYPE.
 *
 * The workflow itself is checked by the engine's own validator, unchanged.
 * This adds only what content needs: a class, a review status that is backed
 * by real review records, structured provenance for anything that is not
 * synthetic, and claims that point at declared sources and at real parts of
 * the workflow. It is deliberately small: not a content management system.
 */
import { validateWorkflow, type WorkflowDefinition, type WorkflowNode } from "../diagnostic-workflow";
import { workflowFingerprint } from "../diagnostic-workflow-persistence/canonical";
import { CLAIM_SUPPORT, CONSULTED, CONTENT_CLASSES, REVIEW_STATUSES, SOURCE_TIER, SOURCE_TYPES, type ContentClass, type WorkflowContent } from "./types";

export type ContentProblem = { code: string; message: string };
export type ContentValidation = { ok: true; fingerprint: string } | { ok: false; problems: ContentProblem[] };

const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const blank = (s: unknown) => typeof s !== "string" || s.trim() === "";

/** The content fingerprint: exactly the V2G workflow fingerprint. Metadata is not part of it (see the design note). */
export function contentFingerprint(workflow: WorkflowDefinition): string {
  return workflowFingerprint(workflow);
}

/** Every DTC code identifier a workflow's conditions name. */
export function codesUsed(workflow: WorkflowDefinition): string[] {
  const out = new Set<string>();
  const walk = (c: unknown): void => {
    if (!c || typeof c !== "object") return;
    if (Array.isArray(c)) return c.forEach(walk);
    const o = c as Record<string, unknown>;
    for (const key of ["dtc", "noDtc"]) {
      const m = o[key] as { code?: string | string[] } | undefined;
      if (m?.code) for (const code of Array.isArray(m.code) ? m.code : [m.code]) out.add(code);
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  walk(workflow.nodes);
  return [...out].sort();
}

/** Every specification id a workflow asks for. */
export function specificationsUsed(workflow: WorkflowDefinition): string[] {
  return [...new Set(workflow.nodes.flatMap((n) => ("specification" in n && typeof n.specification === "string" ? [n.specification] : [])))].sort();
}

const regionsOf = (workflow: WorkflowDefinition) => workflow.nodes.filter((n): n is Extract<WorkflowNode, { type: "test_selection" }> => n.type === "test_selection").map((n) => n.group);

export function validateContent(content: WorkflowContent): ContentValidation {
  const problems: ContentProblem[] = [];
  const add = (code: string, message: string) => problems.push({ code, message });
  if (!content || typeof content !== "object" || !content.workflow) return { ok: false, problems: [{ code: "malformed", message: "Content needs a workflow." }] };
  const w = content.workflow;

  // 1. The workflow, by the engine's own rules.
  const valid = validateWorkflow(w);
  if (!valid.ok) for (const p of valid.problems) add(`workflow:${p.code}`, p.message);
  let fingerprint = "";
  try {
    fingerprint = contentFingerprint(w);
  } catch {
    add("malformed", "The workflow is not plain data.");
  }

  // 2. Class.
  const cls = content.contentClass as ContentClass;
  if (!CONTENT_CLASSES.includes(cls)) add("unknown_content_class", `Unknown content class "${String(content.contentClass)}".`);

  // 3. Review: a status is only as good as the human review records behind it.
  const r = content.review;
  if (!r || typeof r !== "object") {
    add("no_review_record", "Every workflow needs a review record (draft at least).");
  } else {
    if (!REVIEW_STATUSES.includes(r.status)) add("unknown_review_status", `Unknown review status "${String(r.status)}".`);
    if (!Number.isInteger(r.contentRevision) || r.contentRevision < 1) add("invalid_content_revision", "contentRevision must be a whole number from 1.");
    if (!r.preparedBy || !["ai_assisted", "human"].includes(r.preparedBy.kind) || blank(r.preparedBy.note)) add("invalid_prepared_by", "Say who prepared the content (ai_assisted or human) and how.");
    const reviews = Array.isArray(r.reviews) ? r.reviews : [];
    if (!Array.isArray(r.reviews)) add("invalid_reviews", "reviews must be a list (empty when nobody has reviewed it).");
    for (const [i, rev] of reviews.entries()) {
      if (!rev || !["source_reviewed", "approved"].includes(rev.decision)) add("invalid_review", `Review ${i + 1} has no valid decision.`);
      if (rev?.reviewer?.kind !== "human" || blank(rev?.reviewer?.name) || blank(rev?.reviewer?.qualification)) add("invalid_reviewer", `Review ${i + 1} needs a named human reviewer and their qualification.`);
      if (!isDate(rev?.date)) add("invalid_review_date", `Review ${i + 1} needs a date (YYYY-MM-DD).`);
      if (typeof rev?.notes !== "string") add("invalid_review", `Review ${i + 1} needs notes (may be empty text).`);
      if (blank(rev?.reviewedFingerprint)) add("invalid_review", `Review ${i + 1} must name the content fingerprint it reviewed.`);
    }
    // Only reviews of THIS exact diagnostic content count.
    const current = reviews.filter((rev) => rev?.reviewer?.kind === "human" && !blank(rev.reviewer.name) && rev.reviewedFingerprint === fingerprint);
    if (r.status === "approved") {
      if (!reviews.some((rev) => rev?.decision === "approved")) add("approval_without_review", "Approved content needs a recorded human approval.");
      else if (!current.some((rev) => rev.decision === "approved")) add("approval_stale", "The recorded approval is for different diagnostic content; it must be reviewed again.");
    }
    if (r.status === "source_reviewed") {
      if (reviews.length === 0) add("review_without_record", "Source-reviewed content needs a recorded human review.");
      else if (current.length === 0) add("review_stale", "The recorded review is for different diagnostic content; it must be reviewed again.");
    }
    if (cls === "synthetic_test" && r.status !== "draft") add("synthetic_reviewed", "Synthetic test content is never reviewed or approved for use.");
  }

  // 4. Class rules: synthetic content says so; nothing else may look synthetic or pose as manufacturer data.
  const looksSynthetic = w.id?.startsWith("synthetic.") || /SYNTHETIC/i.test(w.provenance ?? "");
  if (cls === "synthetic_test") {
    if (!w.id?.startsWith("synthetic.") || !/^SYNTHETIC\b/.test(w.provenance ?? "")) add("synthetic_unlabelled", 'Synthetic content needs an id starting "synthetic." and provenance starting "SYNTHETIC".');
  } else if (looksSynthetic) {
    add("synthetic_masquerading", "Only synthetic_test content may use a synthetic id or provenance.");
  }
  if (cls !== "oem_licensed" && content.licensing) add("unexpected_licensing", "Licensing metadata belongs to oem_licensed content only.");

  const sources = Array.isArray(content.sources) ? content.sources : [];
  const claims = Array.isArray(content.claims) ? content.claims : [];
  if (!Array.isArray(content.excludes)) add("invalid_excludes", "excludes must be a list.");

  if (cls === "generic_source_backed") {
    if (w.applicability?.make?.length || w.applicability?.engine?.length) add("generic_claims_oem", "Generic content must not be scoped to a manufacturer or engine.");
    if (sources.some((s) => s.type === "manufacturer_licensed")) add("licensed_source_in_generic", "Licensed manufacturer sources belong to oem_licensed content.");
    for (const n of w.nodes) {
      if ((n.type === "measurement" || n.type === "snapshot_check") && n.outcomes.some((o) => !("relativeToSpec" in (o.when as object)))) {
        add("embedded_numeric_range", `"${n.id}" judges against a number written into the workflow. Generic content must name a specification.`);
      }
    }
    if (!content.excludes?.length) add("invalid_excludes", "Say which vehicle-specific information is deliberately excluded.");
  }
  if (cls === "oem_licensed") {
    const l = content.licensing;
    if (!l || blank(l.licensor) || blank(l.licence) || blank(l.reference) || blank(l.permittedUse)) add("no_licensing", "oem_licensed content needs licensing metadata (licensor, licence, reference, permitted use).");
    if (!sources.some((s) => s.type === "manufacturer_licensed")) add("no_licensed_source", "oem_licensed content needs a licensed manufacturer source.");
    if (!w.applicability?.make?.length) add("oem_without_make", "oem_licensed content must state the manufacturer(s) it applies to.");
  }

  // 5. Provenance for everything that is not synthetic.
  if (cls !== "synthetic_test") {
    if (sources.length === 0) add("no_sources", "Non-synthetic content needs at least one source.");
    if (claims.length === 0) add("no_claims", "Non-synthetic content needs claims linking its sources to the workflow.");
  }
  const sourceIds = new Set<string>();
  for (const s of sources) {
    if (blank(s?.id)) add("invalid_source", "A source needs an id.");
    else if (sourceIds.has(s.id)) add("duplicate_source", `Source id "${s.id}" is used twice.`);
    else sourceIds.add(s.id);
    if (!SOURCE_TYPES.includes(s?.type)) add("unknown_source_type", `Source "${s?.id}" has an unknown type "${String(s?.type)}" (forums, SEO articles, anonymous and AI content are not sources).`);
    if (blank(s?.title) || blank(s?.publisher) || blank(s?.edition) || blank(s?.limitations)) add("invalid_source", `Source "${s?.id}" needs a title, publisher, edition (or "none stated") and limitations.`);
    if (blank(s?.url) && blank(s?.reference)) add("invalid_source", `Source "${s?.id}" needs a URL or a reference.`);
    if (!isDate(s?.accessed)) add("invalid_source", `Source "${s?.id}" needs the date it was consulted (YYYY-MM-DD).`);
    if (!CONSULTED.includes(s?.consulted)) add("invalid_source", `Source "${s?.id}" must say how much of it was consulted.`);
  }

  const nodeIds = new Set(w.nodes?.map((n) => n.id));
  const causeIds = new Set(w.causes?.map((c) => c.id));
  const regions = new Set(regionsOf(w));
  const specs = new Set(specificationsUsed(w));
  const codes = new Set(codesUsed(w));
  const cited = new Set<string>();
  const claimIds = new Set<string>();
  const covered = { causes: new Set<string>(), regions: new Set<string>(), specifications: new Set<string>(), codes: new Set<string>() };
  let primarySupported = false;
  for (const c of claims) {
    if (blank(c?.id)) add("invalid_claim", "A claim needs an id.");
    else if (claimIds.has(c.id)) add("duplicate_claim", `Claim id "${c.id}" is used twice.`);
    else claimIds.add(c.id);
    if (blank(c?.statement)) add("invalid_claim", `Claim "${c?.id}" needs a statement.`);
    if (!CLAIM_SUPPORT.includes(c?.support)) add("invalid_claim", `Claim "${c?.id}" has an unknown support level.`);
    const refs = Array.isArray(c?.sources) ? c.sources : [];
    if (c?.support === "author_judgement" && refs.length) add("judgement_with_sources", `Claim "${c.id}" is author judgement and must not look sourced.`);
    if ((c?.support === "supported" || c?.support === "partially_supported") && refs.length === 0) add("unsourced_claim", `Claim "${c.id}" says it is supported but cites no source.`);
    if (c?.support === "partially_supported" && blank(c.note)) add("invalid_claim", `Claim "${c.id}" is only partly supported: say which part is not.`);
    for (const ref of refs) {
      if (!sourceIds.has(ref?.source)) add("unknown_source", `Claim "${c.id}" cites "${String(ref?.source)}", which is not a declared source.`);
      else cited.add(ref.source);
      if (blank(ref?.locator)) add("invalid_claim", `Claim "${c.id}" must say where in "${String(ref?.source)}" (section, task, page).`);
      const s = sources.find((x) => x.id === ref?.source);
      if (s && c.support === "supported" && SOURCE_TIER[s.type] === "primary") primarySupported = true;
    }
    for (const n of c?.covers?.nodes ?? []) if (!nodeIds.has(n)) add("unknown_claim_target", `Claim "${c.id}" covers step "${n}", which is not in the workflow.`);
    const targets: Array<[string, string[] | undefined, Set<string>, Set<string>]> = [
      ["cause", c?.covers?.causes, causeIds, covered.causes],
      ["region", c?.covers?.regions, regions, covered.regions],
      ["specification", c?.covers?.specifications, specs, covered.specifications],
      ["code", c?.covers?.codes, codes, covered.codes],
    ];
    for (const [kind, list, known, into] of targets) {
      for (const x of list ?? []) {
        if (known.has(x)) into.add(x);
        else add("unknown_claim_target", `Claim "${c.id}" covers ${kind} "${x}", which the workflow does not use.`);
      }
    }
  }

  // 6. Coverage: nothing the diagnosis rests on goes unaccounted for.
  if (cls !== "synthetic_test") {
    for (const s of sourceIds) if (!cited.has(s)) add("unused_source", `Source "${s}" is declared but no claim cites it.`);
    for (const x of causeIds) if (!covered.causes.has(x)) add("uncovered_cause", `No claim accounts for cause "${x}".`);
    for (const x of regions) if (!covered.regions.has(x)) add("uncovered_region", `No claim accounts for the test region "${x}".`);
    for (const x of specs) if (!covered.specifications.has(x)) add("uncovered_specification", `No claim accounts for specification "${x}".`);
    for (const x of codes) if (!covered.codes.has(x)) add("uncovered_code", `No claim accounts for the use of code "${x}".`);
    if (claims.length && !primarySupported) add("no_primary_source", "At least one claim must be fully supported by a primary (authoritative) source.");
  }

  return problems.length || !fingerprint ? { ok: false, problems } : { ok: true, fingerprint };
}
