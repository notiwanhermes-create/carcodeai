/**
 * A small in-memory catalog of reviewed workflow content (V2H).
 *
 * RESEARCH PROTOTYPE. Not a content management system and not production
 * storage. It holds only content that passes validation, frozen, keyed by the
 * exact workflow id AND version, and serves:
 *
 * - V2G: `workflowResolver()` (exact id + version; never the newest);
 * - V2F: `suggestionCatalog()` (the allow-list a model may name ids from);
 * - lookups of a workflow together with its content metadata.
 *
 * Nothing here can change a workflow, its sources or its review status.
 */
import type { WorkflowDefinition } from "../diagnostic-workflow";
import type { WorkflowResolver } from "../diagnostic-workflow-persistence/workflow-resolver";
import { REVIEW_STATUSES, type ContentClass, type ReviewStatus, type WorkflowContent } from "./types";
import { validateContent, type ContentProblem } from "./validate-content";

export type CatalogEntry = Readonly<WorkflowContent> & { readonly fingerprint: string };

export type CatalogFilter = {
  /** Only these content classes. */
  classes?: readonly ContentClass[];
  /** Only content reviewed at least this far (draft < source_reviewed < approved). */
  minReview?: ReviewStatus;
};

export class InvalidContentError extends Error {
  constructor(readonly workflow: string, readonly problems: ContentProblem[]) {
    super(`content ${workflow} is invalid: ${problems.map((p) => p.code).join(", ")}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const rank = (s: ReviewStatus) => REVIEW_STATUSES.indexOf(s);

export function createContentCatalog(contents: readonly WorkflowContent[]) {
  const byKey = new Map<string, CatalogEntry>();
  for (const raw of contents) {
    // A private, frozen copy: later edits to the caller's object never reach the catalog.
    const content = deepFreeze(structuredClone(raw));
    const key = `${content.workflow?.id}@${content.workflow?.version}`;
    const checked = validateContent(content);
    if (!checked.ok) throw new InvalidContentError(key, checked.problems);
    if (byKey.has(key)) throw new InvalidContentError(key, [{ code: "duplicate_entry", message: `${key} is in the catalog twice; a changed workflow needs a new version.` }]);
    byKey.set(key, Object.freeze({ ...content, fingerprint: checked.fingerprint }));
  }

  const matches = (e: CatalogEntry, f: CatalogFilter = {}) =>
    (!f.classes || f.classes.includes(e.contentClass)) && (!f.minReview || rank(e.review.status) >= rank(f.minReview));
  const list = (f?: CatalogFilter) => [...byKey.values()].filter((e) => matches(e, f));

  return {
    /** Every entry, in the order given. */
    entries: (filter?: CatalogFilter): CatalogEntry[] => list(filter),

    /** The entry with exactly this id and version, or null. Never another version. */
    resolve(workflowId: string, workflowVersion: number): CatalogEntry | null {
      return byKey.get(`${workflowId}@${workflowVersion}`) ?? null;
    },

    /**
     * A V2G resolver over the catalog. History must stay loadable, so by
     * default every class and review status resolves; a caller may narrow it.
     */
    workflowResolver(filter?: CatalogFilter): WorkflowResolver {
      return {
        resolve: (id, version) => {
          const e = byKey.get(`${id}@${version}`);
          return e && matches(e, filter) ? e.workflow : null;
        },
      };
    },

    /**
     * The workflows a model may suggest from (V2F `suggestWorkflows`). Synthetic
     * test content is left out unless asked for explicitly. Being listed gives a
     * model no authority: it can only name an id, which is then checked.
     */
    suggestionCatalog(filter: CatalogFilter = { classes: ["generic_source_backed", "oem_licensed"] }): WorkflowDefinition[] {
      return list(filter).map((e) => e.workflow);
    },
  };
}

export type ContentCatalog = ReturnType<typeof createContentCatalog>;
