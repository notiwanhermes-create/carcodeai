/**
 * Guided Diagnostics V2G: persisted diagnostic sessions.
 *
 * Research prototype. No database in this file (the Prisma adapter's tests are
 * in tests/integration and need TEST_DATABASE_URL), no network, no AI. Every
 * workflow, vehicle, code and specification here is SYNTHETIC / TEST ONLY /
 * NOT OEM DATA.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resumeSession, specificationDrift, startSession, type DiagnosticSession, type WorkflowDefinition } from "../app/lib/diagnostic-workflow";
import { createInMemorySpecificationProvider } from "../app/lib/diagnostic-workflow/examples/in-memory-specification-provider";
import { SYNTHETIC_SPECIFICATIONS } from "../app/lib/diagnostic-workflow/examples/synthetic-specifications";
import { acceptProposal, explain, parseStepInput, textReference } from "../app/lib/diagnostic-workflow-bridge";
import { createKeywordParser } from "../app/lib/diagnostic-workflow-bridge/examples/fake-adapters";
import {
  NotPlainDataError,
  PERSISTENCE_VERSION,
  SESSION_FORMAT_VERSION,
  canonicalJson,
  createInMemorySessionRepository,
  createInMemoryWorkflowResolver,
  createSessionStore,
  digestOf,
  sealedContent,
  toPlainData,
  workflowFingerprint,
  type IntegrityConfig,
  type InMemorySessionRepository,
  type StoredSession,
} from "../app/lib/diagnostic-workflow-persistence";
import { ANN, BOB, sessionStoreContract } from "./helpers/session-store-contract";
import { CONFLICT_FACTS, CONFLICT_ROUTE, FUEL_FACTS, FUEL_ROUTE, FUEL_VERIFIED, REGION_FACTS, REGION_ROUTE, SPECS, T0, W, direct, persistThrough, started, step } from "./helpers/persisted-sessions";

const garage = () => ({ "car-ann": "ann", "car-bob": "bob" });

/* ───────────────────────── the contract, against the in-memory repository ───────────────────────── */

sessionStoreContract("in-memory", { repository: async () => createInMemorySessionRepository({ vehicles: garage() }) });

/* ───────────────────────── helpers for the rest of this file ───────────────────────── */

let n = 0;
function setup(options: { workflows?: WorkflowDefinition[]; integrity?: IntegrityConfig } = {}) {
  const repo = createInMemorySessionRepository({ vehicles: garage() });
  const store = createSessionStore({ repository: repo, workflows: createInMemoryWorkflowResolver(options.workflows ?? [W]), integrity: options.integrity, newId: () => `s-${++n}` });
  return { repo, store };
}

/** Recompute a tampered record's digest, as someone with database access but no secret could. */
function reseal(record: Record<string, unknown>, integrity: IntegrityConfig = { algorithm: "sha256" }) {
  record.payloadDigest = digestOf(canonicalJson(sealedContent(record as StoredSession)), integrity);
  return record;
}

type Rec = Record<string, unknown> & { payload: DiagnosticSession & Record<string, unknown> };
async function savedFuel(repoStore = setup(), inputs = FUEL_ROUTE) {
  const { id, final } = await persistThrough(repoStore.store, ANN, "car-ann", FUEL_FACTS, inputs);
  return { ...repoStore, id, final };
}
const tamper = (repo: InMemorySessionRepository, id: string, edit: (r: Rec) => unknown) => repo.tamper(id, (r) => edit(r as Rec));

/* ───────────────────────── codec ───────────────────────── */

