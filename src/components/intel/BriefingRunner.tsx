"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Step = { key: string; label: string; state: "wait" | "run" | "done" | "fail"; note?: string };
const DESKS = [
  { key: "world", label: "World and geopolitics" },
  { key: "us", label: "US economy and policy" },
  { key: "markets", label: "Markets, sectors and catalysts" },
  { key: "events", label: "Upcoming events" },
];

async function call(body: Record<string, unknown>) {
  const res = await fetch("/api/intel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

/** Runs the briefing pipeline step by step from the browser, so no single server call runs long. */
export function BriefingRunner({ auto, label = "Generate briefing" }: { auto: boolean; label?: string }) {
  const router = useRouter();
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  // When only the last step failed, it can be retried without paying for the research again.
  const [retrySnap, setRetrySnap] = useState<string | null>(null);
  const set = (key: string, patch: Partial<Step>) => setSteps((s) => s?.map((x) => (x.key === key ? { ...x, ...patch } : x)) ?? null);

  async function synthesize(snapshotId: string) {
    set("synth", { state: "run", note: undefined });
    try {
      const out = await call({ action: "synthesize", snapshotId });
      set("synth", { state: "done", note: `about $${Number(out.costUsd).toFixed(2)} for this briefing` });
      setRetrySnap(null);
      router.refresh();
    } catch (e) {
      setRetrySnap(snapshotId);
      throw e;
    }
  }

  async function retry() {
    if (started.current || !retrySnap) return;
    started.current = true;
    setError(null);
    try { await synthesize(retrySnap); } catch (e) { setError((e as Error).message); set("synth", { state: "fail" }); } finally { started.current = false; }
  }

  async function run() {
    if (started.current) return;
    started.current = true;
    setError(null);
    setRetrySnap(null);
    setSteps([{ key: "snap", label: "Market and macro data", state: "run" }, ...DESKS.map((d) => ({ ...d, state: "wait" as const })), { key: "synth", label: "Outlooks and portfolio implications", state: "wait" }]);
    try {
      const snap = await call({ action: "start" });
      set("snap", { state: "done", note: `${snap.rows} markets, ${snap.macro} macro series${snap.missing ? `, ${snap.missing} unavailable` : ""}` });
      DESKS.forEach((d) => set(d.key, { state: "run" }));
      const results = await Promise.allSettled(DESKS.map(async (d) => {
        try {
          const r = await call({ action: "desk", snapshotId: snap.snapshotId, desk: d.key });
          set(d.key, { state: "done", note: `${r.items} items, ${r.searches} searches${r.unsourced ? `, ${r.unsourced} unsourced` : ""}` });
        } catch (e) {
          set(d.key, { state: "fail", note: (e as Error).message });
          throw e;
        }
      }));
      if (results.every((r) => r.status === "rejected")) throw new Error("No research desk finished, so there is nothing to synthesize.");
      await synthesize(snap.snapshotId);
    } catch (e) {
      setError((e as Error).message);
      setSteps((s) => s?.map((x) => (x.state === "run" ? { ...x, state: "fail" } : x)) ?? null);
    } finally {
      started.current = false;
    }
  }

  useEffect(() => {
    if (auto) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  const busy = steps?.some((s) => s.state === "run");
  return (
    <div className="flex flex-col gap-2">
      {steps && (
        <ul className="flex flex-col gap-1 t-sm" aria-live="polite">
          {steps.map((s) => (
            <li key={s.key} className="flex gap-2">
              <span aria-hidden className={s.state === "fail" ? "loss" : s.state === "done" ? "gain" : ""}>{s.state === "done" ? "✓" : s.state === "fail" ? "✕" : s.state === "run" ? "…" : "○"}</span>
              <span>{s.label}{s.note ? <span className="t-xs"> · {s.note}</span> : null}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {retrySnap && !busy && <button type="button" className="btn" onClick={() => void retry()}>Retry the outlooks only</button>}
        <button type="button" className="btn" disabled={busy} onClick={() => void run()}>{busy ? "Working… about a minute" : label}</button>
      </div>
    </div>
  );
}
