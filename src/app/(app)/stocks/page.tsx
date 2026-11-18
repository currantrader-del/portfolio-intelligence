import { Suspense } from "react";
import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { isEtf } from "@/lib/portfolio/classify";
import { writeBrief } from "@/lib/brief";
import { getQuotes } from "@/lib/market/quotes";
import { pctStr, toneOf, usd } from "@/lib/format";
import { Bar, Card, CardHead, DataLabel, Disclose, LinkRow, PageHeader, Pill, Skel } from "@/components/ui";
import { EventsCard, EventsSkeleton } from "@/components/cards/Events";
import { MoverHeadlines } from "@/components/MoverHeadlines";
import { MarketsTeaser } from "@/components/intel/MarketsTeaser";
import { researchDates } from "@/lib/alerts/events";
import { sessionOfQuotes } from "@/lib/market/hours";
import { holdingAction } from "@/lib/decision/actions";
import { loadDecisionFilings } from "@/lib/alerts/events";
import { DEFAULT_PLAN, buyLevelOf } from "@/lib/plan/target";
import { zoneKind } from "@/lib/policy/zoneKind";

const pts = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;
const firstSentence = (s: string, max = 140) => {
  const t = s.replace(/\s+/g, " ").trim();
  const one = t.match(/^(.+?[.;])(\s|$)/)?.[1] ?? t;
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};
const VERB_TONE = { "Buy more": "gain", Hold: "neutral", Trim: "warn", "Reassess first": "warn" } as const;

/**
 * Stocks & funds (2026-11-17: "many tabs and views"): everything you own or watch, one line each with what to do,
 * and today's move. The full Portfolio and Research pages stay under More.
 */
