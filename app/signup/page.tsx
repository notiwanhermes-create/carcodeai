"use client";

import { useEffect, useState } from "react";
import { getProviders, signIn } from "next-auth/react";
import Link from "next/link";
import { authErrorMessage } from "@/app/lib/auth-errors";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

export default function SignupPage() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState("");
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getProviders()
      .then((providers) => {
        if (!cancelled) setGoogleEnabled(Boolean(providers?.google));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password.length < 6) {
      setError(authErrorMessage("weak_password"));
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/account/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, firstName: firstName.trim(), lastName: lastName.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; code?: string };
      if (res.ok && data.ok) {
        setSentTo(email.trim());
        setPassword("");
        setConfirmPassword("");
      } else {
        setError(authErrorMessage(data.code));
      }
    } catch {
      setError(authErrorMessage("server_error"));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!sentTo || resending) return;
    setResending(true);
    setResendNotice("");
    try {
      const res = await fetch("/api/account/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: sentTo }),
      });
      const data = (await res.json().catch(() => ({}))) as { code?: string };
      setResendNotice(res.ok ? "Sent. Check your inbox and spam folder." : authErrorMessage(data.code));
    } catch {
      setResendNotice(authErrorMessage("server_error"));
    } finally {
      setResending(false);
    }
  };

  const handleGoogleSignIn = () => {
    signIn("google", { callbackUrl: "/" });
  };

  return (
    <main className="min-h-screen bg-[#0f172a] text-slate-100 flex items-center justify-center px-4 py-8">
      <div className="mesh-background">
        <div className="mesh-blob mesh-blob-1" />
        <div className="mesh-blob mesh-blob-2" />
      </div>

      <div className="relative z-10 w-full max-w-md">
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-500 shadow-lg shadow-blue-500/30">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                <path d="M17 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                <path d="M5 17H3v-4l2-5h9l4 5h1a2 2 0 0 1 2 2v2h-2" />
                <path d="M9 17h6" /><path d="M14 8V3" /><path d="M10 5h8" />
              </svg>
            </div>
            <span className="text-2xl font-bold tracking-tight bg-gradient-to-r from-white to-blue-200 bg-clip-text text-transparent">CarCode AI</span>
          </Link>
        </div>

        {sentTo ? (
          <div className="glass-card-strong rounded-3xl p-8" role="status">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/20">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
            </div>
            <h1 className="mt-5 text-center text-xl font-bold text-white">Check your email</h1>
            <p className="mt-2 text-center text-sm text-slate-400">
              We sent a confirmation link to <span className="font-medium text-slate-200 break-all">{sentTo}</span>.
              Open it and sign in with your password to activate your account. The link works for 24 hours.
            </p>

            <div className="mt-6 grid gap-3">
              <button
                type="button"
                onClick={handleResend}
                disabled={resending}
                className="w-full rounded-xl border border-white/10 bg-white/5 py-3 text-sm font-medium text-slate-300 transition-all hover:bg-white/10 disabled:opacity-60"
              >
                {resending ? "Sending..." : "Send the email again"}
              </button>
              {resendNotice && <p className="text-center text-xs text-slate-400">{resendNotice}</p>}
              <Link href="/login" className="text-center text-sm font-medium text-cyan-400 hover:text-cyan-300 transition-colors">
                Go to sign in
              </Link>
            </div>
          </div>
        ) : (
          <div className="glass-card-strong rounded-3xl p-8">
            <h1 className="text-xl font-bold text-white mb-1">Create your account</h1>
            <p className="text-sm text-slate-400 mb-6">Save your vehicles and track maintenance</p>

            {error && (
              <div role="alert" className="mb-4 rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="signup-first-name" className="block text-xs font-medium text-slate-300 mb-1.5">First name</label>
                  <input
                    id="signup-first-name"
                    type="text"
                    autoComplete="given-name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    maxLength={60}
                    placeholder="John"
                    className="glass-input w-full rounded-xl px-4 py-3 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="signup-last-name" className="block text-xs font-medium text-slate-300 mb-1.5">Last name</label>
                  <input
                    id="signup-last-name"
                    type="text"
                    autoComplete="family-name"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    maxLength={60}
                    placeholder="Doe"
                    className="glass-input w-full rounded-xl px-4 py-3 text-sm"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="signup-email" className="block text-xs font-medium text-slate-300 mb-1.5">Email</label>
                <input
                  id="signup-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  maxLength={254}
                  placeholder="you@example.com"
                  className="glass-input w-full rounded-xl px-4 py-3 text-sm"
                />
              </div>
              <div>
                <label htmlFor="signup-password" className="block text-xs font-medium text-slate-300 mb-1.5">Password</label>
                <input
                  id="signup-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  maxLength={200}
                  placeholder="At least 6 characters"
                  className="glass-input w-full rounded-xl px-4 py-3 text-sm"
                />
              </div>
              <div>
                <label htmlFor="signup-confirm-password" className="block text-xs font-medium text-slate-300 mb-1.5">Confirm password</label>
                <input
                  id="signup-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  maxLength={200}
                  placeholder="Confirm your password"
                  className="glass-input w-full rounded-xl px-4 py-3 text-sm"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className={cn(
                  "w-full rounded-xl py-3 text-sm font-semibold transition-all",
                  loading
                    ? "bg-white/5 text-slate-500 cursor-not-allowed"
                    : "bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40"
                )}
              >
                {loading ? "Creating account..." : "Create Account"}
              </button>
            </form>

            {googleEnabled && (
              <>
                <div className="relative my-6">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-white/10" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="bg-[#1a2332] px-3 text-slate-500">or continue with</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  className="w-full flex items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-slate-300 transition-all hover:bg-white/10"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                  Sign up with Google
                </button>
              </>
            )}

            <p className="mt-6 text-center text-sm text-slate-400">
              Already have an account?{" "}
              <Link href="/login" className="text-cyan-400 hover:text-cyan-300 font-medium transition-colors">
                Sign in
              </Link>
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
