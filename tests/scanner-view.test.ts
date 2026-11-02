/**
 * What `/scanner` shows for a session snapshot. Each message is matched against
 * the wording the app's own session and transports really produce, so changing
 * that wording without updating the page fails here rather than quietly showing
 * the raw text to a person.
 */
import { describe, expect, it } from "vitest";
import type { Phase } from "../app/lib/vehicle-communication/scanner/report";
import type { Notice, ScannerSnapshot } from "../app/scanner/scanner-session";
import { connectionSteps, describeNotice, pinsFor, scanSteps, stageOf } from "../app/scanner/scanner-view";

const base = {
  offers: { bluetooth: { status: "available" }, serial: { status: "available" } },
  link: "none",
  transport: null,
  linkInfo: null,
  canReconnect: false,
  lifecycle: null,
  activity: null,
  phase: null,
  stopping: false,
  needsRecovery: false,
  vehicleFound: false,
  notice: null,
  connection: 0,
  discovery: null,
  scan: null,
  live: null,
  log: [],
  logTotal: 0,
} as unknown as ScannerSnapshot;

const view = (patch: Partial<ScannerSnapshot>): ScannerSnapshot => ({ ...base, ...patch });
const error = (text: string): Notice => ({ tone: "error", text });
const states = (steps: readonly { state: string }[]) => steps.map((step) => step.state).join(" ");

describe("which screen", () => {
  it("names every state", () => {
    expect(stageOf(view({}))).toBe("disconnected");
    expect(stageOf(view({ link: "choosing" }))).toBe("choosing");
    expect(stageOf(view({ link: "connecting" }))).toBe("connecting");
    expect(stageOf(view({ link: "open", activity: "discovery" }))).toBe("connecting");
    expect(stageOf(view({ link: "open", vehicleFound: true }))).toBe("connected");
    expect(stageOf(view({ link: "open", vehicleFound: true, activity: "live" }))).toBe("connected");
    expect(stageOf(view({ link: "open", vehicleFound: true, activity: "scan" }))).toBe("scanning");
    expect(stageOf(view({ link: "open", vehicleFound: false }))).toBe("no_vehicle");
    expect(stageOf(view({ link: "closing" }))).toBe("closing");
    expect(stageOf(view({ link: "ended", notice: error("The link to the adapter ended. Everything already read is kept.") }))).toBe("failed");
  });

  it("a form message or a dismissed chooser is not a failed connection", () => {
    expect(stageOf(view({ notice: error("The service UUID is not valid: use 4 or 8 hex digits.") }))).toBe("disconnected");
    expect(stageOf(view({ notice: { tone: "info", text: "Bluetooth: no device was chosen (the chooser was dismissed or listed no matching device)." } }))).toBe("disconnected");
  });
});

describe("steps", () => {
  it("a step is done only once the scanner has moved past it", () => {
    const at = (phase: Phase | null, link: ScannerSnapshot["link"] = "connecting") => states(connectionSteps(view({ link, phase }), "web_bluetooth"));
    expect(at(null, "choosing")).toBe("active waiting waiting waiting waiting waiting");
    expect(at(null)).toBe("done active waiting waiting waiting waiting");
    expect(at("open")).toBe("done active waiting waiting waiting waiting");
    expect(at("initialise")).toBe("done done active waiting waiting waiting");
    expect(at("identify")).toBe("done done active waiting waiting waiting");
    expect(at("protocol")).toBe("done done done active waiting waiting");
    expect(at("current_data_support")).toBe("done done done done active waiting");
    expect(at("vin")).toBe("done done done done done active");
  });

  it("names the connection being made", () => {
    expect(connectionSteps(view({ link: "choosing" }), "web_bluetooth")[1].label).toBe("Bluetooth connected");
    expect(connectionSteps(view({ link: "choosing" }), "web_serial")[1].label).toBe("COM port opened");
  });

  it("follows the scan", () => {
    expect(states(scanSteps(view({ phase: "readiness" })))).toBe("active waiting waiting waiting");
    expect(states(scanSteps(view({ phase: "dtcs" })))).toBe("done active waiting waiting");
    expect(states(scanSteps(view({ phase: "current_data" })))).toBe("done done done active");
  });
});

