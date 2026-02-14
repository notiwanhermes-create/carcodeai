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
      if (!res.ok) throw new Error("Failed to send");
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
          <div className="fixed right-0 bottom-0 top-0 w-full max-w-md md:top-12 md:right-12 md:bottom:auto md:rounded-2xl bg-white dark:bg-[#0b1220] p-4 shadow-2xl overflow-auto" style={{ zIndex: 60 }}>
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Share Your Feedback</h3>
              <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-700">✕</button>
            </div>

            {sent ? (
              <div className="p-3">
                <div className="text-green-500 font-semibold">Thanks — feedback sent!</div>
                <button className="mt-3 text-sm text-blue-500" onClick={() => setSent(false)}>Send more</button>
              </div>
            ) : (
              <div>
                <div className="mb-2">
                  <label className="block text-xs">Name</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-xl px-3 py-2 border" />
                </div>
                <div className="mb-2">
                  <label className="block text-xs">Email</label>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-xl px-3 py-2 border" />
                </div>
                <div className="mb-2">
                  <label className="block text-xs">Feedback *</label>
                  <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} className="w-full rounded-xl px-3 py-2 border" />
                </div>
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-xs text-slate-500">How would you rate your experience?</div>
                  <div className="flex gap-1">
                    {[1,2,3,4,5].map((s) => (
                      <button key={s} onClick={() => setRating(s)} className={cn("px-2 py-1 rounded", rating>=s ? "bg-yellow-400" : "bg-slate-100")}>{s}</button>
                    ))}
                  </div>
                </div>
                {error && <div className="text-sm text-red-500 mb-2">{error}</div>}
                <div className="flex gap-2">
                  <button onClick={handleSubmit} disabled={sending} className="rounded-xl bg-blue-500 text-white px-4 py-2">{sending ? "Sending..." : "Send Feedback"}</button>
                  <button onClick={() => setOpen(false)} className="rounded-xl border px-4 py-2">Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

