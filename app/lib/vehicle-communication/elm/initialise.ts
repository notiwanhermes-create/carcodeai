/**
 * Adapter initialisation, steps 1-6 of protocol-stack.md ("Initialisation").
 *
 * RESEARCH PROTOTYPE. ATZ, then ATE0, ATL0, ATS1, ATH1, ATSP0, in order, each
 * through the command executor (so each passes the read-only policy). `OK` is
 * the only acceptable reply to steps 2-6; any other reply fails
 * initialisation with `adapter_rejected_command` and nothing further is sent.
 * A link-level problem (timeout, lost link, cancellation) fails it with that
 * outcome instead.
 *
 * Steps 7-9 (the first `0100` request, `ATDPN`, `ATI` / `AT@1`) belong to
 * discovery in the scanner layer, which needs the OBD layer to read them.
 */
import { ADAPTER_REPLY_OUTCOMES, type CommandOutcome } from "../types";
import type { AllowedAtCommand } from "./command-policy";
import type { CommandResult, ElmCommandExecutor } from "./executor";

export const INITIALISATION_SEQUENCE: readonly AllowedAtCommand[] = Object.freeze(["ATZ", "ATE0", "ATL0", "ATS1", "ATH1", "ATSP0"]);

export type InitialisationResult =
  | { ok: true; identity: string[]; steps: CommandResult[] }
  | { ok: false; failedAt: AllowedAtCommand; outcome: CommandOutcome; steps: CommandResult[] };

const REPLY_OUTCOMES: readonly CommandOutcome[] = ADAPTER_REPLY_OUTCOMES;

export async function initialiseAdapter(executor: ElmCommandExecutor, signal?: AbortSignal): Promise<InitialisationResult> {
  const steps: CommandResult[] = [];
  for (const command of INITIALISATION_SEQUENCE) {
    const result = await executor.run(command, { signal });
    steps.push(result);
    if (result.outcome !== "ok") {
      // A reply other than the expected one is a rejection; a power event stays what it is.
      const rejected = REPLY_OUTCOMES.includes(result.outcome) && result.outcome !== "adapter_power_event" && result.outcome !== "interrupted";
      return { ok: false, failedAt: command, outcome: rejected ? "adapter_rejected_command" : result.outcome, steps };
    }
  }
  return { ok: true, identity: steps[0].lines, steps };
}
