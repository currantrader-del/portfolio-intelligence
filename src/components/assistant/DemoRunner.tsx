"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** Starts the five test questions and refreshes the page until every answer is in. */
export function DemoRunner({ running }: { running: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 8000);
    return () => clearInterval(t);
  }, [running, router]);
  async function start() {
    setBusy(true); setError(null);
    const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "demo" }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(j.error ?? `HTTP ${res.status}`);
    setBusy(false);
    router.refresh();
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn" onClick={start} disabled={busy || running}>{running ? "Answering… (refreshes itself)" : busy ? "Starting…" : "Run the five questions"}</button>
      <span className="t-xs">Takes about 2-4 minutes. Costs roughly $1-3 for all ten answers.</span>
      {error && <span className="t-sm warn">{error}</span>}
    </div>
  );
}
