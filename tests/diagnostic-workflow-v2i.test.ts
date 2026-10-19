/**
 * Guided Diagnostics V2I: the server-only service that ties reviewed content,
 * the deterministic engine, V2G persistence and authenticated ownership
 * together. Everything here is SYNTHETIC / TEST ONLY / NOT OEM DATA.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { capabilityPreset } from "../app/lib/diagnostic-workflow/examples/capability-presets";
import { GENERIC_GASOLINE_MISFIRE, SYNTHETIC_MISFIRE, contentFingerprint, createContentCatalog, type WorkflowContent } from "../app/lib/diagnostic-workflow-content";
import { canonicalJson, createInMemorySessionRepository } from "../app/lib/diagnostic-workflow-persistence";
import {
  PRODUCTION_CONTENT_POLICY,
  UnrecognizedContentPolicyError,
  createGuidedDiagnosticsService,
  createInMemoryVehicleDirectory,
  testOnlyContentPolicy,
  type ContentPolicy,
  type StartRequest,
} from "../app/lib/diagnostic-workflow-service";
import { ANN, DETAILS, GARAGE_CAR, guidedServiceContract, tickingClock } from "./helpers/guided-service-contract";

const GARAGE = {
  "car-ann": { ownerId: "ann", context: GARAGE_CAR },
  "car-bob": { ownerId: "bob", context: { year: 2018, make: "Synthetic", model: "Other Car" } },
  "car-ann-old": { ownerId: "ann", context: { year: 2003, make: "Synthetic", model: "Old Car" }, archived: true },
};
const VEHICLE_OWNERS = { "car-ann": "ann", "car-bob": "bob", "car-ann-old": "ann" };

let repositories: Array<ReturnType<typeof createInMemorySessionRepository>> = [];
guidedServiceContract("in-memory", {
  fresh: async () => {
    const repository = createInMemorySessionRepository({ vehicles: VEHICLE_OWNERS });
    repositories = [repository];
    return { repository, vehicles: createInMemoryVehicleDirectory(GARAGE) };
  },
  corruptCurrentStep: async (sessionId) => {
    repositories[0].tamper(sessionId, (r) => {
      r.currentStep = "somewhere_else";
      return r;
    });
  },
});

/* ───────────────────────── helpers ───────────────────────── */

const G = GENERIC_GASOLINE_MISFIRE.workflow;
const WORKSHOP = capabilityPreset("workshop");
const edit = (mutate: (c: WorkflowContent) => void, base: WorkflowContent = GENERIC_GASOLINE_MISFIRE) => {
  const c = structuredClone(base);
  mutate(c);
  return c;
};
/** A clearly fictional reviewer, used only to test the rules. No real review has happened. */
const FIXTURE_REVIEWER = { kind: "human" as const, name: "TEST FIXTURE REVIEWER (not a real person)", qualification: "TEST FIXTURE" };
const APPROVED_FIXTURE = edit((c) => {
  c.review.status = "approved";
  c.review.reviews = [{ decision: "approved", reviewer: FIXTURE_REVIEWER, date: "2026-10-16", notes: "TEST FIXTURE", reviewedFingerprint: contentFingerprint(c.workflow) }];
});
const DRAFT_FOR_TESTS = testOnlyContentPolicy({ minReview: "draft", classes: ["generic_source_backed"] });
const genericStart = (over: Partial<StartRequest> = {}): StartRequest => ({ vehicleId: "car-ann", workflow: { id: G.id, version: G.version }, capabilities: WORKSHOP, vehicleDetails: DETAILS, ...over });

function serviceWith(contents: WorkflowContent[], contentPolicy?: ContentPolicy, repository = createInMemorySessionRepository({ vehicles: VEHICLE_OWNERS })) {
  const svc = createGuidedDiagnosticsService({
    catalog: createContentCatalog(contents),
    repository,
    vehicles: createInMemoryVehicleDirectory(GARAGE),
    clock: tickingClock(),
    ...(contentPolicy && { contentPolicy }),
  });
  return { svc, repository };
}

