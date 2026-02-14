 "use client";

import React, { useEffect, useState } from "react";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

export default function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function handleSubmit() {
    if (!message.trim()) {
      setError("Please enter your feedback");
      return;
    }
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          rating: rating || undefined,
          message: message.trim(),
          pageUrl: typeof window !== "undefined" ? window.location.href : undefined,
        }),
      });
      let errorMessage = "Something went wrong";
      if (!res.ok) {
        try {
          const d = await res.json();
          if (typeof d?.error === "string") errorMessage = d.error;
        } catch {}
        throw new Error(errorMessage);
      }
      setSent(true);
      setName("");
      setEmail("");
      setMessage("");
      setRating(0);
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed right-5 bottom-5 z-50 rounded-full bg-blue-500 text-white px-4 py-2 shadow-lg hover:bg-blue-400"
        aria-label="Open feedback"
      >
        Feedback
      </button>

      {open && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div className="fixed right-0 bottom-0 top-0 w-full max-w-md md:top-12 md:right-12 md:bottom:auto md:rounded-2xl bg-white/5 backdrop-blur p-4 shadow-2xl overflow-auto" style={{ zIndex: 60 }}>
            <div className="flex items-center gap-3 mb-4">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
              <h3 className="text-lg font-semibold text-white">Share Your Feedback</h3>
              <div className="ml-auto">
                <button onClick={() => setOpen(false)} className="text-slate-300 hover:text-white">✕</button>
              </div>
            </div>

            <p className="text-sm mb-5 text-slate-300">Help us improve CarCode AI. Tell us what you like, what could be better, or suggest new features.</p>

            {sent ? (
              <div className="mt-4">
                <div className="rounded-2xl p-6 text-center bg-white/5">
                  <div className="text-3xl mb-3 text-white">&#10003;</div>
                  <div className="text-lg font-semibold text-white">Thank you for your feedback!</div>
                  <p className="mt-2 text-sm text-slate-300">We appreciate you taking the time to help us improve CarCode AI.</p>
                  <button onClick={() => setSent(false)} className="mt-4 text-sm text-cyan-400 hover:text-cyan-300">Send more feedback</button>
                </div>
              </div>
            ) : (
              <div>
                <div className="mb-4">
                  <div className="text-xs mb-1 text-slate-300">How would you rate your experience?</div>
                  <div className="flex gap-1">
                    {[1,2,3,4,5].map((star) => (
                      <button
                        key={star}
                        type="button"
                        onMouseEnter={() => setHoverRating(star)}
                        onMouseLeave={() => setHoverRating(0)}
                        onClick={() => setRating(star === rating ? 0 : star)}
                        className={cn("p-0.5 transition-transform rounded", (hoverRating || rating) >= star ? "bg-yellow-400" : "bg-white/5")}
                      >
                      <svg width="28" height="28" viewBox="0 0 24 24" fill={(hoverRating || rating) >= star ? "#fbbf24" : "none"} stroke={(hoverRating || rating) >= star ? "#ffffff" : "#94a3b8"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                        </svg>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">Name <span className="text-slate-400 text-xs">(optional)</span></label>
                    <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-xl px-3 py-2 text-sm bg-white/5 border border-white/10 text-white" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">Email <span className="text-slate-400 text-xs">(optional)</span></label>
                    <input value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-xl px-3 py-2 text-sm bg-white/5 border border-white/10 text-white" />
                  </div>
                </div>

                <div className="mb-4">
                  <label className="block text-xs text-slate-300 mb-1">Your Feedback <span className="text-red-400">*</span></label>
                  <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} className="w-full rounded-xl px-3 py-2 text-sm bg-white/5 border border-white/10 text-white resize-none" />
                  <div className="text-xs mt-1 text-right text-slate-400">{message.length}/2000</div>
                </div>

                {error && <div className="mb-3 text-sm text-red-400">{error}</div>}

                <button onClick={handleSubmit} disabled={sending || !message.trim()} className={cn("w-full rounded-xl py-3 text-sm font-semibold transition-all", sending || !message.trim() ? "bg-white/5 text-slate-500 cursor-not-allowed" : "bg-gradient-to-r from-cyan-500 to-blue-600 text-white")}>
                  {sending ? "Sending..." : "Send Feedback"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

