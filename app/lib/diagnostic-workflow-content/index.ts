/**
 * Reviewed diagnostic content (V2H). RESEARCH PROTOTYPE: nothing in the app
 * imports this yet. See docs/research/guided-diagnostics/v2h-reviewed-content.md.
 *
 * Content is data the deterministic engine consumes unchanged. The engine
 * (app/lib/diagnostic-workflow) never imports this folder.
 */
export * from "./types";
export { codesUsed, contentFingerprint, specificationsUsed, validateContent, type ContentProblem, type ContentValidation } from "./validate-content";
export { InvalidContentError, createContentCatalog, type CatalogEntry, type CatalogFilter, type ContentCatalog } from "./catalog";
export { ASE_A8_TASK_LIST, CARB_OBD2_1968_2, SAE_J2012_CATALOGUE } from "./sources";
export { GENERIC_GASOLINE_MISFIRE, GENERIC_GASOLINE_MISFIRE_WORKFLOW } from "./workflows/generic-gasoline-misfire";
export { SYNTHETIC_MISFIRE } from "./workflows/synthetic-misfire";
