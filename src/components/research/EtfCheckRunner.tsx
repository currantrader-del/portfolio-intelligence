"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/forms";
import { requestPaidJSON } from "@/lib/client/request";

type Status = { status: "none" | "running" | "lost" | "done"; startedAt?: string };

/** Starts the paid ETF check (asks first with the cost) and refreshes the page when it is saved. */
export function EtfCheckRunner({ symbol, label, estimate }: { symbol: string; label: string; estimate: string }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/research/etf?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      const s = (await res.json()) as Status;
      if (s.status === "running") { setRunning(true); timer.current = setTimeout(poll, 5000); return; }
      setRunning((was) => { if (was) router.refresh(); return false; });
    } catch {
      timer.current = setTimeout(poll, 10000);
    }
  }, [symbol, router]);
  useEffect(() => { poll(); return () => { if (timer.current) clearTimeout(timer.current); }; }, [poll]);

  async function start() {
    if (starting || running) return;
    setError(null);
    setStarting(true);
    const r = await requestPaidJSON("/api/research/etf", { json: { symbol } });
    setStarting(false);
    if (!r.ok) { setError(r.error); return; }
    setRunning(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(poll, 5000);
  }
  const busy = starting || running;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" className={`btn btn-sm ${busy ? "is-pending" : ""}`} onClick={start} disabled={busy} aria-busy={busy || undefined}>
        {starting ? <><Spinner />Starting…</> : running ? <><Spinner />Checking… (1-3 min)</> : label}
      </button>
      {!busy && <span className="t-xs">{estimate}</span>}
      {error && <span role="alert" className="form-note form-note-error basis-full">{error}</span>}
    </span>
  );
}
