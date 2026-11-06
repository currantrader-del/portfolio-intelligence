import { Suspense } from "react";
import Link from "next/link";
import { FeedSkeleton, MoverHeadlines } from "@/components/CompanyFeeds";
import { isEtf } from "@/lib/portfolio/classify";
import { getWorkspace } from "@/lib/workspace";
import { writeBrief } from "@/lib/brief";
import { Tag } from "@/components/Tag";
import { AskButton } from "@/components/AskPanel";
import { DataQuality } from "@/components/DataQuality";
import { pctStr, shortDate, toneOf, usd } from "@/lib/format";

const SEV_TONE = { high: "alert", medium: "warn", low: "neutral" } as const;

export default async function TodayPage() {
  const ws = await getWorkspace();
  const p = ws.portfolio;
  const spy = ws.benchmarks.find((b) => b.symbol === "SPY")?.dayPct ?? null;
  const brief = writeBrief(p, spy, ws.alerts);
  const queue = ws.alerts.filter((a) => a.severity !== "low");
  const later = ws.alerts.filter((a) => a.severity === "low");
  const movers = p.holdings.filter((h) => h.contributionPts !== null).sort((a, b) => Math.abs(b.contributionPts!) - Math.abs(a.contributionPts!)).slice(0, 6);
  const newsMovers = p.holdings
    .filter((h) => h.dayPct !== null && !isEtf(h.symbol))
    .sort((a, b) => Math.abs(b.dayPct!) - Math.abs(a.dayPct!))
    .slice(0, 3)
    .map((h) => ({ symbol: h.symbol, dayPct: h.dayPct, name: ws.research.find((r) => r.symbol === h.symbol)?.name ?? null }));
  const maxPts = Math.max(0.01, ...movers.map((m) => Math.abs(m.contributionPts!)));
  const dateLabel = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" }).format(ws.now);

  if (!p.holdings.length && !ws.research.length) {
    return (
      <section className="bg-surface border border-line rounded-2xl p-6 max-w-2xl flex flex-col gap-3">
        <h1 className="font-serif text-3xl font-semibold">Welcome</h1>
        <p className="text-ink-2">Import your research and holdings to start.</p>
        <Link href="/import" className="self-start min-h-11 px-4 inline-flex items-center rounded-lg bg-ink text-ground no-underline font-medium">Import research</Link>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-serif text-2xl sm:text-3xl font-semibold">{dateLabel}</h1>
      <div className="flex flex-wrap gap-6 items-start">
        <div className="flex-[999_1_560px] min-w-0 flex flex-col gap-6">
          <section aria-label="Brief" className="bg-surface border border-line rounded-2xl p-6 flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <span className="text-sm text-muted">{p.quality.status === "verified" ? "Your portfolio" : "Estimated portfolio move"} {ws.marketOpen ? "today" : "last session"}</span>
              <span className={`font-mono text-2xl ${toneOf(p.dayPct)}`}>{p.dayPct === null ? usd(p.total) : `${pctStr(p.dayPct, 2, true)} · ${usd(p.dayDollar)}`}</span>
            </div>
            <p className="font-serif text-lg leading-relaxed">{brief.sentences.join(" ")}</p>
            <div className="text-xs text-muted">Written from the app&apos;s calculations · estimated investable capital {usd(p.total)} · holdings from statements dated {shortDate(p.oldestHoldingsAsOf)} or later</div>
            <DataQuality p={p} compact />
          </section>

          <section aria-labelledby="queue-h" className="flex flex-col gap-3">
            <h2 id="queue-h" className="text-lg font-semibold">{queue.length ? `${queue.length} item${queue.length > 1 ? "s" : ""} to review` : "Nothing urgent"}</h2>
            {queue.map((a) => (
              <Link key={a.id} href={a.href} className="bg-surface border border-line rounded-2xl p-5 no-underline text-ink hover:border-line-strong flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold">{a.title}</span>
                  <Tag tone={SEV_TONE[a.severity]}>{a.severity.toUpperCase()}</Tag>
                </div>
                <span className="text-sm text-ink-2">{a.detail}</span>
              </Link>
            ))}
            <form action="/decisions/new-capital" className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold">New cash to invest</span>
                <Tag tone="warn">WHEN READY</Tag>
              </div>
              <span className="text-sm text-ink-2">Compare holdings, ETFs, new positions and holding cash. You get a recommendation only when the evidence is current.</span>
              <div className="flex flex-wrap gap-2">
                <label htmlFor="amt" className="sr-only">Amount</label>
                <div className="flex items-center rounded-lg border border-line-strong bg-ground px-3 min-h-11">
                  <span className="text-muted">$</span>
                  <input id="amt" name="amount" inputMode="decimal" defaultValue="1250" className="w-28 bg-transparent px-1 font-mono outline-none" />
                </div>
                <button className="min-h-11 px-4 rounded-lg bg-ink text-ground font-medium">Compare options</button>
              </div>
            </form>
          </section>

          {later.length > 0 && (
            <section aria-labelledby="later-h" className="bg-surface border border-line rounded-2xl p-5">
              <h2 id="later-h" className="font-semibold mb-2">Routine ({later.length})</h2>
              <ul className="flex flex-col divide-y divide-line">
                {later.map((a) => (
                  <li key={a.id} className="py-2.5">
                    <Link href={a.href} className="no-underline text-ink"><span className="font-medium">{a.title}</span></Link>
                    <div className="text-sm text-muted">{a.detail}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="flex-[1_1_320px] min-w-0 flex flex-col gap-6">
          <section aria-labelledby="attr-h" className="bg-surface border border-line rounded-2xl p-5">
            <h2 id="attr-h" className="font-semibold">What moved you</h2>
            <p className="text-xs text-muted mb-3">Contribution to today&apos;s move, in percentage points</p>
            {movers.length === 0 ? (
              <p className="text-sm text-muted">Live prices unavailable.</p>
            ) : (
              <ul className="flex flex-col gap-2 font-mono text-sm">
                {movers.map((m) => (
                  <li key={m.symbol} className="grid grid-cols-[56px_1fr_64px] items-center gap-2">
                    <Link href={`/research/${m.symbol}`} className="no-underline text-ink">{m.symbol}</Link>
                    <div className="h-2.5 rounded-sm bg-ground">
                      <div className={`h-2.5 rounded-sm ${m.contributionPts! < 0 ? "bg-loss" : "bg-gain"}`} style={{ width: `${(Math.abs(m.contributionPts!) / maxPts) * 100}%` }} />
                    </div>
                    <span className={`text-right ${toneOf(m.contributionPts)}`}>{m.contributionPts! >= 0 ? "+" : "−"}{Math.abs(m.contributionPts!).toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {newsMovers.length > 0 && (
            <Suspense fallback={<FeedSkeleton title="Headlines behind the moves" />}><MoverHeadlines movers={newsMovers} /></Suspense>
          )}
          <section className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-2">
            <h2 className="font-semibold">Ask</h2>
            {["Why am I up or down today?", "What needs my attention this week?", "Where should $1,250 go?"].map((q) => (
              <AskButton key={q} question={q} className="text-left min-h-11 px-3 rounded-lg border border-line hover:bg-ground text-sm">{q}</AskButton>
            ))}
          </section>
        </aside>
      </div>
    </div>
  );
}
