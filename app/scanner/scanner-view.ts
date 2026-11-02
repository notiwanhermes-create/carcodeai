/**
 * What the `/scanner` page shows for a session snapshot: which screen, which
 * steps, which connector pins, and each notice in plain words.
 *
 * Presentation only. Nothing here talks to the adapter, changes a result or
 * judges a vehicle. Steps follow the order the scanner really reads in, and a
 * step is done only when the scanner has moved past it.
 */
import type { Phase } from "@/app/lib/vehicle-communication/scanner/report";
import type { LinkInfo, Notice, ScannerSnapshot } from "./scanner-session";

export type Stage = "disconnected" | "choosing" | "connecting" | "connected" | "no_vehicle" | "scanning" | "closing" | "failed";

export function stageOf(view: ScannerSnapshot): Stage {
  if (view.link === "choosing") return "choosing";
  if (view.link === "closing") return "closing";
  if (view.link === "connecting" || view.activity === "discovery") return "connecting";
  if (view.link === "open") {
    if (view.activity === "scan") return "scanning";
    return view.vehicleFound ? "connected" : "no_vehicle";
  }
  // A notice with no title is a form message (a bad UUID, a bad baud rate): nothing was attempted, so nothing failed.
  return view.notice?.tone === "error" && describeNotice(view.notice).title ? "failed" : "disconnected";
}

export type StepState = "done" | "active" | "waiting";
export type Step = { id: string; label: string; state: StepState };

const CONNECTION_STEP: Partial<Record<Phase, number>> = { open: 1, initialise: 2, identify: 2, protocol: 3, current_data_support: 4, vin: 5 };
const SCAN_STEP: Partial<Record<Phase, number>> = { readiness: 0, dtcs: 1, freeze_frame: 2, current_data: 3 };

function steps(labels: readonly (readonly [string, string])[], reached: number): Step[] {
  return labels.map(([id, label], index) => ({ id, label, state: index < reached ? "done" : index === reached ? "active" : "waiting" }));
}

/** `kind`: the connection being made, known from the click before the session reports it. */
export function connectionSteps(view: ScannerSnapshot, kind: LinkInfo["kind"] | null): Step[] {
  const reached = view.link === "choosing" ? 0 : ((view.phase && CONNECTION_STEP[view.phase]) ?? 1);
  return steps(
    [
      ["selected", "Scanner selected"],
      ["link", kind === "web_serial" ? "COM port opened" : "Bluetooth connected"],
      ["adapter", "Adapter responding"],
      ["vehicle", "Detecting vehicle"],
      ["modules", "Checking modules"],
      ["vin", "Reading VIN"],
    ],
    reached,
  );
}

export function scanSteps(view: ScannerSnapshot): Step[] {
  return steps(
    [
      ["readiness", "Readiness"],
      ["dtcs", "Fault codes"],
      ["freeze_frame", "Freeze frame"],
      ["current_data", "Live data"],
    ],
    (view.phase && SCAN_STEP[view.phase]) ?? 0,
  );
}

/** Which connector pins the illustration lights: power and ground once the adapter answers, the CAN pins once the car does. */
export type Pins = { power: boolean; bus: "off" | "searching" | "on" | "silent" };

export function pinsFor(stage: Stage, view: ScannerSnapshot): Pins {
  if (stage === "connected" || stage === "scanning") return { power: true, bus: "on" };
  if (stage === "no_vehicle") return { power: true, bus: "silent" };
  if (stage !== "connecting") return { power: false, bus: "off" };
  const reached = (view.phase && CONNECTION_STEP[view.phase]) ?? 1;
  return { power: reached >= 2, bus: reached >= 4 ? "on" : reached === 3 ? "searching" : "off" };
}

/** `noRetry`: connecting to the same device again cannot help. */
export type NoticeMessage = { title: string | null; body: string; technical: string | null; noRetry?: true };

const KEPT = "Everything already read is kept.";

/** First match wins. Each `match` is wording this app's own session and transports produce. */
const MESSAGES: readonly { match: RegExp; title: string | null; body: string; noRetry?: true }[] = [
  {
    match: /none of the profile services|more than one profile|characteristic|exposes no GATT|instances of service/,
    title: "Adapter not recognized",
    body: "CarCode connected to the Bluetooth device, but it doesn't use a scanner profile we currently recognize.",
    noRetry: true,
  },
  {
    match: /port could not be opened|port is already open|already in use|the port did not open/,
    title: "Couldn't open the connection",
    body: "Close any other app using the adapter and make sure it's plugged in and nearby, then try again. If Windows shows two COM ports for it, try the other one.",
  },
  {
    match: /the link did not open/,
    title: "Couldn't connect to the scanner",
    body: "Make sure it's plugged in, powered by the car and not connected to another device, then try again.",
  },
  {
    match: /no device was chosen/,
    title: null,
    body: "No adapter selected. Don't see yours? Turn on Show all Bluetooth devices in Advanced connection options.",
  },
  { match: /no port was chosen/, title: null, body: "No COM port selected. If yours isn't listed, pair the adapter in Windows Bluetooth settings first." },
  {
    match: /refused the chooser/,
    title: "The browser blocked the adapter list",
    body: "Click the connect button again. If this keeps happening, check that Bluetooth and serial access are allowed for this site.",
  },
  { match: /chooser failed|chooser returned|rejected the chooser/, title: "The adapter list didn't open", body: "Try again. If it still doesn't open, reload this page." },
  { match: /stopped responding/, title: "Scanner stopped responding", body: "Unplug the scanner, plug it back in, then reconnect." },
  { match: /link to the adapter (was lost|ended)/, title: "Scanner disconnected", body: "The connection to the scanner dropped." },
  { match: /is not CAN/, title: "This vehicle isn't supported yet", body: "CarCode Scanner reads CAN vehicles for now, and this vehicle uses a different protocol." },
  { match: /answered .*; no OBD request was sent|initialisation failed/, title: "Adapter didn't respond as expected", body: "The device connected but didn't respond like an OBD-II scanner. Unplug it, plug it back in, and try again." },
  { match: /No vehicle was read/, title: "Vehicle couldn't be read", body: "Scanner connected, but CarCode couldn't confirm a vehicle. Make sure the ignition is on and try again." },
];

/**
 * The plain message for a notice. The original wording stays available as
 * technical detail. `hasResults`: whether anything has been read, so a first
 * attempt that failed is not told its results are safe.
 */
export function describeNotice(notice: Notice, hasResults = true): NoticeMessage {
  const found = MESSAGES.find((message) => message.match.test(notice.text));
  if (!found) return { title: null, body: hasResults ? notice.text : notice.text.replace(` ${KEPT}`, ""), technical: null };
  const kept = hasResults && notice.text.includes(KEPT) ? ` ${KEPT}` : "";
  return { title: found.title, body: `${found.body}${kept}`, technical: notice.text, ...(found.noRetry ? { noRetry: true } : {}) };
}
