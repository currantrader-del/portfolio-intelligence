"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/forms";
import { requestJSON } from "@/lib/client/request";

/** Rebuild button for the portfolio plan; refreshes the page until a running rebuild finishes. */
export function PlanRunner({ running, hasPlan }: { running: boolean; hasPlan: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = running || busy;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 6000);
    return () => clearInterval(t);
  }, [running, router]);
  useEffect(() => { if (running) setBusy(false); }, [running]);

  async function start() {
    if (active) return;
    setBusy(true); setError(null);
    const r = await requestJSON("/api/plan", { method: "POST" });
    if (!r.ok) { setError(r.error); setBusy(false); return; }
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
