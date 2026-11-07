"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
    setBusy(true); setError(null);
    const res = await fetch("/api/plan", { method: "POST" });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) { setError(j.error ?? `HTTP ${res.status}`); setBusy(false); return; }
    router.refresh();
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={`btn btn-sm ${hasPlan ? "" : "btn-primary"}`} onClick={start} disabled={active}>
        {active ? "Building the plan… (1–3 min)" : hasPlan ? "Rebuild now" : "Build my plan"}
      </button>
      {error && <span role="alert" className="t-sm warn">{error}</span>}
    </div>
  );
}
