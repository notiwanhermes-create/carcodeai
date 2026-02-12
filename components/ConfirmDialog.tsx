"use client";

import { useCallback, useState } from "react";
import { tr, type LangCode } from "@/app/data/translations";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  theme: "dark" | "light";
  lang: LangCode;
};

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  theme,
  lang,
}: ConfirmDialogProps) {
  const t = useCallback((dark: string, light: string) => (theme === "dark" ? dark : light), [theme]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const handleConfirm = useCallback(async () => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await onConfirm();
      onCancel();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }, [onCancel, onConfirm, pending]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center backdrop-blur-md"
      style={{
        background: theme === "dark" ? "rgba(15,23,42,0.7)" : "rgba(255,255,255,0.7)",
      }}
    >
      <div
        className={cn(
          "w-full max-w-sm rounded-3xl p-6 animate-scale-in",
          t("glass-card-strong", "bg-white border border-slate-200 shadow-xl"),
        )}
      >
        <div className={cn("text-base font-semibold", t("text-white", "text-slate-900"))}>{title}</div>
        <div className={cn("mt-2 text-sm", t("text-slate-400", "text-slate-600"))}>{message}</div>
        {error ? <div className="mt-3 text-xs text-red-400">{error}</div> : null}
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={pending}
            className={cn(
              "rounded-xl px-4 py-2 text-sm font-semibold transition-all",
              pending && "opacity-60 cursor-not-allowed",
              t(
                "border border-white/10 bg-white/10 text-slate-300 hover:bg-white/20",
                "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100",
              ),
            )}
          >
            {tr("cancel", lang)}
          </button>
          <button
            onClick={handleConfirm}
            disabled={pending}
            className={cn(
              "rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-red-500/25 transition-all hover:bg-red-400",
              pending && "opacity-70 cursor-not-allowed",
            )}
          >
            {confirmLabel || tr("confirm", lang)}
          </button>
        </div>
      </div>
    </div>
  );
}

