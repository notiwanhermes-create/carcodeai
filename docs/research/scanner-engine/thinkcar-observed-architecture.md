# Scanner engine research: THINKCAR / ThinkDiag "observed" architecture

Status: **research note, documentation only.** No code, no device, no app and
no vendor artifact was examined to write it. `AGENTS.md` remains binding and
wins on any conflict.

Part of the scanner-engine research set:
[thinkcar-observed-architecture](thinkcar-observed-architecture.md) ·
[vci-transport](vci-transport.md) · [protocol-stack](protocol-stack.md) ·
[module-discovery](module-discovery.md) · [live-data](live-data.md) ·
[scan-flow](scan-flow.md) ·
[carcode-scanner-architecture](carcode-scanner-architecture.md) ·
[capability-gap-analysis](capability-gap-analysis.md)

## Provenance labels

Every substantive claim in this research set carries one label:

| Label | Meaning |
| --- | --- |
| **OBSERVED** | Seen directly in this repository (file and line given) or in an artifact examined for this research. |
| **STANDARD-DOCUMENTED** | Stated in a public standard or public primary vendor document that is cited. Where the document is paywalled or was not re-read for this note, that is said. |
| **INFERRED** | Reasoned from the above. Not verified. May be wrong. |
| **UNKNOWN** | Not known. Must not be assumed in design or code. |
| **PROPRIETARY-NOT-REIMPLEMENTED** | A vendor's proprietary behaviour or data. CarCode does not copy, reverse-engineer or reimplement it. |

A proposed design is never a fact. Proposals are marked "Proposed" and are
labelled INFERRED where they rest on reasoning.

## Why this document is short

The task that produced this set asked for an "observed architecture" of the
THINKCAR / ThinkDiag tool. **Nothing was observed.**

- **OBSERVED**: this repository holds no THINKCAR or ThinkDiag artifact: no
  firmware, app package, SDK, protocol capture, documentation or licence. A
  repository search for `thinkcar` / `thinkdiag` (case-insensitive) outside
  `node_modules` finds only the documents in this folder.
- **OBSERVED**: no authorized artifact (a vendor-supplied SDK or specification
  under a licence that permits this use, or a capture taken by CarCode from a
  device it owns under terms that permit it) was provided for this task.
- **UNKNOWN**: everything about THINKCAR / ThinkDiag internals, including all
  items listed below.

## What remains UNKNOWN (and must not be assumed)

Each item is **UNKNOWN** pending an authorized artifact.

| Question | Status |
| --- | --- |
| Physical link between the dongle and the phone (BLE, Classic Bluetooth, both) | UNKNOWN |
| GATT services, characteristics, UUIDs, MTU use | UNKNOWN |
| Whether the dongle speaks an ELM327-compatible command set at all | UNKNOWN |
| Framing, encryption, authentication or pairing handshake between app and dongle | UNKNOWN |
| Which vehicle protocols the dongle's hardware supports | UNKNOWN |
| Where decoding happens (dongle firmware, phone app, vendor cloud) | UNKNOWN |
| How "full system" module lists are discovered per make | UNKNOWN |
| How live-data parameter definitions, scaling and names are sourced | UNKNOWN |
| How bidirectional (actuator) tests, service functions and coding are authorized and sent | UNKNOWN |
| Licensing / subscription enforcement and per-make software packages | UNKNOWN |
| Whether any of the above is documented publicly by the vendor | UNKNOWN (no vendor primary document was located or verified for this note) |

## What CarCode will not do

- **PROPRIETARY-NOT-REIMPLEMENTED**: CarCode does not decompile, disassemble,
  sniff, replay or emulate THINKCAR / ThinkDiag apps, firmware, cloud APIs or
  licensing. It does not copy their per-make module databases, parameter
  definitions, actuator commands, service procedures or coding data. This
  follows `AGENTS.md` ("Do not copy proprietary OEM diagnostic procedures or
  specifications") and applies equally to tool-vendor proprietary data.
- **PROPRIETARY-NOT-REIMPLEMENTED**: manufacturer-enhanced diagnostics (OEM
  DIDs, routines, security access, coding) are out of scope for the CarCode
  scanner whatever tool is used. See [protocol-stack](protocol-stack.md) for
  the fail-closed command policy that enforces it.

## How this may change

Proposed (INFERRED): this document is revisited only when a person supplies an
authorized artifact and records, in the change, what it is and the terms that
allow its use. Until then:

- the CarCode scanner design ([carcode-scanner-architecture](carcode-scanner-architecture.md))
  depends on **no** THINKCAR / ThinkDiag behaviour;
- a ThinkDiag dongle is not a supported or tested adapter, and nothing claims it
  works with CarCode;
- the comparison in [capability-gap-analysis](capability-gap-analysis.md)
  compares CarCode only against **publicly standardized** generic-OBD
  capability, not against THINKCAR internals.
