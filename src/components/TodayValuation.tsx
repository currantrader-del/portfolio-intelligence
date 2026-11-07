import type { Workspace } from "@/lib/workspace";
import { getQuote } from "@/lib/market/quotes";
import { DEFAULT_ASSUMPTIONS } from "@/lib/decision/newCapital";
import { expectedReturnAt, repriceCheck, scenarioReturnsAt, zoneFor } from "@/lib/research/valuation";
import { researchAgeDays } from "@/lib/research/records";
import { coverage } from "@/lib/research/status";
import { pctStr, shortDate, usd } from "@/lib/format";
import { Bar, Card, CardHead, DataLabel, Disclose, LinkRow, Metric, Pill } from "./ui";
import { ZoneBar, toZoneViews } from "./ZoneBar";

const cap1 = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "—");

/**
 * Company Research card: the stored research (dated) re-priced at today's price, with the
 * labels kept separate. The research's scenario values are never changed here; only the price
 * and the time left move. When research cannot be re-priced, no return is shown.
 */
export async function InvestmentSummary({ ws, symbol }: { ws: Workspace; symbol: string }) {
  const r = ws.research.find((x) => x.symbol === symbol);
  const h = ws.portfolio.holdings.find((x) => x.symbol === symbol);
  const q = ws.quotes.get(symbol) ?? (await getQuote(symbol));
  const price = q?.price ?? h?.price ?? null;
  const v = r?.current;
  const any = r?.current ?? r?.latest;
  const age = r ? researchAgeDays(r, ws.now) : null;
  const freshDays = ws.policy?.researchFreshnessDays ?? 120;
  const check = v ? repriceCheck(v.parsed, price, age, freshDays) : null;
  const er = v && price && check?.ok ? expectedReturnAt(v.parsed, price, ws.now) : null;
  const scen = v && price && check?.ok ? scenarioReturnsAt(v.parsed, price, ws.now) : [];
  const zone = v && price ? zoneFor(v.parsed.zones, price) : null;
  const exp = ws.portfolio.exposures.find((e) => e.symbol === symbol);
  const cov = coverage(r, price, ws.now, freshDays);
  const audit = ws.policy?.audit;
  const etf = audit?.assumptions.etfExpectedReturn.value ?? DEFAULT_ASSUMPTIONS.etfExpectedReturn;
  const hurdle = ws.policy?.hurdleOverEtfPoints ?? audit?.assumptions.hurdle.value ?? DEFAULT_ASSUMPTIONS.hurdlePoints;
  const approved = !!audit && audit.assumptions.etfExpectedReturn.status === "approved" && audit.assumptions.hurdle.status === "approved";
  const lim = ws.policy?.companies[symbol];

  return (
    <Card labelledBy="inv-h">
      <CardHead id="inv-h" cap="Investment summary" right={<span className="pill" style={{ color: cov.tone === "gain" ? "var(--gain)" : cov.tone === "warn" ? "var(--warn-ink)" : undefined, background: cov.tone === "warn" ? "var(--warn-bg)" : undefined }} title={cov.detail}><span className={`dot ${cov.dot === "hollow" ? "dot-hollow" : ""}`} aria-hidden="true" />Research {cov.label.toLowerCase()}</span>} />
      {any ? (
        <div className="grid grid-cols-3 gap-2">
          <Metric label="Action" value={cap1(any.parsed.action)} />
          <Metric label="Confidence" value={cap1(any.parsed.confidence)} />
          <Metric label="Research" value={shortDate(any.research_as_of).replace(/, \d{4}$/, "")} note={age !== null ? `${age} days old` : undefined} />
        </div>
      ) : (
        <p className="t-sm">No research on file for {symbol}. Run the screen below, then start full research before comparing it for new money.</p>
      )}

      {v && (
        <>
          <div className="divider" />
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3"><span className="t-sm">Valuation at today&apos;s price</span><DataLabel kind="model" /></div>
            {v.parsed.zones.length > 0 && <ZoneBar zones={toZoneViews(v.parsed.zones)} price={price} />}
            {zone && <span className="t-xs">Band today: {zone.label} · {zone.action}. A prompt to research, not a trade.</span>}
            {check?.ok ? (
              <>
                <div className="flex items-center justify-between gap-3"><span className="t-sm">Expected return</span><span className="num font-semibold">{er === null ? "—" : `≈ ${pctStr(er)} a year`}</span></div>
                {er !== null && (
                  <div className="flex items-center justify-between gap-3 t-xs">
                    <span>Hurdle: ETF {pctStr(etf, 0)} + {pctStr(hurdle, 0).replace("%", "")} pts{approved ? "" : " (placeholder)"}</span>
                    <span className={er >= etf + hurdle ? "gain" : "warn"}>{er >= etf + hurdle ? "clears it" : "below it"}</span>
                  </div>
                )}
              </>
            ) : (
              <p className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2">Not re-priced. {check?.reason}</p>
            )}
          </div>
        </>
      )}

      <div className="divider" />
      {exp ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3"><span className="t-sm">Your exposure</span><span className="t-sm num text-ink">{pctStr(exp.total)} <span className="t-xs">of max {pctStr(exp.max, 0)}</span></span></div>
          <Bar thin value={exp.total} max={exp.max} markers={lim?.normal ? [lim.normal.low, lim.normal.high] : []} label={`${pctStr(exp.total)} of a ${pctStr(exp.max, 0)} maximum`} />
          <span className="t-xs">{pctStr(exp.direct)} direct · {pctStr(exp.viaEtfs)} through ETFs (approx.) · room {usd(exp.headroomDollars)}</span>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3"><span className="t-sm">Your exposure</span><span className="t-sm">Not held</span></div>
      )}

      {scen.length > 0 && (
        <div className="border-t border-line -mb-2">
          <Disclose summary="Scenarios at today's price">
            <div className="overflow-x-auto -mx-1">
              <table className="tbl">
                <thead><tr><th>Scenario</th><th className="n">Prob.</th><th className="n">Value at horizon</th><th className="n">A year from today</th></tr></thead>
                <tbody>
                  {scen.map((s) => <tr key={s.name}><td className="capitalize">{s.name}</td><td className="n">{pctStr(s.probability, 0)}</td><td className="n">{usd(s.value, 2)}</td><td className="n">{pctStr(s.annualized)}</td></tr>)}
                  <tr><td className="text-ink font-semibold">Weighted</td><td /><td className="n text-ink">{usd(v!.parsed.weightedValue, 2)}</td><td className="n text-ink">{pctStr(er)}</td></tr>
                </tbody>
              </table>
            </div>
            <p className="t-xs">Scenario values are from the {shortDate(v!.research_as_of)} research ({v!.completeness}); only the price ({price ? usd(price, 2) : "—"}{q ? `, ${q.provider} delayed` : ""}) and the time left to {shortDate(v!.parsed.horizonDate)} changed. Reference {usd(v!.parsed.referencePrice, 2)} on {shortDate(v!.parsed.referenceDate)}.</p>
          </Disclose>
        </div>
      )}
      {h && <LinkRow href={`/decisions/review/${symbol}`}>Review this position</LinkRow>}
      {!q && h && <Pill tone="warn" small>Statement price</Pill>}
    </Card>
  );
}