export default async function StocksPage() {
  const ws = await getWorkspace();
  const p = ws.portfolio;
  const planFunds = new Set(DEFAULT_PLAN.funds.map((s) => s.buy));
  // The same filings every page passes to the decision engine, so a stock's action here matches Plan and its research page.
  const filings = await loadDecisionFilings(ws).catch(() => new Map());
  const spy = ws.benchmarks.find((b) => b.symbol === "SPY")?.dayPct ?? null;
  const brief = writeBrief(p, spy, ws.alerts);
  const vsSpy = p.dayPct !== null && spy !== null ? p.dayPct - spy : null;
  const verified = p.quality.status === "verified";

  const funds = p.holdings.filter((h) => isEtf(h.symbol)).sort((a, b) => b.value - a.value);
  const stocks = p.holdings.filter((h) => !isEtf(h.symbol)).sort((a, b) => b.value - a.value);
  const owned = new Set(p.holdings.map((h) => h.symbol));
  const watched = ws.research.filter((r) => !owned.has(r.symbol) && r.current && r.pipeline.stage !== "passed");
  const quotes = await getQuotes(watched.map((r) => r.symbol).filter((s) => !ws.quotes.has(s))).catch(() => new Map());
  const watchRows = watched.map((r) => {
    const action = r.current!.parsed.action ?? "";
    const level = buyLevelOf(action);
    const price = (ws.quotes.get(r.symbol) ?? quotes.get(r.symbol))?.price ?? null;
    const away = level && price ? price / level - 1 : null;
    return { symbol: r.symbol, name: r.name, action, level, price, away, buy: zoneKind(action) === "buy" };
  }).sort((a, b) => (a.away ?? 9) - (b.away ?? 9));

  const movers = p.holdings.filter((h) => h.contributionPts !== null).sort((a, b) => Math.abs(b.contributionPts!) - Math.abs(a.contributionPts!)).slice(0, 5);
  const maxPts = Math.max(0.01, ...movers.map((m) => Math.abs(m.contributionPts!)));
  const newsMovers = stocks.filter((h) => h.dayPct !== null).sort((a, b) => Math.abs(b.dayPct!) - Math.abs(a.dayPct!)).slice(0, 3)
    .map((h) => ({ symbol: h.symbol, dayPct: h.dayPct, name: ws.research.find((r) => r.symbol === h.symbol)?.name ?? null }));
  const qs = sessionOfQuotes(p.holdings.map((h) => ws.quotes.get(h.symbol)?.asOf), ws.now);
  const moveWindow = qs ? { startIso: new Date(Date.parse(qs.closeIso) - (new Date(`${qs.date}T12:00:00Z`).getUTCDay() === 1 ? 3 : 1) * 86_400_000).toISOString(), endIso: qs.open ? ws.now.toISOString() : qs.closeIso } : undefined;

  return (
    <div className="flex flex-col gap-3 lg:gap-4 max-w-3xl">
      <PageHeader title="Stocks & funds" actionsDesktopOnly />

      <Card labelledBy="day-h" className="!gap-2">
        <CardHead id="day-h" cap={ws.marketOpen ? "Today" : "Last session"} right={<DataLabel kind={verified ? "verified" : "estimated"} />} />
        <span className="t-xs">Price change of what you hold today, all accounts. Not a total return: deposits and withdrawals are not counted.</span>
        <div className="flex items-baseline justify-between gap-3">
          <span className={`t-big ${p.dayPct === null ? "" : toneOf(p.dayPct)}`}>{p.dayPct === null ? usd(p.total) : pctStr(p.dayPct, 2, true)}</span>
          <span className="t-sm num text-right">{verified ? "" : "≈ "}{usd(p.total)} invested</span>
        </div>
        <span className="t-sm num">{p.dayDollar !== null ? `${p.dayDollar >= 0 ? "+" : ""}${usd(p.dayDollar)}` : "No live change"}{vsSpy !== null && ` · ${Math.abs(vsSpy) < 0.0005 ? "in line with" : vsSpy > 0 ? "ahead of" : "behind"} the S&P 500${Math.abs(vsSpy) >= 0.0005 ? ` by ${Math.abs(vsSpy * 100).toFixed(1)} pts` : ""}`}</span>
        <p className="t-sm leading-relaxed">{brief.sentences.join(" ")}</p>
        {movers.length > 0 && (
          <Disclose summary={<span className="t-sm">What moved you</span>}>
            <ul className="flex flex-col gap-2.5">
              {movers.map((m) => (
                <li key={m.symbol} className="grid grid-cols-[56px_minmax(0,1fr)_52px] items-center gap-2.5">
                  <Link href={`/research/${m.symbol}`} className="num text-[13px] font-semibold no-underline">{m.symbol}</Link>
                  <Bar thin value={Math.abs(m.contributionPts!)} scale={maxPts} tone={m.contributionPts! < 0 ? "loss" : "gain"} />
                  <span className={`num text-[13px] text-right ${toneOf(m.contributionPts)}`}>{pts(m.contributionPts!)}</span>
                </li>
              ))}
            </ul>
            {newsMovers.length > 0 && <div className="mt-3"><Suspense fallback={<Skel w="80%" />}><MoverHeadlines movers={newsMovers} window={moveWindow} /></Suspense></div>}
          </Disclose>
        )}
      </Card>

      <Card labelledBy="st-h" className="!gap-1">
        <CardHead id="st-h" cap="Stocks you own" right={<span className="t-xs">what to do now</span>} />
        <ul className="flex flex-col">
          {stocks.map((h) => {
            const n = holdingAction(ws, h.symbol, filings)?.now ?? null;
            return (
              <li key={h.symbol} className="border-t border-line first:border-t-0">
                <LinkRow href={`/research/${h.symbol}`}>
                  <span className="flex justify-between gap-3 t-sm"><span className="text-ink font-semibold">{h.symbol} <span className="t-xs font-normal">· {usd(h.value)} · {pctStr(h.weight)}</span></span>{n ? <Pill small tone={VERB_TONE[n.verb]}>{n.verb}</Pill> : <Pill small>No research</Pill>}</span>
                  <span className="t-xs block">{n ? firstSentence(n.headline) : "No research on file yet."}</span>
                </LinkRow>
              </li>
            );
          })}
          {!stocks.length && <li className="t-sm">No individual stocks.</li>}
        </ul>
      </Card>

      <Card labelledBy="fd-h" className="!gap-1">
        <CardHead id="fd-h" cap="Funds you own" />
        <ul className="flex flex-col">
          {funds.map((h) => (
            <li key={h.symbol} className="border-t border-line first:border-t-0">
              <LinkRow href={`/research/${h.symbol}`}>
                <span className="flex justify-between gap-3 t-sm"><span className="text-ink font-semibold">{h.symbol} <span className="t-xs font-normal">· {usd(h.value)} · {pctStr(h.weight)}</span></span><Pill small tone={planFunds.has(h.symbol) ? "gain" : "neutral"}>{planFunds.has(h.symbol) ? "Plan fund" : "Keep"}</Pill></span>
                <span className="t-xs block">{planFunds.has(h.symbol) ? "A plan fund: Decisions says when new money should go here." : "Not one of the plan's funds: keep it unless you decide otherwise."}</span>
              </LinkRow>
            </li>
          ))}
          {!funds.length && <li className="t-sm">No funds yet.</li>}
        </ul>
      </Card>

      <Card labelledBy="wt-h" className="!gap-1">
        <CardHead id="wt-h" cap="Researched, not owned" right={<span className="t-xs">nearest its buy level first</span>} />
        <ul className="flex flex-col">
          {watchRows.map((w) => (
            <li key={w.symbol} className="border-t border-line first:border-t-0">
              <LinkRow href={`/research/${w.symbol}`}>
                <span className="flex justify-between gap-3 t-sm"><span className="text-ink font-semibold">{w.symbol}{w.price ? <span className="t-xs font-normal"> · {usd(w.price, 2)}</span> : null}</span>{w.level ? (w.away !== null && w.away <= 0 ? <Pill small tone="gain">At its level</Pill> : <Pill small>{w.away !== null ? `${(w.away * 100).toFixed(0)}% above ${usd(w.level)}` : `Below ${usd(w.level)}`}</Pill>) : <Pill small>{w.buy ? "Buy range" : "Not now"}</Pill>}</span>
                <span className="t-xs block">{w.action ? firstSentence(w.action) : "No action written."}</span>
              </LinkRow>
            </li>
          ))}
          {!watchRows.length && <li className="t-sm">No researched stocks you don&apos;t own.</li>}
        </ul>
      </Card>

      <Suspense fallback={<EventsSkeleton />}><EventsCard symbols={p.holdings.map((h) => h.symbol)} now={ws.now} dates={researchDates(ws.research)} /></Suspense>

      <MarketsTeaser />

      <Card tight className="!gap-0">
        <LinkRow href="/portfolio"><span className="t-sm text-ink block">Full portfolio details</span><span className="t-xs block">Accounts, allocation, every holding, single-company exposure</span></LinkRow>
        <LinkRow href="/research" className="border-t border-line"><span className="t-sm text-ink block">Research list and ideas</span><span className="t-xs block">Add an idea, research under way, ideas you passed on</span></LinkRow>
      </Card>
    </div>
  );
}
