"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    let failed: string | null = null;
    try {
      const { error } = await createClient().auth.signInWithPassword({ email, password });
      if (error) failed = /fetch|network/i.test(error.message) ? "Couldn't reach the sign-in service. Check your connection and try again." : "Sign-in failed. Check your email and password.";
    } catch {
      failed = "Couldn't reach the sign-in service. Check your connection and try again.";
    }
    // On success the button keeps its spinner until the app has opened.
    if (failed) { setBusy(false); return setError(failed); }
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="min-h-screen grid place-items-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-surface border border-line rounded-2xl p-8 flex flex-col gap-4">
        <h1 className="h1">Portfolio Intelligence</h1>
        <p className="text-sm text-muted">Sign in to continue.</p>
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
            className="min-h-11 px-3 rounded-lg border border-line-strong bg-surface text-base" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
            className="min-h-11 px-3 rounded-lg border border-line-strong bg-surface text-base" />
        </label>
        {error && <p role="alert" className="text-sm text-alert-ink">{error}</p>}
        <button disabled={busy} aria-busy={busy || undefined} className={`btn btn-primary ${busy ? "is-pending" : ""}`}>
          {busy ? <><span className="spin" aria-hidden="true" />Signing in…</> : "Continue"}
        </button>
      </form>
    </main>
  );
}
