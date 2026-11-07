"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** "Write it now": asks the morning question on demand and refreshes Today when the answer is stored. */
export function MorningRunner({ label }: { label: string }) {
  const router = useRouter();
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    const t = setInterval(async () => {
      const j = await fetch(`/api/ask?id=${id}`).then((r) => r.json()).catch(() => null);
      if (j?.status === "done") { setId(null); router.refresh(); }
    }, 4000);
    return () => clearInterval(t);
  }, [id, router]);
  async function start() {
    setError(null);
    const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "morning" }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.requestId) setError(j.error ?? `HTTP ${res.status}`); else setId(j.requestId);
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-sm" onClick={start} disabled={!!id}>{id ? "Writing… (about a minute)" : label}</button>
      {error && <span className="t-sm warn">{error}</span>}
    </span>
  );
}
