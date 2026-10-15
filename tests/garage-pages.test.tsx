// @vitest-environment jsdom
/**
 * The garage pages: a vehicle, a saved diagnosis, "Did you fix this?", and the
 * dashboard cards. They show what is stored, and they never ask the AI for
 * anything.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "user-1", email: "me@example.test" } }, status: "authenticated" }),
}));

import DashboardClient from "../app/dashboard/DashboardClient";
import VehicleClient from "../app/garage/[id]/VehicleClient";
import DiagnosisClient from "../app/garage/[id]/diagnosis/[diagnosisId]/DiagnosisClient";
import type { DiagnosisDetailDto, MaintenanceDto, TimelineItem, VehicleDetailDto, VehicleDto } from "../app/lib/garage-types";
import { OutcomePanel } from "../components/garage/OutcomePanel";
import { StoredDiagnosisView } from "../components/garage/StoredDiagnosisView";
import { MileageEditor, TimelineList } from "../components/garage/VehicleParts";

const vehicle: VehicleDto = {
  id: "veh-1",
  year: "2015",
  make: "Toyota",
  model: "Camry",
  engine: "2.5L I4",
  trim: "SE",
  odometerValue: 138000,
  odometerUnit: "km",
  odometerUpdatedAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
  stats: { openIssues: 1, diagnoses: 2, lastDiagnosisAt: "2026-10-10T09:00:00.000Z", maintenanceRecords: 1, lastMaintenance: { serviceType: "Oil Change", date: "2026-06-15" }, repairs: 1 },
};

const diagnosis: DiagnosisDetailDto = {
  id: "dx-1",
  vehicleId: "veh-1",
  status: "open",
  title: "Rough idle when cold",
  codes: ["P0300", "P1234"],
  diagnosedAt: "2026-10-10T09:00:00.000Z",
  updatedAt: "2026-10-11T09:00:00.000Z",
  fix: null,
  source: "app",
  language: "en",
  vehicle: { year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4", trim: "SE" },
  codeInput: "P0300 P1234",
  symptoms: "Rough idle when cold",
  codeDetails: [
    { code: "P0300", status: "found", trust: "verified", definition: "Random/Multiple Cylinder Misfire Detected" },
    { code: "P1234", status: "unknown", trust: "none" },
  ] as unknown as DiagnosisDetailDto["codeDetails"],
  result: {
    kind: "structured",
    diagnosis: {
      summary: "Most likely an ignition problem, but this is not confirmed.",
      drive_guidance: { level: "caution", reason: "A misfire can damage the catalytic converter.", adjusted: null },
      causes: [
        { id: "c1", rank: 1, title: "Worn spark plugs", explanation: "Old plugs misfire under load.", why_it_fits: ["Matches the rough idle."], likelihood: "very_likely", urgency: "caution", checks: [{ instruction: "Inspect the plugs.", level: "diy" }], recommended_action: "Replace the plugs.", repair_level: "diy_moderate" },
        { id: "c2", rank: 2, title: "Vacuum leak", explanation: "Unmetered air leans the mixture.", why_it_fits: ["Worse when cold."], likelihood: "possible", urgency: "normal", checks: [{ instruction: "Listen for hissing.", level: "owner" }], recommended_action: "Smoke-test the intake.", repair_level: "professional" },
      ],
      follow_up_questions: [],
      limitations: ["The vehicle has not been inspected."],
    },
  },
  followUps: [{ question: "Is the check engine light flashing?", answer: "No" }],
  updateCount: 1,
  odometerValue: 138000,
  odometerUnit: "km",
  statusChangedAt: null,
  confirmedFix: null,
  previousFixes: [],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: string; method: string; body: Record<string, unknown> | null };

/** Stub fetch with a handler and keep a list of what was requested. */
function stubFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const call: Call = { url, method: init?.method || "GET", body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

beforeEach(() => {
  localStorage.clear();
  push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a saved diagnosis", () => {
  it("shows everything from stored data: what was entered, the answer, the follow-ups", () => {
    const calls = stubFetch(() => json({}));
    render(<StoredDiagnosisView diagnosis={diagnosis} />);

    expect((document.querySelector("[data-stored-vehicle]") as HTMLElement).textContent).toBe("2015 Toyota Camry SE (2.5L I4)");
    expect((document.querySelector("[data-stored-symptoms]") as HTMLElement).textContent).toBe("Rough idle when cold");
    expect(screen.getByText(/Oct 10, 2026 · 138,000 km/)).toBeTruthy();
    expect(screen.getByText(/Random\/Multiple Cylinder Misfire Detected/)).toBeTruthy();
    expect((document.querySelector("[data-stored-summary]") as HTMLElement).textContent).toBe("Most likely an ignition problem, but this is not confirmed.");
    expect(screen.getByText("These are possible causes, most likely first. They are not a confirmed repair.")).toBeTruthy();
    expect((document.querySelector("[data-drive-level]") as HTMLElement).getAttribute("data-drive-level")).toBe("caution");
    expect(Array.from(document.querySelectorAll("[data-cause-rank]")).map((el) => el.getAttribute("data-cause-rank"))).toEqual(["1", "2"]);
    expect(screen.getByText("1. Worn spark plugs")).toBeTruthy();
    expect(screen.getByText("Replace the plugs.")).toBeTruthy();
    expect(screen.getByText("Is the check engine light flashing?")).toBeTruthy();
    expect(screen.getByText("The vehicle has not been inspected.")).toBeTruthy();
    // The code with no definition on file is explained in plain words, with none of the app's internal wording.
    expect(document.body.textContent).not.toMatch(/withheld|unsupported|redacted/i);
    // Rendering it needs no request at all.
    expect(calls).toHaveLength(0);
  });

  it("treats a drive level it does not recognise as 'could not be assessed', never as fine to drive", () => {
    const odd = structuredClone(diagnosis);
    if (odd.result.kind === "structured") (odd.result.diagnosis.drive_guidance as { level: string }).level = "probably_fine";
    render(<StoredDiagnosisView diagnosis={odd} />);
    expect((document.querySelector("[data-drive-level]") as HTMLElement).getAttribute("data-drive-level")).toBe("unknown");
  });

  it("shows a diagnosis copied from a device as the summary it is", () => {
    render(
      <StoredDiagnosisView
        diagnosis={{ ...diagnosis, source: "device_import", codeDetails: [], followUps: [], result: { kind: "legacy", issueText: "Code: P0300", causes: [{ title: "Worn spark plugs", why: ["Misfire code"], checks: ["Inspect the plugs"], fix: ["Replace the plugs"] }] } }}
      />,
    );
    expect(screen.getByText("Copied from a device: a summary only")).toBeTruthy();
    expect(screen.getByText("1. Worn spark plugs")).toBeTruthy();
    expect(document.querySelector("[data-drive-level]")).toBeNull();
  });

  it("is reopened by reading it back, without running a new diagnosis", async () => {
    const calls = stubFetch((call) => (call.url.includes("/api/diagnoses/dx-1") ? json({ diagnosis }) : json({ vehicle, openIssues: [], timeline: [], maintenance: [] })));
    render(<DiagnosisClient vehicleId="veh-1" diagnosisId="dx-1" />);

    await screen.findByText("Most likely an ignition problem, but this is not confirmed.");
    expect(screen.getByText("This is the diagnosis as it was saved. Opening it does not run a new one.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Rough idle when cold" })).toBeTruthy();

    await waitFor(() => expect(calls.length).toBe(2));
    // Two reads, nothing else: the diagnosis and its vehicle. The AI route is never touched.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/diagnoses/dx-1", "GET /api/garage/veh-1"]);
    expect(calls.some((c) => c.url.includes("/api/diagnose") && !c.url.includes("/api/diagnoses"))).toBe(false);
  });

  it("says so when the diagnosis is not in this garage", async () => {
    stubFetch(() => json({ error: "Not found" }, 404));
    render(<DiagnosisClient vehicleId="veh-1" diagnosisId="someone-elses" />);
    await screen.findByText("This diagnosis could not be found in your garage.");
  });
});

