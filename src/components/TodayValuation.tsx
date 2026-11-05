import Link from "next/link";
import type { Workspace } from "@/lib/workspace";
import { getQuote } from "@/lib/market/quotes";
import { expectedReturnAt, scenarioReturnsAt, zoneFor } from "@/lib/research/valuation";
import { researchAgeDays } from "@/lib/research/records";
import { pctStr, shortDate, usd } from "@/lib/format";
import { Tag } from "./Tag";
import { AskButton } from "./AskPanel";

/** Research (Layer 2) re-priced at today's price (Layer 3), with the labels kept separate. */
export async function TodayValuation({ ws, symbol }: { ws: Workspace; symbol: string }) {
  const r = ws.research.find((x) => x.symbol === symbol);
  const h = ws.portfolio.holdings.find((x) => x.symbol === symbol);
  const q = ws.quotes.get(symbol) ?? (await getQuote(symbol));
  const price = q?.price ?? h?.price ?? null;
  const v = r?.current;
  const age = r ? researchAgeDays(r, ws.now) : null;
  const er = v && price ? expectedReturnAt(v.parsed, price, ws.now) : null;
  const scen = v && price ? scenarioReturnsAt(v.parsed, price, ws.now) : [];
  const zone = v && price ? zoneFor(v.parsed.zones, price) : null;
  const exp = ws.portfolio.exposures.find((e) => e.symbol === symbol);

  return (
    <section className="bg-surface border border-line rounded-2xl p-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold mr-2">At today&apos;s price</h2>
        <span className="font-mono">{price ? usd(price, 2) : "No price"}</span>
        {q && <span className="text-xs text-muted">{q.provider} · {new Date(q.asOf).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET</span>}
        {!q && h && <Tag tone="warn">Statement price</Tag>}
      </div>
      {!v ? (
        <p className="text-sm text-ink-2">{r?.conflict ? "The stored records conflict, so nothing is re-priced until a targeted refresh." : "No current research to re-price."}</p>
      ) : (
        <>
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
            <div><dt className="text-muted">Expected return</dt><dd className="font-mono text-lg">{er === null ? "—" : `${pctStr(er)} / yr`}</dd><dd className="text-xs text-muted">Calculated · to {shortDate(v.parsed.horizonDate)}</dd></div>
            <div><dt className="text-muted">Research reference</dt><dd className="font-mono text-lg">{usd(v.parsed.referencePrice, 2)}</dd><dd className="text-xs text-muted">{v.parsed.action} · {shortDate(v.parsed.referenceDate)}</dd></div>
            <div><dt className="text-muted">Price band today</dt><dd className="font-medium">{zone ? zone.label : "—"}</dd><dd className="text-xs text-muted">{zone ? zone.action : "No band covers this price"}</dd></div>
            <div><dt className="text-muted">Your exposure</dt><dd className="font-mono text-lg">{exp ? pctStr(exp.total) : "Not held"}</dd><dd className="text-xs text-muted">{exp ? `max ${pctStr(exp.max, 0)} · room ${usd(exp.headroomDollars)}` : ""}</dd></div>
          </dl>
          {scen.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-sm">
                <thead><tr className="text-left text-muted"><th className="py-1.5 font-medium">Scenario</th><th className="py-1.5 font-medium">Probability</th><th className="py-1.5 font-medium">Value at horizon</th><th className="py-1.5 font-medium">Annual return from today</th></tr></thead>
                <tbody className="font-mono">
                  {scen.map((s) => (
                    <tr key={s.name} className="border-t border-line"><td className="py-2 font-sans capitalize">{s.name}</td><td className="py-2">{pctStr(s.probability, 0)}</td><td className="py-2">{usd(s.value, 2)}</td><td className="py-2">{pctStr(s.annualized)}</td></tr>
                  ))}
                  <tr className="border-t border-line-strong font-medium"><td className="py-2 font-sans">Weighted</td><td /><td className="py-2">{usd(v.parsed.weightedValue, 2)}</td><td className="py-2">{pctStr(er)}</td></tr>
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted">
            Scenario values are from the {shortDate(v.research_as_of)} research ({v.completeness}{age !== null ? `, ${age} days old` : ""}); only the price and the time left have changed. Bands are prompts to research, never automatic trades.
          </p>
          <div className="flex flex-wrap gap-2">
            {h && <Link href={`/decisions/review/${symbol}`} className="min-h-11 px-4 inline-flex items-center rounded-lg bg-ink text-ground no-underline font-medium">Review this position</Link>}
            <AskButton question={`What has to be true for ${symbol} to reach the base case, and what would break the thesis?`} className="min-h-11 px-4 rounded-lg border border-line-strong font-medium">Ask about the thesis</AskButton>
          </div>
        </>
      )}
    </section>
  );
}
