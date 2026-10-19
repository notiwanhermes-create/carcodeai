/**
 * Which reviewed content a NEW guided session may start from (V2I).
 *
 * RESEARCH PROTOTYPE. This is the one place the rule lives. The production
 * policy offers only content a named, qualified human has APPROVED, and never
 * synthetic test content. Today no content is approved, so under it nothing
 * can be started.
 *
 * A weaker policy (drafts, synthetic fixtures) exists only for tests and can
 * only be made by `testOnlyContentPolicy`; the service refuses any other
 * policy object. The policy never applies to reopening history: a saved
 * session always loads by its exact workflow id, version and fingerprint,
 * whatever that content's review status is now.
 */
import type { WorkflowDefinition } from "../diagnostic-workflow";
import { REVIEW_STATUSES, type CatalogFilter, type ContentCatalog, type ContentClass, type ReviewStatus } from "../diagnostic-workflow-content";

export type ContentPolicy = Readonly<{ minReview: ReviewStatus; classes: readonly ContentClass[] }>;

export const PRODUCTION_CONTENT_POLICY: ContentPolicy = Object.freeze({
  minReview: "approved",
  classes: Object.freeze(["generic_source_backed", "oem_licensed"] as const),
});

const TEST_POLICIES = new WeakSet<object>();

/** TEST ONLY: a policy that may offer draft or synthetic content. Never used by a production caller. */
export function testOnlyContentPolicy(policy: { minReview: ReviewStatus; classes: readonly ContentClass[] }): ContentPolicy {
  if (!REVIEW_STATUSES.includes(policy.minReview)) throw new Error(`unknown review status: ${String(policy.minReview)}`);
  const made: ContentPolicy = Object.freeze({ minReview: policy.minReview, classes: Object.freeze([...policy.classes]) });
  TEST_POLICIES.add(made);
  return made;
}

/** True for the production policy and for policies made by testOnlyContentPolicy. Anything else is refused. */
export function isRecognizedPolicy(policy: unknown): policy is ContentPolicy {
  return policy === PRODUCTION_CONTENT_POLICY || (typeof policy === "object" && policy !== null && TEST_POLICIES.has(policy));
}

/**
 * The workflows a new session may start from under this policy: exactly the
 * catalog's suggestion list (the same allow-list V2F hands a model) filtered by
 * the policy. Start and listing both use this, so the rule cannot drift.
 */
export function startableWorkflows(catalog: ContentCatalog, policy: ContentPolicy): WorkflowDefinition[] {
  const filter: CatalogFilter = { minReview: policy.minReview, classes: policy.classes };
  return catalog.suggestionCatalog(filter);
}

/** The startable workflow with exactly this id and version, or null. Never another version. */
export function startableWorkflow(catalog: ContentCatalog, policy: ContentPolicy, workflowId: string, workflowVersion: number): WorkflowDefinition | null {
  return startableWorkflows(catalog, policy).find((w) => w.id === workflowId && w.version === workflowVersion) ?? null;
}
