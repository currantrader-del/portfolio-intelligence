"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/forms";
import { requestPaidJSON } from "@/lib/client/request";

/** How long the button waits for a started rebuild to appear before giving up on the spinner. */
const GIVE_UP_MS = 5 * 60_000;

/**
 * Rebuild button for the portfolio plan; refreshes the page until a running rebuild finishes.
 * It keeps refreshing after a start until the server reports the rebuild running or a newer plan
 * (latestAt changes), so a fast rebuild that finishes between refreshes can never leave it stuck.
 */
export function PlanRunner({ running, hasPlan, latestAt = null }: { running: boolean; hasPlan: boolean; latestAt?: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedFrom = useRef<{ at: string | null; when: number } | null>(null);
  const active = running || busy;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (busy && startedFrom.current && Date.now() - startedFrom.current.when > GIVE_UP_MS) { setBusy(false); startedFrom.current = null; return; }
      router.refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [active, busy, router]);
  useEffect(() => {
    if (running) { setBusy(false); startedFrom.current = null; return; }
    if (busy && startedFrom.current && latestAt !== startedFrom.current.at) { setBusy(false); startedFrom.current = null; }
  }, [running, latestAt, busy]);

  async function start() {
    if (active) return;
    setBusy(true); setError(null);
    startedFrom.current = { at: latestAt, when: Date.now() };
    const r = await requestPaidJSON("/api/plan", { json: {} });
    if (!r.ok) { setError(r.error); setBusy(false); startedFrom.current = null; return; }
    router.refresh();
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={`btn btn-sm ${hasPlan ? "" : "btn-primary"} ${active ? "is-pending" : ""}`} onClick={start} disabled={active} aria-busy={active || undefined}>
        {busy && !running ? <><Spinner />Starting…</> : active ? <><Spinner />Building the plan… (1–3 min)</> : hasPlan ? "Rebuild now" : "Build my plan"}
      </button>
      {error && <span role="alert" className="form-note form-note-error basis-full">{error}</span>}
    </div>
  );
}
