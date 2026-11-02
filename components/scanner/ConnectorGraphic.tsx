import type { Pins } from "@/app/scanner/scanner-view";
import { cn } from "@/components/garage/shared";

/** The J1962 pins the scanner relies on: 16 battery, 4 and 5 ground, 6 and 14 CAN. */
const POWER_PINS = [4, 5, 16];
const BUS_PINS = [6, 14];

const TOP_ROW = [1, 2, 3, 4, 5, 6, 7, 8];
const BOTTOM_ROW = [9, 10, 11, 12, 13, 14, 15, 16];

function pinClass(pin: number, { power, bus }: Pins): string {
  if (POWER_PINS.includes(pin) && power) return "fill-blue-400 stroke-blue-300";
  if (BUS_PINS.includes(pin)) {
    if (bus === "on") return "fill-cyan-300 stroke-cyan-200";
    if (bus === "searching") return "fill-cyan-300/70 stroke-cyan-200 motion-safe:animate-pulse";
    if (bus === "silent") return "fill-transparent stroke-amber-300";
  }
  return "fill-slate-400/15 stroke-slate-300/40";
}

function Pin({ pin, x, y, pins }: { pin: number; x: number; y: number; pins: Pins }) {
  const lit = (POWER_PINS.includes(pin) && pins.power) || (BUS_PINS.includes(pin) && (pins.bus === "on" || pins.bus === "searching"));
  return <rect x={x} y={y} width={20} height={36} rx={5} strokeWidth={1.25} filter={lit ? "url(#scanner-pin-glow)" : undefined} className={cn("transition-colors duration-700", pinClass(pin, pins))} />;
}

/**
 * The car's 16-pin OBD-II port, drawn for CarCode. Decorative: the same state
 * is always given in words. Power and ground light once the adapter answers,
 * the CAN pins once the car does; a car that stays silent leaves them outlined.
 */
export function ConnectorGraphic({ pins, className }: { pins: Pins; className?: string }) {
  return (
    <svg aria-hidden data-connector data-bus={pins.bus} data-power={pins.power} viewBox="0 0 320 184" fill="none" className={className}>
      <defs>
        <filter id="scanner-pin-glow" x="-80%" y="-60%" width="260%" height="220%">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="scanner-port-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1e293b" />
          <stop offset="1" stopColor="#0f172a" />
        </linearGradient>
      </defs>
      <path
        d="M34 18h104v-7a4 4 0 0 1 4-4h36a4 4 0 0 1 4 4v7h104c12 0 21 10 18 22l-20 118c-2 11-10 19-22 19H58c-12 0-20-8-22-19L16 40c-3-12 6-22 18-22Z"
        fill="url(#scanner-port-face)"
        className="stroke-slate-300/45"
        strokeWidth={1.5}
      />
      <path d="M40 30h240c6 0 11 5 10 12l-18 106c-1 7-6 13-14 13H62c-8 0-13-6-14-13L30 42c-1-7 4-12 10-12Z" className="stroke-slate-300/20" strokeWidth={1} />
      {TOP_ROW.map((pin, index) => (
        <Pin key={pin} pin={pin} x={41 + index * 31} y={46} pins={pins} />
      ))}
      {BOTTOM_ROW.map((pin, index) => (
        <Pin key={pin} pin={pin} x={49 + index * 29} y={106} pins={pins} />
      ))}
    </svg>
  );
}
