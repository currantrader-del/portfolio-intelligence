"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/forms";

type State = "wait" | "run" | "done" | "fail" | "reused";
type Step = { key: string; label: string; state: State; note?: string | null };
const DESKS = [
  { key: "world", label: "World and geopolitics" },
  { key: "us", label: "US economy and policy" },
  { key: "markets", label: "Markets, sectors and catalysts" },
  { key: "events", label: "Upcoming events" },
  { key: "holdings", label: "Holdings: filings and research" },
];
const POLL_MS = 4000;
const DEADLINE_MS = 8 * 60000; // matches DESK_DEADLINE_MIN on the server

async function call(body: Record<string, unknown>) {
  const res = await fetch("/api/intel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {
    throw new Error(navigator.onLine === false ? "You're offline. Results that were already saved are kept; try again when you're connected." : "Couldn't reach the app. Check your connection and try again.");
  });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}
async function status(snapshotId: string) {
  const res = await fetch(`/api/intel?snapshotId=${encodeURIComponent(snapshotId)}`, { cache: "no-store" });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as { startedAt: string; rows: number; macro: number; desks: { key: string; state: State; note: string | null }[]; briefingId: string | null };
}

/**
 * Starts the briefing and watches its background jobs. The jobs keep running and saving if this page
 * is closed; opening the page again resumes watching (resume = a snapshot id still in progress).
 */
export function BriefingRunner({ auto, resume, label = "Generate briefing" }: { auto: boolean; resume?: string | null; label?: string }) {
  const router = useRouter();
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  async function watch(snapshotId: string, t0: number) {
    let fallbackSent = false;
    let settledAt: number | null = null;
    for (;;) {
      const s = await status(snapshotId);
      setSteps([
        { key: "snap", label: "Market and economic data", state: "done", note: `${s.rows} markets, ${s.macro} economic series` },
        ...DESKS.map((d) => { const x = s.desks.find((y) => y.key === d.key); return { ...d, state: x?.state ?? "run", note: x?.note }; }),
        { key: "synth", label: "Outlooks and portfolio implications", state: s.briefingId ? "done" : "run" },
      ]);
      if (s.briefingId) { router.refresh(); return; }
      const settled = s.desks.every((d) => d.state !== "run");
      if (settled && settledAt === null) settledAt = Date.now();
      // Fallback: if the jobs did not start the writing step (or a desk never reported), start it from here.
      const late = Date.now() - t0 > DEADLINE_MS;
      if (!fallbackSent && ((settledAt && Date.now() - settledAt > 45000) || late)) { fallbackSent = true; await call({ action: "synthesize", snapshotId }).catch(() => {}); }
      if (Date.now() - t0 > DEADLINE_MS + 5 * 60000) throw new Error("The briefing did not finish within 13 minutes. Results that were saved are kept; try again.");
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  async function run(force = false) {
    if (started.current) return;
    started.current = true;
    setBusy(true);
    setError(null);
    setSteps([{ key: "snap", label: "Market and economic data", state: "run" }, ...DESKS.map((d) => ({ ...d, state: "wait" as const })), { key: "synth", label: "Outlooks and portfolio implications", state: "wait" }]);
    try {
      const snap = await call({ action: "start", force });
      await watch(snap.snapshotId, Date.now());
    } catch (e) {
      setError((e as Error).message);
      setSteps((s) => s?.map((x) => (x.state === "run" ? { ...x, state: "fail" } : x)) ?? null);
    } finally {
      started.current = false;
      setBusy(false);
    }
  }

  async function resumeWatch(id: string) {
    if (started.current) return;
    started.current = true;
    setBusy(true);
    try {
      const s = await status(id);
      await watch(id, Date.parse(s.startedAt));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      started.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (resume) void resumeWatch(resume);
    else if (auto) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, resume]);

  const icon = (s: State) => (s === "done" ? "✓" : s === "reused" ? "↺" : s === "fail" ? "✕" : s === "run" ? "…" : "○");
  return (
    <div className="flex flex-col gap-2">
      {steps && (
        <ul className="flex flex-col gap-1 t-sm" aria-live="polite">
          {steps.map((s) => (
            <li key={s.key} className="flex gap-2">
              <span aria-hidden className={s.state === "fail" ? "loss" : s.state === "done" || s.state === "reused" ? "gain" : ""}>{icon(s.state)}</span>
              <span>{s.label}{s.note ? <span className="t-xs"> · {s.note}</span> : null}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`btn ${busy ? "is-pending" : ""}`} disabled={busy} aria-busy={busy || undefined} onClick={() => void run(false)}>{busy ? <><Spinner />Working… 2 to 4 minutes</> : label}</button>
        {!busy && label !== "Generate briefing" && <button type="button" className="btn" onClick={() => void run(true)}>Search again from scratch</button>}
      </div>
      {busy && <p className="t-xs">Research runs in the background and is saved as each part finishes. You can leave this page.</p>}
    </div>
  );
}
