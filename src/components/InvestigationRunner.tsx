"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHead, Pill } from "@/components/ui";
import { Spinner } from "@/components/forms";
import { requestJSON } from "@/lib/client/request";
import { Disclose } from "@/components/ui";
import type { UpdatePlan } from "@/lib/research/updatePlan";

type Run = {
  type: string; status: string; pauseReason: string | null; step: string | null; stepIndex: number; steps: number; startedAt: string; lastCheckpointAt: string; costUsd: number;
  phases: { n: number; title: string; status: string }[]; documents: { total: number; fully: number; unavailable: number }; findings: number; questions: { open: number; total: number };
  completeness: { complete: boolean; reasons: string[] } | null;
};
type Status = { status: "none" } | { status: "running" | "stalled" | "paused" | "finished" | "failed"; requestId: string; type: string; startedAt: string; run: Run | null };

const STEP_LABEL: Record<string, string> = {
  inventory: "Building the reading list from SEC EDGAR", discover: "Finding the earnings call transcript and presentation", read: "Reading every document in full",
  "phase:1": "Phase 1 · business and thesis", "phase:2": "Phase 2 · financials and filings", "phase:3": "Phase 3 · management, competition, capital", "phase:4": "Phase 4 · risks and catalysts",
  "phase:5": "Phase 5 · valuation", skeptic: "Skeptical review", "phase:6": "Phase 6 · conclusion", finalize: "Final checks",
};
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Starts and follows research investigations. Three kinds: a full investigation, a refresh for new
 * events, and the quick preliminary screen (separate card). The run continues in the background.
 */
