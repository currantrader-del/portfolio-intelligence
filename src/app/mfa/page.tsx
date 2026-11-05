"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Mode = { kind: "loading" } | { kind: "enroll"; factorId: string; qr: string; secret: string } | { kind: "verify"; factorId: string };

export default function MfaPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) return setError("Could not load two-factor settings.");
      const verified = data.totp.find((f) => f.status === "verified");
      if (verified) return setMode({ kind: "verify", factorId: verified.id });
      const enrolled = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "Authenticator app" });
      if (enrolled.error) return setError("Could not start two-factor setup.");
      setMode({ kind: "enroll", factorId: enrolled.data.id, qr: enrolled.data.totp.qr_code, secret: enrolled.data.totp.secret });
    })();
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode.kind === "loading") return;
    setError(null);
    const { error } = await createClient().auth.mfa.challengeAndVerify({ factorId: mode.factorId, code: code.trim() });
    if (error) return setError("That code didn't work. Try the newest one.");
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="min-h-screen grid place-items-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-surface border border-line rounded-2xl p-8 flex flex-col gap-4">
        <h1 className="font-serif text-2xl font-semibold">Two-factor verification</h1>
        {mode.kind === "enroll" && (
          <>
            <p className="text-sm text-muted">Scan this with an authenticator app, then enter the 6-digit code.</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={mode.qr} alt="Two-factor setup QR code" className="w-48 h-48 self-center bg-white p-2 rounded" />
            <p className="text-xs text-muted break-all">Or enter this key: <span className="font-mono">{mode.secret}</span></p>
          </>
        )}
        {mode.kind === "verify" && <p className="text-sm text-muted">Enter the 6-digit code from your authenticator app.</p>}
        {mode.kind === "loading" && !error && <p className="text-sm text-muted">Loading…</p>}
        <label className="flex flex-col gap-1 text-sm">
          Code
          <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required value={code} onChange={(e) => setCode(e.target.value)}
            className="min-h-11 px-3 rounded-lg border border-line-strong bg-surface font-mono text-lg tracking-widest" />
        </label>
        {error && <p role="alert" className="text-sm text-alert-ink">{error}</p>}
        <button disabled={mode.kind === "loading"} className="min-h-11 rounded-lg bg-ink text-ground font-medium disabled:opacity-60">Verify</button>
      </form>
    </main>
  );
}