describe("connector pins", () => {
  it("light with what has really answered", () => {
    expect(pinsFor("disconnected", view({}))).toEqual({ power: false, bus: "off" });
    expect(pinsFor("connecting", view({ link: "connecting", phase: "open" }))).toEqual({ power: false, bus: "off" });
    expect(pinsFor("connecting", view({ link: "connecting", phase: "identify" }))).toEqual({ power: true, bus: "off" });
    expect(pinsFor("connecting", view({ link: "connecting", phase: "protocol" }))).toEqual({ power: true, bus: "searching" });
    expect(pinsFor("connecting", view({ link: "connecting", phase: "vin" }))).toEqual({ power: true, bus: "on" });
    expect(pinsFor("connected", view({}))).toEqual({ power: true, bus: "on" });
    expect(pinsFor("no_vehicle", view({}))).toEqual({ power: true, bus: "silent" });
    expect(pinsFor("failed", view({}))).toEqual({ power: false, bus: "off" });
  });
});

describe("messages", () => {
  it.each([
    ["The link to the adapter was lost during connecting (the link did not open: none of the profile services was found (0000fff0)). Everything already read is kept.", "Adapter not recognized", "doesn't use a scanner profile we currently recognize"],
    ["Connecting did not finish (the link did not open: characteristic x is not writable).", "Adapter not recognized", "doesn't use a scanner profile"],
    ["The link to the adapter was lost during connecting (the link did not open: the port could not be opened (NetworkError): another application may hold it).", "Couldn't open the connection", "Close any other app"],
    ["The link to the adapter was lost during connecting (the link did not open: the port is already open (another tab or window may be using it)).", "Couldn't open the connection", "Close any other app"],
    ["The link to the adapter was lost during connecting (the link did not open: GATT connect failed (NetworkError)).", "Couldn't connect to the scanner", "plugged in"],
    ["Bluetooth: the browser refused the chooser (SecurityError): it needs a user gesture and may be blocked by policy.", "The browser blocked the adapter list", "Click the connect button again"],
    ["Serial: the chooser failed (AbortError).", "The adapter list didn't open", "Try again"],
    ["The adapter stopped responding during the scan (no prompt). Everything already read is kept.", "Scanner stopped responding", "plug it back in"],
    ["The link to the adapter was lost during the scan (read failed). Everything already read is kept.", "Scanner disconnected", "Everything already read is kept."],
    ["The link to the adapter ended. Everything already read is kept.", "Scanner disconnected", "Everything already read is kept."],
    ["No vehicle was read: protocol 3 is not CAN; the preview reads CAN only, no further OBD request.", "This vehicle isn't supported yet", "reads CAN vehicles"],
    ["No vehicle was read: ATH1 answered adapter_rejected_command; no OBD request was sent.", "Adapter didn't respond as expected", "like an OBD-II scanner"],
    ["No vehicle was read: no ECU gave a valid 0100 answer.", "Vehicle couldn't be read", "ignition"],
  ])("%s", (text, title, body) => {
    const message = describeNotice(error(text));
    expect(message.title).toBe(title);
    expect(message.body).toContain(body);
    expect(message.technical).toBe(text);
    expect(message.body).not.toMatch(/GATT|no_vehicle|NetworkError|chooser|0100/);
  });

  it("a dismissed chooser explains what to try next, without alarm", () => {
    expect(describeNotice({ tone: "info", text: "Bluetooth: no device was chosen (the chooser was dismissed or listed no matching device)." })).toMatchObject({ title: null, body: expect.stringContaining("Show all Bluetooth devices") });
    expect(describeNotice({ tone: "info", text: "Serial: no port was chosen (the chooser was dismissed or listed no port)." }).body).toContain("Windows Bluetooth settings");
  });

  it("the vehicle-not-responding sentence is the person's wording, unchanged", () => {
    const text = "Scanner connected, but the vehicle did not respond. Make sure the ignition is on and try again.";
    expect(describeNotice(error(text))).toEqual({ title: null, body: text, technical: null });
  });

  it("says results are safe only when something was read", () => {
    const lost = "The link to the adapter was lost during connecting (read failed). Everything already read is kept.";
    expect(describeNotice(error(lost), true).body).toContain("Everything already read is kept.");
    expect(describeNotice(error(lost), false).body).not.toContain("already read");
    expect(describeNotice({ tone: "info", text: "Connecting was cancelled. Everything already read is kept." }, false).body).toBe("Connecting was cancelled.");
  });

  it("anything unknown is shown as it is, never hidden", () => {
    expect(describeNotice(error("Refused: a scan is running."))).toEqual({ title: null, body: "Refused: a scan is running.", technical: null });
  });
});
