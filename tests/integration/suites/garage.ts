/**
 * Phase 2E: the garage as the one place a signed-in user's history lives.
 * Saved diagnoses, "did this fix it?", the vehicle timeline, mileage, archiving
 * and importing a device's data, all against a real database.
 *
 * Only the signed-in session and the AI model are faked.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Pool } from "pg";
import * as db from "../db";
import { modelCause, modelDiagnosis, modelReply } from "../../helpers/diagnosis-fixture";

type SessionUser = { id: string; email: string | null };

export function garageSuite() {
  db.dbDescribe("the garage: history, outcomes, timeline, mileage and import", () => {
    let pool: Pool;
    let signedIn: SessionUser | null = null;
    /** What the faked AI model does next. */
    let modelBehaviour: () => Promise<unknown> = async () => modelReply(modelDiagnosis());
    let modelCalls = 0;

    const ANN = { id: "ann", email: "ann@example.test" };
    const BOB = { id: "bob", email: "bob@example.test" };
    const ENV_KEYS = ["DATABASE_URL", "OPENAI_API_KEY", "DIAGNOSE_GUEST_DAILY_LIMIT", "DIAGNOSE_USER_HOURLY_LIMIT", "DIAGNOSE_IP_BURST_LIMIT", "GARAGE_IMPORT_HOURLY_LIMIT"];
    const savedEnv: Record<string, string | undefined> = {};

    const rows = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
    const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];
    const count = async (from: string) => Number((await one(`SELECT COUNT(*)::int AS n FROM ${from}`)).n);

    const request = (url: string, method = "GET", body?: unknown, ip = "203.0.113.40") =>
      new NextRequest(`http://localhost${url}`, {
        method,
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const withId = (id: string) => ({ params: Promise.resolve({ id }) });

    async function startApp() {
      await db.freshApp();
      return {
        garage: await import("../../../app/api/garage/route"),
        vehicle: await import("../../../app/api/garage/[id]/route"),
        importer: await import("../../../app/api/garage/import/route"),
        maintenance: await import("../../../app/api/maintenance/route"),
        maintenanceItem: await import("../../../app/api/maintenance/[id]/route"),
        diagnoses: await import("../../../app/api/diagnoses/route"),
        diagnosis: await import("../../../app/api/diagnoses/[id]/route"),
        diagnose: await import("../../../app/api/diagnose/route"),
      };
    }
    type App = Awaited<ReturnType<typeof startApp>>;

    const addVehicle = async (app: App, body: Record<string, unknown> = {}) =>
      (await (await app.garage.POST(request("/api/garage", "POST", { year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4", ...body }))).json()).vehicle.id as string;

    const CAMRY = { year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4", lang: "en" };
    /** Run one diagnosis through the real route. */
    const diagnose = async (app: App, body: Record<string, unknown>) => {
      const res = await app.diagnose.POST(request("/api/diagnose", "POST", { ...CAMRY, code: "P0300", symptoms: "Rough idle and hesitation", ...body }));
      return { status: res.status, body: await res.json() };
    };
    const outcome = async (app: App, id: string, body: Record<string, unknown>) => {
      const res = await app.diagnosis.PATCH(request(`/api/diagnoses/${id}`, "PATCH", body), withId(id));
      return { status: res.status, body: await res.json() };
    };
    const detail = async (app: App, vehicleId: string) => (await app.vehicle.GET(request(`/api/garage/${vehicleId}`), withId(vehicleId))).json();

    beforeAll(async () => {
      pool = db.newPool();
      vi.doMock("@/app/lib/auth-config", () => ({ auth: async () => (signedIn ? { user: signedIn } : null) }));
      vi.doMock("openai", () => ({
        default: class FakeOpenAI {
          responses = {
            create: async () => {
              modelCalls += 1;
              return modelBehaviour();
            },
          };
        },
      }));
    });
    afterAll(async () => {
      vi.doUnmock("@/app/lib/auth-config");
      vi.doUnmock("openai");
      await pool.end();
    });
    beforeEach(async () => {
      for (const k of ENV_KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
      process.env.OPENAI_API_KEY = "test-key-not-real";
      signedIn = ANN;
      modelCalls = 0;
      modelBehaviour = async () => modelReply(modelDiagnosis());
      await db.buildFromEmpty(pool);
      await pool.query(`INSERT INTO users (id, email, email_verified) VALUES ('ann', 'ann@example.test', NOW()), ('bob', 'bob@example.test', NOW())`);
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
    });
    afterEach(async () => {
      await db.closeAppConnections();
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    /* ───────────── diagnosis history ───────────── */

    it("saves a signed-in user's diagnosis to the vehicle it was run for", async () => {
      const app = await startApp();
      const vehicleId = await addVehicle(app);
      const run = await diagnose(app, { vehicleId, mileage: "138000", mileageUnit: "km" });

      expect(run.status).toBe(200);
      expect(run.body.saved).toEqual({ id: expect.any(String), vehicleId });
      const saved = await one(`SELECT * FROM diagnoses`);
      expect(saved).toMatchObject({
        id: run.body.saved.id, user_id: "ann", vehicle_id: vehicleId, status: "open", source: "app", language: "en",
        code_input: "P0300", symptoms: "Rough idle and hesitation", update_count: 0, odometer_value: 138000, odometer_unit: "km",
        vehicle_snapshot: { year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4", trim: "" },
      });
      // The structured answer is stored as it was returned, with what is on file for the code.
      expect(saved.result.kind).toBe("structured");
      expect(saved.result.diagnosis).toEqual(run.body.diagnosis);
      expect(saved.codes).toEqual(run.body.codes);
      expect(saved.codes[0]).toMatchObject({ code: "P0300", trust: "local_reference" });
      expect(saved.ticket_id).toEqual(expect.any(String));
      // Nothing about the prompt or the model is kept.
      expect(JSON.stringify(saved)).not.toMatch(/instructions|system prompt|gpt-|input_tokens|test-key-not-real/i);
      // The reading given with the diagnosis became the vehicle's current reading.
      expect(await one(`SELECT odometer_value, odometer_unit FROM garage_vehicles WHERE id = $1`, [vehicleId])).toEqual({ odometer_value: 138000, odometer_unit: "km" });
    });

    it("saves nothing for a guest, for someone else's vehicle, or without a vehicle", async () => {
      const app = await startApp();
      const annsCar = await addVehicle(app);

      signedIn = null;
      const guest = await diagnose(app, { vehicleId: annsCar });
      expect(guest.status).toBe(200);
      expect(guest.body.saved).toBeNull();

      signedIn = BOB;
      const notHis = await diagnose(app, { vehicleId: annsCar });
      expect(notHis.status).toBe(200);
      expect(notHis.body.saved).toBeNull();
      expect(notHis.body.diagnosis.causes.length).toBeGreaterThan(0); // he still gets his answer

      const noVehicle = await diagnose(app, {});
      expect(noVehicle.body.saved).toBeNull();
      expect((await diagnose(app, { vehicleId: "'; DROP TABLE diagnoses; --" })).body.saved).toBeNull();

      expect(await count("diagnoses")).toBe(0);
    });

    it("does not create a history entry when the diagnosis fails or the AI is never called", async () => {
      const app = await startApp();
      const vehicleId = await addVehicle(app);

      modelBehaviour = async () => {
        throw Object.assign(new Error("upstream down"), { status: 500 });
      };
      const failed = await diagnose(app, { vehicleId });
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(failed.body.saved).toBeUndefined();

      modelBehaviour = async () => modelReply({ not: "a diagnosis" });
      expect((await diagnose(app, { vehicleId })).status).toBe(502);

      // A code with no symptoms: the model is not called, and nothing is saved.
      const before = modelCalls;
      const noAi = await diagnose(app, { vehicleId, symptoms: "" });
      expect(noAi.body.noDefinition).toBe(true);
      expect(modelCalls).toBe(before);

      expect(await count("diagnoses")).toBe(0);
    });

    it("still returns the diagnosis if saving it fails", async () => {
      const app = await startApp();
      const vehicleId = await addVehicle(app);
      await pool.query(`ALTER TABLE diagnoses RENAME TO diagnoses_away`);
      try {
        const run = await diagnose(app, { vehicleId });
        expect(run.status).toBe(200);
        expect(run.body.diagnosis.causes.length).toBeGreaterThan(0);
        expect(run.body.saved).toBeNull();
      } finally {
        await pool.query(`ALTER TABLE diagnoses_away RENAME TO diagnoses`);
      }
    });

    it("a follow-up updates the same saved diagnosis instead of creating another", async () => {
      const app = await startApp();
      const vehicleId = await addVehicle(app);
      const first = await diagnose(app, { vehicleId });
      const original = await one(`SELECT id, diagnosed_at, created_at, status FROM diagnoses`);

      modelBehaviour = async () => modelReply(modelDiagnosis({ summary: "Updated after your answers.", causes: [modelCause({ title: "Failing ignition coil" })] }));
      const followUps = [{ question: "Does it happen when cold?", answer: "Yes" }];
      const second = await diagnose(app, { vehicleId, followUps, diagnosisToken: first.body.followUp.token });

      expect(second.status).toBe(200);
      expect(second.body.saved.id).toBe(first.body.saved.id);
      expect(await count("diagnoses")).toBe(1);
      const updated = await one(`SELECT * FROM diagnoses`);
      expect(updated).toMatchObject({ id: original.id, update_count: 1, status: "open", follow_ups: followUps });
      expect(updated.result.diagnosis.summary).toBe("Updated after your answers.");
      expect(updated.result.diagnosis.causes[0].title).toBe("Failing ignition coil");
      // It is still the same diagnosis, made at the same time; only "updated" moved.
      expect(updated.diagnosed_at).toEqual(original.diagnosed_at);
      expect(updated.created_at).toEqual(original.created_at);
      expect(updated.updated_at.getTime()).toBeGreaterThanOrEqual(original.created_at.getTime());

      // A second update: still one record.
      await diagnose(app, { vehicleId, followUps: [...followUps, { question: "Any smell?", answer: "No" }], diagnosisToken: first.body.followUp.token });
      expect(await rows(`SELECT update_count FROM diagnoses`)).toEqual([{ update_count: 2 }]);
    });

    it("keeps a diagnosis attached to the vehicle it was made for", async () => {
      const app = await startApp();
      const camry = await addVehicle(app);
      const civic = await addVehicle(app, { year: "2020", make: "Honda", model: "Civic", engine: "" });
      const run = await diagnose(app, { vehicleId: camry });

      // The user switches to another vehicle, then sends a follow-up for the earlier diagnosis.
      await diagnose(app, { vehicleId: civic, followUps: [{ question: "Q", answer: "A" }], diagnosisToken: run.body.followUp.token });
      // And later edits the vehicle.
      await app.vehicle.PATCH(request(`/api/garage/${camry}`, "PATCH", { trim: "XSE", nickname: "Daily" }), withId(camry));

      expect(await rows(`SELECT vehicle_id, vehicle_snapshot FROM diagnoses`)).toEqual([
        { vehicle_id: camry, vehicle_snapshot: { year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4", trim: "" } },
      ]);
      expect((await detail(app, civic)).timeline).toEqual([]);
      expect((await detail(app, camry)).timeline).toHaveLength(1);
    });

    it("reopens a saved diagnosis entirely from stored data, without calling the AI", async () => {
      const app = await startApp();
      const vehicleId = await addVehicle(app);
      const first = await diagnose(app, { vehicleId, mileage: "138000", mileageUnit: "km" });
      await diagnose(app, { vehicleId, followUps: [{ question: "Does it happen when cold?", answer: "Yes" }], diagnosisToken: first.body.followUp.token });
      const callsSoFar = modelCalls;
      const id = first.body.saved.id as string;

      const res = await app.diagnosis.GET(request(`/api/diagnoses/${id}`), withId(id));
      expect(res.status).toBe(200);
      const { diagnosis } = await res.json();
      expect(modelCalls).toBe(callsSoFar);

      expect(diagnosis).toMatchObject({
        id, vehicleId, status: "open", source: "app", language: "en",
        title: "Rough idle and hesitation", codes: ["P0300"], codeInput: "P0300", symptoms: "Rough idle and hesitation",
        vehicle: { year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4" },
        odometerValue: 138000, odometerUnit: "km", updateCount: 1, confirmedFix: null,
        followUps: [{ question: "Does it happen when cold?", answer: "Yes" }],
      });
      expect(diagnosis.result.kind).toBe("structured");
      const stored = diagnosis.result.diagnosis;
      expect(stored.summary).toEqual(expect.any(String));
      expect(stored.drive_guidance.level).toEqual(expect.any(String));
      expect(stored.causes[0]).toMatchObject({ rank: 1, title: expect.any(String), checks: expect.any(Array), recommended_action: expect.any(String) });
      expect(Array.isArray(stored.limitations)).toBe(true);
      expect(diagnosis.codeDetails[0]).toMatchObject({ code: "P0300", trust: "local_reference" });

      // The list shows it too, also without the AI.
      const list = await (await app.diagnoses.GET(request(`/api/diagnoses?vehicleId=${vehicleId}`))).json();
      expect(list.diagnoses.map((d: { id: string }) => d.id)).toEqual([id]);
      expect(modelCalls).toBe(callsSoFar);
    });

    /* ───────────── ownership ───────────── */

    it("never lets one user read or change another's vehicle, diagnosis, service record or confirmed repair", async () => {
      const app = await startApp();
      const annsCar = await addVehicle(app);
      const annsDiagnosis = (await diagnose(app, { vehicleId: annsCar })).body.saved.id as string;
      await outcome(app, annsDiagnosis, { outcome: "fixed", description: "Ignition coil #3" });
      const annsRecord = (await (await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId: annsCar, date: "2026-09-20", serviceType: "Oil Change" }))).json()).record.id as string;
      const before = {
        vehicle: await one(`SELECT * FROM garage_vehicles WHERE id = $1`, [annsCar]),
        diagnosis: await one(`SELECT * FROM diagnoses WHERE id = $1`, [annsDiagnosis]),
        fix: await one(`SELECT * FROM confirmed_fixes`),
        record: await one(`SELECT * FROM maintenance_records WHERE id = $1`, [annsRecord]),
      };

      signedIn = BOB;
      // Reading.
      expect((await app.vehicle.GET(request(`/api/garage/${annsCar}`), withId(annsCar))).status).toBe(404);
      expect((await app.diagnosis.GET(request(`/api/diagnoses/${annsDiagnosis}`), withId(annsDiagnosis))).status).toBe(404);
      expect((await (await app.diagnoses.GET(request(`/api/diagnoses?vehicleId=${annsCar}`))).json()).diagnoses).toEqual([]);
      expect((await (await app.diagnoses.GET(request(`/api/diagnoses`))).json()).diagnoses).toEqual([]);
      expect((await (await app.garage.GET(request("/api/garage"))).json()).vehicles).toEqual([]);
      expect((await (await app.maintenance.GET(request(`/api/maintenance?vehicleId=${annsCar}`))).json()).records).toEqual([]);
      // Changing.
      expect((await app.vehicle.PATCH(request(`/api/garage/${annsCar}`, "PATCH", { mileage: { value: 5, unit: "km", confirm: true }, archived: true, nickname: "mine now" }), withId(annsCar))).status).toBe(404);
      expect((await app.vehicle.DELETE(request(`/api/garage/${annsCar}`, "DELETE"), withId(annsCar))).status).toBe(404);
      for (const body of [{ outcome: "reopen" }, { outcome: "dismissed" }, { outcome: "not_yet" }, { outcome: "fixed", description: "Bob says otherwise" }]) {
        expect((await outcome(app, annsDiagnosis, body)).status).toBe(404);
      }
      expect((await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId: annsCar, date: "2026-10-01", serviceType: "Sabotage" }))).status).toBe(404);
      await app.maintenanceItem.DELETE(request(`/api/maintenance/${annsRecord}`, "DELETE"), withId(annsRecord));
      // A user id sent by the browser is ignored: it is always the session's.
      const imported = await (await app.importer.POST(request("/api/garage/import", "POST", {
        userId: "ann",
        vehicles: [{ clientId: "x", existingVehicleId: annsCar, userId: "ann", maintenance: [{ type: "Injected", date: "2026-10-01" }], diagnoses: [] }],
      }))).json();
      expect(imported.results[0]).toMatchObject({ outcome: "failed", maintenance: 0 });

      // Nothing of Ann's moved.
      expect(await one(`SELECT * FROM garage_vehicles WHERE id = $1`, [annsCar])).toEqual(before.vehicle);
      expect(await one(`SELECT * FROM diagnoses WHERE id = $1`, [annsDiagnosis])).toEqual(before.diagnosis);
      expect(await one(`SELECT * FROM confirmed_fixes`)).toEqual(before.fix);
      expect(await one(`SELECT * FROM maintenance_records WHERE id = $1`, [annsRecord])).toEqual(before.record);
      expect(await count("maintenance_records")).toBe(1);

      // Signed out, every garage route refuses.
      signedIn = null;
      expect((await app.garage.GET(request("/api/garage"))).status).toBe(401);
      expect((await app.vehicle.GET(request(`/api/garage/${annsCar}`), withId(annsCar))).status).toBe(401);
      expect((await app.vehicle.PATCH(request(`/api/garage/${annsCar}`, "PATCH", { archived: true }), withId(annsCar))).status).toBe(401);
      expect((await app.diagnoses.GET(request("/api/diagnoses"))).status).toBe(401);
      expect((await app.diagnosis.GET(request(`/api/diagnoses/${annsDiagnosis}`), withId(annsDiagnosis))).status).toBe(401);
      expect((await outcome(app, annsDiagnosis, { outcome: "reopen" })).status).toBe(401);
      expect((await app.importer.POST(request("/api/garage/import", "POST", { vehicles: [] }))).status).toBe(401);
    });

    /* ───────────── "did this fix it?" ───────────── */

    it("records what actually fixed the problem, separately from what the AI predicted", async () => {
      const app = await startApp();
      const vehicleId = await addVehicle(app);
      modelBehaviour = async () => modelReply(modelDiagnosis({ causes: [modelCause({ rank: 1, title: "Worn spark plugs" }), modelCause({ rank: 2, title: "Vacuum leak" })] }));
      const id = (await diagnose(app, { vehicleId })).body.saved.id as string;
      const predicted = (await one(`SELECT result FROM diagnoses WHERE id = $1`, [id])).result;

      // The real repair was something the AI did not list. Free text is enough.
      const fixed = await outcome(app, id, { outcome: "fixed", description: "Ignition coil #3", fixedOn: "2026-10-12", odometerValue: 138200, odometerUnit: "km", notes: "Shop found it on cylinder 3" });
      expect(fixed.status).toBe(200);
      expect(fixed.body.diagnosis).toMatchObject({
        status: "resolved",
        confirmedFix: { description: "Ignition coil #3", matchedCauseRank: null, matchedCauseTitle: null, fixedOn: "2026-10-12", odometerValue: 138200, odometerUnit: "km", notes: "Shop found it on cylinder 3" },
      });
      expect(await one(`SELECT user_id, vehicle_id, diagnosis_id, description, matched_cause_rank, matched_cause_title FROM confirmed_fixes`)).toEqual({
        user_id: "ann", vehicle_id: vehicleId, diagnosis_id: id, description: "Ignition coil #3", matched_cause_rank: null, matched_cause_title: null,
      });
      // History is not rewritten: the AI's answer is byte for byte what it was.
      expect((await one(`SELECT result FROM diagnoses WHERE id = $1`, [id])).result).toEqual(predicted);
      expect(JSON.stringify(predicted)).not.toContain("Ignition coil #3");
      expect(await one(`SELECT status, status_changed_at IS NOT NULL AS stamped FROM diagnoses WHERE id = $1`, [id])).toEqual({ status: "resolved", stamped: true });
      expect((await one(`SELECT odometer_value FROM garage_vehicles WHERE id = $1`, [vehicleId])).odometer_value).toBe(138200);

      // Reopening the page shows the confirmed fix.
      const reopened = (await (await app.diagnosis.GET(request(`/api/diagnoses/${id}`), withId(id))).json()).diagnosis;
      expect(reopened.confirmedFix.description).toBe("Ignition coil #3");
      expect(reopened.fix).toEqual({ description: "Ignition coil #3", fixedOn: "2026-10-12" });

      // Correcting it edits the same record; a match to a predicted cause is optional and copied from the stored answer.
      const corrected = await outcome(app, id, { outcome: "fixed", description: "Replaced a cracked vacuum hose", matchedCauseRank: 2 });
      expect(corrected.body.diagnosis.confirmedFix).toMatchObject({ description: "Replaced a cracked vacuum hose", matchedCauseRank: 2, matchedCauseTitle: "Vacuum leak" });
      expect(await count("confirmed_fixes")).toBe(1);
      expect((await outcome(app, id, { outcome: "fixed", description: "Something", matchedCauseRank: 9 })).status).toBe(400);
      expect((await one(`SELECT description FROM confirmed_fixes`)).description).toBe("Replaced a cracked vacuum hose");
    });

    it("follows a diagnosis through open, not yet, dismissed, resolved and reopened", async () => {
      const app = await startApp();
      const vehicleId = await addVehicle(app);
      const id = (await diagnose(app, { vehicleId })).body.saved.id as string;
      const status = async () => one(`SELECT status, reviewed_at IS NOT NULL AS reviewed FROM diagnoses WHERE id = $1`, [id]);
      expect(await status()).toEqual({ status: "open", reviewed: false });

      // "Not yet": still open, and we note when the user answered.
      expect((await outcome(app, id, { outcome: "not_yet" })).body.diagnosis.status).toBe("open");
      expect(await status()).toEqual({ status: "open", reviewed: true });

      // "The problem went away".
      expect((await outcome(app, id, { outcome: "dismissed" })).body.diagnosis.status).toBe("dismissed");
      expect((await outcome(app, id, { outcome: "not_yet" })).status).toBe(409);
      expect((await outcome(app, id, { outcome: "reopen" })).body.diagnosis.status).toBe("open");

      // Fixed, then "it came back": the recorded repair is removed with the reopen.
      await outcome(app, id, { outcome: "fixed", description: "New battery" });
      expect((await outcome(app, id, { outcome: "dismissed" })).status).toBe(409);
      expect(await count("confirmed_fixes")).toBe(1);
      const back = await outcome(app, id, { outcome: "reopen" });
      expect(back.body.diagnosis).toMatchObject({ status: "open", confirmedFix: null });
      expect(await count("confirmed_fixes")).toBe(0);

      // What is not accepted.
      for (const bad of [{ outcome: "fixed", description: "   " }, { outcome: "fixed" }, { outcome: "fixed", description: "x".repeat(301) }, { outcome: "fixed", description: "Coil", fixedOn: "2026-02-31" },
        { outcome: "fixed", description: "Coil", fixedOn: "2999-01-01" }, { outcome: "fixed", description: "Coil", odometerValue: "lots" }, { outcome: "solved" }, {}]) {
        expect((await outcome(app, id, bad)).status, JSON.stringify(bad)).toBe(400);
      }
      expect(await count("confirmed_fixes")).toBe(0);
      expect((await outcome(app, "no-such-diagnosis", { outcome: "reopen" })).status).toBe(404);
    });

    /* ───────────── the vehicle timeline ───────────── */

    it("builds one timeline per vehicle from diagnoses, repairs and service records, newest first", async () => {
      const app = await startApp();
      const camry = await addVehicle(app);
      const civic = await addVehicle(app, { year: "2020", make: "Honda", model: "Civic", engine: "" });
      const service = (vehicleId: string, body: Record<string, unknown>) => app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId, ...body }));

      await service(camry, { date: "2026-08-04", serviceType: "Front brake pads" });
      await service(camry, { date: "2026-09-20", serviceType: "Oil Change", odometer: "138,000 km" });
      const id = (await diagnose(app, { vehicleId: camry })).body.saved.id as string;
      await pool.query(`UPDATE diagnoses SET diagnosed_at = '2026-10-10T15:00:00Z' WHERE id = $1`, [id]);
      await outcome(app, id, { outcome: "fixed", description: "Ignition coil #3", fixedOn: "2026-10-12" });
      // The other vehicle has its own history.
      await service(civic, { date: "2026-10-01", serviceType: "Tire Rotation" });
      const civicDiagnosis = (await diagnose(app, { vehicleId: civic, year: "2020", make: "Honda", model: "Civic", engine: "", symptoms: "Squeal when braking", code: "" })).body.saved.id as string;

      const camryPage = await detail(app, camry);
      expect(camryPage.timeline.map((t: { kind: string; at: string }) => [t.kind, t.at.slice(0, 10)])).toEqual([
        ["fix", "2026-10-12"],
        ["diagnosis", "2026-10-10"],
        ["maintenance", "2026-09-20"],
        ["maintenance", "2026-08-04"],
      ]);
      expect(camryPage.timeline[0]).toMatchObject({ kind: "fix", description: "Ignition coil #3", diagnosisId: id });
      expect(camryPage.timeline[1]).toMatchObject({ kind: "diagnosis", id, title: "Rough idle and hesitation", codes: ["P0300"], status: "resolved" });
      expect(camryPage.timeline[2]).toMatchObject({ kind: "maintenance", serviceType: "Oil Change", odometerValue: 138000, odometerUnit: "km" });
      expect(camryPage.openIssues).toEqual([]);
      expect(camryPage.maintenance).toHaveLength(2);

      // Different vehicles never mix.
      const civicPage = await detail(app, civic);
      expect(civicPage.timeline.map((t: { kind: string }) => t.kind)).toEqual(["diagnosis", "maintenance"]);
      expect(civicPage.openIssues.map((d: { id: string }) => d.id)).toEqual([civicDiagnosis]);
      expect(JSON.stringify(civicPage)).not.toMatch(/Ignition coil|Oil Change|Front brake pads/);
      expect(JSON.stringify(camryPage)).not.toMatch(/Tire Rotation|Squeal when braking/);

      // The timeline is a view: there is no table behind it, and building it stored nothing.
      expect(await db.tableNames(pool)).toEqual(["confirmed_fixes", "diagnoses", "email_verification_tokens", "feedback", "garage_vehicles", "maintenance_records", "rate_limits", "users"]);
      expect([await count("diagnoses"), await count("confirmed_fixes"), await count("maintenance_records")]).toEqual([2, 1, 3]);
    });

    it("shows on each garage card only facts counted from stored records", async () => {
      const app = await startApp();
      const camry = await addVehicle(app, { odometerValue: 137000, odometerUnit: "km", trim: "SE" });
      const empty = await addVehicle(app, { year: "2020", make: "Honda", model: "Civic", engine: "" });
      await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId: camry, date: "2026-09-20", serviceType: "Oil Change", odometer: "138000", odometerUnit: "km" }));
      await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId: camry, date: "2026-08-04", serviceType: "Front brake pads" }));
      const open = (await diagnose(app, { vehicleId: camry })).body.saved.id as string;
      const done = (await diagnose(app, { vehicleId: camry, symptoms: "Battery light on" })).body.saved.id as string;
      await outcome(app, done, { outcome: "fixed", description: "New alternator" });

      const vehicles = (await (await app.garage.GET(request("/api/garage"))).json()).vehicles as Array<Record<string, unknown> & { id: string; stats: Record<string, unknown> }>;
      const card = vehicles.find((v) => v.id === camry)!;
      expect(card).toMatchObject({ year: "2015", make: "Toyota", model: "Camry", trim: "SE", odometerValue: 138000, odometerUnit: "km" });
      expect(card.stats).toEqual({
        openIssues: 1, diagnoses: 2, lastDiagnosisAt: expect.any(String), maintenanceRecords: 2,
        lastMaintenance: { serviceType: "Oil Change", date: "2026-09-20" },
      });
      expect(vehicles.find((v) => v.id === empty)!.stats).toEqual({ openIssues: 0, diagnoses: 0, lastDiagnosisAt: null, maintenanceRecords: 0, lastMaintenance: null });
      // No invented scores of any kind.
      expect(JSON.stringify(vehicles)).not.toMatch(/health|score|condition|urgency|remaining|percent/i);
      expect((await detail(app, camry)).openIssues.map((d: { id: string }) => d.id)).toEqual([open]);
    });

    /* ───────────── mileage ───────────── */

    it("stores a vehicle's mileage in km or miles and never lowers it without confirmation", async () => {
      const app = await startApp();
      const vehicleId = await addVehicle(app);
      const setMileage = async (mileage: Record<string, unknown>) => {
        const res = await app.vehicle.PATCH(request(`/api/garage/${vehicleId}`, "PATCH", { mileage }), withId(vehicleId));
        return { status: res.status, body: await res.json() };
      };
      const stored = async () => one(`SELECT odometer_value, odometer_unit, odometer_updated_at IS NOT NULL AS stamped FROM garage_vehicles WHERE id = $1`, [vehicleId]);
      expect(await stored()).toEqual({ odometer_value: null, odometer_unit: null, stamped: false });

      expect((await setMileage({ value: 75500, unit: "mi" })).body.vehicle).toMatchObject({ odometerValue: 75500, odometerUnit: "mi" });
      expect((await setMileage({ value: "76,000", unit: "mi" })).status).toBe(200);
      expect(await stored()).toEqual({ odometer_value: 76000, odometer_unit: "mi", stamped: true });

      // Lower: refused until confirmed, and the answer says what is on file.
      const lower = await setMileage({ value: 7600, unit: "mi" });
      expect(lower.status).toBe(409);
      expect(lower.body).toMatchObject({ code: "mileage_confirm", reason: "lower", current: { value: 76000, unit: "mi" } });
      expect((await stored()).odometer_value).toBe(76000);
      expect((await setMileage({ value: 7600, unit: "mi", confirm: true })).status).toBe(200);
      expect((await stored()).odometer_value).toBe(7600);

      // The other unit cannot be compared without guessing: also needs confirming.
      expect((await setMileage({ value: 122000, unit: "km" })).body).toMatchObject({ code: "mileage_confirm", reason: "unit_change" });
      expect((await setMileage({ value: 122000, unit: "km", confirm: true })).body.vehicle).toMatchObject({ odometerValue: 122000, odometerUnit: "km" });

      // The same reading again changes nothing; nonsense is refused.
      expect((await setMileage({ value: 122000, unit: "km" })).status).toBe(200);
      for (const bad of [{ value: -1, unit: "km" }, { value: 12.5, unit: "km" }, { value: "lots", unit: "km" }, { value: 10_000_000, unit: "km" }, { value: 5, unit: "furlongs" }, { value: 5 }]) {
        expect((await setMileage(bad)).status, JSON.stringify(bad)).toBe(400);
      }
      expect(await stored()).toEqual({ odometer_value: 122000, odometer_unit: "km", stamped: true });
    });

    it("raises a vehicle's mileage from newer records, and leaves it alone when a record is lower or unclear", async () => {
      const app = await startApp();
      const vehicleId = await addVehicle(app, { odometerValue: 130000, odometerUnit: "km" });
      const current = async () => (await one(`SELECT odometer_value FROM garage_vehicles WHERE id = $1`, [vehicleId])).odometer_value;
      const service = async (body: Record<string, unknown>) => (await (await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId, date: "2026-10-01", serviceType: "Oil Change", ...body }))).json()).record;

      // A number with the unit chosen in the form.
      expect(await service({ odometer: "130250", odometerUnit: "km" })).toMatchObject({ odometer: "130250", odometerValue: 130250, odometerUnit: "km" });
      expect(await current()).toBe(130250);
      // A unit written in the text wins over the form's.
      expect(await service({ odometer: "131,000 km", odometerUnit: "mi" })).toMatchObject({ odometer: "131,000 km", odometerValue: 131000, odometerUnit: "km" });
      expect(await current()).toBe(131000);
      // An older service entered late: recorded, but the vehicle keeps its higher reading.
      expect(await service({ date: "2026-01-10", odometer: "118000", odometerUnit: "km" })).toMatchObject({ odometerValue: 118000 });
      expect(await current()).toBe(131000);
      // Miles against a vehicle kept in km: recorded as entered, vehicle untouched.
      expect(await service({ odometer: "90000", odometerUnit: "mi" })).toMatchObject({ odometerValue: 90000, odometerUnit: "mi" });
      expect(await current()).toBe(131000);
      // Old-style free text is kept exactly as typed and never guessed at.
      expect(await service({ odometer: "about 132k" })).toMatchObject({ odometer: "about 132k", odometerValue: null, odometerUnit: null });
      expect(await current()).toBe(131000);
      // A diagnosis with a higher reading raises it; one with a lower reading does not.
      await diagnose(app, { vehicleId, mileage: "132500", mileageUnit: "km" });
      expect(await current()).toBe(132500);
      await diagnose(app, { vehicleId, mileage: "100", mileageUnit: "km", symptoms: "Another problem" });
      expect(await current()).toBe(132500);

      const listed = (await (await app.maintenance.GET(request(`/api/maintenance?vehicleId=${vehicleId}`))).json()).records;
      expect(listed.find((r: { odometer?: string }) => r.odometer === "about 132k")).toMatchObject({ odometerValue: null, odometerUnit: null });
    });

    /* ───────────── removing a vehicle ───────────── */

    it("deletes a vehicle that has no history, and archives one that does", async () => {
      const app = await startApp();
      const bare = await addVehicle(app, { year: "2001", make: "Mazda", model: "Miata", engine: "" });
      const used = await addVehicle(app);
      const id = (await diagnose(app, { vehicleId: used })).body.saved.id as string;
      await outcome(app, id, { outcome: "fixed", description: "Ignition coil" });
      await app.maintenance.POST(request("/api/maintenance", "POST", { vehicleId: used, date: "2026-09-20", serviceType: "Oil Change" }));
      const remove = async (vehicleId: string) => {
        const res = await app.vehicle.DELETE(request(`/api/garage/${vehicleId}`, "DELETE"), withId(vehicleId));
        return { status: res.status, body: await res.json() };
      };
      const garage = async (query = "") => ((await (await app.garage.GET(request(`/api/garage${query}`))).json()).vehicles as Array<{ id: string }>).map((v) => v.id);

      expect(await remove(bare)).toEqual({ status: 200, body: { ok: true, archived: false } });
      expect(await count(`garage_vehicles WHERE id = '${bare}'`)).toBe(0);

      // With history: nothing is deleted. It leaves the garage and can come back.
      expect(await remove(used)).toEqual({ status: 200, body: { ok: true, archived: true } });
      expect(await garage()).toEqual([]);
      expect(await garage("?archived=1")).toEqual([used]);
      expect([await count("garage_vehicles"), await count("diagnoses"), await count("confirmed_fixes"), await count("maintenance_records")]).toEqual([1, 1, 1, 1]);
      expect((await detail(app, used)).timeline).toHaveLength(3);
      // An archived vehicle takes no new diagnoses.
      expect((await diagnose(app, { vehicleId: used, symptoms: "Something new" })).body.saved).toBeNull();

      const restored = await app.vehicle.PATCH(request(`/api/garage/${used}`, "PATCH", { archived: false }), withId(used));
      expect((await restored.json()).vehicle.archivedAt).toBeNull();
      expect(await garage()).toEqual([used]);

      // The database itself refuses to delete a vehicle from under its diagnoses.
      await expect(pool.query(`DELETE FROM garage_vehicles WHERE id = $1`, [used])).rejects.toThrow(/diagnoses_vehicle_id_fkey|confirmed_fixes_vehicle_id_fkey/);
      // Deleting the account removes everything of that person's, and nobody else's.
      signedIn = BOB;
      const bobsCar = await addVehicle(app);
      await diagnose(app, { vehicleId: bobsCar });
      await pool.query(`DELETE FROM users WHERE id = 'ann'`);
      expect([await count("garage_vehicles"), await count("diagnoses"), await count("confirmed_fixes"), await count("maintenance_records")]).toEqual([1, 1, 0, 0]);
      expect((await one(`SELECT user_id FROM diagnoses`)).user_id).toBe("bob");
    });

    /* ───────────── importing what a device holds ───────────── */

    it("imports a device's vehicles with their service records and diagnoses, and never merges duplicates", async () => {
      const app = await startApp();
      const existing = await addVehicle(app); // 2015 Toyota Camry 2.5L I4, already in the account
      const importData = async (vehicles: unknown[]) => {
        const res = await app.importer.POST(request("/api/garage/import", "POST", { vehicles }));
        return { status: res.status, body: await res.json() };
      };
      const savedDiagnosis = (key: string, extra: Record<string, unknown> = {}) => ({
        key, at: "2026-07-01T10:00:00.000Z", code: "P0171", symptoms: "Hesitation when accelerating", issueText: "Code: P0171 | Symptoms: Hesitation when accelerating",
        vehicle: { year: "2012", make: "Ford", model: "Focus", engine: "2.0L" }, followUps: [{ question: "Any hissing?", answer: "Yes" }],
        causes: [{ title: "Vacuum leak", why: ["Lean code with a hiss"], checks: ["Listen around the intake"], fix: ["Replace the cracked hose"] }, { title: "Dirty MAF sensor", why: [], checks: [], fix: [] }],
        ...extra,
      });
      const focus = {
        clientId: "guest-focus", year: "2012", make: "Ford", model: "Focus", engine: "2.0L", nickname: "Runabout",
        maintenance: [{ type: "Oil Change", date: "2026-06-01", odometerValue: 88000, odometerUnit: "mi", notes: "5W-20" }, { type: "Other", date: "sometime in spring" }],
        diagnoses: [savedDiagnosis("guest-d1"), savedDiagnosis("guest-d2", { at: "2026-08-01T10:00:00.000Z", confirmedFix: { title: "Vacuum leak", fix: "Replace the cracked hose" } })],
      };
      const twin = { clientId: "guest-camry", year: "2015", make: "toyota", model: "CAMRY", engine: "2.5L I4", maintenance: [{ type: "Brakes", date: "2026-05-05" }], diagnoses: [savedDiagnosis("guest-d3")] };

      const first = await importData([focus, twin]);
      expect(first.status).toBe(200);
      expect(first.body.results).toEqual([
        { clientId: "guest-focus", outcome: "imported", vehicleId: expect.any(String), maintenance: 2, diagnoses: 2 },
        // Already in the account: reported, and nothing of it copied or merged.
        { clientId: "guest-camry", outcome: "duplicate", vehicleId: existing, maintenance: 0, diagnoses: 0 },
      ]);
      const focusId = first.body.results[0].vehicleId as string;
      expect(await one(`SELECT user_id, year, model_year, make, model, engine, nickname, odometer_value, odometer_unit FROM garage_vehicles WHERE id = $1`, [focusId])).toEqual({
        user_id: "ann", year: "2012", model_year: 2012, make: "Ford", model: "Focus", engine: "2.0L", nickname: "Runabout", odometer_value: 88000, odometer_unit: "mi",
      });
      expect(await rows(`SELECT type, date, mileage, odometer_value, odometer_unit, notes FROM maintenance_records WHERE vehicle_id = $1 ORDER BY date`, [focusId])).toEqual([
        { type: "Oil Change", date: "2026-06-01", mileage: "88000", odometer_value: 88000, odometer_unit: "mi", notes: "5W-20" },
        { type: "Other", date: "sometime in spring", mileage: null, odometer_value: null, odometer_unit: null, notes: null },
      ]);
      // Diagnoses arrive marked as copied from a device, dated when they were made.
      const imported = await rows(`SELECT import_key, source, status, code_input, symptoms, diagnosed_at, result, follow_ups, vehicle_snapshot FROM diagnoses WHERE vehicle_id = $1 ORDER BY import_key`, [focusId]);
      expect(imported.map((d) => [d.import_key, d.source, d.status, d.diagnosed_at.toISOString().slice(0, 10)])).toEqual([
        ["guest-d1", "device_import", "open", "2026-07-01"],
        ["guest-d2", "device_import", "resolved", "2026-08-01"],
      ]);
      expect(imported[0]).toMatchObject({ code_input: "P0171", symptoms: "Hesitation when accelerating", follow_ups: [{ question: "Any hissing?", answer: "Yes" }], vehicle_snapshot: { year: "2012", make: "Ford", model: "Focus" } });
      expect(imported[0].result).toMatchObject({ kind: "legacy", causes: [{ title: "Vacuum leak" }, { title: "Dirty MAF sensor" }] });
      // A repair the user had marked on the device comes across as a confirmed fix.
      expect(await one(`SELECT description, matched_cause_rank, matched_cause_title, to_char(fixed_on, 'YYYY-MM-DD') AS fixed_on FROM confirmed_fixes`)).toEqual({
        description: "Replace the cracked hose", matched_cause_rank: 1, matched_cause_title: "Vacuum leak", fixed_on: "2026-08-01",
      });
      // The account's own vehicle was not touched.
      expect(await count(`maintenance_records WHERE vehicle_id = '${existing}'`)).toBe(0);
      expect(await count(`diagnoses WHERE vehicle_id = '${existing}'`)).toBe(0);

      // Importing the same things again creates nothing new.
      const again = await importData([focus]);
      expect(again.body.results[0]).toMatchObject({ outcome: "duplicate", vehicleId: focusId, maintenance: 0, diagnoses: 0 });
      expect([await count("garage_vehicles"), await count("maintenance_records"), await count("diagnoses")]).toEqual([2, 2, 2]);

      // History kept on the device for a vehicle that IS in the account is attached to it, once.
      const attach = { clientId: "account-camry", existingVehicleId: existing, maintenance: [{ type: "Brakes", date: "2026-05-05", odometerValue: 120000, odometerUnit: "km" }], diagnoses: [savedDiagnosis("device-d9"), savedDiagnosis("device-d9")] };
      expect((await importData([attach])).body.results[0]).toEqual({ clientId: "account-camry", outcome: "attached", vehicleId: existing, maintenance: 1, diagnoses: 1 });
      // Sent again (say the device was not cleared): nothing is added twice.
      expect((await importData([attach])).body.results[0]).toMatchObject({ outcome: "attached", maintenance: 0, diagnoses: 0 });
      expect(await count(`diagnoses WHERE vehicle_id = '${existing}'`)).toBe(1);
      expect(await count(`maintenance_records WHERE vehicle_id = '${existing}'`)).toBe(1);

      // An imported diagnosis opens like any other, from stored data.
      const id = (await one(`SELECT id FROM diagnoses WHERE import_key = 'guest-d2'`)).id as string;
      const opened = (await (await app.diagnosis.GET(request(`/api/diagnoses/${id}`), withId(id))).json()).diagnosis;
      expect(opened).toMatchObject({ source: "device_import", status: "resolved", title: "Hesitation when accelerating", codes: ["P0171"], confirmedFix: { description: "Replace the cracked hose" } });
      expect(modelCalls).toBe(0);
    });

    it("refuses an import request that is not well formed, and imports nothing from it", async () => {
      const app = await startApp();
      const send = async (body: unknown) => (await app.importer.POST(request("/api/garage/import", "POST", body))).status;
      const ok = { clientId: "a", year: "2012", make: "Ford", model: "Focus", maintenance: [], diagnoses: [] };

      expect(await send({})).toBe(400);
      expect(await send({ vehicles: [] })).toBe(400);
      expect(await send({ vehicles: [{ ...ok, year: "12" }] })).toBe(400);
      expect(await send({ vehicles: [{ ...ok, make: "" }] })).toBe(400);
      expect(await send({ vehicles: [ok, ok] })).toBe(400); // the same vehicle twice
      expect(await send({ vehicles: [{ ...ok, maintenance: [{ type: "Oil", date: "2026-01-01", odometerValue: "many" }] }] })).toBe(400);
      expect(await send({ vehicles: [{ ...ok, maintenance: [{ date: "2026-01-01" }] }] })).toBe(400);
      expect(await send({ vehicles: [{ ...ok, diagnoses: [{ key: "k", causes: [] }] }] })).toBe(400);
      expect(await send({ vehicles: [{ ...ok, diagnoses: [{ key: "k", causes: [{ title: "x".repeat(201) }] }] }] })).toBe(400);
      expect(await send({ vehicles: Array.from({ length: 21 }, (_, i) => ({ ...ok, clientId: `v${i}`, model: `Model ${i}` })) })).toBe(400);
      expect(await send({ vehicles: [{ ...ok, clientId: "big", maintenance: Array.from({ length: 201 }, () => ({ type: "Oil", date: "2026-01-01" })) }] })).toBe(400);

      expect([await count("garage_vehicles"), await count("maintenance_records"), await count("diagnoses")]).toEqual([0, 0, 0]);
      expect(await send({ vehicles: [ok] })).toBe(200);
      expect(await count("garage_vehicles")).toBe(1);
    });
  });
}
