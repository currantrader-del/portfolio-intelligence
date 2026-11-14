"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/forms";
import { requestJSON } from "@/lib/client/request";

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
    if (busy || running) return;
    setBusy(true); setError(null);
    const r = await requestJSON("/api/ask", { json: { action: "demo" } });
    if (!r.ok) setError(r.error);
    setBusy(false);
    if (r.ok) router.refresh();
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={`btn ${busy || running ? "is-pending" : ""}`} onClick={start} disabled={busy || running} aria-busy={busy || running || undefined}>{running ? <><Spinner />Answering… (refreshes itself)</> : busy ? <><Spinner />Starting…</> : "Run the five questions"}</button>
      <span className="t-xs">Takes about 2-4 minutes. Costs roughly $1-3 for all ten answers.</span>
      {error && <span role="alert" className="form-note form-note-error basis-full">{error}</span>}
    </div>
  );
}
