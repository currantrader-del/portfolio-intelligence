"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/forms";
import { requestJSON } from "@/lib/client/request";

/** "Look for a trade" with an optional ticker; refreshes the page until the search finishes. */
export function TradeRunner({ running }: { running: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const active = running || busy;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 8000);
    return () => clearInterval(t);
  }, [running, router]);
  useEffect(() => { if (running) setBusy(false); }, [running]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (active) return;
    setBusy(true); setError(null);
    const r = await requestJSON("/api/trades", { json: { focus: focus.trim() || undefined } });
    if (!r.ok) { setError(r.error); setBusy(false); return; }
    router.refresh();
  }
  return (
    <form onSubmit={start} className="flex flex-wrap items-center gap-2">
      <input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Ticker (optional)" aria-label="Ticker to start with (optional)" maxLength={10}
        className="min-h-11 w-40 rounded-[12px] bg-surface-2 border border-line px-3 text-[15px] uppercase placeholder:normal-case" disabled={active} />
      <button type="submit" className={`btn btn-primary btn-sm ${active ? "is-pending" : ""}`} disabled={active} aria-busy={active || undefined}>{busy && !running ? <><Spinner />Starting…</> : active ? <><Spinner />Looking… (2–5 min)</> : "Look for a trade"}</button>
      {error && <span role="alert" className="form-note form-note-error basis-full">{error}</span>}
    </form>
  );
}
