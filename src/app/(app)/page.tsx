import { Suspense } from "react";
import { after } from "next/server";
import Link from "next/link";
import { MarketsTeaser } from "@/components/intel/MarketsTeaser";
import { isEtf } from "@/lib/portfolio/classify";
import { createClient } from "@/lib/supabase/server";
import { recordDaily } from "@/lib/portfolio/daily";
import { getWorkspace } from "@/lib/workspace";
import { writeBrief } from "@/lib/brief";
import { getNews } from "@/lib/market/news";
import { pctStr, shortDate, toneOf, usd } from "@/lib/format";
import { Bar, Card, CardHead, Chevron, DataLabel, Disclose, Dot, Metric, PageHeader, Pill, Skel } from "@/components/ui";
import { AlertList } from "@/components/cards/Alerts";
import { EventsCard, EventsSkeleton } from "@/components/cards/Events";
import { AnswerView } from "@/components/AnswerView";
import { MorningRunner } from "@/components/MorningRunner";
import { OutdatedNotice } from "@/components/OutdatedNotice";
import { loadContextEvents } from "@/lib/freshness/contextEvents";
import { outdatedVerdict } from "@/lib/freshness/outdated";
import { currentDecisionFor } from "@/lib/decision/currentPortfolio";
import { loadDecisionFilings } from "@/lib/alerts/events";

const pts = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;

