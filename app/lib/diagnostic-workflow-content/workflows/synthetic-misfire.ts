/**
 * The engine's SYNTHETIC development fixture, classified as content (V2H).
 *
 * SYNTHETIC / TEST ONLY / NOT OEM DATA. The workflow itself stays where it
 * is (app/lib/diagnostic-workflow/examples) and is not changed: this only
 * records what it is, so the catalog can never mistake it for real content.
 */
import { SYNTHETIC_MISFIRE_WORKFLOW } from "../../diagnostic-workflow/examples/synthetic-misfire";
import type { WorkflowContent } from "../types";

export const SYNTHETIC_MISFIRE: WorkflowContent = {
  workflow: SYNTHETIC_MISFIRE_WORKFLOW,
  contentClass: "synthetic_test",
  review: {
    status: "draft",
    contentRevision: 1,
    preparedBy: { kind: "ai_assisted", note: "SYNTHETIC / TEST ONLY / NOT OEM DATA: the engine's development fixture. Never reviewed for use." },
    reviews: [],
  },
  sources: [],
  claims: [],
  excludes: ["Everything real: this workflow and its specifications are made up for tests"],
};