export function InvestigationRunner({ symbol, hasResearch, plan }: { symbol: string; hasResearch: boolean; hasInvestigation?: boolean; plan?: UpdatePlan | null }) {
  const router = useRouter();
  const [st, setSt] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [confirmFull, setConfirmFull] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/research/investigate?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      const s = (await res.json()) as Status & { error?: string };
      if (!res.ok) { setError(s.error ?? "Could not check the research status."); return; }
      setSt((prev) => {
        if (prev && prev.status === "running" && s.status !== "running") router.refresh();
        if (prev && "run" in prev && "run" in s && prev.run && s.run && prev.run.phases.filter((p) => p.status === "complete").length !== s.run.phases.filter((p) => p.status === "complete").length) router.refresh();
        return s;
      });
      if (s.status === "running") timer.current = setTimeout(poll, 10000);
    } catch {
      timer.current = setTimeout(poll, 15000);
    }
  }, [symbol, router]);

  useEffect(() => { poll(); return () => { if (timer.current) clearTimeout(timer.current); }; }, [poll]);
  useEffect(() => {
    if (st?.status !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [st?.status]);

  async function start(kind: "full" | "refresh" | "resume") {
    if (starting) return;
    setError(null);
    setStarting(kind);
    const r = await requestJSON("/api/research/investigate", { json: kind === "resume" ? { symbol, resume: true } : { symbol, type: kind } });
    setStarting(null);
    if (!r.ok) { setError(`Did not start. ${r.error}`); return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(poll, 3000);
    setSt({ status: "running", requestId: "", type: kind, startedAt: new Date().toISOString(), run: null });
  }

  const running = st?.status === "running";
  const run = st && "run" in st ? st.run : null;
  const elapsed = st && "startedAt" in st ? Math.floor((now - new Date(st.startedAt).getTime()) / 1000) : 0;
  const busy = running || !!starting || st === null;
  // An update needs a finished investigation to build on; without one only a full investigation makes sense.
  const canUpdate = plan ? !!plan.foundation : hasResearch;

  return (
    <Card labelledBy="inv-h" className="!gap-3">
      <CardHead id="inv-h" title="Research" right={running ? <Pill small tone="copper" dot="solid">Running</Pill> : st?.status === "stalled" || st?.status === "paused" ? <Pill small tone="warn">{st.status === "paused" ? "Paused" : "Stopped"}</Pill> : null} />
      {running ? (
        <div className="flex flex-col gap-2" role="status" aria-live="polite">
          <p className="t-sm">
            {st.type === "material_event_refresh" || st.type === "refresh" ? "Refreshing" : "Investigating"} {symbol}: {run?.step ? STEP_LABEL[run.step] ?? run.step : "starting"}. {mmss(elapsed)} so far{run ? `, $${run.costUsd.toFixed(2)}` : ""}. It runs in the background; you can leave this page.
          </p>
          {run && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {run.phases.map((p) => <Pill key={p.n} small tone={p.status === "complete" ? "gain" : p.status === "incomplete" ? "warn" : p.status === "running" ? "copper" : "neutral"} dot={p.status === "complete" ? "solid" : "hollow"}>{p.n}</Pill>)}
              </div>
              <span className="t-xs">{run.documents.fully} of {run.documents.total} documents read in full · {run.findings} findings · {run.questions.open} open questions</span>
            </>
          )}
        </div>
      ) : plan ? (
        <UpdateSummary plan={plan} />
      ) : (
        <div className="flex flex-col gap-1.5 t-sm">
          <p><strong className="text-ink">Update research.</strong> Reads only what was filed or said since the investigation it builds on, and updates the evidence, model and conclusion. A price move alone needs no AI.</p>
          <p className="t-xs">Results are saved as a new dated record. Nothing replaces the research in use until you approve it.</p>
        </div>
      )}
      {st?.status === "stalled" && <p className="t-xs warn">The last run stopped between steps. Resume it from its last checkpoint.</p>}
      {st?.status === "paused" && run?.pauseReason && <p className="t-xs warn">{run.pauseReason}</p>}
      {st?.status === "failed" && <p className="t-xs warn">The last run failed at the start (the reading list could not be built).</p>}
      {error && <p role="alert" className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {(st?.status === "stalled" || st?.status === "paused") && (
          <button type="button" className={`btn btn-primary ${starting === "resume" ? "is-pending" : ""}`} onClick={() => start("resume")} disabled={!!starting}>{starting === "resume" ? <><Spinner />Resuming…</> : "Resume"}</button>
        )}
        {canUpdate && (
          <button type="button" className={`btn ${plan?.recommend !== "full" ? "btn-primary" : ""} ${starting === "refresh" ? "is-pending" : ""}`} onClick={() => start("refresh")} disabled={busy || plan?.recommend === "nothing_new"} aria-busy={starting === "refresh" || undefined}>
            {starting === "refresh" ? <><Spinner />Starting…</> : running ? <><Spinner />Running…</> : st === null ? <><Spinner />Checking…</> : plan?.recommend === "nothing_new" ? "Up to date" : `Update research${plan ? ` · about ${range(plan.estimates.update)}` : ""}`}
          </button>
        )}
      </div>
      {!running && (
        <div className="rounded-[12px] border border-line px-3">
          <Disclose summary={<span className="t-sm">Full re-investigation{plan?.recommend === "full" ? " · recommended" : " · not needed now"}</span>} open={plan?.recommend === "full" || !canUpdate}>
            <div className="flex flex-col gap-2 t-sm pb-2">
              <p>Reads the annual and quarterly reports, earnings release, call transcript with Q&amp;A, presentation, financing filings and proxy in full, works through six phases and ends with a skeptical review. Usually 20–45 minutes{plan ? `, about ${range(plan.estimates.full)} (${plan.estimates.full.basis})` : ", a few dollars"}.</p>
              {plan?.recommend === "full" ? (
                <ul className="list-disc pl-4">{plan.fullReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
              ) : (
                <p className="t-xs">Recommended only when the foundation is unreliable: no finished investigation, the price outside the bear-to-bull range, research over a year old, or a business that has changed. None applies now, so an update is the better use of money.</p>
              )}
              <label className="flex items-start gap-2 t-sm"><input type="checkbox" className="mt-1" checked={confirmFull} onChange={(e) => setConfirmFull(e.target.checked)} />
                <span>I want a full re-investigation{plan ? ` (about ${range(plan.estimates.full)})` : ""}. It does not replace the research in use until I approve it.</span></label>
              <button type="button" className={`btn self-start ${plan?.recommend === "full" ? "btn-primary" : ""} ${starting === "full" ? "is-pending" : ""}`} onClick={() => start("full")} disabled={busy || !confirmFull} aria-busy={starting === "full" || undefined}>
                {starting === "full" ? <><Spinner />Starting…</> : "Run full investigation"}
              </button>
            </div>
          </Disclose>
        </div>
      )}
    </Card>
  );
}

const range = (c: { low: number; high: number }) => `$${c.low.toFixed(2)}–$${c.high.toFixed(2)}`;
const pctx = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}% a year`);

/** What is new since the research, what an update would cost, and the free re-pricing at today's price. */
function UpdateSummary({ plan }: { plan: UpdatePlan }) {
  const r = plan.reprice;
  return (
    <div className="flex flex-col gap-1.5 t-sm">
      <p>{plan.summary}</p>
      {plan.foundation && <p className="t-xs">Builds on: research of {plan.foundation.label}. The result is a new dated record; nothing replaces the research in use until you approve it.</p>}
      {plan.newEvidence.length > 0 && (
        <ul className="list-disc pl-4 t-xs">{plan.newEvidence.slice(0, 8).map((e, i) => <li key={i}>{e.filed}: {e.label}</li>)}</ul>
      )}
      {r && (
        <p className="t-xs rounded-[10px] bg-surface-2 px-2 py-1.5">Re-priced for free: the saved weighted value ${r.weighted.toFixed(2)} at today&apos;s ${r.price.toFixed(2)} implies {pctx(r.annualizedNow)} (it was {pctx(r.annualizedThen)} at ${r.reference.toFixed(2)}).{r.outsideRange ? " The price is outside the research's scenarios." : ""}</p>
      )}
    </div>
  );
}
