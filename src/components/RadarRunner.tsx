"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/forms";
import { requestPaidJSON } from "@/lib/client/request";

/** "Run Radar now"; refreshes the page until the run finishes. */
export function RadarRunner({ running }: { running: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = running || busy;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(t);
  }, [running, router]);
  useEffect(() => { if (running) setBusy(false); }, [running]);

  async function start() {
    if (active) return;
    setBusy(true); setError(null);
    const r = await requestPaidJSON("/api/radar", { json: {} });
    if (!r.ok) { setError(r.error); setBusy(false); return; }
    router.refresh();
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={start} className={`btn btn-sm ${active ? "is-pending" : ""}`} disabled={active} aria-busy={active || undefined}>{busy && !running ? <><Spinner />Starting…</> : active ? <><Spinner />Looking… (3–6 min)</> : "Run Radar now (about $0.45)"}</button>
      {error && <span role="alert" className="form-note form-note-error basis-full">{error}</span>}
    </div>
  );
}
