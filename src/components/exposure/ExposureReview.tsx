"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardHead, Disclose, Pill } from "@/components/ui";
import type { ReviewResult } from "@/lib/exposure/reviewJob";

type Status =
  | { status: "none" }
  | { status: "running" | "lost"; startedAt: string }
  | { status: "done"; startedAt: string; finishedAt: string; result: ReviewResult };

const COND = { favorable: { tone: "gain", t: "Favorable" }, mixed: { tone: "neutral", t: "Mixed" }, deteriorating: { tone: "warn", t: "Deteriorating" }, unclear: { tone: "neutral", t: "Unclear" } } as const;
const REC = { maintain: "Maintain", review: "Review", reduce: "Reduce", research: "Research further" } as const;
const RISK = { higher: "Risk higher", unchanged: "Risk unchanged", lower: "Risk lower", unclear: "Risk change unclear" } as const;

/** On-demand market analysis of the portfolio's largest exposures (background job, polled). */
export function ExposureReview() {
  const [st, setSt] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/exposure", { cache: "no-store" });
      const s = (await res.json()) as Status & { error?: string };
      if (!res.ok) { setError(s.error ?? "Could not check the analysis."); return; }
      setSt(s);
      if (s.status === "running") timer.current = setTimeout(poll, 5000);
    } catch {
      timer.current = setTimeout(poll, 10000);
    }
  }, []);
  useEffect(() => { poll(); return () => { if (timer.current) clearTimeout(timer.current); }; }, [poll]);
  useEffect(() => {
    if (st?.status !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [st?.status]);

  async function start() {
    if (starting) return;
    setError(null);
    setStarting(true);
    try {
      const res = await fetch("/api/exposure", { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setError(j.error ?? "The analysis did not start. Try again."); return; }
      setSt({ status: "running", startedAt: new Date().toISOString() });
      setNow(Date.now());
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(poll, 5000);
    } catch {
      setError("No connection. Nothing was started; try again.");
    } finally {
      setStarting(false);
    }
  }

  const running = st?.status === "running";
  const elapsed = running ? Math.floor((now - new Date(st.startedAt).getTime()) / 1000) : 0;
  const done = st?.status === "done" ? st : null;
  const r = done?.result ?? null;
  const rep = r?.ok ? r.report : null;

  return (
    <Card labelledBy="mkt-h" className="!gap-3">
      <CardHead id="mkt-h" title="Market conditions for your exposures" right={running ? <Pill small tone="copper" dot="solid">Running</Pill> : done ? <span className="t-xs">{new Date(done.finishedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span> : null} />
      {running && <p className="t-sm" role="status" aria-live="polite">Analysing your largest exposures: earnings and revisions, valuations, the spending cycle, rates, momentum and policy. {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")} so far; usually 3–8 minutes. You can leave this page.</p>}
      {!running && !rep && <p className="t-sm">Claude checks the current environment for the sectors, industries and markets you are most exposed to, and says whether your risk has changed and what to do: maintain, review, reduce or research further. About $0.30–1 per run, counted in today&apos;s cost limit.</p>}
      {rep && !running && (
        <div className="flex flex-col gap-3">
          <p className="t-sm text-ink font-semibold">{rep.headline}</p>
          <ul className="flex flex-col gap-3">
            {rep.exposures.map((e) => {
              const c = COND[e.condition as keyof typeof COND] ?? COND.unclear;
              return (
                <li key={e.exposure} className="rounded-[12px] bg-surface-2 px-3 py-2.5 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="t-sm text-ink font-semibold">{e.exposure}</span>
                    <span className="flex gap-1.5 flex-wrap"><Pill small tone={c.tone}>{c.t}</Pill><Pill small tone={e.recommendation === "reduce" ? "alert" : e.recommendation === "review" ? "warn" : "neutral"}>{REC[e.recommendation as keyof typeof REC] ?? e.recommendation}</Pill></span>
                  </div>
                  <span className="t-xs">{e.portfolio} · {RISK[e.risk_change as keyof typeof RISK] ?? ""}</span>
                  <p className="t-sm">{e.reasoning}</p>
                  <Disclose summary="Evidence, outlook and catalysts">
                    <div className="flex flex-col gap-2 t-sm">
                      <p><span className="text-ink font-semibold">Next 1–3 months:</span> {e.short_term}</p>
                      <p><span className="text-ink font-semibold">1–5 years:</span> {e.long_term}</p>
                      {e.supporting.length > 0 && <div><span className="text-ink font-semibold">Supporting</span><ul className="list-disc pl-5">{e.supporting.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
                      {e.contradicting.length > 0 && <div><span className="text-ink font-semibold">Contradicting</span><ul className="list-disc pl-5">{e.contradicting.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
                      {e.catalysts.length > 0 && <div><span className="text-ink font-semibold">Coming up</span><ul className="list-disc pl-5">{e.catalysts.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
                    </div>
                  </Disclose>
                </li>
              );
            })}
          </ul>
          {rep.opportunities.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="t-sm text-ink font-semibold">Worth researching (on its own merits, not to fill a gap)</span>
              <ul className="list-disc pl-5 t-sm">{rep.opportunities.map((o) => <li key={o.area}><span className="text-ink">{o.area}:</span> {o.evidence} {o.next_step}</li>)}</ul>
            </div>
          )}
          {r?.problems && r.problems.length > 0 && <p className="t-xs warn">Gaps in this analysis: {r.problems.join("; ")}</p>}
          <Disclose summary={`Sources (${rep.sources.length})`}>
            <ul className="t-xs flex flex-col gap-1">{rep.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a>{s.date ? ` · ${s.date}` : ""}</li>)}</ul>
          </Disclose>
          <span className="t-xs">{Math.max(1, Math.round((r?.ms ?? 0) / 60000))} min · {r?.searches} searches · ${(r?.costUsd ?? 0).toFixed(2)}</span>
        </div>
      )}
      {r && !r.ok && !running && <p className="t-sm warn" role="alert">Last run failed: {r.error}</p>}
      {st?.status === "lost" && <p className="t-xs warn">The last run never finished. You can start it again.</p>}
      {error && <p role="alert" className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2">{error}</p>}
      <button type="button" className={`btn ${rep ? "" : "btn-primary"} self-start min-h-11`} onClick={start} disabled={running || starting || st === null} aria-busy={starting}>
        {starting ? "Starting…" : running ? "Analysing…" : st === null ? "Checking…" : rep ? "Run the analysis again" : "Analyse market conditions"}
      </button>
    </Card>
  );
}
