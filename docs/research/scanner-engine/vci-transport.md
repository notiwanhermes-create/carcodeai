# Scanner engine research: VCI transport

Status: **research note and proposed design, documentation only.** No transport
code exists in this repository. Labels are defined in
[thinkcar-observed-architecture](thinkcar-observed-architecture.md#provenance-labels).
`AGENTS.md` remains binding.

"VCI" (vehicle communication interface) here means the adapter plugged into the
vehicle's diagnostic connector. The transport layer moves **bytes** between the
browser and that adapter. It knows nothing about ELM327 commands, OBD services,
DTCs or Guided Diagnostics.

## Repository facts

- **OBSERVED**: no Web Bluetooth, Web Serial or WebUSB code exists in the
  application. The Guided Diagnostics engine forbids vehicle communication
  (`AGENTS.md`, "Guided Diagnostics architecture"; the engine's own header,
  `app/lib/diagnostic-workflow/types.ts:26-29`, "The engine never talks to a
  vehicle").
- **OBSERVED**: the app is a Next.js application with a web manifest
  (`public/manifest.json`). Any transport must run in the browser (client
  component), never in a server action or route.

## Candidate browser transports

| Transport | What it reaches | Label |
| --- | --- | --- |
| Web Bluetooth (GATT over BLE) | BLE adapters that expose a GATT serial-like service | STANDARD-DOCUMENTED: W3C Web Bluetooth Community Group draft, <https://webbluetoothcg.github.io/web-bluetooth/> (a CG report, not a W3C Recommendation) |
| Web Serial | USB-serial adapters, and on some platforms a paired Classic Bluetooth SPP port exposed as a serial port | STANDARD-DOCUMENTED: WICG Web Serial draft, <https://wicg.github.io/serial/> |
| WebUSB | Vendor-class USB devices only; USB-serial adapters normally claimed by an OS driver are not reachable | STANDARD-DOCUMENTED: WICG WebUSB draft, <https://wicg.github.io/webusb/>; applicability to OBD adapters INFERRED |
| Classic Bluetooth SPP / RFCOMM directly | Most low-cost "Bluetooth ELM327" dongles | INFERRED: not exposed by Web Bluetooth (the Web Bluetooth draft covers GATT only) |
| Wi-Fi (TCP socket) adapters | Wi-Fi ELM327 clones | INFERRED: browsers expose no raw TCP sockets to web pages, so not reachable from a normal web app |

The preview requires **both** Web Bluetooth and Web Serial transports
(baseline, [carcode-scanner-architecture](carcode-scanner-architecture.md#baseline-requirements-and-deviations));
each is offered only where feature detection finds it.

## Browser compatibility (to be re-verified before implementation)

Compatibility tables change between releases; none of these were re-checked
against a live browser for this note. **Source verification is pending**: before
S11a / S11b (see [carcode-scanner-architecture](carcode-scanner-architecture.md#small-task-implementation-sequence)),
re-read MDN's "Web Bluetooth API" and "Web Serial API" compatibility tables
(<https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API>,
<https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API>) and
Chromium's status entries, and record the date.

| Environment | Web Bluetooth | Web Serial | Label |
| --- | --- | --- | --- |
| Chrome / Edge, desktop (Windows, macOS, ChromeOS) | Shipped | Shipped | INFERRED from MDN as last known; re-verify |
| Chrome / Edge, Linux desktop | Partial / may need a flag | Shipped | UNKNOWN for current releases; re-verify |
| Chrome, Android | Shipped | UNKNOWN (status has changed across releases) | INFERRED / UNKNOWN; re-verify |
| Firefox (any) | Not supported | Not supported | INFERRED from MDN as last known; re-verify |
| Safari macOS | Not supported | Not supported | INFERRED; re-verify |
| Any browser on iOS / iPadOS | Not supported (all iOS browsers use WebKit) | Not supported | INFERRED; re-verify |
| Installed PWA | Same as the host browser | Same as the host browser | INFERRED |

Consequences (INFERRED):

- An iPhone user cannot use a browser-based scanner at all. The preview must
  say so plainly and must not offer a broken "Connect" button.
- Feature detection (`"bluetooth" in navigator`, `navigator.bluetooth.getAvailability()`,
  `"serial" in navigator`) decides what is offered. A user-agent string never does.
- Web Bluetooth and Web Serial require a secure context (HTTPS or localhost)
  and a user gesture for the device chooser (STANDARD-DOCUMENTED in both drafts above).

## Adapter uncertainty

- **INFERRED**: "ELM327" on a product label is not evidence of an ELM
  Electronics chip. Many clones report a version string (`ATI` → `ELM327 v1.5`,
  `v2.1`) that does not match the command set they actually implement. CarCode
  treats the version string as **reported, not proven**.
- **UNKNOWN**: which specific adapters (brand, model, firmware) work with Web
  Bluetooth. **No adapter has been tested.** Real-adapter validation is
  **pending** (see [carcode-scanner-architecture](carcode-scanner-architecture.md#validation-status)).
- **INFERRED**: an adapter may silently drop commands it does not implement,
  answer `?`, or answer with stale data. The ELM layer must therefore treat any
  unexpected reply as an error, never as data (see [protocol-stack](protocol-stack.md#fail-closed-command-policy)).

## Candidate BLE UUIDs (UNVERIFIED community claims)

BLE OBD adapters do not share a standard GATT service. The Bluetooth SIG
assigns no "OBD" or "ELM327" service (INFERRED: none appears in the SIG's
Assigned Numbers document, <https://www.bluetooth.com/specifications/assigned-numbers/>;
not re-checked for this note).

**Every row is UNVERIFIED**: no vendor primary document was found, no adapter
was inspected, and nothing here is OBSERVED. The community sources below were
located and read on 2026-10-26; they are user reports and open-source sample
configuration, not vendor documentation. "UNKNOWN" means no identifiable source
was found. Rows with an UNKNOWN source are **not** researched evidence.

| Service | Characteristic(s) | Reported for | Source | Status |
| --- | --- | --- | --- | --- |
| `000018f0-0000-1000-8000-00805f9b34fb` (16-bit `18F0`) | `2AF0` notify (also indicate), `2AF1` write / write without response | **Vgate iCar Pro BLE** (community-reported) | ABRP feature request "Add OBD Support for Vgate iCar Pro Bluetooth 4.0 (BLE) OBD2 and IOS15.2", <https://abrp.featurebase.app/p/add-odb-support-for-vgate-icar-pro-bluetooth-40-ble-2> (ticket text: service 18F0, notify 2AF0, write 2AF1); ABRP user report "I plugged an OBD Vgate iCar Pro BLE 4.0 ...", <https://abrp.featurebase.app/p/i-plugged-an-obd-vgate-icar-pro-ble-40-unfortunatly-2> (GATT listing: primary service 0x18F0, 0x2AF0 indicate/notify with 0x2902 descriptor, 0x2AF1 write / write without response). Read 2026-10-26 | `community_unverified`; in the preview profile table, pending real-adapter validation |
| `0000fff0-0000-1000-8000-00805f9b34fb` (16-bit `FFF0`) | `FFF1` receive (notify), `FFF2` send (write) | Unbranded ELM327 BLE clones | Arduino forum thread "ESP32 with ELM327", <https://forum.arduino.cc/t/esp32-with-elm327/1315461>: post #1 (updated code: service FFF0, FFF1 to receive, FFF2 to send), posts #6 and #7 (users' adapters exposing only FFF1 and FFF2). PyPI `elm327-obdii` project page, <https://pypi.org/project/elm327-obdii/>, sample configuration: `uuid_read` `0000fff1-...`, `uuid_write` `0000fff2-...`. Read 2026-10-26 | `community_unverified`; in the preview profile table, pending real-adapter validation. Roles are confirmed at runtime from the characteristic properties, never assumed |
| `0000ffe0-0000-1000-8000-00805f9b34fb` (16-bit `FFE0`) | `FFE1` notify + write (as commonly described) | HM-10-style BLE-UART modules | UNKNOWN for OBD use: searched 2026-10-26, no OBD-specific source identified | Not researched; excluded from the profile table. An adapter using it fails closed with `unsupported_adapter`; the manual UUID override is the only way to try it |

An earlier draft also listed a 128-bit service / characteristic pair with no
identifiable source; it has been removed rather than kept as an unsourced
claim.

Before S11a ([carcode-scanner-architecture](carcode-scanner-architecture.md#small-task-implementation-sequence))
each profile used must record: the source URL, the exact location in it (file
and line, post, or section), the adapter model it is claimed for, and the date
read. A profile with no recorded source stays out of the table.

Rules for using these (Proposed, INFERRED):

1. They live in **one data table of adapter profiles**, each row carrying its
   recorded source and `provenance: "community_unverified"` until a person
   validates it with a real adapter and records the adapter, firmware and date.
2. Web Bluetooth requires every service to be named in `filters` or
   `optionalServices` before it can be used (STANDARD-DOCUMENTED, Web Bluetooth
   draft, `requestDevice()`); the profile table supplies them.
3. After connecting, the transport **verifies** the expected characteristics and
   properties (notify / write / writeWithoutResponse) exist. A missing one fails
   the connection with `unsupported_adapter`; it never guesses another
   characteristic.
4. A profile match proves only that bytes can move. The ELM layer must still
   prove the adapter answers an ELM-style handshake before any OBD request.
5. No UUID is presented to users as "supported" or "compatible".

## Proposed transport interface

Proposed (INFERRED). Sketch only, no code in this task:

```ts
type TransportState = "idle" | "connecting" | "open" | "closing" | "closed" | "failed";

interface ByteTransport {
  readonly kind: "web_bluetooth" | "web_serial" | "simulated";
  readonly state: TransportState;
  open(signal: AbortSignal): Promise<void>;
  /** Writes all bytes, chunked to the link's limit. Rejects if not open or aborted. */
  write(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /** Every received chunk, in order, unmodified. Chunk boundaries carry no meaning. */
  onData(listener: (chunk: Uint8Array) => void): () => void;
  onClose(listener: (reason: TransportCloseReason) => void): () => void;
  close(): Promise<void>;
}
```

Transport rules (Proposed, INFERRED):

- **Chunk boundaries are meaningless.** A BLE notification may hold part of a
  line, several lines, or a lone `>` prompt. Reassembly is the ELM layer's job
  ([protocol-stack](protocol-stack.md#framing)). With the default ATT MTU of 23
  a notification payload is at most 20 bytes (STANDARD-DOCUMENTED, Bluetooth
  Core Specification, ATT: payload is ATT_MTU − 3; Core v5.4 Vol 3 Part F;
  paywall-free from bluetooth.com but not re-read for this note).
- Writes are chunked to the negotiated limit; Web Bluetooth does not expose the
  MTU directly, so the default 20-byte chunk is used unless a validated profile
  says otherwise (INFERRED).
- Exactly one transport is open per scanner session. `open()` while open is
  refused, never a second connection.
- Disconnect (`gattserverdisconnected`, serial `disconnect`) moves to `closed`
  and fails any in-flight write. There is **no automatic reconnect** inside a
  scan; the scan ends `partial` with reason `transport_lost`
  ([scan-flow](scan-flow.md#partial-scan-provenance)).
- `close()` is idempotent. After `closed`, every call is refused.
- The transport never logs or sends payload bytes off the device.

## Simulated transport

Proposed (INFERRED): a `SimulatedTransport` driven by a scripted adapter model
(fixtures of request → response bytes, with controllable chunking, delays,
disconnects and garbage). It is the **only** transport the automated test suite
uses. See [scan-flow](scan-flow.md#simulated-test-matrix).
