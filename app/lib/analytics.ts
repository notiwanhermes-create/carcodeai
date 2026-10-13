/**
 * Product analytics for the garage flow.
 *
 * Privacy rule: an event carries only a fixed name and a few yes/no or
 * multiple-choice facts. It can never carry a VIN, symptoms, diagnosis text,
 * an email address, a vehicle's make or model, an id, or any other text a
 * person typed. `sanitizeEvent` enforces that: anything it does not explicitly
 * allow is dropped, so a careless call cannot leak content.
 */

export const ANALYTICS_EVENTS = [
  "vehicle_added",
  "vehicle_opened",
  "diagnosis_started",
  "diagnosis_completed",
  "diagnosis_reopened",
  "diagnosis_resolved",
  "confirmed_fix_added",
  "maintenance_added",
  "guest_data_imported",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

/** Where in the app something happened. */
const SOURCES = ["home", "dashboard", "vehicle_page", "diagnosis_page"] as const;
const OUTCOMES = ["fixed", "not_yet", "dismissed", "reopened"] as const;

/** Yes/no facts an event may carry. */
const FLAGS = ["signed_in", "has_code", "has_symptoms", "has_mileage", "is_update", "matched_prediction", "has_vehicle"] as const;
/** Counts an event may carry. They are sent as coarse ranges, never exact numbers. */
const COUNTS = ["vehicle_count", "imported_vehicles", "imported_records", "imported_diagnoses"] as const;

export type AnalyticsParams = Partial<
  Record<(typeof FLAGS)[number], boolean> &
    Record<(typeof COUNTS)[number], number> & { source: (typeof SOURCES)[number]; outcome: (typeof OUTCOMES)[number] }
>;

type SafeValue = boolean | string;

/** 0, 1, 2, 3, 4, then "5+". Enough to see patterns, not enough to identify anyone. */
export function countRange(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const whole = Math.floor(n);
  return whole >= 5 ? "5+" : String(whole);
}

/**
 * The event as it may be sent, or null if the name is not one of ours.
 * Unknown keys and values of the wrong kind are dropped, not passed through.
 */
export function sanitizeEvent(name: string, params: Record<string, unknown> = {}): { name: AnalyticsEvent; params: Record<string, SafeValue> } | null {
  if (!(ANALYTICS_EVENTS as readonly string[]).includes(name)) return null;
  const safe: Record<string, SafeValue> = {};
  for (const flag of FLAGS) {
    if (typeof params[flag] === "boolean") safe[flag] = params[flag] as boolean;
  }
  for (const count of COUNTS) {
    if (typeof params[count] === "number") safe[count] = countRange(params[count] as number);
  }
  if ((SOURCES as readonly unknown[]).includes(params.source)) safe.source = params.source as string;
  if ((OUTCOMES as readonly unknown[]).includes(params.outcome)) safe.outcome = params.outcome as string;
  return { name: name as AnalyticsEvent, params: safe };
}

type Gtag = (command: "event", name: string, params: Record<string, SafeValue>) => void;

/** Send one event to Google Analytics, if it is loaded. Never throws. */
export function track(name: AnalyticsEvent, params: AnalyticsParams = {}): void {
  try {
    const event = sanitizeEvent(name, params as Record<string, unknown>);
    if (!event || typeof window === "undefined") return;
    const gtag = (window as unknown as { gtag?: Gtag }).gtag;
    if (typeof gtag === "function") gtag("event", event.name, event.params);
  } catch {
    /* analytics must never break the page */
  }
}
