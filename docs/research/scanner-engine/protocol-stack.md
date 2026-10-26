# Scanner engine research: protocol stack

Status: **research note and proposed design, documentation only.** Labels are
defined in [thinkcar-observed-architecture](thinkcar-observed-architecture.md#provenance-labels).
`AGENTS.md` remains binding.

## Layers and boundaries (Proposed)

```
 browser APIs ─► transport ─► elm ─► obd ─► scanner ─► evidence mapper ─► GD input types
   (bytes)        (bytes)    (lines,   (services,   (discovery,  (one-way,        (DiagnosticScanInput,
                              prompt,   PIDs, DTCs,  scan flow,   pure)            SnapshotInput)
                              errors)   per ECU)     provenance)
```

| Layer | Owns | Must not | Label |
| --- | --- | --- | --- |
| transport | bytes in / out, connect, disconnect | parse text; know commands | Proposed, INFERRED |
| elm | command/response framing, prompt detection, echo and line handling, adapter error tokens, the command policy gate, cancellation | know OBD meaning of bytes | Proposed, INFERRED |
| obd | building allowed SAE J1979 requests; parsing responses **per ECU**; ISO-TP reassembly when headers are shown; DTC and PID decoding | send anything not built from the allowlist; know about Guided Diagnostics | Proposed, INFERRED |
| scanner | discovery, scan flow, lifecycle, per-step provenance, the ScannerReport | import Guided Diagnostics code | Proposed, INFERRED |
| evidence mapper | pure function ScannerReport → `DiagnosticScanInput` | talk to a vehicle; run the engine; strengthen evidence | Proposed, INFERRED |

Dependency direction is one way: each layer imports only the one below it, and
only the mapper imports Guided Diagnostics **types**. Guided Diagnostics never
imports the scanner (see [carcode-scanner-architecture](carcode-scanner-architecture.md#scanner-independence)).

## Primary references

| Reference | Access | Used for | Verified for this note |
| --- | --- | --- | --- |
| ELM Electronics, *ELM327 OBD to RS232 Interpreter* datasheet, document `ELM327DS`, last known at <https://www.elmelectronics.com/wp-content/uploads/2017/01/ELM327DS.pdf> | Public PDF | See the section map below | **URL confirmed 2026-10-26**: the PDF downloads from that address (about 436 KB, 40+ pages). Its text could not be extracted in that environment, so the **edition** (revision in the PDF footer) and the **section titles** below are still unconfirmed and must be recorded from the PDF itself |
| SAE J1979 / ISO 15031-5, OBD-II diagnostic test modes | Paywalled | Service ($01–$0A) semantics, response layouts | **Not verified** (no licensed copy available) |
| ISO 15765-4 (CAN for emissions OBD) and ISO 15765-2 (ISO-TP) | Paywalled | 11/29-bit OBD addressing, PCI frame types | **Not verified** (no licensed copy available) |
| SAE J2012 / ISO 15031-6, DTC format | Paywalled | Two-byte DTC encoding | **Not verified** (no licensed copy available) |
| Wikipedia, "OBD-II PIDs", <https://en.wikipedia.org/wiki/OBD-II_PIDs> | Public, secondary | Cross-check of common PID formulas | Secondary source; must not be the only source for a formula that drives anything |
| ISO 14229-1 (UDS) | Paywalled | Only to name the services the policy **denies** | Not verified |

ELM327 datasheet section map (section titles as last known, **to be confirmed
against the fetched edition**; until then every "STANDARD-DOCUMENTED (ELM327
datasheet)" label below is verification-pending):

| Claim in this note | Datasheet section |
| --- | --- |
| CR / LF line endings, `>` prompt, echo | "Communicating with the ELM327" |
| `ATZ`, `ATWS`, `ATE0`, `ATL0`, `ATS0/1`, `ATH0/1`, `ATSP`, `ATDP(N)`, `ATI`, `AT@1`, `ATRV` and the denied AT commands | "AT Commands" and "AT Command Descriptions" |
| Interrupting a request by sending a character; `STOPPED` | "OBD Commands" |
| Protocol numbers 1–C, automatic search, `A` prefix | "Selecting Protocols" and the `ATSP` / `ATDPN` descriptions |
| Header display, multi-frame CAN responses | "Setting the Headers" and "Multiline Responses" |
| `?`, `NO DATA`, `UNABLE TO CONNECT`, `BUS INIT: ...ERROR`, `CAN ERROR`, `BUFFER FULL`, `DATA ERROR`, `<RX ERROR`, `STOPPED`, `ERRxx`, `LV RESET`, `ACT ALERT` | "Error Messages and Alerts" |

Where a statement below cites a paywalled standard, the label is
STANDARD-DOCUMENTED **(unverified copy)**: the standard is the authority, but
this note's wording comes from public secondary descriptions and has not been
checked against the licensed text.

## ELM layer

### Initialisation (Proposed)

| Step | Command | Purpose | Label |
| --- | --- | --- | --- |
| 1 | `ATZ` (or `ATWS`) | Reset; the adapter prints its identity line then `>` | STANDARD-DOCUMENTED (ELM327 datasheet) |
| 2 | `ATE0` | Echo off | STANDARD-DOCUMENTED (ELM327 datasheet) |
| 3 | `ATL0` | No line feed after CR | STANDARD-DOCUMENTED (ELM327 datasheet) |
| 4 | `ATS1` | Keep spaces between bytes (simpler, stricter parsing) | STANDARD-DOCUMENTED (ELM327 datasheet); choice INFERRED |
| 5 | `ATH1` | Show headers, so every response line names its ECU | STANDARD-DOCUMENTED (ELM327 datasheet); choice INFERRED |
| 6 | `ATSP0` | Automatic protocol search | STANDARD-DOCUMENTED (ELM327 datasheet) |
| 7 | `0100` | First request; triggers the search, proves the vehicle answers | STANDARD-DOCUMENTED (unverified copy), SAE J1979 |
| 8 | `ATDPN` | Read which protocol was found | STANDARD-DOCUMENTED (ELM327 datasheet) |
| 9 | `ATI`, optionally `AT@1` | Record adapter identity strings (reported, not proven) | STANDARD-DOCUMENTED (ELM327 datasheet); trust INFERRED |

Every reply is checked against what that command may return. `OK` is the only
acceptable reply to steps 2–6. Anything else (including `?`) fails
initialisation with `adapter_rejected_command`, and the scan does not continue
(INFERRED: a clone that ignores `ATH1` would otherwise produce headerless lines
the obd layer would misattribute).

### Framing

STANDARD-DOCUMENTED (ELM327 datasheet): the adapter ends each line with CR
(and LF unless `ATL0`), and signals it is ready for the next command by
printing `>`.

Proposed rules (INFERRED):

1. Bytes are accumulated across chunks. A response is complete **only** when
   `>` arrives. A chunk boundary never completes a response.
2. Lines are split on CR and/or LF; empty lines are dropped. `0x00` bytes are
   dropped (some adapters are reported to emit them; INFERRED).
3. If echo is still on (before `ATE0` takes effect), a first line equal to the
   command is removed. Echo is never assumed off until `ATE0` returned `OK`.
4. Informational lines (`SEARCHING...`, `BUS INIT: ...`) are recorded and removed.
5. The response is then classified: an error token, or data lines.
6. A response larger than a fixed byte cap (Proposed: 4 KiB) without `>` is a
   framing error. The adapter is reset before the next command.
7. **One command in flight.** A new command is written only after the previous
   response's `>` (or after a cancellation completed, below).
8. **Late data**: bytes that arrive after a timeout but before the next command
   are drained and discarded until a `>` is seen. A command is never written
   while an earlier one may still answer, so a late reply cannot be read as the
   answer to the next command.

### Adapter error tokens

STANDARD-DOCUMENTED (ELM327 datasheet, exact strings to be re-checked against
the edition used). Each maps to a distinct, typed outcome; none is ever data.

| Token | Proposed outcome | Treat as |
| --- | --- | --- |
| `?` | `adapter_rejected_command` | adapter does not accept the command |
| `NO DATA` | `no_response` | no ECU answered in time. **Not** "no codes" and **not** "unsupported" |
| `UNABLE TO CONNECT` | `no_vehicle_protocol` | protocol search failed |
| `BUS INIT: ...ERROR` | `bus_init_failed` | non-CAN initialisation failed |
| `CAN ERROR` | `bus_error` | CAN-level fault |
| `BUS ERROR`, `BUS BUSY`, `FB ERROR` | `bus_error` | bus fault |
| `DATA ERROR`, `<DATA ERROR`, `<RX ERROR` | `data_error` | corrupted reply; the affected line is unusable |
| `BUFFER FULL` | `adapter_overflow` | reply truncated |
| `STOPPED` | `interrupted` | the command was interrupted (cancellation or stray byte) |
| `ERR` followed by digits | `adapter_internal_error` | |
| `LV RESET`, `ACT ALERT` | `adapter_power_event` | the adapter reset itself; session state is lost |
| anything else non-hex | `unexpected_reply` | fail closed |

### Cancellation

- STANDARD-DOCUMENTED (ELM327 datasheet): sending any character while the
  adapter is working on an OBD request interrupts it; it prints `STOPPED` and
  then `>`.
- Proposed (INFERRED): every command takes an `AbortSignal`. On abort the elm
  layer writes a single CR, waits (bounded, Proposed 1 s) for `>`, and reports
  the command `interrupted`. If no `>` arrives in time, the session is marked
  `adapter_unresponsive` and the transport is closed; no further command is
  sent on that connection.
- A cancelled command never yields partial data as a result.

### Timeouts

- Proposed (INFERRED): an outer per-command timeout (Proposed 5 s for normal
  requests, 15 s for the first request that triggers a protocol search). The
  adapter's own timeout (`ATST`) is left at its default in the preview.
- A timeout is handled exactly like an abort (interrupt, wait for `>`), then
  reported as `timeout`.

## Fail-closed command policy

The policy is a **closed allowlist** applied in the elm layer to every command
before any byte is written. Anything not on it is refused with
`command_not_allowed`, and nothing is sent. There is no "raw command" escape
hatch in product code; tests use the simulated transport directly.

Proposed allowlist (INFERRED, built from the references above):

| Group | Allowed | Notes |
| --- | --- | --- |
| Adapter setup | `ATZ`, `ATWS`, `ATE0`, `ATL0`, `ATS0`, `ATS1`, `ATH0`, `ATH1`, `ATSP0`, `ATDP`, `ATDPN`, `ATI`, `AT@1`, `ATRV` | `ATRV` reads the adapter's supply voltage (adapter-measured, not an ECU value) |
| OBD $01 | `01` + one PID (two hex digits) | current data; supported-PID bitmap reads `0100`, `0120`, … `01E0` |
| OBD $02 | `02` + PID + frame `00` | freeze frame, frame 0 only in the preview; e.g. `020000` (frame-0 bitmap), `020200` (DTC that stored it), `020500` |
| OBD $03 | `03` | stored (confirmed) emission-related DTCs |
| OBD $07 | `07` | pending DTCs |
| OBD $0A | `0A` | permanent DTCs |
| OBD $09 | `09` + `00`, `02` (VIN) | vehicle information; other infotypes deferred |

Explicitly **denied** (refused even if a future caller asks), with reasons:

| Denied | Why | Label |
| --- | --- | --- |
| `04` (clear DTCs / reset emission monitors) | Changes vehicle state and erases evidence; would also make readiness and freeze-frame evidence disappear | STANDARD-DOCUMENTED (unverified copy), SAE J1979 $04 |
| `08` (control of on-board system) | Commands the vehicle | STANDARD-DOCUMENTED (unverified copy), SAE J1979 $08 |
| `05`, `06` | Deferred, not denied for safety: read-only, but `06` test-ID semantics need separate review before they inform anything | Proposed |
| Any UDS / KWP2000 service (e.g. `10`, `11`, `14`, `19`, `22`, `27`, `2E`, `2F`, `31`, `34`–`37`, `3E`, `85`) | Manufacturer-enhanced or state-changing diagnostics, security access, programming | PROPRIETARY-NOT-REIMPLEMENTED; ISO 14229-1 named only to list what is denied |
| `ATMA`, `ATMR`, `ATMT`, other monitor modes | Floods the link; passive bus sniffing is out of scope | Proposed |
| `ATSH`, `ATCRA`, `ATCF`, `ATCM` and other header / filter overrides | Allows addressing an individual ECU outside the functional OBD request | Proposed (may be revisited with review) |
| `ATPP…`, `AT@3`, `ATBRD`, `ATBRT`, `ATPB`, `ATSI`, `ATFI`, `ATLP`, `ATST`, `ATAT` | Adapter persistent settings, baud changes, low-power mode, manual protocol initialisation or timing changes | Proposed |
| Any text containing a non-hex, non-`AT` character, or longer than the longest allowed command | Malformed | Proposed |

Policy rules (Proposed, INFERRED):

- The allowlist is data plus a pure check, unit-tested exhaustively (every
  denied example refused, every allowed form accepted, case and whitespace
  variants handled).
- Commands are **built** from typed requests (`{ service: "01", pid: 0x0c }`),
  never from free text. The check runs again on the built text.
- The guided-diagnostics `actuator_test` and `service_function` steps stay
  modelling-only (`app/lib/diagnostic-workflow/types.ts:495-524`, OBSERVED). The
  scanner never performs them; with this policy it cannot.

## OBD layer

### Protocols

STANDARD-DOCUMENTED (ELM327 datasheet, protocol numbers as reported by `ATDPN`;
an `A` prefix means found by automatic search):

| # | Protocol | Preview scope |
| --- | --- | --- |
| 1 | SAE J1850 PWM | Not in preview |
| 2 | SAE J1850 VPW | Not in preview |
| 3 | ISO 9141-2 | Not in preview |
| 4 | ISO 14230-4 KWP (5-baud init) | Not in preview |
| 5 | ISO 14230-4 KWP (fast init) | Not in preview |
| 6 | ISO 15765-4 CAN 11-bit, 500 kbit/s | Preview |
| 7 | ISO 15765-4 CAN 29-bit, 500 kbit/s | Preview |
| 8 | ISO 15765-4 CAN 11-bit, 250 kbit/s | Preview |
| 9 | ISO 15765-4 CAN 29-bit, 250 kbit/s | Preview |
| A–C | SAE J1939, user CAN | Not supported |

Proposed (INFERRED): a non-CAN protocol is reported as
`unsupported_protocol` with the protocol number, and the scan stops before any
service request. Non-CAN response layouts differ (for example $03 on non-CAN
has no DTC count byte and is padded per frame), so they get their own parser
and their own fixtures before being enabled.

### ECU-aware parsing

STANDARD-DOCUMENTED (unverified copy), ISO 15765-4: an OBD request is sent to
the functional address, and **each** emission-related ECU may answer from its
own address (11-bit: responses `7E8`–`7EF`; 29-bit: `18DAF1xx`, where `xx`
is the ECU's address).

Proposed rules (INFERRED):

1. With `ATH1`, every data line begins with its CAN identifier. Lines are
   grouped **by identifier first**; each group is one ECU's response.
2. ISO-TP frames are reassembled per identifier using the PCI nibble
   (STANDARD-DOCUMENTED (unverified copy), ISO 15765-2: `0` single frame, `1`
   first frame with 12-bit length, `2` consecutive frame with 4-bit sequence
   number, `3` flow control). Frames from different ECUs may interleave; each
   ECU has its own buffer.
3. **The ISO-TP length governs extraction.** STANDARD-DOCUMENTED (unverified
   copy), ISO 15765-2 / ISO 15765-4: a single frame's low PCI nibble (`SF_DL`)
   and a first frame's 12-bit `FF_DL` give the payload length, and OBD frames
   on CAN may be padded to 8 data bytes. Proposed (INFERRED):
   - From a single frame, exactly `SF_DL` bytes after the PCI byte are the
     payload; any bytes after them are padding.
   - From a first frame, its 6 payload bytes are taken; from each consecutive
     frame, `min(7, FF_DL − received)` bytes are taken; bytes after that in the
     final consecutive frame are padding.
   - Padding is discarded **before** any application-level check, and its byte
     values are not checked (adapters and ECUs differ). Whether the adapter
     displays padding at all varies (INFERRED: depends on ELM CAN formatting
     settings and on the clone), so both padded and unpadded frames must parse
     identically.
4. A response is `malformed` for **that ECU** (other ECUs' responses from the
   same request remain usable) when any of these holds:
   - **transport**: `SF_DL` is 0 or greater than 7; a frame holds fewer bytes
     than its declared length needs; `FF_DL` is below 8; a sequence gap or
     duplicate sequence number; a consecutive frame without a first frame; a
     consecutive frame after `FF_DL` bytes were already received; fewer than
     `FF_DL` bytes when `>` arrives;
   - **application**: the extracted payload (padding already removed) does not
     have exactly the length its service and PID require (for example $03 on
     CAN: `2 + 2 × count` bytes; $01: the PID's fixed data length + 2).
5. A response must echo the request: service byte + `0x40`, then the PID for
   $01/$02/$09 (and the frame number for $02). A mismatched service, PID or
   frame from an ECU is `malformed` for that ECU, never data.
6. A negative response (`7F <service> <code>`) is recorded as
   `negative_response` with its code. It is never "no codes" or "zero".
7. An ECU that answered one request but not the next is recorded as
   `no_response` for the second; ECU presence is not carried forward as an
   answer.
8. Lines without a parseable identifier (headers not on) fail the whole
   response closed (`unexpected_reply`).

Fixtures for valid padding (padded and unpadded single frames, padded final
consecutive frames, both from several ECUs at once) and for each malformed
case are rows 37–44 of the [simulated test matrix](scan-flow.md#simulated-test-matrix).

### DTC decoding

STANDARD-DOCUMENTED (unverified copy), SAE J2012 / ISO 15031-6: a DTC is two
bytes. The top two bits select the system (`00` P, `01` C, `10` B, `11` U), the
next two bits the first digit (0–3), and the remaining twelve bits three hex
digits. On CAN, the $03/$07/$0A positive response is the service byte, a count
of DTCs, then two bytes per DTC.

Proposed rules (INFERRED):

- The decoded text always matches the repository's OBD form
  `/^[PBCU][0-3][0-9A-F]{3}$/` (OBSERVED, `app/lib/diagnostic-workflow/dtc.ts:29`),
  so mapped codes are declared `format: "obd"`.
- On CAN, the count byte governs: exactly `count` pairs are read from the
  payload extracted under rule 3 (ISO-TP padding already removed), and the
  payload must be exactly `2 + 2 × count` bytes, otherwise that ECU's response
  is `malformed`. A `0000` pair inside the counted pairs is not a code; that
  ECU's response is recorded `malformed` rather than guessed at. (Skipping
  `0000` filler pairs belongs to the non-CAN layouts, which the preview does
  not parse.)
- Codes are attributed to the ECU that sent them; a code from two ECUs is two
  observations.

### PID decoding

PID formulas are taken from SAE J1979 (unverified copy) cross-checked against
the public secondary source above. Each formula used is a row in one reviewed
table with its reference; see [live-data](live-data.md#pid-table-preview).
Supported-PID bitmaps ($01 PID `00`, `20`, `40`, …) are decoded as
STANDARD-DOCUMENTED (unverified copy): byte A bit 7 is the first PID of the
range, and the last bit says whether the next bitmap PID is supported.
