import { Suspense } from "react";
import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { getHistories } from "@/lib/market/history";
import { holdingsPeriodChange, periodMoves } from "@/lib/portfolio/risk";
import { loadDaily } from "@/lib/portfolio/daily";
import { writeBrief } from "@/lib/brief";
import { isEtf } from "@/lib/portfolio/classify";
import { STAGES } from "@/lib/research/screen";
import { DataQuality } from "@/components/DataQuality";
import { EventAlerts } from "@/components/EventAlerts";
import { FeedSkeleton, MoverHeadlines } from "@/components/CompanyFeeds";
import { AskButton } from "@/components/AskPanel";
import { Tag } from "@/components/Tag";
import { pctStr, shortDate, toneOf, usd } from "@/lib/format";
import { currentDecisionFor } from "@/lib/decision/currentPortfolio";
import { loadDecisionFilings } from "@/lib/alerts/events";

const card = "bg-surface border border-line rounded-2xl p-5 flex flex-col gap-3";
const SEV = { high: "alert", medium: "warn", low: "neutral" } as const;

export default async function BriefPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const sp = await searchParams;
  const weekly = sp.period === "week";
  const ws = await getWorkspace();
  const p = ws.portfolio;
  const db = await createClient();
  const sessions = weekly ? 5 : 1;
  const symbols = p.holdings.map((h) => h.symbol);
  const [histories, daily, { data: decisions }, { data: lastDecision }, filings] = await Promise.all([
    getHistories([...symbols, "SPY", "QQQ"], "3mo"),
    loadDaily(db, 30),
    db.from("decisions").select("id, kind, symbol, decided_at, user_action").gte("decided_at", new Date(ws.now.getTime() - (weekly ? 7 : 1) * 86400000).toISOString()).order("decided_at", { ascending: false }),
    db.from("decisions").select("decided_at, recommendation, user_action").eq("kind", "new_capital").order("decided_at", { ascending: false }).limit(1).maybeSingle(),
    loadDecisionFilings(ws).catch(() => new Map()),
  ]);
  // Same calculation as the Decisions page, so the brief can only say whether that decision changed, never make its own.
  const best = currentDecisionFor(ws, filings);
  const reassess = best.capacity.options.filter((o) => (o.kind === "stock" || o.kind === "new_stock") && (o.label === "Refresh required" || o.reassessment?.status === "needed" || /conflict/i.test(o.verdicts?.research.detail ?? "")));
  const lastRec = (lastDecision?.recommendation ?? null) as { headline?: string; action?: string; allocations?: { symbol: string; amount: number }[] } | null;
  const sameSyms = (a: { symbol: string }[] = [], b: { symbol: string }[] = []) => a.map((x) => x.symbol).sort().join() === b.map((x) => x.symbol).sort().join();
  const changedSinceLast = lastRec ? !sameSyms(lastRec.allocations, best.allocations) : null;
  const spy = ws.benchmarks.find((b) => b.symbol === "SPY")?.dayPct ?? null;
  const moves = periodMoves(histories, symbols, sessions).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  const bench = periodMoves(histories, ["SPY", "QQQ"], sessions);
  const change = weekly ? holdingsPeriodChange(p.holdings.map((h) => ({ symbol: h.symbol, quantity: h.quantity, value: h.value })), histories, sessions, p.total) : null;
  const daySentences = writeBrief(p, spy, ws.alerts).sentences;
  const since = new Date(ws.now.getTime() - (weekly ? 7 : 1) * 86400000).toISOString();
  const pipelineChanges = ws.research.filter((r) => (r.pipeline.stageUpdatedAt ?? "") >= since || (r.pipeline.screenedAt ?? "") >= since);
  const review = ws.alerts.filter((a) => a.severity !== "low");
  const weekAgo = daily.find((d) => d.as_of <= new Date(ws.now.getTime() - 7 * 86400000).toISOString().slice(0, 10));
  const recordedNow = daily.at(-1);
  const dateLabel = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" }).format(ws.now);
  const newsMovers = moves.filter((m) => !isEtf(m.symbol)).slice(0, 3).map((m) => ({ symbol: m.symbol, dayPct: m.change, name: ws.research.find((r) => r.symbol === m.symbol)?.name ?? null }));
  const spyMove = bench.find((b) => b.symbol === "SPY");

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <Link href="/" className="text-sm no-underline max-lg:hidden">← Today</Link>
          <h1 className="h1">{weekly ? "Weekly brief" : "Daily brief"}</h1>
          <p className="text-muted text-sm">{weekly && spyMove ? `Week of ${shortDate(spyMove.from)} to ${shortDate(spyMove.to)}` : dateLabel}</p>
        </div>
        <nav className="flex gap-1.5 text-sm" aria-label="Period">
          <Link href="/brief" aria-current={!weekly ? "page" : undefined} className={`min-h-11 px-3.5 active:opacity-70 inline-flex items-center rounded-full border no-underline ${!weekly ? "bg-ink text-ground border-ink" : "border-line-strong text-ink"}`}>Day</Link>
          <Link href="/brief?period=week" aria-current={weekly ? "page" : undefined} className={`min-h-11 px-3.5 active:opacity-70 inline-flex items-center rounded-full border no-underline ${weekly ? "bg-ink text-ground border-ink" : "border-line-strong text-ink"}`}>Week</Link>
        </nav>
      </div>

      <section aria-label="Summary" className={card}>
        {weekly ? (
          <p className="text-[16px] leading-relaxed">
            {change
              ? `Over the week, today's holdings would have moved ${pctStr(change.pct, 1, true)} (${usd(change.dollars)}) of your invested portfolio, against ${pctStr(spyMove?.change, 1, true)} for the S&P 500.`
              : "Weekly price history is not available right now."}
            {moves[0] ? ` The biggest mover was ${moves[0].symbol} at ${pctStr(moves[0].change, 1, true)}.` : ""}
            {review.length ? ` ${review.length} item${review.length > 1 ? "s" : ""} to review.` : " Nothing needs a decision."}
          </p>
        ) : (
          <p className="text-[16px] leading-relaxed">{daySentences.join(" ")}</p>
        )}
        <p className="text-xs text-muted">{weekly ? "Hypothetical: today's share counts at last week's prices, so trades and deposits during the week are not reflected. " : ""}Estimated investable capital {usd(p.total)}; protected reserve excluded.</p>
        {weekly && weekAgo && recordedNow && (
          <p className="text-sm">Recorded value: {usd(weekAgo.investable)} on {shortDate(weekAgo.as_of)} → {usd(recordedNow.investable)} on {shortDate(recordedNow.as_of)} <span className="text-xs text-muted">(includes any deposits or withdrawals you recorded)</span></p>
        )}
        <DataQuality p={p} compact />
      </section>

      <section aria-labelledby="mv-h" className={card}>
        <h2 id="mv-h" className="font-semibold">{weekly ? "Week's moves" : "Last session's moves"}</h2>
        {moves.length === 0 ? <p className="text-sm text-muted">Price history unavailable.</p> : (
          <ul className="grid gap-1 sm:grid-cols-2 font-mono text-sm">
            {moves.map((m) => <li key={m.symbol} className="flex justify-between gap-2"><Link href={`/research/${m.symbol}`} className="no-underline text-ink">{m.symbol}</Link><span className={toneOf(m.change)}>{pctStr(m.change, 1, true)}</span></li>)}
            {bench.map((b) => <li key={b.symbol} className="flex justify-between gap-2 text-muted"><span>{b.symbol === "SPY" ? "S&P 500" : "Nasdaq 100"}</span><span>{pctStr(b.change, 1, true)}</span></li>)}
          </ul>
        )}
      </section>

      <section aria-labelledby="rv-h" className={card}>
        <h2 id="rv-h" className="font-semibold">To review</h2>
        {review.length === 0 ? <p className="text-sm text-muted">Nothing needs a decision.</p> : (
          <ul className="flex flex-col divide-y divide-line">
            {review.map((a) => <li key={a.id} className="py-2"><Link href={a.href} className="no-underline text-ink font-medium">{a.title}</Link> <Tag tone={SEV[a.severity]}>{a.severity}</Tag><div className="text-sm text-muted">{a.detail}</div></li>)}
          </ul>
        )}
      </section>

      <section aria-labelledby="rc-h" className={card}>
        <h2 id="rc-h" className="font-semibold">Does a decision need another look?</h2>
        <p className="text-sm"><span className="text-ink font-medium">Best action now:</span> {best.headline}. <Link href="/decisions">Decisions</Link></p>
        {lastDecision && (
          <p className="text-sm">{changedSinceLast
            ? `This differs from your last recorded decision (${shortDate(lastDecision.decided_at)}: ${lastRec?.headline ?? lastRec?.action ?? "recorded"}). Look at Decisions before acting on the old one.`
            : `Same direction as your last recorded decision (${shortDate(lastDecision.decided_at)}).`}</p>
        )}
        {reassess.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {reassess.map((o) => <li key={o.symbol}><Link href={`/research/${o.symbol}`} className="font-mono">{o.symbol}</Link>: {/conflict/i.test(o.verdicts?.research.detail ?? "") ? "research records conflict; resolve before new money" : "research needs reassessing before new money"}. {(o.reassessment?.changes.length ? o.reassessment.changes.slice(0, 2).join("; ") : o.verdicts?.research.detail ?? "").replace(/\.$/, "")}.</li>)}
          </ul>
        ) : <p className="text-sm text-muted">No held or researched stock has a material change (results, financing, filings, valuation) since its research.</p>}
      </section>

      <Suspense fallback={<FeedSkeleton title="Company events" />}><EventAlerts symbols={symbols} now={ws.now} /></Suspense>

      {newsMovers.length > 0 && <Suspense fallback={<FeedSkeleton title="Headlines behind the moves" />}><MoverHeadlines movers={newsMovers} /></Suspense>}

      <section aria-labelledby="act-h" className={card}>
        <h2 id="act-h" className="font-semibold">Your activity</h2>
        <ul className="text-sm flex flex-col gap-1">
          <li>{(decisions ?? []).length ? `${decisions!.length} decision${decisions!.length > 1 ? "s" : ""} recorded` : "No decisions recorded"} {weekly ? "this week" : "today"}. <Link href="/decisions">Decisions</Link></li>
          {pipelineChanges.length ? pipelineChanges.map((r) => (
            <li key={r.symbol}><Link href={`/research/${r.symbol}`} className="font-mono">{r.symbol}</Link>: {STAGES.find((s) => s.key === r.pipeline.stage)?.label}{r.pipeline.screen ? `, screen ${r.pipeline.screen.verdict.toLowerCase()}` : ""}</li>
          )) : <li>No research pipeline changes.</li>}
        </ul>
      </section>

      <section className={card}>
        <AskButton question={weekly ? "Write my weekly review: what moved, why (check news and filings), what changed in my research, and what I should look at next week." : "Summarise today for me: what moved and why (check news and filings), and anything I need to decide."} className="self-start min-h-11 px-4 rounded-lg bg-ink text-ground font-medium">Ask for a written {weekly ? "weekly review" : "summary"}</AskButton>
        <p className="text-xs text-muted">The written summary uses the same tools and rules as the assistant: headlines are unverified and nothing here is a trade instruction.</p>
      </section>
    </div>
  );
}
