import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { getHistories, type Range } from "@/lib/market/history";
import { buildRisk } from "@/lib/portfolio/risk";
import { loadDaily } from "@/lib/portfolio/daily";
import { LineChart } from "@/components/LineChart";
import { Tag } from "@/components/Tag";
import { pctStr, shortDate, toneOf, usd } from "@/lib/format";

const RANGES: { key: Range; label: string }[] = [
  { key: "3mo", label: "3M" }, { key: "6mo", label: "6M" }, { key: "1y", label: "1Y" }, { key: "2y", label: "2Y" },
];
const card = "bg-surface border border-line rounded-2xl p-5 flex flex-col gap-3";
const n2 = (v: number | null) => (v === null ? "—" : v.toFixed(2));

export default async function RiskPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const sp = await searchParams;
  const range = (RANGES.find((r) => r.key === sp.range)?.key ?? "1y") as Range;
  const ws = await getWorkspace();
  const p = ws.portfolio;
  const db = await createClient();
  const [histories, daily] = await Promise.all([
    getHistories([...p.holdings.map((h) => h.symbol), "SPY", "QQQ", "SOXX"], range),
    loadDaily(db),
  ]);
  const risk = buildRisk({
    positions: p.holdings.map((h) => ({ symbol: h.symbol, quantity: h.quantity, value: h.value })),
    cash: p.cash,
    investable: p.total,
    histories,
    exposures: p.exposures.map((e) => ({ symbol: e.symbol, total: e.total })),
  });
  const s = risk.stats;
  const recorded = daily.filter((d) => d.investable > 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-serif text-2xl sm:text-3xl font-semibold">Risk and history</h1>
        <p className="text-muted text-sm">How today&apos;s mix has behaved, and what a bad stretch could cost. Estimates from {histories.get("SPY")?.provider === "stooq" ? "Stooq" : "Yahoo"} daily prices, not advice.</p>
      </div>

      <section aria-labelledby="hyp-h" className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="hyp-h" className="font-semibold">Today&apos;s holdings at past prices</h2>
          <nav className="flex gap-1 text-sm" aria-label="Range">
            {RANGES.map((r) => (
              <Link key={r.key} href={`/risk?range=${r.key}`} aria-current={r.key === range ? "page" : undefined} className={`min-h-10 min-w-11 px-2 inline-flex items-center justify-center rounded-full border no-underline ${r.key === range ? "bg-ink text-ground border-ink" : "border-line-strong text-ink"}`}>{r.label}</Link>
            ))}
          </nav>
        </div>
        <p className="text-xs"><Tag tone="warn">Hypothetical</Tag> <span className="text-muted">Today&apos;s share counts and cash, priced at each past close. This is not your actual return: it ignores past trades, deposits and when you bought.</span></p>
        <LineChart label="Hypothetical value of today's holdings versus the S&P 500" format={(v) => usd(v)}
          series={[{ label: "Today's holdings", points: risk.series, color: "accent" }, { label: "S&P 500 (same start)", points: risk.benchmark, color: "muted", dashed: true }]} />
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><dt className="text-muted">Change over period</dt><dd className={`font-mono ${toneOf(s.ret)}`}>{pctStr(s.ret, 1, true)}</dd><dd className="text-xs text-muted">S&amp;P 500 {pctStr(s.benchRet, 1, true)}</dd></div>
          <div><dt className="text-muted">Volatility (yearly)</dt><dd className="font-mono">{pctStr(s.vol)}</dd><dd className="text-xs text-muted">S&amp;P 500 {pctStr(s.benchVol)}</dd></div>
          <div><dt className="text-muted">Largest drop</dt><dd className="font-mono text-loss">{pctStr(s.maxDrawdown)}</dd><dd className="text-xs text-muted">{s.drawdownFrom ? `${shortDate(s.drawdownFrom)} to ${shortDate(s.drawdownTo)}` : ""}</dd></div>
          <div><dt className="text-muted">Beta to S&amp;P 500</dt><dd className="font-mono">{n2(s.beta)}</dd><dd className="text-xs text-muted">1.00 moves with the market</dd></div>
        </dl>
        {(risk.missing.length > 0 || risk.partial.length > 0) && (
          <p className="text-xs text-muted">{risk.missing.length > 0 && `No price history for ${risk.missing.join(", ")}; held flat at today's value. `}{risk.partial.length > 0 && `Shorter history for ${risk.partial.join(", ")}; held at its first price before that.`}</p>
        )}
      </section>

      <section aria-labelledby="sc-h" className={card}>
        <div>
          <h2 id="sc-h" className="font-semibold">What if</h2>
          <p className="text-xs text-muted">Estimated effect on investable capital of {usd(p.total)}. The protected reserve and cash are not affected. Based on each holding&apos;s past behaviour; real moves can be larger.</p>
        </div>
        <ul className="flex flex-col divide-y divide-line">
          {risk.scenarios.map((sc) => (
            <li key={sc.key} className="py-2">
              <details>
                <summary className="cursor-pointer flex flex-wrap items-baseline justify-between gap-x-3 min-h-11 py-1">
                  <span className="font-medium">{sc.name}</span>
                  <span className="font-mono"><span className="text-loss">{usd(sc.dollars)}</span> <span className="text-muted text-sm">({pctStr(sc.pct, 1, true)})</span></span>
                </summary>
                <p className="text-xs text-muted mb-2">{sc.basis}</p>
                {sc.lines.length > 0 && (
                  <ul className="grid gap-1 text-sm font-mono sm:grid-cols-2">
                    {sc.lines.slice(0, 12).map((l) => <li key={l.symbol} className="flex justify-between gap-2"><span>{l.symbol} {pctStr(l.move, 0, true)}</span><span className={toneOf(l.dollars)}>{usd(l.dollars)}</span></li>)}
                  </ul>
                )}
              </details>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-6 lg:grid-cols-2 items-start">
        <section aria-labelledby="conc-h" className={card}>
          <h2 id="conc-h" className="font-semibold">Concentration</h2>
          <p className="text-sm">Your five largest company exposures, including what your index ETFs hold, are <span className="font-mono font-medium">{pctStr(risk.concentration.topFive)}</span> of investable capital. Across holdings you have the diversification of about <span className="font-mono font-medium">{risk.concentration.effectiveN.toFixed(1)}</span> equal-sized positions.</p>
          <ul className="flex flex-col gap-1.5 text-sm font-mono">
            {risk.concentration.top.map((t) => (
              <li key={t.symbol} className="grid grid-cols-[64px_1fr_56px] items-center gap-2">
                <Link href={`/research/${t.symbol}`} className="no-underline text-ink">{t.symbol}</Link>
                <div className="h-2.5 rounded-sm bg-ground"><div className="h-2.5 rounded-sm bg-accent" style={{ width: `${Math.min(100, (t.weight / Math.max(0.01, risk.concentration.top[0]?.weight ?? 1)) * 100)}%` }} /></div>
                <span className="text-right">{pctStr(t.weight)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="rec-h" className={card}>
          <h2 id="rec-h" className="font-semibold">Recorded history</h2>
          <p className="text-xs text-muted">What the app showed each day you opened it. This starts building now and becomes your real value history; rows stay labelled estimated until accounts sync automatically.</p>
          {recorded.length >= 2 ? (
            <LineChart label="Recorded investable capital by day" format={(v) => usd(v)} height={160} series={[{ label: "Investable capital (recorded)", points: recorded.map((d) => ({ date: d.as_of, value: d.investable })), color: "accent" }]} />
          ) : (
            <p className="text-sm">{recorded.length === 1 ? `First day recorded: ${shortDate(recorded[0].as_of)}, ${usd(recorded[0].investable)}.` : "Nothing recorded yet. The Today page records a row each market day it is opened."}</p>
          )}
          {recorded.length > 0 && <p className="text-xs text-muted">{recorded.filter((d) => d.quality === "verified").length} of {recorded.length} days verified.</p>}
        </section>
      </div>

      <section aria-labelledby="hr-h" className={card}>
        <h2 id="hr-h" className="font-semibold">By holding</h2>
        <ul className="sm:hidden flex flex-col divide-y divide-line text-sm">
          {[...risk.holdings].sort((a, b) => b.weight - a.weight).map((h) => (
            <li key={h.symbol} className="py-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
              <Link href={`/research/${h.symbol}`} className="no-underline text-ink font-mono font-medium">{h.symbol}</Link>
              <span className="text-right font-mono">{pctStr(h.weight)} <span className={toneOf(h.ret)}>{pctStr(h.ret, 0, true)}</span></span>
              <span className="text-xs text-muted col-span-2">Volatility {pctStr(h.vol, 0)} · largest drop {pctStr(h.maxDrawdown, 0)} · beta {n2(h.beta)}{h.partial ? ` · ${h.historyDays} days of history` : ""}</span>
            </li>
          ))}
        </ul>
        <div className="hidden sm:block overflow-x-auto -mx-1">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted text-left"><tr>
              <th className="font-normal px-1 py-1">Holding</th><th className="font-normal px-1 text-right">Weight</th><th className="font-normal px-1 text-right">Change</th><th className="font-normal px-1 text-right">Volatility</th><th className="font-normal px-1 text-right">Largest drop</th><th className="font-normal px-1 text-right">Beta</th>
            </tr></thead>
            <tbody className="divide-y divide-line font-mono">
              {[...risk.holdings].sort((a, b) => b.weight - a.weight).map((h) => (
                <tr key={h.symbol}>
                  <td className="px-1 py-1.5"><Link href={`/research/${h.symbol}`} className="no-underline text-ink">{h.symbol}</Link>{h.partial && <span className="text-xs text-muted font-sans"> · {h.historyDays}d</span>}</td>
                  <td className="px-1 text-right">{pctStr(h.weight)}</td>
                  <td className={`px-1 text-right ${toneOf(h.ret)}`}>{pctStr(h.ret, 0, true)}</td>
                  <td className="px-1 text-right">{pctStr(h.vol, 0)}</td>
                  <td className="px-1 text-right text-loss">{pctStr(h.maxDrawdown, 0)}</td>
                  <td className="px-1 text-right">{n2(h.beta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted">Over the selected range{risk.start ? `, ${shortDate(risk.start)} to ${shortDate(risk.asOf)}` : ""}. Volatility is yearly; beta is against the S&amp;P 500.</p>
      </section>
    </div>
  );
}
