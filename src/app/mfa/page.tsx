"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Mode = { kind: "loading" } | { kind: "verify"; factorId: string };

export default function MfaPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) return setError("Could not load two-factor settings.");
      const verified = data.totp.find((f) => f.status === "verified");
      if (verified) return setMode({ kind: "verify", factorId: verified.id });
      // No authenticator enrolled: two-factor is optional, so go straight in.
      router.replace("/");
    })();
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode.kind === "loading" || busy) return;
    setError(null);
    setBusy(true);
    let failed: string | null = null;
    try {
      const { error } = await createClient().auth.mfa.challengeAndVerify({ factorId: mode.factorId, code: code.trim() });
      if (error) failed = "That code didn't work. Try the newest one.";
    } catch {
      failed = "Couldn't reach the sign-in service. Check your connection and try again.";
    }
    if (failed) { setBusy(false); return setError(failed); }
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="min-h-screen grid place-items-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-surface border border-line rounded-2xl p-8 flex flex-col gap-4">
        <h1 className="h1">Two-factor verification</h1>
        {mode.kind === "verify" && <p className="text-sm text-muted">Enter the 6-digit code from your authenticator app.</p>}
        {mode.kind === "loading" && !error && <p className="text-sm text-muted">Loading…</p>}
        <label className="flex flex-col gap-1 text-sm">
          Code
          <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required value={code} onChange={(e) => setCode(e.target.value)}
            className="min-h-11 px-3 rounded-lg border border-line-strong bg-surface font-mono text-lg tracking-widest" />
        </label>
        {error && <p role="alert" className="text-sm text-alert-ink">{error}</p>}
        <button disabled={mode.kind === "loading" || busy} aria-busy={busy || undefined} className={`btn btn-primary ${busy ? "is-pending" : ""}`}>{busy ? <><span className="spin" aria-hidden="true" />Verifying…</> : "Verify"}</button>
      </form>
    </main>
  );
}
