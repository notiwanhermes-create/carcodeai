/**
 * BLE adapter profiles (vci-transport.md, "Candidate BLE UUIDs").
 *
 * RESEARCH PROTOTYPE. BLE OBD adapters share no standard GATT service. Each
 * documented profile is a COMMUNITY CLAIM, `community_unverified`, with its
 * recorded sources; none has been confirmed on a device. A profile match
 * proves only that bytes can move; the ELM layer must still prove an ELM-style
 * handshake. No profile is presented as "supported" or "compatible".
 *
 * A manual override is three UUIDs typed by a person, validated for syntax
 * only; it is labelled `user_supplied` and replaces the documented profiles.
 */
import type { BleUuid } from "./web-bluetooth-api";

export type BleProfileProvenance = "community_unverified" | "user_supplied";

export type BleProfileSource = {
  readonly url: string;
  /** Where in the source (post, section, field). */
  readonly location: string;
  readonly dateRead: string;
};

export type BleProfile = {
  readonly id: string;
  readonly label: string;
  readonly provenance: BleProfileProvenance;
  /** Real-adapter validation: always "pending" until a person records adapter, firmware and date. */
  readonly validation: "pending";
  /** The adapter the sources claim it for, as reported (not verified). */
  readonly reportedFor: string;
  readonly sources: readonly BleProfileSource[];
  /** Full 128-bit, lower-case UUIDs. */
  readonly service: BleUuid;
  readonly notify: BleUuid;
  readonly write: BleUuid;
};

const BASE_SUFFIX = "-0000-1000-8000-00805f9b34fb";

/** The full 128-bit form of a 16-bit SIG-base UUID given as four hex digits. */
function short(hex4: string): BleUuid {
  return `0000${hex4.toLowerCase()}${BASE_SUFFIX}`;
}

/** The documented profiles, in table order. Both are community claims (vci-transport.md table, rows 1-2). */
export const DOCUMENTED_BLE_PROFILES: readonly BleProfile[] = [
  {
    id: "ble_18f0",
    label: "Service 18F0 (notify 2AF0, write 2AF1)",
    provenance: "community_unverified",
    validation: "pending",
    reportedFor: "Vgate iCar Pro BLE (community-reported)",
    sources: [
      {
        url: "https://abrp.featurebase.app/p/add-odb-support-for-vgate-icar-pro-bluetooth-40-ble-2",
        location: "feature request text: service 18F0, notify 2AF0, write 2AF1",
        dateRead: "2026-10-26",
      },
      {
        url: "https://abrp.featurebase.app/p/i-plugged-an-obd-vgate-icar-pro-ble-40-unfortunatly-2",
        location: "user GATT listing: primary service 0x18F0, 0x2AF0 indicate/notify, 0x2AF1 write / write without response",
        dateRead: "2026-10-26",
      },
    ],
    service: short("18f0"),
    notify: short("2af0"),
    write: short("2af1"),
  },
  {
    id: "ble_fff0",
    label: "Service FFF0 (notify FFF1, write FFF2)",
    provenance: "community_unverified",
    validation: "pending",
    reportedFor: "Unbranded ELM327 BLE clones (community-reported)",
    sources: [
      {
        url: "https://forum.arduino.cc/t/esp32-with-elm327/1315461",
        location: "post #1 (service FFF0, FFF1 receive, FFF2 send); posts #6 and #7 (adapters exposing FFF1 and FFF2)",
        dateRead: "2026-10-26",
      },
      {
        url: "https://pypi.org/project/elm327-obdii/",
        location: "project page sample configuration: uuid_read 0000fff1-..., uuid_write 0000fff2-...",
        dateRead: "2026-10-26",
      },
    ],
    service: short("fff0"),
    notify: short("fff1"),
    write: short("fff2"),
  },
];

const UUID_128 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Validates one UUID as typed: four hex digits (16-bit), eight hex digits
 * (32-bit), or the canonical 128-bit form. Returns the lower-case 128-bit
 * form, or null. Nothing else (prefixes, braces, inner spaces, names) is accepted.
 */
export function parseBleUuid(input: string): BleUuid | null {
  const text = input.trim().toLowerCase();
  if (/^[0-9a-f]{4}$/.test(text)) return short(text);
  if (/^[0-9a-f]{8}$/.test(text)) return `${text}${BASE_SUFFIX}`;
  return UUID_128.test(text) ? text : null;
}

export type BleOverrideInput = { service: string; notify: string; write: string };

export type BleOverrideResult =
  | { ok: true; profile: BleProfile }
  | { ok: false; field: keyof BleOverrideInput; reason: "invalid_uuid" | "same_as_service" };

/**
 * A manual UUID override. Notify and write may name the same characteristic
 * (one characteristic with both roles); its properties are still checked at
 * connect time. Neither may equal the service UUID.
 */
export function createManualBleProfile(input: BleOverrideInput): BleOverrideResult {
  const fields: (keyof BleOverrideInput)[] = ["service", "notify", "write"];
  const parsed: Partial<Record<keyof BleOverrideInput, BleUuid>> = {};
  for (const field of fields) {
    const uuid = typeof input[field] === "string" ? parseBleUuid(input[field]) : null;
    if (!uuid) return { ok: false, field, reason: "invalid_uuid" };
    parsed[field] = uuid;
  }
  const { service, notify, write } = parsed as Record<keyof BleOverrideInput, BleUuid>;
  if (notify === service) return { ok: false, field: "notify", reason: "same_as_service" };
  if (write === service) return { ok: false, field: "write", reason: "same_as_service" };
  return {
    ok: true,
    profile: {
      id: "manual_override",
      label: "Manual UUID override",
      provenance: "user_supplied",
      validation: "pending",
      reportedFor: "Entered by the user",
      sources: [],
      service,
      notify,
      write,
    },
  };
}