/* ───────────────────────── new-session content policy ───────────────────────── */

describe("V2I content policy for new sessions", () => {
  it("offers nothing under the default (production) policy today: the generic workflow is a draft and the fixture is synthetic", async () => {
    const { svc } = serviceWith([SYNTHETIC_MISFIRE, GENERIC_GASOLINE_MISFIRE]);
    expect(svc.listStartable()).toEqual([]);
    expect(await svc.startGuidedSession(ANN, genericStart())).toEqual({ status: "workflow_not_offered", workflowId: G.id, workflowVersion: G.version });
    expect(await svc.startGuidedSession(ANN, genericStart({ workflow: { id: SYNTHETIC_MISFIRE.workflow.id, version: SYNTHETIC_MISFIRE.workflow.version } }))).toMatchObject({ status: "workflow_not_offered" });
  });

  it("starts approved content under the production policy, and nothing that is not approved", async () => {
    const { svc } = serviceWith([APPROVED_FIXTURE, SYNTHETIC_MISFIRE], PRODUCTION_CONTENT_POLICY);
    expect(svc.listStartable()).toEqual([{ id: G.id, version: G.version, title: G.title }]);
    expect(await svc.startGuidedSession(ANN, genericStart())).toMatchObject({ status: "started", meta: { workflowId: G.id, workflowVersion: 1 } });
  });

  it("uses draft or synthetic content only through an explicit test-only policy, and refuses any other policy object", async () => {
    const { svc } = serviceWith([GENERIC_GASOLINE_MISFIRE], DRAFT_FOR_TESTS);
    expect(await svc.startGuidedSession(ANN, genericStart())).toMatchObject({ status: "started" });
    // A hand-made policy cannot weaken the rule, even with the same shape as a test policy.
    const handMade = Object.freeze({ minReview: "draft", classes: ["generic_source_backed", "synthetic_test"] }) as ContentPolicy;
    expect(() => serviceWith([GENERIC_GASOLINE_MISFIRE], handMade)).toThrow(UnrecognizedContentPolicyError);
    // The production policy is frozen: it cannot be loosened in place.
    expect(Object.isFrozen(PRODUCTION_CONTENT_POLICY) && Object.isFrozen(PRODUCTION_CONTENT_POLICY.classes)).toBe(true);
    expect(PRODUCTION_CONTENT_POLICY).toEqual({ minReview: "approved", classes: ["generic_source_backed", "oem_licensed"] });
  });

  it("starts only the exact version asked for: never another, never the newest", async () => {
    const v2 = edit((c) => {
      c.workflow.version = 2;
    });
    const { svc } = serviceWith([GENERIC_GASOLINE_MISFIRE, v2], DRAFT_FOR_TESTS);
    expect(await svc.startGuidedSession(ANN, genericStart({ workflow: { id: G.id, version: 3 } }))).toEqual({ status: "workflow_not_offered", workflowId: G.id, workflowVersion: 3 });
    expect(await svc.startGuidedSession(ANN, genericStart({ workflow: { id: G.id, version: 1 } }))).toMatchObject({ status: "started", meta: { workflowVersion: 1 } });
    expect(await svc.startGuidedSession(ANN, genericStart({ workflow: { id: G.id, version: 1.5 } }))).toMatchObject({ status: "invalid_request" });
  });
});

/* ───────────────────────── historical sessions ───────────────────────── */

