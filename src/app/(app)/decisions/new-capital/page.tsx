import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { newCapital, type OptionLabel } from "@/lib/decision/newCapital";
import { Tag } from "@/components/Tag";
import { AskButton } from "@/components/AskPanel";
import { DataQuality } from "@/components/DataQuality";
import { pctStr, usd } from "@/lib/format";
import { recordNewCapital } from "../actions";

const LABEL_TONE: Record<OptionLabel, "accent" | "warn" | "alert" | "neutral"> = {
  Candidate: "accent", "Valid option": "neutral", "Refresh required": "warn", "Research needed": "warn", "At limit": "neutral", "Below hurdle": "neutral", "Trim review": "alert",
};
const KIND: Record<string, string> = { stock: "existing position", new_stock: "new position", etf: "diversified ETF", cash: "", trim: "reduce exposure" };

export default async function NewCapitalPage({ searchParams }: { searchParams: Promise<{ amount?: string; source?: string }> }) {
  const sp = await searchParams;
  const amount = Math.max(1, Math.min(1_000_000, Number(String(sp.amount ?? "1250").replace(/[$,]/g, "")) || 1250));
  const source = sp.source === "existing" ? "existing" : "new";
  const ws = await getWorkspace();
  const r = newCapital({ amount, source, portfolio: ws.portfolio, research: ws.research, policy: ws.policy, now: ws.now, quotes: ws.quotes });
  const rec = r.recommendation;
  const wait = r.status !== "actionable";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Link href="/" className="text-sm no-underline">← Today</Link>
        <h1 className="font-serif text-2xl sm:text-3xl font-semibold">New capital analysis</h1>
        <form className="flex flex-wrap gap-2 items-end" action="/decisions/new-capital">
          <label className="text-sm flex flex-col gap-1">Amount
            <span className="flex items-center rounded-lg border border-line-strong bg-surface px-3 min-h-11"><span className="text-muted">$</span><input name="amount" defaultValue={amount} inputMode="decimal" className="w-28 bg-transparent px-1 font-mono outline-none" /></span>
          </label>
          <label className="text-sm flex flex-col gap-1">Coming from
            <select name="source" defaultValue={source} className="rounded-lg border border-line-strong bg-surface px-3 min-h-11">
              <option value="new">New money (paycheck, transfer in)</option>
              <option value="existing">Cash I already hold</option>
            </select>
          </label>
          <button className="min-h-11 px-4 rounded-lg border border-line-strong font-medium">Recalculate</button>
        </form>
      </div>

      <section aria-labelledby="st-h" className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm text-muted">Available to evaluate</div>
            <div className="font-mono text-3xl">{usd(amount)}</div>
          </div>
          <div className="text-right">
            <div className="text-sm text-muted">Decision status</div>
            <h2 id="st-h" className="text-2xl font-semibold">{wait ? "WAIT / REVIEW" : "ACTIONABLE"}</h2>
            <Tag tone={wait ? "warn" : "accent"}>{wait ? `${r.gates.filter((g) => !g.ok).length} of ${r.gates.length} checks open` : "All checks passed"}</Tag>
          </div>
        </div>
        <p className="text-[15px]">
          {wait
            ? "There is not enough current evidence to rank the alternatives with confidence. Clear the items below before treating any split as a recommendation."
            : `${rec.headline}. Every input is current and every limit is one you approved.`}
        </p>
        <ul className="grid gap-1.5 sm:grid-cols-2 text-sm">
          {r.gates.map((g) => (
            <li key={g.key} className="flex gap-2"><span aria-hidden="true" className={g.ok ? "text-gain" : "text-warn-ink"}>{g.ok ? "✓" : "○"}</span><span><span className="font-medium">{g.label}.</span> <span className="text-ink-2">{g.detail}</span></span></li>
          ))}
        </ul>
        {r.toVerify.length > 0 && (
          <div>
            <h3 className="font-semibold text-sm mb-1">What to verify</h3>
            <ol className="text-sm list-decimal pl-5 flex flex-col gap-0.5">{r.toVerify.map((t) => <li key={t}>{t}</li>)}</ol>
          </div>
        )}
      </section>

      <section aria-labelledby="alt-h" className="bg-surface border border-line rounded-2xl p-5">
        <h2 id="alt-h" className="font-semibold mb-2">Alternatives</h2>
        <ul className="flex flex-col divide-y divide-line">
          {r.options.map((o) => (
            <li key={`${o.kind}-${o.symbol}`}>
              <details className="py-2.5">
                <summary className="flex items-center justify-between gap-3 cursor-pointer list-none">
                  <span><span className="font-mono font-medium">{o.kind === "cash" ? "Hold cash" : o.symbol}</span>{KIND[o.kind] && <span className="text-sm text-ink-2"> · {KIND[o.kind]}</span>}</span>
                  <Tag tone={LABEL_TONE[o.label]}>{o.label}</Tag>
                </summary>
                <div className="mt-2 text-sm flex flex-col gap-1">
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[13px] text-ink-2">
                    {o.price !== null && <span>{usd(o.price, 2)}{o.priceSource === "statement" ? " (statement)" : ""}</span>}
                    {o.expectedReturn !== null && <span>exp. {pctStr(o.expectedReturn)}/yr{o.kind === "etf" ? " (assumption)" : ""}</span>}
                    {o.weightNow !== null && <span>now {pctStr(o.weightNow)}{o.maxWeight !== null ? ` / ${pctStr(o.maxWeight, 0)}` : ""}</span>}
                    {o.headroomDollars !== null && <span>room {usd(o.headroomDollars)}</span>}
                  </div>
                  {o.zoneAction && <div className="text-ink-2">Research price band today: {o.zoneAction} (a prompt to research, not a trade)</div>}
                  <ul className="list-disc pl-5 text-ink-2">{o.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                </div>
              </details>
            </li>
          ))}
        </ul>
      </section>

      <details className="bg-surface border border-line rounded-2xl p-5" open={!wait}>
        <summary className="font-semibold cursor-pointer">{wait ? "Illustrative split (not a recommendation)" : `Recommended split · confidence ${rec.confidence}/10`}</summary>
        <div className="mt-3 flex flex-col gap-2 text-sm">
          <div className="font-mono text-lg">{rec.allocations.map((x) => `${usd(x.amount)} ${x.symbol}`).join(" + ")}</div>
          {wait && <p className="text-warn-ink">Shown only to make the engine&apos;s mechanics visible. It uses placeholder assumptions and unverified inputs.</p>}
          <ul className="list-disc pl-5 text-ink-2 flex flex-col gap-1">{rec.rationale.map((x) => <li key={x}>{x}</li>)}</ul>
          <p className="text-ink-2"><span className="font-medium text-ink">Would change it:</span> {rec.wouldChange.join(" ")}</p>
          <p className="text-xs text-muted">ETF {pctStr(r.assumptions.etfExpectedReturn)} ({r.assumptions.etfSource}) · hurdle {pctStr(r.assumptions.hurdlePoints, 0)} ({r.assumptions.hurdleSource}). <Link href="/policy">Set your own →</Link></p>
        </div>
      </details>

      <DataQuality p={ws.portfolio} compact />

      <section aria-labelledby="rec2-h" className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-3">
        <h2 id="rec2-h" className="font-semibold">Record what you decide</h2>
        <form action={recordNewCapital} className="flex flex-col gap-3">
          <input type="hidden" name="amount" value={amount} />
          <input type="hidden" name="source" value={source} />
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm text-muted mb-1">Your decision (nothing is selected for you)</legend>
            {(wait
              ? [["deferred", "Wait and verify first"], ["declined", "Act anyway, differently (describe below)"], ["partially_followed", "Act on part of the illustrative split"]]
              : [["followed", "Follow the recommendation"], ["partially_followed", "Follow part of it"], ["declined", "Do something else"], ["deferred", "Decide later / keep cash"]]
            ).map(([v, l]) => (
              <label key={v} className="inline-flex items-center gap-2 min-h-10"><input type="radio" name="user_action" value={v} required /> {l}</label>
            ))}
          </fieldset>
          <label htmlFor="exec" className="text-sm text-muted">What you actually traded, if anything (optional)</label>
          <input id="exec" name="execution" placeholder="e.g. bought 3 AVUV at $98.10 in Schwab" className="rounded-lg border border-line-strong bg-ground px-3 min-h-10" />
          <label htmlFor="note" className="text-sm text-muted">Why (optional)</label>
          <textarea id="note" name="note" rows={2} className="rounded-lg border border-line-strong bg-ground px-3 py-2" />
          <button className="min-h-11 px-4 rounded-lg bg-ink text-ground font-medium">Save decision</button>
          <p className="text-xs text-muted">Saving records the inputs, timestamps, alternatives, assumptions and your choice. The app never places trades.</p>
        </form>
        <AskButton question={`Explain the ${usd(amount)} new capital analysis, what is blocking it, and the strongest case against each alternative.`} className="min-h-11 px-4 rounded-lg border border-line-strong font-medium">Ask why</AskButton>
      </section>
    </div>
  );
}
