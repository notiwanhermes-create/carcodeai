/**
 * The scanner's VIN identification against the REAL `/api/vehicles/vin` route
 * handler: only the NHTSA call behind it (`fetchVinRow`) is scripted, so every
 * response shape the client reads is the one the route actually builds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchVinRow } = vi.hoisted(() => ({ fetchVinRow: vi.fn() }));
vi.mock("../app/lib/vin-lookup", () => ({ fetchVinRow }));

import { GET } from "../app/api/vehicles/vin/route";

/** A fresh client module, so its once-per-VIN answers start empty. */
async function client() {
  vi.resetModules();
  return import("../app/lib/scanner-vin");
}

const VALID = "1HGCM82633A004352"; // check digit matches
const NO_CHECK_DIGIT = "WBAYF8C50DD123456"; // check digit does not match
const ROW = { ModelYear: "2003", Make: "HONDA", Model: "Accord", Trim: "EX", DisplacementL: "2.4", EngineCylinders: "4", EngineConfiguration: "In-Line" };

beforeEach(() => {
  fetchVinRow.mockReset();
  // The browser's same-origin request, answered by the real route handler.
  vi.stubGlobal("fetch", vi.fn((url: string) => GET(new Request(new URL(url, "https://carcodeai.test")))));
});

afterEach(() => vi.unstubAllGlobals());

describe("identifying the vehicle from the VIN it reported", () => {
  it("a decoded VIN gives year, make, model, trim and the route's engine description", async () => {
    fetchVinRow.mockResolvedValue(ROW);
    const { identifyVehicle, identityName } = await client();
    const identity = await identifyVehicle(VALID);
    expect(identity).toEqual({ status: "identified", year: "2003", make: "Honda", model: "Accord", trim: "EX", engine: "2.4L I4", checkDigitWarning: false });
    expect(identityName(identity as Extract<typeof identity, { status: "identified" }>)).toBe("2003 Honda Accord EX");
    expect(fetch).toHaveBeenCalledWith(`/api/vehicles/vin?vin=${VALID}`, { cache: "no-store" });
  });

  it("a decoded VIN whose check digit does not match carries the warning, and no engine when NHTSA gave none", async () => {
    fetchVinRow.mockResolvedValue({ ModelYear: "2013", Make: "BMW", Model: "750Li" });
    const { identifyVehicle } = await client();
    expect(await identifyVehicle(NO_CHECK_DIGIT)).toEqual({ status: "identified", year: "2013", make: "BMW", model: "750Li", trim: "", engine: null, checkDigitWarning: true });
  });

  it("a partial decode (no model) is not recognised, never a guessed vehicle", async () => {
    fetchVinRow.mockResolvedValue({ ModelYear: "2003", Make: "HONDA", Model: "" });
    const { identifyVehicle } = await client();
    expect(await identifyVehicle(VALID)).toEqual({ status: "not_identified", reason: "not_recognized" });
  });

  it("an unreachable NHTSA is unavailable, and is asked again next time; an answer is kept", async () => {
    fetchVinRow.mockResolvedValueOnce(null).mockResolvedValue(ROW);
    const { identifyVehicle } = await client();
    expect(await identifyVehicle(VALID)).toEqual({ status: "not_identified", reason: "unavailable" });
    expect((await identifyVehicle(VALID)).status).toBe("identified");
    expect((await identifyVehicle(VALID)).status).toBe("identified");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a text the route rejects as a VIN is not recognised, and nothing reaches NHTSA", async () => {
    const { identifyVehicle } = await client();
    expect(await identifyVehicle("NOT-A-VIN")).toEqual({ status: "not_identified", reason: "not_recognized" });
    expect(fetchVinRow).not.toHaveBeenCalled();
  });

  it("a failing request or a server error is unavailable", async () => {
    const { identifyVehicle } = await client();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    expect(await identifyVehicle(VALID)).toEqual({ status: "not_identified", reason: "unavailable" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await identifyVehicle(VALID)).toEqual({ status: "not_identified", reason: "unavailable" });
  });
});
