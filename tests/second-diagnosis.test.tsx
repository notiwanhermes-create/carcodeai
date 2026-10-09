// @vitest-environment jsdom
/**
 * The diagnosis screen.
 *
 * Started as the regression test for the "second diagnosis crashes the app"
 * bug: the results panel used to call hooks after an early return, so clearing
 * the previous result made React throw "Rendered fewer hooks than expected"
 * and blanked the whole page.
 *
 * It now also checks that everything the screen shows about a diagnosis
 * (ranking, likelihood, urgency, drive guidance, follow-up questions) is read
 * from the structured result, never worked out in the browser from keywords.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: "unauthenticated" }),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

import Home from "../app/page";
import type { Diagnosis, DiagnoseOk } from "../app/lib/diagnosis-schema";
import { lookupCodes } from "../app/lib/dtc";

type Cause = Diagnosis["causes"][number];

function cause(rank: number, title: string, overrides: Partial<Cause> = {}): Cause {
  return {
    id: `c${rank}`,
    rank,
    title,
    explanation: `${title} explained.`,
    why_it_fits: ["Fits what was described."],
    likelihood: "likely",
    urgency: "normal",
    checks: [{ instruction: `Check for ${title}.`, level: "owner" }],
    recommended_action: `Deal with ${title}.`,
    repair_level: "diy_easy",
    ...overrides,
  };
}

function response(overrides: Partial<Diagnosis> = {}, extra: Partial<DiagnoseOk> = {}): DiagnoseOk {
  return {
    diagnosis: {
      summary: "Most likely an ignition problem, but this is not confirmed.",
      drive_guidance: { level: "unknown", reason: "Not enough information to judge." },
      causes: [cause(1, "Worn spark plugs", { likelihood: "very_likely" }), cause(2, "Vacuum leak", { likelihood: "possible" })],
      follow_up_questions: [],
      limitations: [],
      ...overrides,
    },
    codes: [],
    refined: false,
    ...extra,
  };
}

type Body = { code?: string; symptoms?: string; followUps?: Array<{ question: string; answer: string }>; vin?: string; mileage?: string; lang?: string };

describe("diagnosis screen", () => {
  let requests: Body[] = [];
  let reply: (body: Body, index: number) => { status?: number; body: unknown };

  beforeEach(() => {
    requests = [];
    reply = (body) => {
      const code = (body.code || "").toUpperCase();
      return { body: response({ causes: [cause(1, code === "P0420" ? "Failing catalytic converter" : "Worn spark plugs", { likelihood: "very_likely" }), cause(2, "Vacuum leak", { likelihood: "possible" })] }) };
    };
    localStorage.clear();
    localStorage.setItem("carcode_onboarded_v1", "1");
    localStorage.setItem(
      "carcode_garage_v1:anon",
      JSON.stringify({
        garage: [{ id: "veh-1", year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4", vin: "4T1BF1FK5FU000000" }],
        activeId: "veh-1",
      }),
    );

    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    Element.prototype.scrollIntoView = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/api/diagnose")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as Body;
          requests.push(body);
          const r = reply(body, requests.length - 1);
          return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
            status: r.status ?? 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** Open the Diagnose tab. Found by position so it works in every language. */
  async function openDiagnose(label = "Diagnose") {
    fireEvent.click(await screen.findByRole("button", { name: label }));
    await waitFor(() => expect(document.querySelector('input[name="code"]')).not.toBeNull());
  }

  function submit(fields: { code?: string; symptoms?: string; mileage?: string }) {
    const codeInput = document.querySelector('input[name="code"]') as HTMLInputElement;
    const form = codeInput.closest("form") as HTMLFormElement;
    fireEvent.change(codeInput, { target: { value: fields.code ?? "" } });
    fireEvent.change(form.querySelector('textarea[name="symptoms"]') as HTMLTextAreaElement, { target: { value: fields.symptoms ?? "" } });
    if (fields.mileage !== undefined) fireEvent.change(form.querySelector('input[name="mileage"]') as HTMLInputElement, { target: { value: fields.mileage } });
    fireEvent.submit(form);
  }

  const pageText = () => document.body.textContent || "";

  it("runs a second diagnosis in the same session without crashing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<Home />);
    await openDiagnose();

    submit({ code: "P0300" });
    expect(await screen.findByText("Worn spark plugs")).toBeTruthy();

    // Back to the search form, then diagnose again.
    fireEvent.click(screen.getByRole("button", { name: /Search New Issue/i }));
    submit({ code: "P0420" });

    expect(await screen.findByText("Failing catalytic converter")).toBeTruthy();
    await waitFor(() => expect(requests).toHaveLength(2));

    const hookErrors = errorSpy.mock.calls.filter((args) =>
      args.some((a) => /Rendered (fewer|more) hooks/.test(String(a instanceof Error ? a.message : a))),
    );
    expect(hookErrors).toHaveLength(0);
  });

  it("shows the empty state (not a crash) when a diagnosis request fails after a previous success", async () => {
    render(<Home />);
    await openDiagnose();

    submit({ code: "P0300" });
    expect(await screen.findByText("Worn spark plugs")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Search New Issue/i }));
    reply = () => ({ status: 429, body: { error: "Too many requests. Please wait a moment." } });
    submit({ code: "P0420" });

    expect(await screen.findByText("Too many requests. Please wait a moment.")).toBeTruthy();
    expect(screen.getByText("Run a diagnostic to see causes here.")).toBeTruthy();
  });

  it("shows an error, not a made-up diagnosis, when the server reply is not a diagnosis", async () => {
    render(<Home />);
    await openDiagnose();

    for (const body of [{ causes: [{ title: "Old format" }] }, { diagnosis: { summary: "no causes list" } }, "not json at all"]) {
      reply = () => ({ body });
      submit({ symptoms: "rough idle" });
      expect(await screen.findByText("Invalid response from server.")).toBeTruthy();
      expect(screen.getByText("Run a diagnostic to see causes here.")).toBeTruthy();
      expect(pageText()).not.toMatch(/Old format|no causes list/);
    }
  });

  it("sends the vehicle, both the code and the symptoms, the mileage and the saved VIN", async () => {
    render(<Home />);
    await openDiagnose();
    submit({ code: "P0300", symptoms: "rough idle around 1200 RPM", mileage: "128000" });
    await screen.findByText("Worn spark plugs");
    expect(requests[0]).toMatchObject({
      year: "2015",
      make: "Toyota",
      model: "Camry",
      engine: "2.5L I4",
      vin: "4T1BF1FK5FU000000",
      mileage: "128000",
      mileageUnit: "km",
      code: "P0300",
      symptoms: "rough idle around 1200 RPM",
      lang: "en",
    });
  });

  it("shows causes in the server's ranked order with likelihood as a category, and nothing invented", async () => {
    render(<Home />);
    await openDiagnose();
    reply = () => ({
      body: response({
        causes: [
          cause(1, "Worn spark plugs", { likelihood: "very_likely" }),
          cause(2, "Failing ignition coil", { likelihood: "likely" }),
          cause(3, "Vacuum leak", { likelihood: "possible" }),
          cause(4, "Faulty ECU", { likelihood: "unlikely" }),
        ],
      }),
    });
    submit({ code: "P0300" });

    await screen.findByText("Worn spark plugs");
    const cards = Array.from(document.querySelectorAll("[data-cause-rank]"));
    expect(cards.map((c) => c.getAttribute("data-cause-rank"))).toEqual(["1", "2", "3", "4"]);
    expect(cards.map((c) => c.querySelector("[data-likelihood]")?.getAttribute("data-likelihood"))).toEqual(["very_likely", "likely", "possible", "unlikely"]);
    expect(cards.map((c) => c.querySelector("[data-likelihood]")?.textContent)).toEqual(["Very likely", "Likely", "Possible", "Unlikely"]);

    // Open a cause to check the detail panel too.
    fireEvent.click(screen.getByText("Worn spark plugs"));
    expect(await screen.findByText("Check for Worn spark plugs.")).toBeTruthy();
    expect(screen.getByText("Deal with Worn spark plugs.")).toBeTruthy();
    expect(document.querySelector("[data-check-level]")?.getAttribute("data-check-level")).toBe("owner");

    const text = pageText();
    expect(text).not.toMatch(/\d+\s*%/);
    expect(text).not.toMatch(/Confidence/i);
    expect(text).not.toMatch(/Typical parts|Labor:|Labour hours|Est\. cost/i);
    expect(text).not.toMatch(/\$\s?\d/);
    expect(text).toMatch(/possible causes, most likely first\. They are not a confirmed repair/);
  });

  it("takes urgency and drive guidance from the structured result, never from words on the page", async () => {
    render(<Home />);
    await openDiagnose();

    // Alarming words everywhere, but the structured result says "normal" / "unknown".
    reply = () => ({
      body: response({
        summary: "A coolant leak or misfire is possible, with smoke and fire mentioned.",
        drive_guidance: { level: "unknown", reason: "Fire, smoke and coolant leak were mentioned but cannot be judged." },
        causes: [cause(1, "Coolant leak near the misfire", { urgency: "normal", explanation: "Smoke, fire, leak, coolant, misfire." })],
      }),
    });
    submit({ symptoms: "fire smoke coolant leak misfire stop driving" });
    await screen.findByText("Coolant leak near the misfire");
    expect(document.querySelector("[data-drive-guidance]")?.getAttribute("data-drive-guidance")).toBe("unknown");
    expect(screen.getByText("Driving safety could not be assessed from this information")).toBeTruthy();
    expect(document.querySelector("[data-urgency]")?.textContent).toBe("Not urgent");
    expect(pageText()).not.toMatch(/Do not drive until|Drive with caution/);

    // Calm words, but the structured result says "stop".
    fireEvent.click(screen.getByRole("button", { name: /Search New Issue/i }));
    reply = () => ({
      body: response({
        summary: "Possibly a minor issue.",
        drive_guidance: { level: "stop", reason: "Brakes may not work." },
        causes: [cause(1, "Soft brake pedal", { urgency: "stop" }), cause(2, "Worn pads", { urgency: "caution" }), cause(3, "Unknown issue", { urgency: "unknown" })],
      }),
    });
    submit({ symptoms: "pedal feels a little different" });
    await screen.findByText("Soft brake pedal");
    expect(document.querySelector("[data-drive-guidance]")?.getAttribute("data-drive-guidance")).toBe("stop");
    expect(screen.getByText("Do not drive until it has been inspected")).toBeTruthy();
    expect(screen.getByText("Brakes may not work.")).toBeTruthy();
    expect(Array.from(document.querySelectorAll("[data-urgency]")).map((e) => e.textContent)).toEqual(["Stop driving", "Fix soon", "Urgency unclear"]);
  });

  it("shows each code with how far its definition can be trusted", async () => {
    render(<Home />);
    await openDiagnose();
    reply = () => ({ body: response({}, { codes: lookupCodes("P0300 P2096 P1345 P3400 hello", "Toyota") }) });
    submit({ code: "P0300 P2096 P1345 P3400 hello", symptoms: "rough idle" });

    await screen.findByText("Random/Multiple Cylinder Misfire Detected");
    const rows = Array.from(document.querySelectorAll("[data-code-trust]"));
    expect(rows.map((r) => r.getAttribute("data-code-trust"))).toEqual(["local_reference", "none", "none", "none", "none"]);
    expect(rows[0].textContent).toMatch(/Commonly published title for this code\. Not yet checked against the official standard/);
    expect(rows[0].textContent).not.toMatch(/Verified definition/);
    expect(rows[1].textContent).toMatch(/P2096Definition not verified yet/);
    expect(rows[2].textContent).toMatch(/P1345Manufacturer-specific code/);
    expect(rows[3].textContent).toMatch(/P3400Definition not verified yet/);
    expect(rows[4].textContent).toMatch(/HELLONot a valid trouble code/);
  });

  it("asks no follow-up questions when the result has none", async () => {
    render(<Home />);
    await openDiagnose();
    submit({ code: "P0300" });
    await screen.findByText("Worn spark plugs");
    expect(document.querySelector("#refine-diagnosis")).toBeNull();
    expect(screen.queryByRole("button", { name: "Update diagnosis" })).toBeNull();
  });

  it("re-ranks only by asking the server again with the user's answers", async () => {
    render(<Home />);
    await openDiagnose();

    const questions: Diagnosis["follow_up_questions"] = [
      { id: "q1", question: "Is the check engine light flashing?", answer_type: "yes_no", options: [], why_it_matters: "A flashing light means an active misfire." },
      { id: "q2", question: "When is it worst?", answer_type: "single_choice", options: [{ id: "o1", label: "Cold start" }, { id: "o2", label: "Hot engine" }], why_it_matters: "Narrows the cause." },
      { id: "q3", question: "Any recent repairs?", answer_type: "free_text", options: [], why_it_matters: "Recent work can cause faults." },
    ];
    reply = (body) =>
      body.followUps?.length
        ? { body: response({ causes: [cause(1, "Failing ignition coil", { likelihood: "very_likely" }), cause(2, "Worn spark plugs")], follow_up_questions: [] }, { refined: true }) }
        : { body: response({ follow_up_questions: questions }) };

    submit({ code: "P0300", symptoms: "rough idle" });
    await screen.findByText("Is the check engine light flashing?");
    expect(Array.from(document.querySelectorAll("[data-follow-up]")).map((e) => e.getAttribute("data-follow-up"))).toEqual(["yes_no", "single_choice", "free_text"]);
    expect(screen.getByText("A flashing light means an active misfire.")).toBeTruthy();

    // Nothing is sent, and nothing moves, until the user asks for an update.
    const update = screen.getByRole("button", { name: "Update diagnosis" }) as HTMLButtonElement;
    expect(update.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Cold start" }));
    fireEvent.change(screen.getByLabelText("Any recent repairs?"), { target: { value: "new plugs last month" } });
    expect(requests).toHaveLength(1);
    expect(Array.from(document.querySelectorAll("[data-cause-rank]")).map((c) => c.textContent)).toEqual([
      expect.stringContaining("Worn spark plugs"),
      expect.stringContaining("Vacuum leak"),
    ]);

    expect(update.disabled).toBe(false);
    fireEvent.click(update);

    expect(await screen.findByText("Failing ignition coil")).toBeTruthy();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ code: "P0300", symptoms: "rough idle", year: "2015", make: "Toyota" });
    expect(requests[1].followUps).toEqual([
      { question: "Is the check engine light flashing?", answer: "Yes" },
      { question: "When is it worst?", answer: "Cold start" },
      { question: "Any recent repairs?", answer: "new plugs last month" },
    ]);
    expect(screen.getByText("Updated based on your answers")).toBeTruthy();
  });

  it("keeps the current diagnosis on screen when an update fails", async () => {
    render(<Home />);
    await openDiagnose();
    reply = (body) =>
      body.followUps?.length
        ? { status: 503, body: { error: "Diagnosis is temporarily unavailable. Please try again in a moment.", code: "service_unavailable" } }
        : { body: response({ follow_up_questions: [{ id: "q1", question: "Is the light flashing?", answer_type: "yes_no", options: [], why_it_matters: "" }] }) };

    submit({ code: "P0300" });
    await screen.findByText("Is the light flashing?");
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    fireEvent.click(screen.getByRole("button", { name: "Update diagnosis" }));

    expect(await screen.findByText("Diagnosis is temporarily unavailable. Please try again in a moment.")).toBeTruthy();
    expect(screen.getByText("Worn spark plugs")).toBeTruthy();
    expect(requests[1].followUps).toEqual([{ question: "Is the light flashing?", answer: "No" }]);
  });

  it("shows the same structured values in another language: only the labels change", async () => {
    localStorage.setItem("carcode_lang", "es");
    render(<Home />);
    await openDiagnose("Diagnóstico");

    reply = () => ({
      body: response({
        summary: "Lo más probable es un problema de encendido, pero no está confirmado.",
        drive_guidance: { level: "caution", reason: "Un fallo de encendido puede dañar el catalizador." },
        causes: [cause(1, "Bujías desgastadas", { likelihood: "very_likely", urgency: "caution", repair_level: "professional" })],
        follow_up_questions: [{ id: "q1", question: "¿Parpadea la luz?", answer_type: "yes_no", options: [], why_it_matters: "Indica un fallo activo." }],
        limitations: ["El vehículo no ha sido inspeccionado."],
      }),
    });
    submit({ symptoms: "ralentí irregular" });

    await screen.findByText("Bujías desgastadas");
    expect(requests[0].lang).toBe("es");
    // Same structure, same identifiers…
    expect(document.querySelector("[data-drive-guidance]")?.getAttribute("data-drive-guidance")).toBe("caution");
    expect(document.querySelector("[data-likelihood]")?.getAttribute("data-likelihood")).toBe("very_likely");
    expect(document.querySelector("[data-urgency]")?.getAttribute("data-urgency")).toBe("caution");
    // …shown with Spanish labels.
    expect(document.querySelector("[data-likelihood]")?.textContent).toBe("Muy probable");
    expect(document.querySelector("[data-urgency]")?.textContent).toBe("Reparar pronto");
    expect(screen.getByText("Conduzca con precaución y hágalo revisar pronto")).toBeTruthy();
    expect(screen.getByText("Reparación: se recomienda un mecánico")).toBeTruthy();
    expect(screen.getByText("Límites de este diagnóstico")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sí" })).toBeTruthy();

    // The answer goes back as a stable value, whatever the page language.
    fireEvent.click(screen.getByRole("button", { name: "Sí" }));
    fireEvent.click(screen.getByRole("button", { name: "Actualizar diagnóstico" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].followUps).toEqual([{ question: "¿Parpadea la luz?", answer: "Yes" }]);
  });
});