describe("V2I historical sessions", () => {
  /** A session started from the draft under the test policy, then reopened by a service with other content. */
  async function savedThenReopenedWith(contents: WorkflowContent[]) {
    const repository = createInMemorySessionRepository({ vehicles: VEHICLE_OWNERS });
    const { svc } = serviceWith([GENERIC_GASOLINE_MISFIRE], DRAFT_FOR_TESTS, repository);
    const started = await svc.startGuidedSession(ANN, genericStart());
    if (started.status !== "started") throw new Error(JSON.stringify(started));
    const saved = await svc.submitGuidedStep(ANN, { sessionId: started.meta.id, expectedRevision: 1, input: { nodeId: "confirm_symptom", kind: "yes_no", answer: "yes" } });
    if (saved.status !== "saved") throw new Error(JSON.stringify(saved));
    // Reopened under the PRODUCTION policy: history never depends on what may start today.
    const later = serviceWith(contents, PRODUCTION_CONTENT_POLICY, repository).svc;
    return { later, id: started.meta.id, saved };
  }

  it("reopens and continues after a metadata-only content change, without needing approval", async () => {
    const metadataOnly = edit((c) => {
      c.review.contentRevision = 2;
      c.excludes = [...c.excludes, "TEST FIXTURE: one more stated exclusion"];
    });
    expect(contentFingerprint(metadataOnly.workflow)).toBe(contentFingerprint(G));
    const { later, id, saved } = await savedThenReopenedWith([metadataOnly]);
    const loaded = await later.loadGuidedSession(ANN, id);
    if (loaded.status !== "loaded") throw new Error(JSON.stringify(loaded));
    expect(canonicalJson(loaded.session)).toBe(canonicalJson(saved.session));
    expect(await later.submitGuidedStep(ANN, { sessionId: id, expectedRevision: 2, input: { nodeId: "mil_flashing", kind: "yes_no", answer: "no" } })).toMatchObject({ status: "saved", meta: { revision: 3 } });
  });

  it("refuses to reopen against diagnostically changed content under the same version", async () => {
    const changed = edit((c) => {
      c.workflow.title = `${c.workflow.title} (changed)`;
    });
    const { later, id } = await savedThenReopenedWith([changed]);
    const refused = { status: "incompatible_workflow", reason: "workflow_changed", workflowId: G.id, workflowVersion: 1 };
    expect(await later.loadGuidedSession(ANN, id)).toEqual(refused);
    expect(await later.submitGuidedStep(ANN, { sessionId: id, expectedRevision: 2, input: { nodeId: "mil_flashing", kind: "yes_no", answer: "no" } })).toEqual(refused);
  });

  it("never falls back to the newest version when the session's version is gone", async () => {
    const v2 = edit((c) => {
      c.workflow.version = 2;
    });
    const { later, id } = await savedThenReopenedWith([v2]);
    expect(await later.loadGuidedSession(ANN, id)).toEqual({ status: "incompatible_workflow", reason: "workflow_unavailable", workflowId: G.id, workflowVersion: 1 });
  });

  it("refuses a session written by a newer persistence format instead of guessing", async () => {
    const repository = createInMemorySessionRepository({ vehicles: VEHICLE_OWNERS });
    const { svc } = serviceWith([GENERIC_GASOLINE_MISFIRE], DRAFT_FOR_TESTS, repository);
    const started = await svc.startGuidedSession(ANN, genericStart());
    if (started.status !== "started") throw new Error("start");
    repository.tamper(started.meta.id, (r) => ({ ...r, persistenceVersion: 99 }));
    expect(await svc.loadGuidedSession(ANN, started.meta.id)).toMatchObject({ status: "unsupported_version", persistenceVersion: 99 });
    expect(await svc.submitGuidedStep(ANN, { sessionId: started.meta.id, expectedRevision: 1, input: { nodeId: "confirm_symptom", kind: "yes_no", answer: "yes" } })).toMatchObject({ status: "unsupported_version" });
  });
});

/* ───────────────────────── boundaries ───────────────────────── */

