/**
 * Capability presets for TESTS AND DEVELOPMENT ONLY.
 *
 * Each preset is just a shorthand that produces an explicit
 * DiagnosticCapabilityContext. The engine never sees a preset name and never
 * assumes anything a context does not declare: to add or remove one
 * instrument, edit the context, not the preset.
 */
import type { DiagnosticCapabilityContext } from "../types";

export const CAPABILITY_PRESETS = ["basic", "diy", "advanced_diy", "workshop"] as const;
export type CapabilityPreset = (typeof CAPABILITY_PRESETS)[number];

const PRESETS: Record<CapabilityPreset, DiagnosticCapabilityContext> = {
  /** Look, listen and answer questions. No scan tool. */
  basic: { skill: "owner", scanAccess: "none", instruments: [], facilities: [] },
  /** Hand tools, a multimeter, and a code reader. */
  diy: { skill: "diy", scanAccess: "codes", instruments: ["hand_tools", "multimeter"], facilities: [] },
  /** As DIY, plus live data and pressure/compression gauges. */
  advanced_diy: { skill: "diy", scanAccess: "live_data", instruments: ["hand_tools", "multimeter", "pressure_gauge", "compression_tester"], facilities: [] },
  /** Professional skill, bidirectional scan access, the usual instruments, a lift. */
  workshop: {
    skill: "professional",
    scanAccess: "bidirectional",
    instruments: ["hand_tools", "multimeter", "pressure_gauge", "compression_tester", "oscilloscope", "smoke_machine"],
    facilities: ["vehicle_lift", "workshop_space"],
  },
};

/** A fresh, explicit capability context for a preset. */
export function capabilityPreset(name: CapabilityPreset): DiagnosticCapabilityContext {
  const p = PRESETS[name];
  return { skill: p.skill, scanAccess: p.scanAccess, instruments: [...p.instruments], facilities: [...p.facilities] };
}
