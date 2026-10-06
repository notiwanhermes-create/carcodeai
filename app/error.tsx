"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Route-level error boundary. Shown instead of the blank "Application error"
 * screen when a page throws while rendering.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/error]", error);
  }, [error]);

  return (
    <main className="relative min-h-screen bg-[#0f172a] text-slate-100 flex items-center justify-center px-4 py-10">
      <div className="mesh-background">
        <div className="mesh-blob mesh-blob-1" />
        <div className="mesh-blob mesh-blob-2" />
      </div>

      <div role="alert" className="relative z-10 w-full max-w-md glass-card-strong rounded-3xl p-8 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/20">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
            <path d="M10.363 3.818l-7.329 12.952A1.5 1.5 0 0 0 4.34 19h15.32a1.5 1.5 0 0 0 1.306-2.23l-7.329-12.952a1.5 1.5 0 0 0-2.674 0z" />
          </svg>
        </div>

        <h1 className="mt-5 text-xl font-bold text-white">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-400">
          This screen hit an unexpected problem. Your saved vehicles and history are not affected.
          Try again, and if it keeps happening, reload the page.
        </p>

        <div className="mt-6 grid gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="w-full rounded-xl bg-blue-500 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-500/25 transition-all hover:bg-blue-400"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full rounded-xl border border-white/10 bg-white/5 py-3 text-sm font-medium text-slate-300 transition-all hover:bg-white/10"
          >
            Reload the page
          </button>
          <Link
            href="/"
            className="w-full rounded-xl py-2 text-sm font-medium text-cyan-400 transition-colors hover:text-cyan-300"
          >
            Back to home
          </Link>
        </div>

        {error.digest ? (
          <p className="mt-5 text-[11px] text-slate-500">Reference: {error.digest}</p>
        ) : null}
      </div>
    </main>
  );
}