describe("V2I boundaries", () => {
  const ROOT = path.join(__dirname, "..");
  const filesUnder = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "generated" || e.name === "node_modules" ? [] : filesUnder(p);
      return /\.(ts|tsx|js|mjs)$/.test(e.name) ? [p] : [];
    });
  const read = (p: string) => fs.readFileSync(p, "utf8");
  const importsOf = (src: string) => [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const SERVICE = path.join(ROOT, "app", "lib", "diagnostic-workflow-service");

  it("is not used by any app route, page, component or other module", () => {
    const users = [...filesUnder(path.join(ROOT, "app")), ...filesUnder(path.join(ROOT, "components"))]
      .filter((f) => !f.startsWith(SERVICE))
      .filter((f) => importsOf(read(f)).some((i) => i.includes("diagnostic-workflow-service")));
    expect(users).toEqual([]);
  });

  it("keeps the engine free of the service, persistence, content, the bridge, Prisma, AI and network code", () => {
    for (const f of filesUnder(path.join(ROOT, "app", "lib", "diagnostic-workflow"))) {
      const src = read(f);
      for (const i of importsOf(src)) expect(i, `${f} imports ${i}`).not.toMatch(/diagnostic-workflow-(service|persistence|content|bridge)|prisma|openai|anthropic|^ai$|node:(http|https|net)/);
      expect(src, f).not.toMatch(/\bfetch\(/);
    }
  });

  it("keeps the bridge free of persistence and the service", () => {
    for (const f of filesUnder(path.join(ROOT, "app", "lib", "diagnostic-workflow-bridge"))) {
      for (const i of importsOf(read(f))) expect(i, `${f} imports ${i}`).not.toMatch(/diagnostic-workflow-(service|persistence)|prisma/);
    }
  });

  it("keeps the service free of AI SDKs and network code, with Prisma in one garage-reading file only", () => {
    const files = filesUnder(SERVICE);
    expect(files.map((f) => path.basename(f)).sort()).toEqual(["index.ts", "policy.ts", "prisma-vehicles.ts", "service.ts", "vehicles.ts"]);
    for (const f of files) {
      const src = read(f);
      for (const i of importsOf(src)) expect(i, `${f} imports ${i}`).not.toMatch(/openai|anthropic|^ai$|@ai-sdk|node:(http|https|net)/);
      expect(src, f).not.toMatch(/\bfetch\(/);
      const touchesPrisma = importsOf(src).some((i) => /prisma/.test(i) && !/diagnostic-workflow-persistence$/.test(i));
      expect(touchesPrisma, f).toBe(path.basename(f) === "prisma-vehicles.ts");
    }
    // It reads the garage and never writes it.
    expect(read(path.join(SERVICE, "prisma-vehicles.ts"))).not.toMatch(/\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(|\$executeRaw|\$queryRaw/);
    // The index (what a route would import) does not drag Prisma in.
    expect(importsOf(read(path.join(SERVICE, "index.ts")))).not.toContain("./prisma-vehicles");
  });

  it("has no state transition of its own: every change goes through the engine's submitStep or the bridge's acceptProposal", () => {
    const src = read(path.join(SERVICE, "service.ts"));
    expect(src).not.toMatch(/replaySession|resumeSession|remainingCauses|supportedCauses|currentNodeId\s*=|endResult\s*=/);
    expect(src.match(/\bsubmitStep\(/g)).toHaveLength(1);
    expect(src.match(/\bacceptProposal\(/g)).toHaveLength(1);
  });

  it("takes workflows only from the content catalog's suggestion boundary, filtered in one place", () => {
    const service = read(path.join(SERVICE, "service.ts"));
    const policy = read(path.join(SERVICE, "policy.ts"));
    expect(service).not.toMatch(/suggestionCatalog|minReview|\.entries\(/);
    expect(policy.match(/suggestionCatalog\(/g)).toHaveLength(1);
    // The synthetic engine fixture never reaches the service except through content passed in.
    expect(importsOf(service).filter((i) => /examples|workflows\//.test(i))).toEqual([]);
  });
});
