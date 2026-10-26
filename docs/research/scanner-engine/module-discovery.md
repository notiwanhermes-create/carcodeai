# Scanner engine research: module discovery

Status: **research note and proposed design, documentation only.** Labels are
defined in [thinkcar-observed-architecture](thinkcar-observed-architecture.md#provenance-labels).
`AGENTS.md` remains binding.

## Scope: what "discovery" can mean for CarCode

| Kind | What it finds | In CarCode | Label |
| --- | --- | --- | --- |
| Generic OBD discovery | ECUs that answer the functional emission-related OBD request, and which $01 PIDs each supports | **Yes** (preview) | STANDARD-DOCUMENTED (unverified copy), ISO 15765-4 / SAE J1979 |
| Full-system ("all modules") discovery | Body, chassis, network modules addressed individually with manufacturer-specific diagnostics | **No** | PROPRIETARY-NOT-REIMPLEMENTED |
| How THINKCAR / ThinkDiag discovers modules | | Not known, not copied | UNKNOWN; see [thinkcar-observed-architecture](thinkcar-observed-architecture.md) |

Consequence (INFERRED): a generic OBD scan sees only ECUs that implement
emission-related OBD. Body, chassis and most network modules, and many codes in
powertrain ECUs that are not emission-related, are **outside its coverage**.
This is the main reason a CarCode scan can never claim vehicle-wide absence of
a code (see [scan-flow](scan-flow.md#completeness-and-coverage)).

## Proposed discovery sequence

All steps use only allowlisted commands ([protocol-stack](protocol-stack.md#fail-closed-command-policy)).

1. **Adapter handshake** (`ATZ`, `ATE0`, `ATL0`, `ATS1`, `ATH1`, `ATSP0`).
   Any rejection stops discovery: `adapter_rejected_command`.
2. **Protocol search** with `0100`, then `ATDPN`. `UNABLE TO CONNECT`,
   `BUS INIT: ...ERROR` or a non-CAN protocol stops discovery with that
   reason. `NO DATA` here means "no ECU answered", which may mean ignition off;
   the person is told to check ignition, and nothing is concluded about the
   vehicle.
3. **Responding ECUs**: every distinct CAN identifier in the valid `0100`
   responses is one discovered ECU. Malformed responses are kept as
   `malformed` with their identifier but do not count as discovered support.
4. **Supported PIDs per ECU**: follow each ECU's bitmap chain (`0100` → `0120`
   → … while the "next range" bit is set). Each ECU's chain is independent; an
   ECU that stops answering mid-chain has `supportKnownUpTo` set to the last
   range it answered, and later ranges are `unknown`, not unsupported. These
   are **$01** (current data) bitmaps only; they say nothing about $02
   freeze-frame support, which has its own probe
   ([scan-flow](scan-flow.md#freeze-frame-probe-02)).
5. **Optional VIN** (`0902`): recorded per ECU as reported text. See
   [capability-gap-analysis](capability-gap-analysis.md#vehicle-identity) for
   why it never overwrites the garage vehicle.

## ECU identity

STANDARD-DOCUMENTED (unverified copy), ISO 15765-4: 11-bit responses come from
`7E8`–`7EF`, 29-bit responses from `18DAF1xx`. The identifier says **which
address answered**, not what the ECU is. Proposed (INFERRED):

- An ECU is identified in scanner output by its response identifier, e.g.
  `{ protocol: "6", responseId: "7E8" }`.
- The scanner does **not** label an ECU "engine" or "transmission" from its
  address. Common conventions (for example `7E8` often being the engine ECU)
  are not guaranteed and are not used (INFERRED).
- A human-readable name may only come from a source that states it (for
  example an ECU name from $09 infotype `0A`, which the preview defers).

## Mapping to Guided Diagnostics module ids

**OBSERVED** (`app/lib/diagnostic-workflow/types.ts:125-126`, `dtc.ts:32,65-75`):
`ModuleOrigin` is `{ id: string; name?: string }`, the id must match
`/^[a-z0-9][a-z0-9_.-]{0,63}$/` after normalisation (trimmed, lower case), the
name is short text, and no other fields are accepted. The type comment says
"Provenance only: no addressing, no topology."

Proposed (INFERRED): module id = `obd-` + protocol family + `-` + lower-case
response identifier, e.g. `obd-can11-7e8`, `obd-can29-18daf110`. It is stable
across scans of the same vehicle on the same protocol, which coverage
comparisons need, and it fits the id pattern.

**Mapping gap, needs a decision before S10** (INFERRED): an id derived from a CAN
address arguably carries addressing, which the `ModuleOrigin` comment excludes.
The id is used only as an opaque label (nothing parses it), so the proposal
treats it as provenance. If that reading is rejected, the alternative is an
opaque per-vehicle mapping table kept in the scanner, which adds state and is
not recommended. Recorded in
[capability-gap-analysis](capability-gap-analysis.md#guided-diagnostics-mapping-gaps).

**OBSERVED** (`app/lib/diagnostic-workflow/dtc.ts:218-246`): absence of a code
is provable only from a `complete` scan, and when the scan has `coverage`, only
for a matcher that names a covered module. A matcher without a module against a
scan with coverage gives "unknown". Because the scanner always states coverage
as the ECUs that answered (see [scan-flow](scan-flow.md#completeness-and-coverage)),
vehicle-wide absence is never concluded from a scanner read (INFERRED from the
code). **OBSERVED**: the reviewed misfire workflow uses no module in its code
matchers (`app/lib/diagnostic-workflow-content/workflows/generic-gasoline-misfire.ts`;
no `module:` field present), so scanner module ids cannot match workflow
module names today, and none need to.

## Discovery output (Proposed)

```ts
type DiscoveredEcu = {
  responseId: string;               // e.g. "7E8"
  supportedPids: { known: number[]; supportKnownUpTo: number | null };
  vin?: { text: string; status: "reported" | "malformed" };
  problems: StepProblem[];          // malformed, negative_response, no_response, ...
};

type DiscoveryResult =
  | { status: "ok"; protocol: { number: string; auto: boolean }; adapter: AdapterIdentity; ecus: DiscoveredEcu[] }
  | { status: "failed"; reason: DiscoveryFailure; adapter?: AdapterIdentity; log: StepRecord[] };
```

`AdapterIdentity` holds the `ATI` / `AT@1` strings as **reported**. Every
command and its classified outcome is a `StepRecord` (see
[scan-flow](scan-flow.md#partial-scan-provenance)).
