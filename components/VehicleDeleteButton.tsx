"use client";

import { useCallback } from "react";
import { tr, type LangCode } from "@/app/data/translations";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

export type VehicleDeleteButtonProps = {
  onClick: () => void;
  disabled?: boolean;
  theme: "dark" | "light";
  lang: LangCode;
};

export function VehicleDeleteButton({ onClick, disabled, theme, lang }: VehicleDeleteButtonProps) {
  const t = useCallback((dark: string, light: string) => (theme === "dark" ? dark : light), [theme]);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-xl px-2 py-1.5 text-xs transition-colors",
        disabled && "opacity-60 cursor-not-allowed",
        t("text-slate-500 hover:text-red-400", "text-slate-400 hover:text-red-500"),
      )}
    >
      {tr("delete", lang)}
    </button>
  );
}

