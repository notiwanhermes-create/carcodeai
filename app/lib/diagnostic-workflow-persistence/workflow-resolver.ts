/**
 * Finds the EXACT workflow a persisted session was run against (V2G).
 *
 * RESEARCH PROTOTYPE. Keyed on id AND version. There is no "latest" lookup and
 * no fallback: a version-5 session is never resumed with version 6, and a
 * session whose version is not available cannot be loaded. A session is never
 * migrated to a newer workflow; continuing under a newer one means starting a
 * new session. There is no production registry; tests use the in-memory one.
 */
import type { WorkflowDefinition } from "../diagnostic-workflow";
import { workflowFingerprint } from "./canonical";

export interface WorkflowResolver {
  /** The workflow with exactly this id and version, or null. Never a different version. */
  resolve(workflowId: string, workflowVersion: number): WorkflowDefinition | null;
}

/** A fixed set of reviewed workflow definitions, held in memory. Two different definitions under one id and version are refused. */
export function createInMemoryWorkflowResolver(workflows: readonly WorkflowDefinition[]): WorkflowResolver {
  const byKey = new Map<string, WorkflowDefinition>();
  for (const w of workflows) {
    const key = `${w.id}@${w.version}`;
    const existing = byKey.get(key);
    if (existing && workflowFingerprint(existing) !== workflowFingerprint(w)) {
      throw new Error(`two different definitions of ${key}: a changed workflow needs a new version`);
    }
    byKey.set(key, w);
  }
  return {
    resolve: (workflowId, workflowVersion) => byKey.get(`${workflowId}@${workflowVersion}`) ?? null,
  };
}
