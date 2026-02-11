"use client";

import { useState, useCallback } from "react";

type Row = {
  created_at: string;
  rating: number | null;
  name: string | null;
  email: string | null;
  page_url: string | null;
  message: string;
};

export default function AdminFeedbackClient({
  initialRows,
}: {
  initialRows: Row[] | null;
}) {
  const [inputPassword, setInputPassword] = useState("");
  const [rows, setRows] = useState<Row[] | null>(initialRows);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authorized = rows !== null;

  const fetchFeedback = useCallback(async (authToken: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/feedback", {
        headers: { "x-admin-token": authToken },
        cache: "no-store",
      });
      if (!res.ok) {
        if (res.status === 401) {
          setError("Invalid token");
          return;
        }
        setError("Failed to load feedback");
        return;
      }
      const data = await res.json();
      setRows(data);
    } catch {
      setError("Failed to load feedback");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const t = inputPassword.trim();
    if (!t) return;
    fetchFeedback(t);
  };

  if (!authorized && !loading) {
    return (
      <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-xl font-semibold text-slate-200">Admin — Feedback</h1>
        <p className="mt-2 text-sm text-slate-400">Enter the admin token to view feedback.</p>
        <form onSubmit={handleLogin} className="mt-6">
          <input
            type="password"
            value={inputPassword}
            onChange={(e) => setInputPassword(e.target.value)}
            placeholder="Admin token"
            className="w-full rounded border border-slate-600 bg-slate-800/50 px-4 py-2 text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            autoComplete="off"
          />
          <button
            type="submit"
            className="mt-4 w-full rounded bg-cyan-600 px-4 py-2 font-medium text-white hover:bg-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 focus:ring-offset-slate-900"
          >
            View feedback
          </button>
        </form>
        {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      </main>
    );
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-10">
        <h1 className="text-xl font-semibold text-slate-200">Admin — Feedback</h1>
        <p className="mt-4 text-slate-400">Loading…</p>
      </main>
    );
  }

  if (error && !rows) {
    return (
      <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-xl font-semibold text-slate-200">Admin — Feedback</h1>
        <p className="mt-4 text-red-400">{error}</p>
        <button
          type="button"
          onClick={() => { setError(null); setRows(null); setInputPassword(""); }}
          className="mt-4 text-sm text-cyan-400 hover:text-cyan-300"
        >
          Try again
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-xl font-semibold text-slate-200">Admin — Feedback</h1>
      <p className="mt-1 text-sm text-slate-400">
        Latest 200 rows (newest first). Token is in memory only; refresh to re-enter.
      </p>
      <div className="mt-6 overflow-x-auto rounded border border-slate-700">
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-slate-700 bg-slate-800/80">
              <th className="whitespace-nowrap px-4 py-3 font-medium text-slate-300">created_at</th>
              <th className="whitespace-nowrap px-4 py-3 font-medium text-slate-300">rating</th>
              <th className="whitespace-nowrap px-4 py-3 font-medium text-slate-300">name</th>
              <th className="whitespace-nowrap px-4 py-3 font-medium text-slate-300">email</th>
              <th className="whitespace-nowrap px-4 py-3 font-medium text-slate-300">page_url</th>
              <th className="px-4 py-3 font-medium text-slate-300">message</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((row, i) => (
              <tr key={i} className="border-b border-slate-800 hover:bg-slate-800/40">
                <td className="whitespace-nowrap px-4 py-2 text-slate-400">
                  {row.created_at ? new Date(row.created_at).toISOString().replace("T", " ").slice(0, 19) : "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-slate-300">{row.rating ?? "—"}</td>
                <td className="max-w-[120px] truncate px-4 py-2 text-slate-300" title={row.name ?? ""}>
                  {row.name || "—"}
                </td>
                <td className="max-w-[180px] truncate px-4 py-2 text-slate-300" title={row.email ?? ""}>
                  {row.email || "—"}
                </td>
                <td className="max-w-[200px] truncate px-4 py-2 text-slate-400" title={row.page_url ?? ""}>
                  {row.page_url || "—"}
                </td>
                <td className="max-w-[320px] truncate px-4 py-2 text-slate-300" title={row.message}>
                  {row.message || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows && rows.length === 0 && (
        <p className="mt-4 text-slate-500">No feedback yet.</p>
      )}
    </main>
  );
}
