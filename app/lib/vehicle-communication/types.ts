/**
 * Vehicle communication: shared outcome and lifecycle types.
 *
 * RESEARCH PROTOTYPE (scanner foundation). Used only by the gated `/scanner`
 * preview. Client-only, read-only: no database, no network, no Guided Diagnostics
 * imports. Design: docs/research/scanner-engine/ (protocol-stack.md,
 * scan-flow.md, vci-transport.md, carcode-scanner-architecture.md).
 *
 * Every outcome is a distinct, typed value. Only `ok` ever carries data; every
 * other outcome is a reason no data was produced.
 */

/** Refused before a single byte was written to the adapter. */
export const REFUSED_OUTCOMES = [
  "command_not_allowed", // not on the read-only allowlist, or malformed
  "busy", // another command is in flight; never queued
  "adapter_not_initialised", // OBD request before echo off and headers on were confirmed
  "adapter_needs_reset", // after a framing error only ATZ / ATWS are accepted
  "session_unavailable", // the session is closed or failed
] as const;

/** An adapter reply token (protocol-stack.md, "Adapter error tokens"). */
export const ADAPTER_REPLY_OUTCOMES = [
  "adapter_rejected_command", // "?"
  "no_response", // "NO DATA": not "no codes", not "unsupported"
  "no_vehicle_protocol", // "UNABLE TO CONNECT"
  "bus_init_failed", // "BUS INIT: ...ERROR"
  "bus_error", // "CAN ERROR", "BUS ERROR", "BUS BUSY", "FB ERROR"
  "data_error", // "DATA ERROR", "<DATA ERROR", "<RX ERROR"
  "adapter_overflow", // "BUFFER FULL"
  "interrupted", // "STOPPED", or the command was cancelled
  "adapter_internal_error", // "ERR" + digits
  "adapter_power_event", // "LV RESET", "ACT ALERT", or the adapter reset itself
  "unexpected_reply", // anything the command may not return
] as const;

/** Raised by the command executor itself. */
export const EXECUTOR_OUTCOMES = [
  "framing_error", // more than the byte cap without a prompt
  "timeout", // no prompt within the command's bound
  "adapter_unresponsive", // no prompt after an interrupt; the session is over
  "resync_impossible", // after an interrupt, no probe's answer can be told apart from the interrupted command's late answer; the session is over
  "transport_lost", // the link closed or a write failed; the session is over
] as const;

export type RefusedOutcome = (typeof REFUSED_OUTCOMES)[number];
export type AdapterReplyOutcome = (typeof ADAPTER_REPLY_OUTCOMES)[number];
export type ExecutorOutcome = (typeof EXECUTOR_OUTCOMES)[number];
export type CommandOutcome = "ok" | RefusedOutcome | AdapterReplyOutcome | ExecutorOutcome;

/** Why a command session can no longer be used. */
export type SessionFailure = "transport_lost" | "adapter_unresponsive" | "resync_impossible" | "adapter_power_event";

/**
 * Scanner lifecycle (scan-flow.md, "Lifecycle"). `failed` is reachable from
 * every non-terminal state; `closed` is terminal. `ready → initialising` is a
 * person-started recovery (re-initialise and rediscover on the same link);
 * `polling` is user-started live data (live-data.md, "Live polling").
 */
export type ScannerLifecycleState =
  | "idle"
  | "connecting"
  | "initialising"
  | "discovering"
  | "ready"
  | "scanning"
  | "polling"
  | "closing"
  | "closed"
  | "failed";

/** How a scan ended (scan-flow.md, ScannerReport.ended). */
export type ScanEndReason = "finished" | "cancelled" | "transport_lost" | "adapter_unresponsive" | "failed";

export const LIFECYCLE_TRANSITIONS: Readonly<Record<ScannerLifecycleState, readonly ScannerLifecycleState[]>> = {
  idle: ["connecting", "closing", "failed"],
  connecting: ["initialising", "closing", "failed"],
  initialising: ["discovering", "closing", "failed"],
  discovering: ["ready", "closing", "failed"],
  ready: ["scanning", "polling", "initialising", "closing", "failed"],
  scanning: ["ready", "closing", "failed"],
  polling: ["ready", "closing", "failed"],
  closing: ["closed", "failed"],
  failed: ["closed"],
  closed: [],
};

/** Whether the lifecycle allows `from` → `to`. Anything not listed is refused. */
export function canTransition(from: ScannerLifecycleState, to: ScannerLifecycleState): boolean {
  const allowed = Object.prototype.hasOwnProperty.call(LIFECYCLE_TRANSITIONS, from) ? LIFECYCLE_TRANSITIONS[from] : [];
  return allowed.includes(to);
}