export default async function TodayPage() {
  const ws = await getWorkspace();
  const p = ws.portfolio;
  // Recording today's row happens after the response is sent, so it never slows the page.
  const db = await createClient();
  after(() => recordDaily(db, ws));
  const { data: mrow } = await db.from("model_runs").select("computed_at, outputs").eq("kind", "assistant_answer").eq("inputs->>purpose", "morning").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const mout = mrow?.outputs as { answer?: string; ms?: number; costUsd?: number; error?: string } | undefined;
  const etDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const morning = mrow && mout?.answer && !mout.error ? { answer: mout.answer, at: mrow.computed_at as string, ms: mout.ms ?? 0, costUsd: mout.costUsd ?? 0, today: etDay(new Date(mrow.computed_at)) === etDay(ws.now) } : null;
  // A saved briefing stays as written; it is flagged when the policy, holdings, cash or research it used changed since.
  const morningCheck = morning ? outdatedVerdict({ writtenAt: morning.at, events: await loadContextEvents(db, morning.at).catch(() => []), text: morning.answer, currentReserve: p.cashDetail.protectedReserve }) : null;

  const spy = ws.benchmarks.find((b) => b.symbol === "SPY")?.dayPct ?? null;
  const brief = writeBrief(p, spy, ws.alerts);
  const queue = ws.alerts.filter((a) => a.severity !== "low");
  const routine = ws.alerts.filter((a) => a.severity === "low");
  const movers = p.holdings.filter((h) => h.contributionPts !== null).sort((a, b) => Math.abs(b.contributionPts!) - Math.abs(a.contributionPts!)).slice(0, 5);
  const maxPts = Math.max(0.01, ...movers.map((m) => Math.abs(m.contributionPts!)));
  const newsMovers = p.holdings
    .filter((h) => h.dayPct !== null && !isEtf(h.symbol))
    .sort((a, b) => Math.abs(b.dayPct!) - Math.abs(a.dayPct!))
    .slice(0, 3)
    .map((h) => ({ symbol: h.symbol, dayPct: h.dayPct, name: ws.research.find((r) => r.symbol === h.symbol)?.name ?? null }));
  const dateLabel = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" }).format(ws.now);
  const session = ws.marketOpen ? "today" : "last session";
  const vsSpy = p.dayPct !== null && spy !== null ? p.dayPct - spy : null;
  const verified = p.quality.status === "verified";

  if (!p.holdings.length && !ws.research.length) {
    return (
      <Card className="max-w-xl">
        <h1 className="h1">Welcome</h1>
        <p className="t-sm">Import your research and holdings to start.</p>
        <div><Link href="/import" className="btn btn-primary">Import research</Link></div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3 lg:gap-4">
      <PageHeader kicker={dateLabel} title="Today" actions={
        <>
          <Link href="/plan" className="btn btn-sm lg:min-h-11 lg:px-4 lg:text-[15px]">Your plan</Link>
          <Link href="/brief?period=week" className="btn btn-sm lg:min-h-11 lg:px-4 lg:text-[15px] max-lg:hidden">Weekly brief</Link>
          <Link href="/brief" className="btn btn-sm lg:min-h-11 lg:px-4 lg:text-[15px] max-lg:hidden">Daily brief</Link>
        </>
      } />

      <Card labelledBy="mb-h" className="!gap-2">
        <CardHead id="mb-h" cap="Morning briefing" right={<MorningRunner label={morningCheck?.outdated ? "Rewrite with today's facts" : morning ? "Write a new one" : "Write it now"} />} />
        {morning ? (
          <>
            {morningCheck && <OutdatedNotice v={morningCheck} what="briefing" />}
            <div className={morningCheck?.outdated ? "opacity-70" : undefined}><AnswerView text={morning.answer} /></div>
            <span className="t-xs">Written {new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(morning.at))} ET{morning.today ? "" : ` on ${shortDate(morning.at)}`} · {Math.round(morning.ms / 1000)}s · ${morning.costUsd.toFixed(2)} · from your portfolio, policy, research and that day&apos;s market briefing · AI summary: facts are checked against sources on Markets, not here</span>
          </>
        ) : <p className="t-sm">Written automatically at 9:00 AM ET on weekdays, after the 8:30 economic data: what happened, what it means for your holdings, and what (if anything) to do.</p>}
      </Card>

      <MarketsTeaser />

      {/* Market strip (phones; desktop shows it inside the portfolio card) */}
      <Card tight className="lg:hidden !py-2.5" label="Market">
        <div className="grid grid-cols-3 gap-2">
          {ws.benchmarks.map((b) => <Metric key={b.symbol} size="sm" label={b.label} value={pctStr(b.dayPct, 1, true)} tone={b.dayPct === null ? null : b.dayPct >= 0 ? "gain" : "loss"} />)}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-8" labelledBy="pt-h">
          <CardHead id="pt-h" cap={`Your portfolio ${session}`} right={<DataLabel kind={verified ? "verified" : "estimated"} />} />
          <div className="flex items-end justify-between gap-x-6 gap-y-3">
            <div className="flex flex-col gap-1 min-w-0 flex-1">
              <span className={`t-big ${p.dayPct === null ? "" : toneOf(p.dayPct)}`}>{p.dayPct === null ? usd(p.total) : pctStr(p.dayPct, 2, true)}</span>
              <span className="t-sm num">
                {p.dayDollar !== null ? `${p.dayDollar >= 0 ? "+" : ""}${usd(p.dayDollar)}` : "No live change"}
                {vsSpy !== null && ` · ${Math.abs(vsSpy) < 0.0005 ? "in line with" : vsSpy > 0 ? "ahead of" : "behind"} the S&P 500${Math.abs(vsSpy) >= 0.0005 ? ` by ${Math.abs(vsSpy * 100).toFixed(1)} pts` : ""}`}
              </span>
            </div>
            <div className="flex gap-6 lg:gap-7">
              {ws.benchmarks.map((b) => (
                <Metric key={b.symbol} className="max-lg:hidden" size="sm" align="right" label={b.label} value={pctStr(b.dayPct, 1, true)} tone={b.dayPct === null ? null : b.dayPct >= 0 ? "gain" : "loss"} />
              ))}
              <Metric size="sm" align="right" label="Invested" value={`${verified ? "" : "≈ "}${usd(p.total)}`} note={p.investableCapital > p.total + 0.5 ? `${usd(p.investableCapital)} with savings` : undefined} />
            </div>
          </div>
          <p className="t-sm leading-relaxed">{brief.sentences.join(" ")}</p>
          <Link href="/portfolio/reconcile" className="src no-underline hover:text-ink-2">
            <Dot kind={verified ? "solid" : "hollow"} style={{ color: verified ? "var(--gain)" : "var(--warn-ink)" }} />
            <span>Holdings from statements dated {shortDate(p.oldestHoldingsAsOf)} or later{p.quality.missing.length ? ` · ${p.quality.missing.length} gap${p.quality.missing.length > 1 ? "s" : ""} to fill` : ""}</span>
          </Link>
        </Card>

        <div className="lg:col-span-4 max-lg:order-last flex flex-col gap-3 lg:gap-4">
          <Suspense fallback={<EventsSkeleton />}><EventsCard symbols={p.holdings.map((h) => h.symbol)} now={ws.now} /></Suspense>
        </div>

        <Card className="lg:col-span-7 !gap-1 !pb-1.5" labelledBy="q-h">
          <div className="mb-1"><CardHead id="q-h" title={queue.length ? "Needs attention" : "Nothing urgent"} right={queue.length > 0 && <Pill>{queue.length}</Pill>} /></div>
          {queue.length > 0 ? <AlertList alerts={queue} /> : <p className="t-sm pb-3">No high or medium items. Routine updates are below.</p>}
          {routine.length > 0 && (
            <div className="border-t border-line">
              <Disclose summary={`Routine updates (${routine.length})`}>
                <AlertList alerts={routine} wrap />
              </Disclose>
            </div>
          )}
        </Card>

        <Card className="lg:col-span-5" labelledBy="mv-h">
          <CardHead id="mv-h" title="What moved you" right={<span className="t-xs">pts of the move</span>} />
          {movers.length === 0 ? (
            <p className="t-sm">No live prices yet, so no contributions to show.</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {movers.map((m) => (
                <li key={m.symbol} className="grid grid-cols-[56px_minmax(0,1fr)_52px] items-center gap-2.5">
                  <Link href={`/research/${m.symbol}`} className="num text-[13px] font-semibold no-underline">{m.symbol}</Link>
                  <Bar thin value={Math.abs(m.contributionPts!)} scale={maxPts} tone={m.contributionPts! < 0 ? "loss" : "gain"} />
                  <span className={`num text-[13px] text-right ${toneOf(m.contributionPts)}`}>{pts(m.contributionPts!)}</span>
                </li>
              ))}
            </ul>
          )}
          {newsMovers.length > 0 && (
            <div className="border-t border-line -mb-2">
              <Disclose summary={<span>Headlines behind the moves <span className="t-xs">· unverified</span></span>}>
                <Suspense fallback={<div className="flex flex-col gap-2"><Skel w="90%" /><Skel w="70%" /></div>}><MoverHeadlines movers={newsMovers} /></Suspense>
              </Disclose>
            </div>
          )}
        </Card>

        <Suspense fallback={<div className="card card-tight lg:col-span-12"><Skel w="60%" /></div>}><BestAction /></Suspense>
      </div>
    </div>
  );
}

