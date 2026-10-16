# Guided Diagnostics V2H: reviewed content foundation

Research prototype, still not wired into the app. Builds on V2G (`0b03ad0`,
[v2g-persistence.md](v2g-persistence.md)).

- **No engine change.**
- **No database change:** no migration, no content storage.
- **No AI calls.**
- **The first source-backed workflow is a DRAFT** that no human has reviewed.

## Content versus engine

```
engine (app/lib/diagnostic-workflow)        unchanged; consumes WorkflowDefinition
content (app/lib/diagnostic-workflow-content)        reviewed data around it
  types.ts            content classes, review record, sources, claims
  validate-content.ts content rules (on top of the engine's validateWorkflow)
  catalog.ts          in-memory catalog: exact id + version → workflow + metadata
  sources.ts          public source citations
  workflows/          generic-gasoline-misfire.ts; synthetic-misfire.ts (classification only)
```

The engine never imports content and reads no metadata, so metadata cannot
change a diagnosis. Content holds no engine logic. The synthetic fixture
stays the engine's development fixture, in its old place, unchanged except
for a header line ("SYNTHETIC / TEST ONLY / NOT OEM DATA").

## Content classes

- **`synthetic_test`**
  - Id starts `synthetic.`, provenance starts `SYNTHETIC`.
  - Always `draft`; it can never be reviewed or approved.
- **`generic_source_backed`**
  - Needs sources and claims.
  - Must not be scoped to a make or engine.
  - Must not judge against a number written into it: every measurement names
    a specification.
  - Must list what vehicle-specific information it excludes.
- **`oem_licensed`** is reserved. It needs licensing metadata, a licensed
  manufacturer source, and a stated make. None exists.

Classes cannot be faked:

- only synthetic content may use a synthetic id or provenance;
- synthetic content cannot be relabelled as source-backed (it has no sources
  or claims, and its id gives it away).

## Review states

- **`draft`**: the most AI-generated or AI-assembled content can be on its
  own.
- **`source_reviewed`**: a named human checked the claims against the
  sources.
- **`approved`**: a named, qualified human approved the whole workflow.

Each review records:

- the reviewer (`kind: "human"`, name, qualification);
- the date;
- notes;
- `reviewedFingerprint`.

`contentRevision` and `preparedBy` (AI-assisted or human) sit on the record.

A status above `draft` is refused unless a review with a matching
fingerprint exists. So any change to the diagnostic content after approval
makes the approval stale. No reviewer is invented: the generic workflow has
`reviews: []`.

## Provenance model

**Sources:**

- id, title, publisher, type;
- a URL or a reference;
- edition (or "none stated");
- the date accessed;
- how much was consulted (`full_text`, `partial_text`, `catalogue_only`);
- limitations (required).

Citations only: no copied passages.

**Claims:**

- a short statement in CarCode's own words;
- support: `supported`, `partially_supported` (with a note on what is not
  supported) or `author_judgement`;
- source references with a locator (section, task number);
- what they cover: steps, causes, regions, codes, specifications.

**Validated:**

- source ids are unique and resolve, and every declared source is cited;
- supported claims cite something, and author judgement cites nothing;
- every cause, region, code and specification the workflow uses is
  accounted for by a claim;
- at least one claim is fully supported by a primary source.

## Source hierarchy

The tier is derived from the source type, never declared, so it cannot be
inflated.

- **Primary:**
  - `regulation`;
  - `standard_summary` and `standard_licensed`;
  - `manufacturer_public` and `manufacturer_licensed`;
  - `technical_institution`.
- **Secondary:** `technical_education`.

Forums, SEO articles, unsourced code lists, anonymous content and AI output
are not source types at all.

## Fingerprint semantics

The content fingerprint is exactly the V2G workflow fingerprint: a sha256
of the canonical `WorkflowDefinition`.

- **Changes the fingerprint:** everything in the workflow object.
  - Steps, routes, cause effects, applicability, conditions and specification
    ids.
  - Hazards, prompts, titles and recommendations, because people act on that
    text.
  - The short provenance string, kept deliberately stable.
- **Does not change it:** review records, sources, claims, exclusions,
  `contentRevision`.

**Consequences (tested):**

- A metadata-only change leaves every persisted session loadable.
- A diagnostic change under the same version is refused by V2G
  (`workflow_changed`): it needs a new version.
- It also makes any approval stale.

V2G's exact-history guarantees are unchanged.

## Catalog

`createContentCatalog(contents)`:

- **Validates and freezes** every entry.
- **Refuses** invalid content and duplicate id@version.
- **`resolve(id, version)`** returns the exact entry or null; there is no
  "latest".
- **`workflowResolver(filter?)`** is the V2G resolver. By default every
  class and status resolves, so history stays loadable.
- **`suggestionCatalog(filter?)`** is the V2F allow-list. Synthetic content
  is excluded by default.
  - A model can only name ids. Invented ids are rejected.
  - Extra fields (such as a "reviewStatus") make its output invalid.
  - Nothing it returns changes the catalog.

No database storage, no editor.

## First generic workflow

`generic.gasoline-engine-misfire` v1 is a draft. See the
[content review file](content/generic-gasoline-misfire-review.md) for:

- its structure, sources and claim-to-source map;
- its assumptions, exclusions and unresolved questions;
- the reviewer checklist.

In short:

- **Scope:** gasoline only, five coarse categories, two small reorderable
  regions.
- **Codes:** route only when current.
- **Specifications:** one specification id (`fuel_supply_pressure_expected`)
  and no vehicle values.
- **Verification:** needs the detecting check, the symptom and a complete
  post-repair scan.

## Known limitations

- **Sources:**
  - one old CARB edition, read in part;
  - an SAE catalogue page only, so the code identifiers are unverified;
  - section A of the ASE A8 task list.
- **Most cause effects and every hazard note are author judgement.**
- **Fuel pressure can never be judged today:** no verified specification
  source exists.
- **No contradiction possible in the draft's regions.** Every supporting
  result leaves its region, so a contradiction cannot arise there today. The
  engine rule is still tested on a reviewer variant.
- **Not validated on real vehicles.**

## Human review requirement and production approval

Before any user sees this workflow:

1. A qualified automotive reviewer completes the checklist in the review
   file and resolves its open questions. This means changes and a new
   version where needed.
2. Their review is recorded with the fingerprint they reviewed. The validator
   then accepts `approved`.
3. The code identifiers are verified against licensed SAE J2012-DA data, or
   the code routing is removed.
4. A verified specification source exists for `fuel_supply_pressure_expected`,
   or the step is accepted as always routing to a professional.
5. Production integration decides that only `approved` content is offered
   (`suggestionCatalog({ minReview: "approved" })`) while history still
   resolves.

Then come production UI and API work, still not started.

## Production build and V2G migration

- Production build: pending local or CI verification.
- V2G real migration: pending local verification.

Both for the same cloud-environment reasons as before.