describe("Did you fix this problem?", () => {
  function setup(start: DiagnosisDetailDto = diagnosis) {
    const onChange = vi.fn();
    const calls = stubFetch((call) => {
      const body = call.body ?? {};
      if (body.outcome === "fixed") {
        return json({
          diagnosis: {
            ...start,
            status: "resolved",
            confirmedFix: { id: "fix-1", attempt: 1, outcome: "fixed", returnedAt: null, description: body.description, matchedCauseRank: body.matchedCauseRank ?? null, matchedCauseTitle: body.matchedCauseRank ? "Worn spark plugs" : null, fixedOn: body.fixedOn, odometerValue: null, odometerUnit: null, notes: null },
          },
        });
      }
      return json({ diagnosis: { ...start, status: body.outcome === "dismissed" ? "dismissed" : "open", confirmedFix: null } });
    });
    const view = render(<OutcomePanel diagnosis={start} defaultUnit="km" onChange={onChange} />);
    return { onChange, calls, view };
  }

  it("records what the user says fixed it, even when the AI never listed it", async () => {
    const { calls, onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Yes, fixed" }));

    // The listed causes are offered as shortcuts, but nothing is preselected.
    expect(screen.getByRole("button", { name: "Worn spark plugs" })).toBeTruthy();
    fireEvent.change(document.querySelector("[data-fix-description]") as HTMLInputElement, { target: { value: "Cracked intake boot" } });
    fireEvent.click(screen.getByRole("button", { name: "Save repair" }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "PATCH", url: "/api/diagnoses/dx-1" });
    expect(calls[0].body).toMatchObject({ outcome: "fixed", description: "Cracked intake boot", matchedCauseRank: null });
    // Only the outcome is sent. The stored AI answer is not part of the request, so it cannot be rewritten.
    expect(Object.keys(calls[0].body ?? {}).sort()).toEqual(["description", "fixedOn", "matchedCauseRank", "outcome"]);
  });

  it("notes a match only when the user picks one of the listed causes", async () => {
    const { calls } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Yes, fixed" }));
    fireEvent.click(screen.getByRole("button", { name: "Worn spark plugs" }));
    expect((document.querySelector("[data-fix-description]") as HTMLInputElement).value).toBe("Worn spark plugs");

    // Changing their mind to "Something else" clears the match and the borrowed text.
    fireEvent.click(screen.getByRole("button", { name: "Something else" }));
    expect((document.querySelector("[data-fix-description]") as HTMLInputElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Worn spark plugs" }));
    fireEvent.click(screen.getByRole("button", { name: "Save repair" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toMatchObject({ outcome: "fixed", description: "Worn spark plugs", matchedCauseRank: 1 });
  });

  it("will not save a repair with no description", async () => {
    const { calls } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Yes, fixed" }));
    fireEvent.click(screen.getByRole("button", { name: "Save repair" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("keeps an issue open on 'Not yet' and dismisses it on 'Problem went away'", async () => {
    const { calls } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Not yet" }));
    await screen.findByText("Thanks. This stays open in your garage.");
    fireEvent.click(screen.getByRole("button", { name: "Problem went away" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => c.body)).toEqual([{ outcome: "not_yet" }, { outcome: "dismissed" }]);
  });

  it("shows a confirmed repair as the user's report, and says plainly when it was not a listed cause", () => {
    const resolved: DiagnosisDetailDto = {
      ...diagnosis,
      status: "resolved",
      confirmedFix: { id: "fix-1", attempt: 1, outcome: "fixed", returnedAt: null, description: "Cracked intake boot", matchedCauseRank: null, matchedCauseTitle: null, fixedOn: "2026-10-12", odometerValue: 138200, odometerUnit: "km", notes: "Found by the shop" },
    };
    setup(resolved);
    expect((document.querySelector("[data-confirmed-fix]") as HTMLElement).textContent).toBe("Cracked intake boot");
    expect(screen.getByText("Reported by you. It was not one of the causes the diagnosis listed.")).toBeTruthy();
    expect(screen.getByText(/Oct 12, 2026 · 138,200 km/)).toBeTruthy();
  });

  it("can be reopened, after saying what reopening does", async () => {
    const resolved: DiagnosisDetailDto = {
      ...diagnosis,
      status: "resolved",
      confirmedFix: { id: "fix-1", attempt: 1, outcome: "fixed", returnedAt: null, description: "Worn spark plugs", matchedCauseRank: 1, matchedCauseTitle: "Worn spark plugs", fixedOn: "2026-10-12", odometerValue: null, odometerUnit: null, notes: null },
    };
    const { calls } = setup(resolved);
    expect(screen.getByText("You said this matched cause 1 in the diagnosis: Worn spark plugs.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "It came back" }));
    expect(calls).toHaveLength(0); // one more step first
    expect(screen.getByText("This reopens the issue. The repair you reported stays in its history, marked as not having held.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ outcome: "reopen" });
  });

  it("shows a repair that did not hold as an earlier attempt, never as the resolution, and lets a new one be reported", async () => {
    const earlier = { id: "fix-1", attempt: 1, outcome: "did_not_hold" as const, returnedAt: "2026-10-12T10:00:00.000Z", description: "Replaced the spark plugs", matchedCauseRank: 1, matchedCauseTitle: "Worn spark plugs", fixedOn: "2026-09-01", odometerValue: 137000, odometerUnit: "km" as const, notes: null };
    const reopened: DiagnosisDetailDto = { ...diagnosis, status: "open", confirmedFix: null, previousFixes: [earlier] };
    const { calls } = setup(reopened);

    // Open again, with the earlier repair listed as history.
    expect(screen.getByText("Did you fix this problem?")).toBeTruthy();
    expect(screen.queryByText("Confirmed repair")).toBeNull();
    const history = document.querySelector("[data-previous-fixes]") as HTMLElement;
    expect(history.textContent).toContain("An earlier repair that did not hold");
    expect(history.textContent).toContain("Replaced the spark plugs");
    expect(history.textContent).toContain("Reported as the fix Sep 1, 2026 · 137,000 km · you said the problem came back Oct 12, 2026");
    expect(history.querySelector("[data-previous-fix]")?.getAttribute("data-fix-outcome")).toBe("did_not_hold");
    // Nothing in it can be edited or removed.
    expect(within(history).queryByRole("button")).toBeNull();

    // A new repair starts from an empty form.
    fireEvent.click(screen.getByRole("button", { name: "Yes, fixed" }));
    expect((document.querySelector("[data-fix-description]") as HTMLInputElement).value).toBe("");
    fireEvent.change(document.querySelector("[data-fix-description]") as HTMLInputElement, { target: { value: "Cracked vacuum hose" } });
    fireEvent.click(screen.getByRole("button", { name: "Save repair" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toMatchObject({ outcome: "fixed", description: "Cracked vacuum hose" });
  });
});

describe("a vehicle's mileage", () => {
  it("saves a higher reading straight away", async () => {
    const onUpdated = vi.fn();
    const calls = stubFetch(() => json({ vehicle: { ...vehicle, odometerValue: 139000 } }));
    render(<MileageEditor vehicle={vehicle} onUpdated={onUpdated} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText("Mileage"), { target: { value: "139000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save mileage" }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ odometerValue: 139000 })));
    expect(calls[0].body).toEqual({ mileage: { value: "139000", unit: "km", confirm: false } });
  });

  it("asks before lowering it, and lowers it only on a clear yes", async () => {
    const onUpdated = vi.fn();
    const calls = stubFetch((call) => {
      const mileage = (call.body?.mileage ?? {}) as { confirm?: boolean };
      return mileage.confirm
        ? json({ vehicle: { ...vehicle, odometerValue: 13800 } })
        : json({ error: "That is lower than the mileage on file.", code: "mileage_confirm", reason: "lower", current: { value: 138000, unit: "km" } }, 409);
    });
    render(<MileageEditor vehicle={vehicle} onUpdated={onUpdated} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText("Mileage"), { target: { value: "13800" } });
    fireEvent.click(screen.getByRole("button", { name: "Save mileage" }));
    await screen.findByText("That is lower than 138,000 km. Save it anyway as a correction?");
    expect(onUpdated).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Yes, save it" }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ odometerValue: 13800 })));
    expect(calls.map((c) => (c.body?.mileage as { confirm: boolean }).confirm)).toEqual([false, true]);
  });

  it("asks before replacing a reading with one in the other unit", async () => {
    stubFetch(() => json({ error: "Different unit.", code: "mileage_confirm", reason: "unit_change", current: { value: 138000, unit: "km" } }, 409));
    render(<MileageEditor vehicle={vehicle} onUpdated={() => {}} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText("Mileage"), { target: { value: "85,750" } });
    fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "mi" } });
    fireEvent.click(screen.getByRole("button", { name: "Save mileage" }));
    await screen.findByText("The mileage on file is 138,000 km, in a different unit. Replace it with 85,750 mi?");
  });
});

describe("a vehicle's page", () => {
  const timeline: TimelineItem[] = [
    { kind: "diagnosis", id: "dx-1", at: "2026-10-10T09:00:00.000Z", title: "Rough idle when cold", codes: ["P0300"], status: "open" },
    { kind: "fix", id: "fix-0", at: "2026-08-05T00:00:00.000Z", diagnosisId: "dx-0", description: "Replaced the battery", outcome: "fixed", odometerValue: 136000, odometerUnit: "km" },
    { kind: "maintenance", id: "m-1", at: "2026-06-15T00:00:00.000Z", serviceType: "Oil Change", dateText: "2026-06-15", odometer: "130,250 km", odometerValue: 130250, odometerUnit: "km", cost: "60" },
    { kind: "maintenance", id: "m-old", at: "2025-03-01T00:00:00.000Z", serviceType: "Other", dateText: "last spring", odometer: "about 90k", odometerValue: null, odometerUnit: null },
  ];
  const maintenance: MaintenanceDto[] = [
    { id: "m-1", vehicleId: "veh-1", serviceType: "Oil Change", date: "2026-06-15", serviceDate: "2026-06-15", odometer: "130,250 km", odometerValue: 130250, odometerUnit: "km", cost: "60", createdAt: "2026-06-15T12:00:00.000Z" },
    { id: "m-old", vehicleId: "veh-1", serviceType: "Other", date: "last spring", serviceDate: null, odometer: "about 90k", odometerValue: null, odometerUnit: null, cost: "CAD 45", createdAt: "2025-03-01T12:00:00.000Z" },
  ];
  const detail: VehicleDetailDto = {
    vehicle,
    openIssues: [{ id: "dx-1", vehicleId: "veh-1", status: "open", title: "Rough idle when cold", codes: ["P0300"], diagnosedAt: "2026-10-10T09:00:00.000Z", updatedAt: "2026-10-10T09:00:00.000Z", fix: null }],
    timeline,
    maintenance,
  };

  it("lists one history, newest first, each entry linking to its record", () => {
    render(<TimelineList vehicleId="veh-1" items={timeline} />);
    const rows = Array.from(document.querySelectorAll("[data-timeline-kind]"));
    expect(rows.map((r) => r.getAttribute("data-timeline-kind"))).toEqual(["diagnosis", "fix", "maintenance", "maintenance"]);
    expect(within(rows[0] as HTMLElement).getByRole("link").getAttribute("href")).toBe("/garage/veh-1/diagnosis/dx-1");
    // A confirmed repair opens the diagnosis it belongs to.
    expect(within(rows[1] as HTMLElement).getByRole("link").getAttribute("href")).toBe("/garage/veh-1/diagnosis/dx-0");
    expect(rows[2].textContent).toContain("130,250 km");
    expect(rows[2].textContent).toContain("$60");
    // An old free-text date and reading are shown as they were typed.
    expect(rows[3].textContent).toContain("last spring");
    expect(rows[3].textContent).toContain("about 90k");
    expect(document.body.textContent).not.toMatch(/km miles/);
  });

  it("labels a repair that did not hold as such, not as a confirmed repair", () => {
    render(<TimelineList vehicleId="veh-1" items={[{ kind: "fix", id: "fix-9", at: "2026-09-01T00:00:00.000Z", diagnosisId: "dx-1", description: "Replaced the spark plugs", outcome: "did_not_hold", odometerValue: null, odometerUnit: null }]} />);
    const row = document.querySelector("[data-timeline-kind]") as HTMLElement;
    expect(row.textContent).toContain("Repair that did not hold");
    expect(row.textContent).not.toContain("Confirmed repair");
    expect(row.querySelector("[data-fix-outcome]")?.getAttribute("data-fix-outcome")).toBe("did_not_hold");
  });

  it("can show just the most recent entries", () => {
    render(<TimelineList vehicleId="veh-1" items={timeline} limit={2} />);
    expect(document.querySelectorAll("[data-timeline-kind]")).toHaveLength(2);
  });

  it("shows the vehicle, its open issues, its history, its service records and the three actions", async () => {
    const calls = stubFetch(() => json(detail));
    render(<VehicleClient vehicleId="veh-1" />);

    await screen.findByText("Open issues");
    const identity = (document.querySelector("[data-vehicle-identity]") as HTMLElement).textContent ?? "";
    for (const fact of ["2015", "Toyota", "Camry", "SE", "2.5L I4", "138,000 km"]) expect(identity).toContain(fact);

    expect((document.querySelector("[data-open-count]") as HTMLElement).textContent).toBe("1");
    expect(within(document.querySelector("[data-open-issues]") as HTMLElement).getByRole("link").getAttribute("href")).toBe("/garage/veh-1/diagnosis/dx-1");
    expect(document.querySelectorAll("[data-timeline-kind]")).toHaveLength(4);

    const readings = Array.from(document.querySelectorAll("[data-maintenance-record] [data-odometer]")).map((el) => el.textContent);
    expect(readings).toEqual(["130,250 km", "about 90k"]);
    // A cost that already names its currency is not given a "$".
    expect(document.body.textContent).toContain("CAD 45");
    expect(document.body.textContent).not.toContain("$CAD");
    expect(document.body.textContent).not.toMatch(/km miles/);

    expect((document.querySelector("[data-action-diagnose]") as HTMLAnchorElement).getAttribute("href")).toBe("/?vehicle=veh-1");
    expect(screen.getByRole("button", { name: "Add maintenance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update mileage" })).toBeTruthy();

    // Nothing invented: no score, no percentage, no predicted life.
    expect(document.body.textContent).not.toMatch(/health score|% healthy|remaining life|condition:/i);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/garage/veh-1"]);
  });

  it("adds a service record with the unit chosen, then reloads the vehicle", async () => {
    const calls = stubFetch((call) => (call.method === "POST" ? json({ record: { ...maintenance[0], id: "m-new" } }) : json(detail)));
    render(<VehicleClient vehicleId="veh-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add maintenance" }));

    const form = document.querySelector("[data-maintenance-form]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("Mileage"), { target: { value: "139500" } });
    fireEvent.change(within(form).getByLabelText("Unit"), { target: { value: "mi" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save record" }));

    await waitFor(() => expect(calls.filter((c) => c.method === "GET")).toHaveLength(2));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/maintenance");
    expect(post?.body).toMatchObject({ vehicleId: "veh-1", serviceType: "Oil Change", odometer: "139500", odometerUnit: "mi" });
  });

  it("says a removed vehicle will be archived, not deleted, before removing it", async () => {
    const calls = stubFetch((call) => (call.method === "DELETE" ? json({ ok: true, archived: true }) : json(detail)));
    render(<VehicleClient vehicleId="veh-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove this vehicle from my garage" }));

    expect(calls.some((c) => c.method === "DELETE")).toBe(false); // nothing happens on the first click
    expect(screen.getByText(/will be archived, not deleted/)).toBeTruthy();
    // A vehicle still in the garage offers no permanent deletion.
    expect(screen.queryByRole("button", { name: "Delete permanently…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Archive vehicle" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
  });

  it("shows an archived vehicle's history, offers to restore it, and hides the actions", async () => {
    const calls = stubFetch((call) => (call.method === "PATCH" ? json({ vehicle }) : json({ ...detail, vehicle: { ...vehicle, archivedAt: "2026-10-12T00:00:00.000Z" } })));
    render(<VehicleClient vehicleId="veh-1" />);

    await screen.findByText(/This vehicle is archived/);
    expect(document.querySelectorAll("[data-timeline-kind]")).toHaveLength(4);
    expect(document.querySelector("[data-action-diagnose]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add maintenance" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Restore to my garage" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ archived: false }));
    await waitFor(() => expect(document.querySelector("[data-archived-banner]")).toBeNull());
  });

  it("deletes an archived vehicle permanently only after the warning and the typed confirmation", async () => {
    const calls = stubFetch((call) =>
      call.url.endsWith("/permanent-delete") ? json({ ok: true, deleted: { maintenance: 1, diagnoses: 2, repairs: 1 } }) : json({ ...detail, vehicle: { ...vehicle, archivedAt: "2026-10-12T00:00:00.000Z" } }),
    );
    render(<VehicleClient vehicleId="veh-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete permanently…" }));

    // The warning names everything that goes with it.
    const panel = document.querySelector("[data-permanent-delete]") as HTMLElement;
    expect(panel.textContent).toContain("Delete 2015 Toyota Camry permanently?");
    expect(panel.textContent).toContain("its service records, its diagnoses and the repairs you reported (1 service record, 2 diagnoses and 1 reported repair)");
    expect(panel.textContent).toContain("They cannot be restored afterwards.");

    // The button does nothing until DELETE is typed.
    const confirm = within(panel).getByRole("button", { name: "Delete permanently" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    fireEvent.change(within(panel).getByLabelText("Type DELETE to confirm"), { target: { value: "delete" } });
    expect(confirm.disabled).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/permanent-delete"))).toBe(false);

    fireEvent.change(within(panel).getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
    const sent = calls.filter((c) => c.url.endsWith("/permanent-delete"));
    expect(sent).toEqual([{ url: "/api/garage/veh-1/permanent-delete", method: "POST", body: { confirm: "DELETE" } }]);
  });

  it("keeps the vehicle and says nothing was deleted when the server refuses", async () => {
    stubFetch((call) =>
      call.url.endsWith("/permanent-delete") ? json({ error: "Archive the vehicle first. Only an archived vehicle can be deleted for good.", code: "not_archived" }, 409) : json({ ...detail, vehicle: { ...vehicle, archivedAt: "2026-10-12T00:00:00.000Z" } }),
    );
    render(<VehicleClient vehicleId="veh-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete permanently…" }));
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Archive the vehicle first");
    expect(push).not.toHaveBeenCalled();
  });

  it("says so when the vehicle is not in this garage", async () => {
    stubFetch(() => json({ error: "Vehicle not found." }, 404));
    render(<VehicleClient vehicleId="someone-elses" />);
    await screen.findByText("This vehicle could not be found in your garage.");
  });
});

describe("the dashboard", () => {
  const bare: VehicleDto = { id: "veh-2", year: "2020", make: "Honda", model: "Civic", odometerValue: null, odometerUnit: null, odometerUpdatedAt: null, archivedAt: null, stats: { openIssues: 0, diagnoses: 0, lastDiagnosisAt: null, maintenanceRecords: 0, lastMaintenance: null, repairs: 0 } };
  const archivedTruck: VehicleDto = { ...bare, id: "veh-3", make: "Ford", model: "F-150", archivedAt: "2026-09-01T00:00:00.000Z" };
  const record: MaintenanceDto = { id: "m-1", vehicleId: "veh-1", serviceType: "Oil Change", date: "2026-06-15", serviceDate: "2026-06-15", odometer: "130,250 km", odometerValue: 130250, odometerUnit: "km", cost: "60", createdAt: "2026-06-15T12:00:00.000Z" };

  function dashboard() {
    return stubFetch((call) => {
      if (call.url.includes("/api/garage?archived=1")) return json({ vehicles: [archivedTruck] });
      if (call.method === "DELETE") return json({ ok: true, archived: true });
      if (call.url.endsWith("/permanent-delete")) return json({ ok: true, deleted: { maintenance: 0, diagnoses: 0, repairs: 0 } });
      if (call.url.includes("/api/garage")) return json({ vehicles: [vehicle, bare] });
      if (call.url.includes("/api/maintenance")) return json({ records: [record] });
      return json({});
    });
  }

  it("shows real facts on each vehicle card, and says 'none yet' instead of making something up", async () => {
    dashboard();
    render(<DashboardClient />);

    await waitFor(() => expect(document.querySelectorAll("[data-vehicle-card]")).toHaveLength(2));
    const [first, second] = Array.from(document.querySelectorAll("[data-vehicle-card]")) as HTMLElement[];

    const facts = (first.querySelector("[data-vehicle-card-facts]") as HTMLElement).textContent ?? "";
    expect(facts).toContain("138,000 km");
    expect(facts).toContain("Oct 10, 2026");
    expect(facts).toContain("Oil Change · Jun 15, 2026");
    expect((first.querySelector("[data-open-issues]") as HTMLElement).textContent).toBe("1");
    expect((first.querySelector("[data-open-vehicle]") as HTMLAnchorElement).getAttribute("href")).toBe("/garage/veh-1");

    const empty = (second.querySelector("[data-vehicle-card-facts]") as HTMLElement).textContent ?? "";
    expect(empty).toContain("Not set");
    expect(empty.match(/None yet/g)).toHaveLength(2);
    expect((second.querySelector("[data-open-issues]") as HTMLElement).textContent).toBe("0");

    expect(document.body.textContent).not.toMatch(/health score|%|remaining life|due soon|overdue/i);
  });

  it("shows a service record's mileage with its own unit", async () => {
    dashboard();
    render(<DashboardClient />);
    await waitFor(() => expect(document.querySelector("[data-maintenance-record]")).not.toBeNull());
    expect((document.querySelector("[data-maintenance-record] [data-odometer]") as HTMLElement).textContent).toBe("130,250 km");
    expect(document.body.textContent).not.toMatch(/km miles/);
  });

  it("archives a removed vehicle, says so, and lists archived vehicles with a way back", async () => {
    const calls = dashboard();
    render(<DashboardClient />);
    await waitFor(() => expect(document.querySelectorAll("[data-vehicle-card]")).toHaveLength(2));

    const archivedList = await waitFor(() => {
      const el = document.querySelector("[data-archived-list]") as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(archivedList.textContent).toContain("2020 Ford F-150");
    expect(within(archivedList).getByRole("button", { name: "Restore" })).toBeTruthy();

    fireEvent.click(within(document.querySelector("[data-vehicle-card]") as HTMLElement).getByRole("button", { name: "Delete" }));
    // The dialog says what will really happen.
    expect(screen.getByText(/will be archived, not deleted/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/garage/veh-1")).toBe(true));
    await waitFor(() => expect((document.querySelector("[data-garage-notice]") as HTMLElement | null)?.textContent).toBe("Vehicle archived. Nothing was deleted."));
    // Archiving never asks the server to delete anything for good.
    expect(calls.some((c) => c.url.endsWith("/permanent-delete"))).toBe(false);
  });

  it("offers permanent deletion only for an archived vehicle, behind the typed confirmation", async () => {
    const calls = dashboard();
    render(<DashboardClient />);
    const row = await waitFor(() => {
      const el = document.querySelector("[data-archived-vehicle]") as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // The garage's own cards have no permanent deletion.
    for (const card of Array.from(document.querySelectorAll("[data-vehicle-card]"))) {
      expect(within(card as HTMLElement).queryByRole("button", { name: "Delete permanently…" })).toBeNull();
    }

    fireEvent.click(within(row).getByRole("button", { name: "Delete permanently…" }));
    const panel = row.querySelector("[data-permanent-delete]") as HTMLElement;
    expect(panel.textContent).toContain("Delete 2020 Ford F-150 permanently?");
    fireEvent.click(within(panel).getByRole("button", { name: "Delete permanently" }));
    expect(calls.some((c) => c.url.endsWith("/permanent-delete"))).toBe(false);

    fireEvent.change(within(panel).getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(document.querySelector("[data-archived-list]")).toBeNull());
    expect(calls.filter((c) => c.url.endsWith("/permanent-delete"))).toEqual([{ url: "/api/garage/veh-3/permanent-delete", method: "POST", body: { confirm: "DELETE" } }]);
    expect((document.querySelector("[data-garage-notice]") as HTMLElement).textContent).toBe("Vehicle deleted permanently, with its service records, diagnoses and reported repairs.");
  });
});
