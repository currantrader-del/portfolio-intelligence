import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { newCapital } from "@/lib/decision/newCapital";
import { Tag } from "@/components/Tag";
import { AskButton } from "@/components/AskPanel";
import { pctStr, usd } from "@/lib/format";
import { recordNewCapital } from "../actions";

export default async function NewCapitalPage({ searchParams }: { searchParams: Promise<{ amount?: string }> }) {
  const sp = await searchParams;
  const amount = Math.max(1, Math.min(1_000_000, Number(String(sp.amount ?? "1250").replace(/[$,]/g, "")) || 1250));
  const ws = await getWorkspace();
  const r = newCapital({ amount, portfolio: ws.portfolio, research: ws.research, policy: ws.policy, now: ws.now });
  const rec = r.recommendation;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/" className="text-sm no-underline">← Today</Link>
          <h1 className="font-serif text-3xl font-semibold mt-1">Where should {usd(amount)} go?</h1>
          <p className="text-muted text-sm">Your researched stocks at today&apos;s prices, against an ETF and holding cash.</p>
        </div>
        <form className="flex gap-2" action="/decisions/new-capital">
          <label htmlFor="amount" className="sr-only">Amount</label>
          <div className="flex items-center rounded-lg border border-line-strong bg-surface px-3 min-h-11"><span className="text-muted">$</span><input id="amount" name="amount" defaultValue={amount} inputMode="decimal" className="w-28 bg-transparent px-1 font-mono outline-none" /></div>
          <button className="min-h-11 px-4 rounded-lg border border-line-strong font-medium">Recalculate</button>
        </form>
      </div>

      {r.warnings.length > 0 && (
        <div className="rounded-xl border border-warn-ink/30 bg-warn-bg text-warn-ink px-4 py-3 text-sm flex flex-col gap-1">
          {r.warnings.map((w) => <span key={w}>{w}</span>)}
        </div>
      )}

      <div className="flex flex-wrap gap-6 items-start">
        <div className="flex-[999_1_560px] min-w-0 flex flex-col gap-6">
          <section aria-labelledby="opt-h" className="bg-surface border border-line rounded-2xl p-5 overflow-x-auto">
            <h2 id="opt-h" className="font-semibold mb-3">Options compared</h2>
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr className="text-left text-muted">
                <th className="py-2 font-medium">Option</th><th className="py-2 font-medium">Price</th><th className="py-2 font-medium">Expected return</th><th className="py-2 font-medium">Weight / max</th><th className="py-2 font-medium">Room</th><th className="py-2 font-medium">Notes</th>
              </tr></thead>
              <tbody>
                {r.options.map((o) => (
                  <tr key={o.symbol} className="border-t border-line align-top">
                    <td className="py-2.5 pr-3">
                      <div className="font-mono font-medium">{o.kind === "cash" ? "Cash" : o.symbol}</div>
                      <div className="flex gap-1 mt-1">{o.kind === "etf" && <Tag>ETF</Tag>}{o.kind === "stock" && (o.eligible ? <Tag tone="accent">Qualifies</Tag> : <Tag>Not now</Tag>)}</div>
                    </td>
                    <td className="py-2.5 pr-3 font-mono">{o.price ? usd(o.price, 2) : "—"}{o.priceSource === "statement" && <div className="font-sans text-xs text-muted">statement</div>}</td>
                    <td className="py-2.5 pr-3 font-mono">{o.expectedReturn === null ? "—" : pctStr(o.expectedReturn)}{o.kind === "etf" && <div className="font-sans text-xs text-muted">assumption</div>}</td>
                    <td className="py-2.5 pr-3 font-mono">{o.weightNow === null ? "—" : pctStr(o.weightNow)}{o.maxWeight !== null ? ` / ${pctStr(o.maxWeight, 0)}` : ""}</td>
                    <td className="py-2.5 pr-3 font-mono">{o.headroomDollars === null ? "—" : usd(o.headroomDollars)}</td>
                    <td className="py-2.5 text-xs text-ink-2">
                      {o.zoneAction && <div>Today&apos;s band: {o.zoneAction}</div>}
                      {o.researchAction && <div>Research said: {o.researchAction}</div>}
                      {o.notes.map((n) => <div key={n}>{n}</div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted mt-3">Expected returns re-price each stock&apos;s stored scenarios at today&apos;s price. The ETF figure ({pctStr(r.assumptions.etfExpectedReturn)}) and the {pctStr(r.assumptions.hurdlePoints, 0)} hurdle are {r.assumptions.hurdleSource === "default" ? "defaults until you set your own" : "from your policy"}.</p>
          </section>
        </div>

        <aside className="flex-[1_1_340px] min-w-0 flex flex-col gap-6">
          <section aria-labelledby="rec-h" className="bg-chrome text-chrome-ink rounded-2xl p-6 flex flex-col gap-3">
            <h2 id="rec-h" className="text-xs font-semibold tracking-wider text-chrome-muted">RECOMMENDATION · CONFIDENCE {rec.confidence}/10</h2>
            <div className="font-serif text-2xl font-semibold">{rec.headline}</div>
            <ul className="flex flex-col gap-2 text-[15px] text-[#d9dbde] list-disc pl-5">{rec.rationale.map((x) => <li key={x}>{x}</li>)}</ul>
            <div className="text-sm text-chrome-muted"><span className="font-medium">Would change it:</span> {rec.wouldChange.join(" ")}</div>
            <div className="text-xs text-chrome-muted">Calculated by the app (model output). The app never places trades.</div>
          </section>

          <section aria-labelledby="rec2-h" className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-3">
            <h2 id="rec2-h" className="font-semibold">Record what you decide</h2>
            <form action={recordNewCapital} className="flex flex-col gap-3">
              <input type="hidden" name="amount" value={amount} />
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-sm text-muted mb-1">I will</legend>
                {[["followed", "Follow it"], ["partially_followed", "Follow part of it"], ["declined", "Do something else"], ["deferred", "Decide later / keep cash"]].map(([v, l], i) => (
                  <label key={v} className="inline-flex items-center gap-2 min-h-10"><input type="radio" name="user_action" value={v} defaultChecked={i === 0} /> {l}</label>
                ))}
              </fieldset>
              <label htmlFor="note" className="text-sm text-muted">Note (optional)</label>
              <textarea id="note" name="note" rows={2} className="rounded-lg border border-line-strong bg-ground px-3 py-2" />
              <button className="min-h-11 px-4 rounded-lg bg-ink text-ground font-medium">Save decision</button>
            </form>
            <AskButton question={`Explain the ${usd(amount)} recommendation and the strongest case against it.`} className="min-h-11 px-4 rounded-lg border border-line-strong font-medium">Ask why</AskButton>
          </section>
        </aside>
      </div>
    </div>
  );
}
