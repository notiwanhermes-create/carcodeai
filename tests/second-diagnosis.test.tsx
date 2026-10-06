// @vitest-environment jsdom
/**
 * Regression test for the "second diagnosis crashes the app" bug.
 *
 * Flow: diagnose -> "Search New Issue" -> diagnose again. The results panel
 * used to call hooks after an early return, so clearing the previous result
 * while the panel was mounted made React throw
 * "Rendered fewer hooks than expected" and blanked the whole page.
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

function diagnosisResponse(title: string, code: string) {
  return {
    causes: [
      { title, why: "Because.", severity: "medium", difficulty: "DIY Easy", confirm: ["Check it"], fix: ["Fix it"] },
      { title: `${title} (secondary)`, why: "Also possible.", severity: "low", difficulty: "DIY Moderate", confirm: [], fix: [] },
    ],
    summary_title: `${code}: Test definition`,
    dtcLookup: [{ code, title: "Test definition", found: true }],
  };
}

describe("diagnosis flow", () => {
  let diagnoseCalls = 0;

  beforeEach(() => {
    diagnoseCalls = 0;
    localStorage.clear();
    localStorage.setItem("carcode_onboarded_v1", "1");
    localStorage.setItem(
      "carcode_garage_v1:anon",
      JSON.stringify({
        garage: [{ id: "veh-1", year: "2015", make: "Toyota", model: "Camry", engine: "2.5L I4" }],
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
          diagnoseCalls += 1;
          const body = JSON.parse(String(init?.body ?? "{}")) as { code?: string };
          const code = (body.code || "P0000").toUpperCase();
          const title = code === "P0420" ? "Failing catalytic converter" : "Worn spark plugs";
          return new Response(JSON.stringify(diagnosisResponse(title, code)), {
            status: 200,
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

  async function submitCode(code: string) {
    const input = await screen.findByPlaceholderText("e.g. P0300, P0171, C0035");
    fireEvent.change(input, { target: { value: code } });
    const form = input.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
  }

  it("runs a second diagnosis in the same session without crashing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<Home />);

    // Home renders after mount; open the Diagnose tab.
    const diagnoseTab = await screen.findByRole("button", { name: "Diagnose" });
    fireEvent.click(diagnoseTab);

    // First diagnosis.
    await submitCode("P0300");
    expect(await screen.findByText("Worn spark plugs")).toBeTruthy();

    // Back to the search form, then diagnose again.
    fireEvent.click(screen.getByRole("button", { name: /Search New Issue/i }));
    await submitCode("P0420");

    expect(await screen.findByText("Failing catalytic converter")).toBeTruthy();
    await waitFor(() => expect(diagnoseCalls).toBe(2));

    const hookErrors = errorSpy.mock.calls.filter((args) =>
      args.some((a) => /Rendered (fewer|more) hooks/.test(String(a instanceof Error ? a.message : a))),
    );
    expect(hookErrors).toHaveLength(0);
  });

  it("shows the empty state (not a crash) when a diagnosis request fails after a previous success", async () => {
    render(<Home />);
    fireEvent.click(await screen.findByRole("button", { name: "Diagnose" }));

    await submitCode("P0300");
    expect(await screen.findByText("Worn spark plugs")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Search New Issue/i }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Too many requests. Please wait a moment." }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await submitCode("P0420");

    expect(await screen.findByText("Too many requests. Please wait a moment.")).toBeTruthy();
    expect(screen.getByText("Run a diagnostic to see causes here.")).toBeTruthy();
  });
});