describe("V2G codec: one canonical, plain-data serialization", () => {
  it("round-trips a session exactly, whatever the key order", () => {
    const s = direct(FUEL_FACTS, [...FUEL_ROUTE, FUEL_VERIFIED]);
    const text = canonicalJson(s);
    expect(canonicalJson(JSON.parse(text))).toBe(text);
    expect(toPlainData(s)).toEqual(JSON.parse(JSON.stringify(s)));
    // Key order never matters.
    const reversed = JSON.parse(JSON.stringify(s), (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
    expect(canonicalJson(reversed)).toBe(text);
    // And the engine resumes from the canonical form (its resume comparison ignores key order too).
    const back = resumeSession(W, JSON.parse(text));
    expect(back.ok && canonicalJson(back.session)).toBe(text);
  });

  it("refuses anything that is not plain data, rather than silently changing it", () => {
    for (const bad of [{ a: () => 1 }, { a: new Date(0) }, { a: NaN }, { a: Infinity }, { a: BigInt(1) }, { a: Symbol("x") }, { a: new Map() }, [undefined], { [Symbol("k")]: 1 }]) {
      expect(() => canonicalJson(bad), String(Object.keys(bad))).toThrow(NotPlainDataError);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycle/);
    // Missing and undefined are the same; -0 is 0.
    expect(canonicalJson({ a: undefined, b: -0 })).toBe('{"b":0}');
  });

  it("will not store a session that is not plain data or not a session", async () => {
    const { store } = setup();
    const s = started(FUEL_FACTS);
    expect(await store.start(ANN, { vehicleId: "car-ann", session: { ...s, extra: () => 1 } as never })).toMatchObject({ status: "invalid_session", reason: expect.stringMatching(/not plain data at extra/) });
    expect(await store.start(ANN, { vehicleId: "car-ann", session: { ...s, unknownField: 1 } as never })).toMatchObject({ status: "invalid_session" });
    expect(await store.start(ANN, { vehicleId: "car-ann", session: { ...s, status: "paused" } as never })).toMatchObject({ status: "invalid_session" });
    // A session with inputs already in it is not a start: revision 1 is the started session.
    expect(await store.start(ANN, { vehicleId: "car-ann", session: step(s, FUEL_ROUTE[0]) })).toMatchObject({ status: "invalid_session" });
  });

  it("stores explicit format versions and refuses future ones", async () => {
    const { repo, store, id } = await savedFuel();
    expect(repo.rawRecord(id)).toMatchObject({ persistenceVersion: PERSISTENCE_VERSION, sessionFormatVersion: SESSION_FORMAT_VERSION, workflowId: W.id, workflowVersion: W.version, workflowFingerprint: workflowFingerprint(W) });
    tamper(repo, id, (r) => ((r.persistenceVersion = PERSISTENCE_VERSION + 1), r));
    expect(await store.load(ANN, id)).toEqual({ status: "unsupported_version", persistenceVersion: 2, sessionFormatVersion: 1 });
    tamper(repo, id, (r) => ((r.persistenceVersion = 1), (r.sessionFormatVersion = 99), r));
    expect(await store.load(ANN, id)).toEqual({ status: "unsupported_version", persistenceVersion: 1, sessionFormatVersion: 99 });
  });
});

/* ───────────────────────── exact workflow versions ───────────────────────── */

describe("V2G workflow versions: exact id and version, never the newest", () => {
  const W5: WorkflowDefinition = { ...W, version: 5 };
  const W7: WorkflowDefinition = { ...W, version: 7 };

  it("resumes a session with the exact version it was run against, even when a newer one exists", async () => {
    const { store } = setup({ workflows: [W5, W] });
    const r = startSession(W5, FUEL_FACTS, T0, SPECS);
    if (!r.ok) throw new Error(r.error);
    const saved = await store.start(ANN, { vehicleId: "car-ann", session: r.session });
    if (saved.status !== "saved") throw new Error(JSON.stringify(saved));
    const loaded = await store.load(ANN, saved.meta.id);
    expect(loaded.status === "loaded" && [loaded.workflow.version, loaded.session.workflowVersion, loaded.meta.workflowVersion]).toEqual([5, 5, 5]);
  });

  it("refuses to load when that version is unavailable, and never substitutes another", async () => {
    const { repo, id } = await savedFuel(setup({ workflows: [W] }));
    const onlyNewer = createSessionStore({ repository: repo, workflows: createInMemoryWorkflowResolver([W7]) });
    expect(await onlyNewer.load(ANN, id)).toEqual({ status: "incompatible_workflow", reason: "workflow_unavailable", workflowId: W.id, workflowVersion: W.version });
    const none = createSessionStore({ repository: repo, workflows: createInMemoryWorkflowResolver([]) });
    expect(await none.load(ANN, id)).toMatchObject({ status: "incompatible_workflow", reason: "workflow_unavailable" });
    // Nothing was rewritten to the newer version.
    expect(repo.rawRecord(id)).toMatchObject({ workflowVersion: W.version });
  });

  it("refuses a workflow whose content changed under the same id and version", async () => {
    const { repo, id } = await savedFuel();
    const edited: WorkflowDefinition = { ...W, title: `${W.title} (edited without a new version)` };
    const store = createSessionStore({ repository: repo, workflows: createInMemoryWorkflowResolver([edited]) });
    expect(await store.load(ANN, id)).toMatchObject({ status: "incompatible_workflow", reason: "workflow_changed" });
    expect(() => createInMemoryWorkflowResolver([W, edited])).toThrow(/needs a new version/);
  });

  it("never starts a stored session for a workflow version it cannot resolve", async () => {
    const { store } = setup({ workflows: [W] });
    const r = startSession(W7, FUEL_FACTS, T0, SPECS);
    if (!r.ok) throw new Error(r.error);
    expect(await store.start(ANN, { vehicleId: "car-ann", session: r.session })).toMatchObject({ status: "incompatible_workflow", reason: "workflow_unavailable" });
  });
});

/* ───────────────────────── pinned history ───────────────────────── */

describe("V2G pinned history: reconstruction uses only what the session pinned", () => {
  it("does not consult any specification provider: provider drift is reported separately and never rewrites the result", async () => {
    const { store, id, final } = await savedFuel();
    // The provider's data changes after the session (the low limit drops so 200 kPa would now be "within").
    const changed = createInMemorySpecificationProvider(
      SYNTHETIC_SPECIFICATIONS.map((s) => (s.id === "synthetic.fuel_supply_pressure_idle" ? { ...s, revision: "SYNTHETIC-TEST-ONLY-r2", expected: { min: 150, max: 450 } } : s)),
    );
    const reloaded = await store.load(ANN, id);
    if (reloaded.status !== "loaded") throw new Error("load");
    expect(canonicalJson(reloaded.session)).toBe(canonicalJson(final.session));
    expect(reloaded.session).toMatchObject({ supportedCauses: ["fuel_supply"], conclusionNodeId: "concl_fuel_supply" });
    const drift = specificationDrift(reloaded.session, changed);
    expect(drift.map((d) => d.id)).toEqual(["synthetic.fuel_supply_pressure_idle"]);
    // Asking about drift changed nothing.
    expect(canonicalJson(reloaded.session)).toBe(canonicalJson(final.session));
    // The store has no provider at all: there is no way for it to ask one.
    expect(Object.keys(store).sort()).toEqual(["advance", "history", "load", "start"]);
  });

  it("keeps the pinned vehicle when the garage vehicle changes later", async () => {
    const { repo, store, id, final } = await savedFuel();
    repo.setVehicle("car-ann", "ann"); // the garage record is edited / re-registered
    const reloaded = await store.load(ANN, id);
    expect(reloaded.status === "loaded" && reloaded.session.facts.vehicle).toEqual(final.session.facts.vehicle);
    // Continuing a session can never swap its pinned vehicle.
    const swapped = step(started({ ...FUEL_FACTS, vehicle: { fuel: "gasoline", cylinders: 4, make: "Other" } }), FUEL_ROUTE[0]);
    expect(await store.advance(ANN, { sessionId: id, expectedRevision: final.meta.revision, session: swapped })).toMatchObject({ status: "invalid_transition" });
  });

  it("keeps the database lifecycle separate from the diagnostic outcome", async () => {
    const { repo, id } = await savedFuel(setup(), [...FUEL_ROUTE, FUEL_VERIFIED]);
    const raw = repo.rawRecord(id)!;
    expect(raw.lifecycle).toBe("completed");
    expect((raw.payload as DiagnosticSession).endResult).toBe("resolved");
    expect(Object.keys(raw)).not.toContain("endResult");
  });
});

/* ───────────────────────── corruption and tampering fail closed ───────────────────────── */

describe("V2G corruption: a record that cannot be established is refused, never repaired", () => {
  const corrupted = { status: "corrupted", reason: expect.any(String) };

  it("edited evidence", async () => {
    const { repo, store, id } = await savedFuel();
    tamper(repo, id, (r) => {
      (r.payload.evidence as unknown as Array<{ nodeId: string; value: string }>).find((e) => e.nodeId === "fuel_pump_actuator")!.value = "no_response";
      return r;
    });
    expect(await store.load(ANN, id)).toEqual({ status: "corrupted", reason: "digest_mismatch" });
    // Even with the digest recomputed, the engine's replay catches it.
    tamper(repo, id, (r) => reseal(r));
    expect(await store.load(ANN, id)).toEqual({ status: "corrupted", reason: expect.stringMatching(/^replay_failed: /) });
  });

  it("edited cause state", async () => {
    const { repo, store, id } = await savedFuel();
    tamper(repo, id, (r) => reseal({ ...r, payload: { ...r.payload, supportedCauses: ["ignition_coil"] } }));
    expect(await store.load(ANN, id)).toEqual({ status: "corrupted", reason: expect.stringMatching(/^replay_failed: /) });
    tamper(repo, id, (r) => reseal({ ...r, payload: { ...r.payload, supportedCauses: ["fuel_supply"], remainingCauses: ["fuel_supply"] } }));
    expect(await store.load(ANN, id)).toMatchObject(corrupted);
  });

  it("edited conflict record", async () => {
    const { store, repo } = setup();
    const { id } = await persistThrough(store, ANN, "car-ann", CONFLICT_FACTS, CONFLICT_ROUTE);
    tamper(repo, id, (r) => {
      const c = (r.payload.evidence as unknown as Array<{ kind: string; conflict?: { causes: Array<{ earlierState: string }> } }>).find((e) => e.kind === "conflict")!;
      c.conflict!.causes[0].earlierState = "supported";
      return reseal(r);
    });
    expect(await store.load(ANN, id)).toEqual({ status: "corrupted", reason: expect.stringMatching(/replay_failed/) });
  });

  it("changed workflow version", async () => {
    const { repo, store, id } = await savedFuel(setup({ workflows: [W, { ...W, version: 7 }] }));
    tamper(repo, id, (r) => ({ ...r, workflowVersion: 7 }));
    expect(await store.load(ANN, id)).toEqual({ status: "corrupted", reason: "digest_mismatch" });
    tamper(repo, id, (r) => reseal({ ...r, workflowVersion: 7 }));
    expect(await store.load(ANN, id)).toEqual({ status: "corrupted", reason: "workflow_identity_mismatch" });
    tamper(repo, id, (r) => reseal({ ...r, payload: { ...r.payload, workflowVersion: 7 } }));
    expect(await store.load(ANN, id)).toMatchObject({ status: "incompatible_workflow", reason: "workflow_changed" });
  });

  it("changed pinned specification", async () => {
    const { repo, store, id } = await savedFuel();
    const edit = (r: Rec) => {
      const spec = (r.payload.specifications as Record<string, { specification: { expected: { min: number } } }>)["synthetic.fuel_supply_pressure_idle"];
      spec.specification.expected.min = 150;
      return r;
    };
    tamper(repo, id, edit);
    expect(await store.load(ANN, id)).toEqual({ status: "corrupted", reason: "digest_mismatch" });
    // Resealed: the pinned value now judges 200 kPa differently, so the replay no longer matches the record.
    tamper(repo, id, (r) => reseal(r));
    expect(await store.load(ANN, id)).toEqual({ status: "corrupted", reason: expect.stringMatching(/replay_failed/) });
  });

  it("with a keyed digest, a resealed edit that replay alone could not see is still refused", async () => {
    const integrity: IntegrityConfig = { algorithm: "hmac-sha256", secret: "test-only-secret" };
    const { repo, store, id } = await savedFuel(setup({ integrity }));
    expect(repo.rawRecord(id)).toMatchObject({ integrityAlgorithm: "hmac-sha256", payloadDigest: expect.stringMatching(/^hmac-sha256:/) });
    // Raising the pinned upper limit changes no judgement (200 kPa is still below 300): replay alone would accept it.
    tamper(repo, id, (r) => {
      (r.payload.specifications as Record<string, { specification: { expected: { max: number } } }>)["synthetic.fuel_supply_pressure_idle"].specification.expected.max = 999;
      return reseal(r, { algorithm: "hmac-sha256", secret: "guessed" });
    });
    expect(await store.load(ANN, id)).toEqual({ status: "corrupted", reason: "digest_mismatch" });
    // A store configured differently refuses rather than guesses.
    const plain = createSessionStore({ repository: repo, workflows: createInMemoryWorkflowResolver([W]) });
    expect(await plain.load(ANN, id)).toEqual({ status: "corrupted", reason: "integrity_algorithm_mismatch" });
  });

  it("invalid current step", async () => {
    const { repo, store, id } = await savedFuel();
    tamper(repo, id, (r) => reseal({ ...r, currentStep: "concl_coil" }));
    expect(await store.load(ANN, id)).toEqual({ status: "corrupted", reason: "current_step_mismatch" });
    tamper(repo, id, (r) => reseal({ ...r, currentStep: "no_such_step", payload: { ...r.payload, currentNodeId: "no_such_step" } }));
    expect(await store.load(ANN, id)).toMatchObject({ status: "corrupted", reason: expect.stringMatching(/replay_failed/) });
  });

  it("malformed payload and malformed records", async () => {
    const { repo, store, id } = await savedFuel();
    const original = repo.rawRecord(id)!;
    for (const edit of [
      (r: Rec) => ({ ...r, payload: "not a session" }),
      (r: Rec) => ({ ...r, payload: { ...r.payload, evidence: "nope" } }),
      (r: Rec) => ({ ...r, payload: { ...r.payload, injected: { code: "x" } } }),
      (r: Rec) => ({ ...r, unknownColumn: 1 }),
      () => "{ not json",
      () => "null",
      () => "[]",
    ]) {
      repo.tamper(id, () => original);
      tamper(repo, id, edit);
      expect(await store.load(ANN, id)).toMatchObject(corrupted);
    }
  });

  it("impossible revision or lifecycle metadata", async () => {
    const { repo, store, id } = await savedFuel();
    const original = repo.rawRecord(id)!;
    const cases: Array<[(r: Rec) => unknown, string | RegExp]> = [
      [(r) => reseal({ ...r, revision: 3 }), /^impossible_revision/],
      [(r) => reseal({ ...r, revision: 0 }), /^malformed_record/],
      [(r) => reseal({ ...r, lifecycle: "completed" }), "lifecycle_mismatch"],
      [(r) => ({ ...r, completedAt: r.updatedAt }), "impossible_timestamps: completedAt"],
      [(r) => ({ ...r, updatedAt: "2020-01-01T00:00:00.000Z" }), "impossible_timestamps"],
      [(r) => ({ ...r, id: "someone-elses-id" }), "digest_mismatch"],
      [(r) => ({ ...r, vehicleId: "car-bob" }), "digest_mismatch"],
    ];
    for (const [edit, reason] of cases) {
      repo.tamper(id, () => original);
      tamper(repo, id, edit);
      expect(await store.load(ANN, id), String(reason)).toEqual({ status: "corrupted", reason: typeof reason === "string" ? reason : expect.stringMatching(reason) });
    }
  });

  it("a history that does not match the session", async () => {
    const { repo, store, id } = await savedFuel();
    repo.tamperHistory(id, (list) => list.pop());
    expect(await store.history(ANN, id)).toMatchObject({ status: "corrupted", reason: "history: revision_count_mismatch" });
  });

  it("refuses to advance a corrupted session instead of building on it", async () => {
    const { repo, store, id, final } = await savedFuel();
    tamper(repo, id, (r) => reseal({ ...r, payload: { ...r.payload, supportedCauses: [] } }));
    const next = step(final.session, FUEL_VERIFIED);
    expect(await store.advance(ANN, { sessionId: id, expectedRevision: final.meta.revision, session: next })).toMatchObject(corrupted);
  });

  it("never rewrites a completed session, and a rewritten one is caught", async () => {
    const { repo, store, id } = await savedFuel(setup(), [...FUEL_ROUTE, FUEL_VERIFIED]);
    tamper(repo, id, (r) => reseal({ ...r, payload: { ...r.payload, verification: "not_verified", repairVerified: false } }));
    expect(await store.load(ANN, id)).toMatchObject(corrupted);
  });
});

/* ───────────────────────── the AI bridge stays outside ───────────────────────── */

describe("V2G and the V2F bridge: persistence needs no AI, and AI never becomes stored truth", () => {
  it("saves and resumes with no AI adapter, and needs no explanation", async () => {
    const { store, id, final } = await savedFuel();
    const loaded = await store.load(ANN, id);
    expect(loaded.status).toBe("loaded");
    // An explanation can be made afterwards, deterministically, without changing anything.
    const e = await explain(null, final.workflow, final.session);
    expect(e.status).toBe("ok");
    const after = await store.load(ANN, id);
    expect(after.status === "loaded" && canonicalJson(after.session)).toBe(canonicalJson(final.session));
  });

  it("stores an accepted AI-parsed input exactly like a direct one, with only a hash of the text in the history", async () => {
    const parser = createKeywordParser();
    const { store, repo } = setup();
    const text = "yes it was definitely shaking and rough";
    const viaAi = await store.start(ANN, { vehicleId: "car-ann", session: started(FUEL_FACTS) });
    const viaHand = await store.start(ANN, { vehicleId: "car-ann", session: started(FUEL_FACTS) });
    if (viaAi.status !== "saved" || viaHand.status !== "saved") throw new Error("start");

    const loaded = await store.load(ANN, viaAi.meta.id);
    if (loaded.status !== "loaded") throw new Error("load");
    const parsed = await parseStepInput(parser, loaded.workflow, loaded.session, text, SPECS);
    expect(parsed.status).toBe("valid");
    const accepted = acceptProposal(loaded.workflow, loaded.session, parsed, "2026-10-16T10:01:00Z", SPECS);
    if (!accepted.ok) throw new Error(accepted.error);
    const ref = textReference(text).hash;
    expect(await store.advance(ANN, { sessionId: viaAi.meta.id, expectedRevision: 1, session: accepted.session, provenance: { origin: "ai_parser", textRef: ref } })).toMatchObject({ status: "saved" });
    expect(await store.advance(ANN, { sessionId: viaHand.meta.id, expectedRevision: 1, session: step(started(FUEL_FACTS), FUEL_ROUTE[0]) })).toMatchObject({ status: "saved" });

    // Identical sessions; only the history says where the input came from, by reference.
    expect(canonicalJson(repo.rawRecord(viaAi.meta.id)!.payload)).toBe(canonicalJson(repo.rawRecord(viaHand.meta.id)!.payload));
    const h = await store.history(ANN, viaAi.meta.id);
    expect(h.status === "found" && h.history.revisions[1]).toMatchObject({ inputOrigin: "ai_parser", aiTextRef: ref });
    const everything = JSON.stringify([repo.rawRecord(viaAi.meta.id), h]);
    expect(everything).not.toContain("shaking");
    expect(everything).not.toMatch(/ai_parser.*proposal|audit/);
    // The AI provenance does not take part in replay: the session loads the same either way.
    const a = await store.load(ANN, viaAi.meta.id);
    const b = await store.load(ANN, viaHand.meta.id);
    expect(a.status === "loaded" && b.status === "loaded" && canonicalJson(a.session) === canonicalJson(b.session)).toBe(true);
    // Raw text is never accepted as a reference.
    expect(await store.advance(ANN, { sessionId: viaHand.meta.id, expectedRevision: 2, session: step(step(started(FUEL_FACTS), FUEL_ROUTE[0]), FUEL_ROUTE[1]), provenance: { origin: "ai_parser", textRef: text } })).toMatchObject({ status: "invalid_transition" });
  });

  it("never stores a rejected or ambiguous proposal", async () => {
    const parser = createKeywordParser();
    const { store, repo, id } = await savedFuel(setup(), FUEL_ROUTE.slice(0, 1));
    const loaded = await store.load(ANN, id);
    if (loaded.status !== "loaded") throw new Error("load");
    const parsed = await parseStepInput(parser, loaded.workflow, loaded.session, "yes and no, not sure", SPECS);
    expect(parsed.status).toBe("ambiguous");
    const accepted = acceptProposal(loaded.workflow, loaded.session, parsed);
    expect(accepted.ok).toBe(false);
    // There is nothing to save: the unchanged session is not a new revision.
    expect(await store.advance(ANN, { sessionId: id, expectedRevision: 2, session: loaded.session })).toMatchObject({ status: "invalid_transition" });
    const h = await store.history(ANN, id);
    expect(h.status === "found" && h.history.revisions.length).toBe(2);
    expect(JSON.stringify(repo.rawRecord(id))).not.toMatch(/not sure|ambiguous/);
  });
});

/* ───────────────────────── boundaries ───────────────────────── */

describe("V2G boundaries", () => {
  const ROOT = path.join(__dirname, "..");
  const tsFiles = (dir: string) => (fs.readdirSync(path.join(ROOT, dir), { recursive: true }) as string[]).map(String).filter((f) => /\.(ts|tsx)$/.test(f));

  it("keeps the engine free of persistence, Prisma, database, AI and network code", () => {
    for (const f of tsFiles("app/lib/diagnostic-workflow")) {
      const text = fs.readFileSync(path.join(ROOT, "app/lib/diagnostic-workflow", f), "utf8");
      expect(text, f).not.toMatch(/diagnostic-workflow-persistence|diagnostic-workflow-bridge|generated\/prisma|@prisma\/|from ["']pg["']|lib\/prisma|from ["'](zod|openai|ai|node:crypto|crypto)["']|fetch\(|XMLHttpRequest|WebSocket/);
    }
  });

  it("keeps Prisma out of everything except the one adapter, and the store free of AI and network code", () => {
    const dir = "app/lib/diagnostic-workflow-persistence";
    for (const f of tsFiles(dir)) {
      const text = fs.readFileSync(path.join(ROOT, dir, f), "utf8");
      if (f !== "prisma-repository.ts") expect(text, f).not.toMatch(/generated\/prisma|@prisma\/|from ["']pg["']|lib\/prisma/);
      expect(text, f).not.toMatch(/diagnostic-workflow-bridge|from ["'](openai|ai)["']|@anthropic-ai|fetch\(|XMLHttpRequest|WebSocket/);
    }
    // The adapter does not import the app's own connection: the client is passed in.
    expect(fs.readFileSync(path.join(ROOT, dir, "prisma-repository.ts"), "utf8")).not.toMatch(/lib\/prisma["']/);
  });

  it("is not used by the production app yet", () => {
    // (The generated Prisma client is excluded: it only repeats the schema's documentation.)
    for (const f of tsFiles("app").filter((f) => !f.includes("diagnostic-workflow") && !f.startsWith("generated"))) {
      expect(fs.readFileSync(path.join(ROOT, "app", f), "utf8"), f).not.toMatch(/diagnostic-workflow/);
    }
  });

  it("uses only the synthetic fixture", () => {
    expect(W.provenance).toMatch(/SYNTHETIC/);
    expect(fs.readFileSync(path.join(ROOT, "tests/helpers/persisted-sessions.ts"), "utf8")).toMatch(/SYNTHETIC \/ TEST ONLY \/ NOT OEM DATA/);
  });

  it("runs the region fixture end to end through storage too", async () => {
    const { store } = setup();
    const { final } = await persistThrough(store, BOB, "car-bob", REGION_FACTS, REGION_ROUTE);
    expect(final.session).toMatchObject({ conclusionNodeId: "concl_coil", currentNodeId: "verify_repair" });
  });
});
