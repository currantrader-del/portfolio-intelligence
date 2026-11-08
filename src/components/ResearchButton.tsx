"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHead, Pill } from "@/components/ui";
import { Spinner } from "@/components/forms";
import { requestJSON } from "@/lib/client/request";

type Result = { ok: boolean; error?: string; madeCurrent?: boolean; completeness?: string; problems?: string[]; summary?: string; costUsd: number; ms: number; searches: number };
type Status =
  | { status: "none" }
  | { status: "running" | "lost"; startedAt: string }
  | { status: "done"; startedAt: string; finishedAt: string; result: Result };

const mins = (ms: number) => `${Math.max(1, Math.round(ms / 60000))} min`;

/** The preliminary screen: one quick AI pass to decide whether a company deserves a full investigation. */
export function ResearchButton({ symbol, hasResearch, needsResearch }: { symbol: string; hasResearch: boolean; needsResearch: boolean }) {
  const router = useRouter();
  const [st, setSt] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/research?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      const s = (await res.json()) as Status & { error?: string };
      if (!res.ok) { setError(s.error ?? "Could not check the research status."); return; }
      setSt((prev) => {
        if (prev?.status === "running" && s.status === "done") router.refresh();
        return s;
      });
      if (s.status === "running") timer.current = setTimeout(poll, 5000);
    } catch {
      timer.current = setTimeout(poll, 10000);
    }
  }, [symbol, router]);

  useEffect(() => { poll(); return () => { if (timer.current) clearTimeout(timer.current); }; }, [poll]);
  useEffect(() => {
    if (st?.status !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [st?.status]);

  async function start(confirm = false) {
    if (starting) return;
    setError(null);
    setNeedsConfirm(false);
    setStarting(true);
    const r = await requestJSON<{ needsConfirm?: boolean }>("/api/research", { json: { symbol, confirm } });
    setStarting(false);
    if (!r.ok) { setNeedsConfirm(!!r.data?.needsConfirm); setError(r.data?.needsConfirm ? r.error : `Research did not start. ${r.error}`); return; }
    setSt({ status: "running", startedAt: new Date().toISOString() });
    setNow(Date.now());
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(poll, 5000);
  }

  const running = st?.status === "running";
  const elapsed = running ? Math.floor((now - new Date(st.startedAt).getTime()) / 1000) : 0;
  const done = st?.status === "done" ? st : null;
  const last = done?.result ?? null;

  return (
    <Card labelledBy="ai-r-h" className="!gap-3">
      <CardHead id="ai-r-h" title="Quick screen" right={running ? <Pill small tone="copper" dot="solid">Running</Pill> : needsResearch ? <Pill small tone="warn">Needed</Pill> : null} />
      {running ? (
        <p className="t-sm" role="status" aria-live="polite">
          Screening {symbol}. {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")} so far; this usually takes 1–2 minutes.
        </p>
      ) : (
        <p className="t-sm">
          A one-minute first pass from the SEC data, a few searches and excerpts of the latest filings, to decide whether {symbol} deserves a full investigation. It is not an investment rating and is never used for decisions. About $0.25.
        </p>
      )}
      {last && !running && (
        <div className="t-sm rounded-[12px] bg-surface-2 px-3 py-2 flex flex-col gap-1">
          {last.ok ? (
            <>
              <span className="text-ink font-semibold">
                Last run {new Date(done!.finishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}: screen saved (not used for decisions)
              </span>
              {last.problems && last.problems.length > 0 && <span className="t-xs warn">Gaps: {last.problems.join("; ")}</span>}
              <span className="t-xs">{mins(last.ms)} · {last.searches} searches · ${last.costUsd.toFixed(2)}</span>
            </>
          ) : (
            <span className="warn">Last run failed: {last.error}</span>
          )}
        </div>
      )}
      {st?.status === "lost" && <p className="t-xs warn">The last run never finished. You can start it again.</p>}
      {error && <p role="alert" className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2">{error}</p>}
      {needsConfirm && <button type="button" className="btn btn-sm self-start" onClick={() => start(true)} disabled={starting}>Start anyway</button>}
      <button type="button" className={`btn ${needsResearch ? "btn-primary" : ""} self-start ${starting || running ? "is-pending" : ""}`} onClick={() => start()} disabled={running || starting || st === null} aria-busy={starting || running || undefined}>
        {starting ? <><Spinner />Starting…</> : running ? <><Spinner />Research running…</> : st === null ? <><Spinner />Checking status…</> : "Run quick screen"}
      </button>
    </Card>
  );
}
