import type { ReactNode } from "react";

function Icon({ className = "size-5", children }: { className?: string; children: ReactNode }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className}>
      {children}
    </svg>
  );
}

type IconProps = { className?: string };

export const BluetoothIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="m7 7 10 10-5 5V2l5 5L7 17" />
  </Icon>
);

/** A serial plug: the COM-port option. */
export const PortIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M5 8h14l-1.6 8H6.6L5 8Z" />
    <path d="M9 11.5h.01M12 11.5h.01M15 11.5h.01" />
    <path d="M12 16v5" />
    <path d="M12 3v5" />
  </Icon>
);

export const CheckIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const AlertIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" />
    <path d="M12 10v4.5M12 17.2h.01" />
  </Icon>
);

export const ChevronIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

export const ShieldIcon = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M12 3 5 5.8v5.7c0 4.3 2.9 7.7 7 9.5 4.1-1.8 7-5.2 7-9.5V5.8L12 3Z" />
    <path d="m9.2 12 2 2 3.6-4" />
  </Icon>
);
