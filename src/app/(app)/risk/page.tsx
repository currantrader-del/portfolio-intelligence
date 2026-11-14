import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { getHistories, type Range } from "@/lib/market/history";
import { buildRisk } from "@/lib/portfolio/risk";
import { loadDaily } from "@/lib/portfolio/daily";
import { LineChart } from "@/components/LineChart";
import { pctStr, shortDate, toneOf, usd } from "@/lib/format";
import { Bar, Card, CardHead, DataLabel, Disclose, Metric, PageHeader, Seg } from "@/components/ui";
import { ExposureCard } from "@/components/cards/ExposureCard";

const RANGES: { key: Range; label: string }[] = [
  { key: "3mo", label: "3M" }, { key: "6mo", label: "6M" }, { key: "1y", label: "1Y" }, { key: "2y", label: "2Y" },
];
const RANGE_WORD: Record<string, string> = { "3mo": "3 months", "6mo": "6 months", "1y": "1 year", "2y": "2 years" };
const n2 = (v: number | null) => (v === null ? "—" : v.toFixed(2));
const md = (iso: string | null | undefined) => (iso ? shortDate(iso).replace(/, \d{4}$/, "") : "");

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
  const conflicts = new Set(ws.policy?.audit?.conflicts.map((x) => x.subject) ?? []);
  const exps = [...p.exposures].sort((a, b) => b.total - a.total);
  // Same dollars, larger denominator: savings hold no stocks.
  const share = p.investableCapital ? p.total / p.investableCapital : 1;
  const top = exps[0];
  const others = exps.slice(1, 7);
  const name = (sym: string) => ws.research.find((r) => r.symbol === sym)?.name ?? null;
  const pb = risk.priceBasis;
  const provider = pb.providers.length ? pb.providers.map((x) => (x === "stooq" ? "Stooq" : "Yahoo")).join(" and ") : "no provider";
  const basisNote = pb.priceOnly.length === 0 ? "Adjusted closes (dividends and splits included), so returns are total return." : pb.adjusted.length === 0 ? "Unadjusted closes: price only, dividends not included." : `Mixed: total return for ${pb.adjusted.length} symbols, price only for ${pb.priceOnly.join(", ")}. Returns are not fully comparable.`;

  return (
    <div className="flex flex-col gap-3 lg:gap-4">
      <PageHeader title="Risk" actions={<DataLabel kind="hypothetical">Hypothetical history</DataLabel>} />

      <div className="grid grid-cols-1 gap-3 lg:gap-4 lg:grid-cols-12 items-start">
        <div className="lg:col-span-7 flex flex-col gap-3 lg:gap-4 min-w-0">
          <Seg label="Range" current={range} items={RANGES.map((r) => ({ key: r.key, label: r.label, href: `/risk?range=${r.key}` }))} />

          {/* Chart Container */}
          <Card labelledBy="hyp-h">
            <CardHead id="hyp-h" cap={`Today's mix vs S&P 500 · ${RANGE_WORD[range]}`} />
            <LineChart label="Hypothetical value of today's holdings versus the S&P 500" format={(v) => usd(v)}
              series={[{ label: "Today's holdings", points: risk.series, color: "accent" }, { label: "S&P 500 (same start)", points: risk.benchmark, color: "muted", dashed: true }]} />
            <div className="grid grid-cols-2 gap-3">
              <Metric size="sm" label="Change" value={<><span className={toneOf(s.ret)}>{pctStr(s.ret, 1, true)}</span> <span className="t-xs">vs {pctStr(s.benchRet, 1, true)}</span></>} />
              <Metric size="sm" label="Volatility, yearly" value={<>{pctStr(s.vol, 0)} <span className="t-xs">vs {pctStr(s.benchVol, 0)}</span></>} />
              <Metric size="sm" label="Largest drop" value={<span className="loss">{pctStr(s.maxDrawdown)}</span>} note={s.drawdownFrom ? `${md(s.drawdownFrom)} – ${md(s.drawdownTo)}` : undefined} />
              <Metric size="sm" label="Beta to S&P 500" value={n2(s.beta)} note={s.beta !== null ? `moves ${s.beta.toFixed(1)}× the market` : undefined} />
            </div>
            <p className="t-xs">Today&apos;s share counts and cash priced at each past close ({provider} daily prices). {basisNote} Not your actual return: it ignores past trades, deposits and when you bought.
              {risk.missing.length > 0 && ` No history for ${risk.missing.join(", ")}; held flat.`}{risk.partial.length > 0 && ` Shorter history for ${risk.partial.join(", ")}.`}</p>
          </Card>

          {/* Risk card: stress tests */}
          <Card className="!gap-1 !pb-2" labelledBy="sc-h">
            <div className="mb-1.5"><CardHead id="sc-h" title="Stress tests" right={<DataLabel kind="estimate" />} /></div>
            <div className="list">
              {risk.scenarios.map((sc) => (
                <details key={sc.key} className="disclose border-t border-line first:border-t-0">
                  <summary className="!min-h-[52px]">
                    <span className="flex flex-col min-w-0">
                      <span className="font-semibold text-ink text-[14px]">{sc.name}</span>
                      <span className="t-xs truncate">{sc.basis.split(".")[0]}</span>
                    </span>
                    <span className="flex flex-col items-end shrink-0">
                      <span className="num font-semibold loss">{usd(sc.dollars)}</span>
                      <span className="t-xs num">{pctStr(sc.pct, 1, true)}</span>
                    </span>
                  </summary>
                  <div className="disclose-body">
                    <p className="t-xs">{sc.basis}</p>
                    {sc.lines.length > 0 && (
                      <ul className="grid gap-x-6 gap-y-1 t-sm num sm:grid-cols-2">
                        {sc.lines.slice(0, 12).map((l) => <li key={l.symbol} className="flex justify-between gap-2"><span>{l.symbol} {pctStr(l.move, 0, true)}</span><span className={toneOf(l.dollars)}>{usd(l.dollars)}</span></li>)}
                      </ul>
                    )}
                  </div>
                </details>
              ))}
            </div>
            <span className="t-xs">Effect on your invested portfolio of {usd(p.total)} (savings outside the brokerage are not included). Cash is never shocked. Based on past behaviour; real moves can be larger.</span>
          </Card>
        </div>

        <div className="lg:col-span-5 flex flex-col gap-3 lg:gap-4 min-w-0">
          {top && <ExposureCard e={top} name={name(top.symbol)} limit={ws.policy?.companies[top.symbol]} conflict={conflicts.has(top.symbol)} />}

          {/* Allocation / exposure */}
          <Card labelledBy="ox-h">
            <CardHead id="ox-h" title="Other exposures" right={<span className="t-xs">of invested · of all investable</span>} />
            {others.map((e) => {
              const c = conflicts.has(e.symbol);
              return (
                <div key={e.symbol} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <Link href={`/research/${e.symbol}`} className="t-sm text-ink no-underline">{e.symbol}</Link>
                    <span className="t-xs num"><span className="text-ink">{pctStr(e.total)}</span> · {pctStr(e.total * share)} · limit {pctStr(e.max, 0)}{c && <span className="warn"> conflict</span>}</span>
                  </div>
                  <Bar thin value={e.total} max={e.max} label={`${e.symbol} ${pctStr(e.total)} of ${pctStr(e.max, 0)}`} />
                </div>
              );
            })}
            <div className="divider" />
            <div className="flex items-center justify-between gap-3"><span className="t-sm">Top 5 companies</span><span className="t-sm num text-ink font-semibold">{pctStr(risk.concentration.topFive, 0)} of invested · {pctStr(risk.concentration.topFive * share, 0)} of all investable</span></div>
            <span className="t-xs">Two denominators: your invested portfolio ({usd(p.total)}, which every limit applies to) and total investable capital ({usd(p.investableCapital)}, adding savings). Each company is counted once: direct plus its share inside your ETFs. Top 5 includes your share of companies inside ETFs (approximate). Across holdings, the mix is like about {risk.concentration.effectiveN.toFixed(0)} equal positions, counting each ETF as one. Conflicted limits use the stricter source until you choose.</span>
          </Card>

          <Card flush>
            <Disclose summary="By holding">
              <div className="overflow-x-auto -mx-1">
                <table className="tbl">
                  <thead><tr><th>Holding</th><th className="n">Weight</th><th className="n">Change</th><th className="n">Vol.</th><th className="n">Drop</th><th className="n">Beta</th></tr></thead>
                  <tbody>
                    {[...risk.holdings].sort((a, b) => b.weight - a.weight).map((h) => (
                      <tr key={h.symbol}>
                        <td><Link href={`/research/${h.symbol}`} className="no-underline text-ink">{h.symbol}</Link>{h.partial && <span className="t-xs"> · {h.historyDays}d</span>}</td>
                        <td className="n">{pctStr(h.weight)}</td>
                        <td className={`n ${toneOf(h.ret)}`}>{pctStr(h.ret, 0, true)}</td>
                        <td className="n">{pctStr(h.vol, 0)}</td>
                        <td className="n loss">{pctStr(h.maxDrawdown, 0)}</td>
                        <td className="n">{n2(h.beta)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="t-xs">{risk.start ? `${shortDate(risk.start)} to ${shortDate(risk.asOf)}. ` : ""}Volatility is yearly; beta is against the S&amp;P 500.</p>
            </Disclose>
            <Disclose summary="Methodology and data">
              <ul className="t-sm list-disc pl-4 flex flex-col gap-1">
                <li>History is hypothetical: today&apos;s share counts at past daily closes, with cash held flat.</li>
                <li>Index scenarios move each holding by its beta to that index; the single-company scenario includes its approximate weight inside your index ETFs.</li>
                <li>ETF look-through weights are approximate reference data, not live.</li>
                <li>Prices: {provider} daily closes. {basisNote}</li>
                <li>Volatility is the sample standard deviation of daily returns times the square root of 252. Beta is the covariance with the index divided by the index variance, over the chosen range.</li>
                <li>A holding with too little history (under 20 daily returns) has no beta and is left out of the index scenarios rather than given an assumed one.</li>
              </ul>
            </Disclose>
            <Disclose summary={`Recorded history${recorded.length ? ` · started ${md(recorded[0].as_of)}` : ""}`}>
              <p className="t-xs">What the app showed each day you opened it. This is your real value history; rows stay labelled estimated until accounts sync automatically.</p>
              {recorded.length >= 2 ? (
                <LineChart label="Recorded invested portfolio by day" format={(v) => usd(v)} height={150} series={[{ label: "Invested portfolio (recorded; savings excluded)", points: recorded.map((d) => ({ date: d.as_of, value: d.invested + d.cash })), color: "accent" }]} />
              ) : (
                <p className="t-sm">{recorded.length === 1 ? `First day recorded: ${shortDate(recorded[0].as_of)}, ${usd(recorded[0].invested + recorded[0].cash)} invested portfolio.` : "Nothing recorded yet. Opening Today records a row each market day."}</p>
              )}
              {recorded.length > 0 && <p className="t-xs">{recorded.filter((d) => d.quality === "verified").length} of {recorded.length} days verified.</p>}
            </Disclose>
          </Card>
        </div>
      </div>
    </div>
  );
}
