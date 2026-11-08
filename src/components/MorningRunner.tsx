"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/forms";
import { requestJSON, requestPaidJSON } from "@/lib/client/request";

const GIVE_UP_MS = 6 * 60_000;

/** "Write it now": asks the morning question on demand and refreshes Today when the answer is stored. */
export function MorningRunner({ label }: { label: string }) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    const t0 = Date.now();
    const t = setInterval(async () => {
      const r = await requestJSON<{ status?: string; answer?: { error?: string } }>(`/api/ask?id=${id}`, { method: "GET" });
      if (r.ok && r.data.status === "done") {
        setId(null);
        if (r.data.answer?.error) setError(`The answer failed: ${r.data.answer.error}`);
        router.refresh();
      } else if (Date.now() - t0 > GIVE_UP_MS) {
        setId(null);
        setError("This is taking longer than usual. It will appear here when it finishes; reload in a few minutes.");
      }
    }, 4000);
    return () => clearInterval(t);
  }, [id, router]);
  async function start() {
    if (starting || id) return;
    setError(null);
    setStarting(true);
    const r = await requestPaidJSON<{ requestId?: string }>("/api/ask", { json: { action: "morning" } });
    setStarting(false);
    if (!r.ok || !r.data.requestId) setError(r.ok ? "It didn't start. Try again." : r.error); else setId(r.data.requestId);
  }
  const busy = starting || !!id;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" className={`btn btn-sm ${busy ? "is-pending" : ""}`} onClick={start} disabled={busy} aria-busy={busy || undefined}>
        {starting ? <><Spinner />Starting…</> : id ? <><Spinner />Writing… (about a minute)</> : label}
      </button>
      {error && <span role="alert" className="form-note form-note-error basis-full">{error}</span>}
    </span>
  );
}
