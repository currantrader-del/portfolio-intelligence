import { ActionForm, SubmitButton } from "@/components/forms";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspace } from "@/lib/workspace";
import { reviewPosition } from "@/lib/decision/review";
import { Tag } from "@/components/Tag";
import { AskButton } from "@/components/AskPanel";
import { pctStr, shortDate, toneOf, usd } from "@/lib/format";
import { recordReview } from "../../actions";

export default async function ReviewPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const ws = await getWorkspace();
  const sym = symbol.toUpperCase();
  const rv = reviewPosition(ws, sym);
  if (!rv) notFound();
  const alerts = ws.alerts.filter((a) => a.symbol === sym);
  const spy = ws.benchmarks.find((b) => b.symbol === "SPY")?.dayPct ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/" className="text-sm no-underline max-lg:hidden">← Today</Link>
          <h1 className="h1 mt-1">Review {sym}</h1>
          <div className="text-sm text-muted">
            <span className="font-mono">{usd(rv.price, 2)} <span className={toneOf(rv.dayPct)}>{pctStr(rv.dayPct, 1, true)}</span></span>
            {rv.priceSource === "statement" && " (statement price)"} · your position {pctStr(rv.weight)} of the portfolio, {usd(rv.value)}
          </div>
        </div>
        {alerts[0] && <Tag tone={alerts[0].severity === "high" ? "alert" : alerts[0].severity === "medium" ? "warn" : "neutral"}>{alerts[0].severity.toUpperCase()}</Tag>}
      </div>

      <div className="flex flex-wrap gap-6 items-start">
        <div className="flex-[999_1_560px] min-w-0 flex flex-col gap-6">
          <section aria-labelledby="what-h" className="bg-surface border border-line rounded-2xl p-6">
            <h2 id="what-h" className="font-semibold mb-2">What happened</h2>
            <ul className="list-disc pl-5 flex flex-col gap-1.5 text-[15px]">
              {alerts.map((a) => <li key={a.id}><span className="font-medium">{a.title}.</span> {a.detail}</li>)}
              {rv.dayPct !== null && spy !== null && <li>Today {pctStr(rv.dayPct, 1, true)} against {pctStr(spy, 1, true)} for the S&amp;P 500. <span className="text-xs text-muted">Market data</span></li>}
              {!alerts.length && <li>No alerts on {sym} right now.</li>}
            </ul>
            <div className="mt-3"><AskButton question={`Has anything material happened to ${sym} recently (filings, financing, guidance)? What does it mean for the thesis?`} className="btn btn-sm">Ask what caused it</AskButton></div>
          </section>

          <section aria-labelledby="th-h" className="bg-surface border border-line rounded-2xl p-6 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="th-h" className="font-semibold mr-1">Thesis on file</h2>
              {rv.researchAsOf ? <><Tag tone={rv.completeness === "complete" ? "accent" : "warn"}>{rv.completeness}</Tag><Tag>{shortDate(rv.researchAsOf)} · {rv.researchAge} days old</Tag></> : <Tag tone="warn">No current research</Tag>}
            </div>
            {rv.thesis ? <p className="text-[16px] leading-relaxed">{rv.thesis}</p> : <p className="text-ink-2">Nothing stored. <Link href={`/research/${sym}`}>Open research</Link></p>}
            {rv.researchAction && <p className="text-sm text-muted">Research action then: {rv.researchAction} at {usd(rv.referencePrice, 2)}.</p>}
          </section>

          {rv.repriceNote && <p className="rounded-lg border border-warn-ink/30 bg-warn-bg text-warn-ink px-3 py-2 text-sm">{rv.repriceNote}</p>}
          {rv.scenarios.length > 0 && (
            <section aria-labelledby="val-h" className="bg-surface border border-line rounded-2xl p-6 overflow-x-auto">
              <h2 id="val-h" className="font-semibold mb-3">Valuation at today&apos;s price</h2>
              <table className="w-full min-w-[460px] text-sm">
                <thead><tr className="text-left text-muted"><th className="py-1.5 font-medium">Scenario</th><th className="py-1.5 font-medium">Probability</th><th className="py-1.5 font-medium">Value</th><th className="py-1.5 font-medium">Annual return from {usd(rv.price, 2)}</th></tr></thead>
                <tbody className="font-mono">
                  {rv.scenarios.map((s) => <tr key={s.name} className="border-t border-line"><td className="py-2 font-sans capitalize">{s.name}</td><td className="py-2">{pctStr(s.probability, 0)}</td><td className="py-2">{usd(s.value, 2)}</td><td className="py-2">{pctStr(s.annualized)}</td></tr>)}
                  <tr className="border-t border-line-strong font-medium"><td className="py-2 font-sans">Weighted</td><td /><td /><td className="py-2">{pctStr(rv.expectedReturn)}</td></tr>
                </tbody>
              </table>
              {rv.zone && <p className="text-sm mt-3">Today&apos;s band: <span className="font-medium">{rv.zone.label}</span> · {rv.zone.action}</p>}
              <p className="text-xs text-muted mt-2">Scenario values from stored research; re-priced by the app.</p>
            </section>
          )}
        </div>

        <aside className="flex-[1_1_340px] min-w-0 flex flex-col gap-6">
          <section className="bg-chrome text-chrome-ink rounded-2xl p-6 flex flex-col gap-3">
            <h2 className="text-xs font-semibold tracking-wider text-chrome-muted">SUGGESTION · CONFIDENCE {rv.suggestion.confidence}/10</h2>
            <div className="h1">{rv.suggestion.label}</div>
            <p className="text-[15px] text-[#d9dbde]">{rv.suggestion.reason}</p>
            <div className="text-xs text-chrome-muted">Model output from your research and limits. For a written second opinion, use Deep review.</div>
          </section>

          <section className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-3">
            <h2 className="font-semibold">Your options</h2>
            <ActionForm action={recordReview} success="Decision recorded" className="flex flex-col gap-2">
              <input type="hidden" name="symbol" value={sym} />
              {rv.options.map((o) => (
                <label key={o.key} className={`grid grid-cols-[20px_56px_1fr] gap-2 items-start p-3 rounded-lg border ${o.key === rv.suggestion.key ? "border-accent bg-accent-soft" : "border-line"} ${o.available ? "" : "opacity-50"}`}>
                  <input type="radio" name="chosen" value={o.key} required disabled={!o.available} className="mt-1" />
                  <span className="font-semibold">{o.label}</span>
                  <span className="text-sm">
                    {o.key === "hold" ? o.note : `${o.key === "add" ? "+" : "−"}${usd(o.dollars)} → ${pctStr(o.weightAfter)}`}
                    <span className="block text-xs text-muted">{o.key !== "hold" ? o.note + " · " : ""}{o.tax}</span>
                  </span>
                </label>
              ))}
              <label htmlFor="rnote" className="text-sm text-muted mt-1">Note (optional)</label>
              <textarea id="rnote" name="note" rows={2} className="rounded-lg border border-line-strong bg-ground px-3 py-2" />
              <SubmitButton className="btn btn-primary">Record my decision</SubmitButton>
            </ActionForm>
            <AskButton question={`Deep review of ${sym}: given the research, today's price and my limits, should I add, hold, trim or exit? Give the strongest case each way.`} className="min-h-11 px-4 rounded-lg border border-line-strong font-medium">Deep review</AskButton>
            <p className="text-xs text-muted">Recording saves your choice; it does not trade. Place any order yourself at Schwab.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