async function MoverHeadlines({ movers }: { movers: { symbol: string; dayPct: number | null; name?: string | null }[] }) {
  const rows = await Promise.all(movers.map(async (m) => ({ ...m, r: await getNews(m.symbol, m.name, 2) })));
  const ok = rows.filter((x) => !("error" in x.r));
  if (!ok.length) return <p className="t-sm">Headlines are unavailable right now.</p>;
  return (
    <div className="flex flex-col gap-3">
      {ok.map((x) => (
        <div key={x.symbol} className="flex flex-col gap-1.5">
          <div className="t-sm"><span className="font-semibold text-ink">{x.symbol}</span> <span className={`num ${toneOf(x.dayPct)}`}>{pctStr(x.dayPct, 1, true)}</span></div>
          {"error" in x.r ? null : x.r.headlines.map((h) => (
            <a key={h.url} href={h.url} target="_blank" rel="noreferrer nofollow" className="t-sm no-underline hover:text-ink">
              {h.title}
              <span className="block t-xs">{[h.publisher, h.publishedAt ? shortDate(h.publishedAt) : null].filter(Boolean).join(" · ")}</span>
            </a>
          ))}
        </div>
      ))}
      <p className="t-xs">Headlines are leads to check, not reasons to trade.</p>
    </div>
  );
}

/** The Current Portfolio decision in one line: the same answer the Decisions page gives. */
async function BestAction() {
  const ws = await getWorkspace();
  const d = currentDecisionFor(ws, await loadDecisionFilings(ws).catch(() => new Map()));
  return (
    <Link href="/decisions" className="card card-tight lg:col-span-12 !flex-row items-center justify-between gap-3 no-underline">
      <span className="flex flex-col min-w-0">
        <span className="cap">Best action now</span>
        <span className="font-semibold text-ink">{d.headline}</span>
        <span className="t-xs">From your holdings, approved research, cash and standing transfer limit. No AI. Open Decisions for the alternatives and what to confirm.</span>
      </span>
      <Chevron />
    </Link>
  );
}
