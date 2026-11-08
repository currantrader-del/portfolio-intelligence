import Link from "next/link";
import type { Workspace } from "@/lib/workspace";
import { newCapital, type OptionLabel } from "@/lib/decision/newCapital";
import { recordNewCapital } from "@/app/(app)/decisions/actions";
import { loadDecisionFilings } from "@/lib/alerts/events";
import { AskButton } from "@/components/AskPanel";
import { pctStr, usd } from "@/lib/format";
import { Card, CardHead, DataLabel, Disclose, Dot, Pill } from "@/components/ui";

const LABEL_TONE: Record<OptionLabel, "gain" | "warn" | "neutral" | "solid" | "alert"> = {
  Candidate: "solid", "Valid option": "neutral", "Refresh required": "warn", "Research needed": "warn", "No limit set": "warn", "At limit": "warn", "Below the bar": "neutral", "Research says wait": "neutral", "Trim review": "alert",
};
const KIND: Record<string, string> = { stock: "Existing position", new_stock: "New position", etf: "Diversified ETF", cash: "Always available", trim: "Reduce exposure" };
const GATE_LINK: Record<string, { href: string; label: string }> = {
  holdings: { href: "/portfolio/reconcile", label: "Update holdings" },
  cash: { href: "/portfolio/reconcile", label: "Enter savings" },
  limits: { href: "/policy", label: "Choose limits" },
  assumptions: { href: "/policy", label: "Review on Policy" },
  research: { href: "/research", label: "Refresh research" },
};

/**
 * Investment Decision card set for new cash. The engine decides; this only lays it out.
 * When the status is WAIT / REVIEW nothing here reads as a recommendation.
 */
export async function NewCapitalView({ ws, amount, source, action }: { ws: Workspace; amount: number; source: "new" | "existing"; action: string }) {
  const filings = await loadDecisionFilings(ws);
  const r = newCapital({ amount, source, portfolio: ws.portfolio, research: ws.research, policy: ws.policy, now: ws.now, quotes: ws.quotes, filings });
  const rec = r.recommendation;
  const wait = r.status !== "actionable";
  const open = r.gates.filter((g) => !g.ok);

  return (
    <div className="grid grid-cols-1 gap-3 lg:gap-4 lg:grid-cols-12 items-start">
      <div className="lg:col-span-6 flex flex-col gap-3 lg:gap-4 min-w-0">
        <form action={action} className="card card-tight !flex-row items-end gap-2">
          <label className="field flex-1">Amount
            <span className="flex items-center rounded-[12px] border border-line-strong bg-ground px-3 min-h-11"><span className="text-muted">$</span><input name="amount" defaultValue={amount} inputMode="decimal" aria-label="Amount in dollars" className="w-full bg-transparent px-1 num outline-none text-ink" /></span>
          </label>
          <label className="field flex-1">From
            <select name="source" defaultValue={source} className="input">
              <option value="new">New money</option>
              <option value="existing">Cash I hold</option>
            </select>
          </label>
          <button className="btn shrink-0">Update</button>
        </form>

        <Card labelledBy="res-h">
          <CardHead id="res-h" cap="Result" right={wait ? <Pill>Wait / review</Pill> : <DataLabel kind="recommendation">Actionable</DataLabel>} />
          <div className="flex flex-col gap-1">
            <span className="text-[20px] font-semibold tracking-tight leading-snug">{wait ? "Wait before investing this" : rec.headline}</span>
            <span className="t-sm">{wait ? `${open.length} of ${r.gates.length} checks are open, so no allocation is recommended yet. Holding cash is always a valid choice.` : "Every input is current and every limit is one you approved."}</span>
          </div>
          <ul className="flex flex-col gap-2">
            {r.gates.map((g) => (
              <li key={g.key} className="flex items-start justify-between gap-3">
                <span className="flex items-start gap-2 min-w-0">
                  <Dot kind={g.ok ? "solid" : "hollow"} className="mt-[6px]" style={{ color: g.ok ? "var(--gain)" : "var(--warn-ink)" }} />
                  <span className="flex flex-col min-w-0">
                    <span className="t-sm text-ink">{g.label}<span className="sr-only">{g.ok ? " (passed)" : " (open)"}</span></span>
                    <span className="t-xs">{g.detail}</span>
                  </span>
                </span>
                {!g.ok && GATE_LINK[g.key] && <Link href={GATE_LINK[g.key].href} className="t-xs warn no-underline shrink-0 min-h-8 inline-flex items-center">{GATE_LINK[g.key].label}</Link>}
              </li>
            ))}
          </ul>
        </Card>

        {r.toVerify.length > 0 && (
          <Card labelledBy="wc-h" className="!gap-2.5">
            <CardHead id="wc-h" title="What to verify" right={<Pill>{r.toVerify.length}</Pill>} />
            <ol className="flex flex-col gap-1.5 t-sm list-decimal pl-5">{r.toVerify.slice(0, 4).map((t) => <li key={t}>{t}</li>)}</ol>
            {r.toVerify.length > 4 && (
              <div className="border-t border-line -mb-2">
                <Disclose summary={`${r.toVerify.length - 4} more`}>
                  <ol start={5} className="flex flex-col gap-1.5 t-sm list-decimal pl-5">{r.toVerify.slice(4).map((t) => <li key={t}>{t}</li>)}</ol>
                </Disclose>
              </div>
            )}
          </Card>
        )}
      </div>

      <div className="lg:col-span-6 flex flex-col gap-3 lg:gap-4 min-w-0">
        <Card className="!gap-1 !pb-2" labelledBy="opt-h">
          <div className="mb-1.5"><CardHead id="opt-h" title="Options compared" right={<span className="t-xs">exp. return · room</span>} /></div>
          <div className="list">
            {r.options.map((o) => (
              <details key={`${o.kind}-${o.symbol}`} className="disclose border-t border-line first:border-t-0">
                <summary className="!min-h-14">
                  <span className="flex flex-col min-w-0 gap-0.5">
                    <span className="flex items-center gap-2 min-w-0"><span className="font-semibold text-ink">{o.kind === "cash" ? "Hold cash" : o.symbol}</span>{o.kind !== "cash" && <Pill small tone={LABEL_TONE[o.label]}>{o.label}</Pill>}</span>
                    <span className="t-xs truncate">{KIND[o.kind]}{o.notes[0] ? ` · ${o.notes[0]}` : ""}</span>
                  </span>
                  <span className="flex flex-col items-end shrink-0">
                    <span className={`num font-semibold ${o.expectedReturn === null ? "text-muted" : "text-ink"}`}>{o.expectedReturn === null ? "—" : pctStr(o.expectedReturn)}</span>
                    {o.kind !== "cash" && <span className="t-xs num">{o.headroomDollars === null ? "no cap" : usd(o.headroomDollars)}</span>}
                  </span>
                </summary>
                <div className="disclose-body t-sm">
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 t-xs num">
                    {o.price !== null && <span>{usd(o.price, 2)}{o.priceSource === "statement" ? " (statement)" : " (delayed)"}</span>}
                    {o.expectedReturn !== null && <span>exp. {pctStr(o.expectedReturn)}/yr{o.kind === "etf" ? " (forecast middle)" : " (model)"}</span>}
                    {o.comparison && <span>bar {pctStr(o.comparison.bar)}</span>}
                    {o.weightNow !== null && <span>now {pctStr(o.weightNow)}{o.maxWeight !== null ? ` of ${pctStr(o.maxWeight, 0)}` : ""}</span>}
                  </div>
                  {o.zoneAction && <span>Research price band today: {o.zoneAction} (a prompt to research, not a trade).</span>}
                  <ul className="list-disc pl-4 flex flex-col gap-0.5">{o.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                </div>
              </details>
            ))}
          </div>
          <span className="t-xs">Expected returns are model estimates from your research scenarios at today&apos;s price. A stock must beat the top of the published U.S. stock forecasts plus a margin for its own scenario spread. A drop is never a buy signal by itself.</span>
        </Card>

        <Card flush>
          <Disclose open={!wait} summary={wait ? "Illustrative split (not a recommendation)" : `Recommended split · confidence ${rec.confidence}/10`}>
            {wait && <DataLabel kind="illustrative" />}
            <div className="num text-[17px] text-ink">{rec.allocations.length ? rec.allocations.map((x) => `${usd(x.amount)} ${x.symbol}`).join(" + ") : "Nothing allocated"}</div>
            {wait && <p className="t-sm warn">Shown only to make the engine&apos;s mechanics visible. It uses inputs that are not yet verified or approved.</p>}
            <ul className="list-disc pl-4 t-sm flex flex-col gap-1">{rec.rationale.map((x) => <li key={x}>{x}</li>)}</ul>
            {rec.wouldChange.length > 0 && <p className="t-sm"><span className="text-ink font-semibold">Would change it:</span> {rec.wouldChange.join(" ")}</p>}
          </Disclose>
          <Disclose summary="Assumptions and sources">
            <ul className="t-sm flex flex-col gap-1">
              <li className="flex justify-between gap-3"><span>U.S. stocks, published forecasts</span><span className="num text-ink">{pctStr(r.assumptions.benchmark.low)}–{pctStr(r.assumptions.benchmark.high)} <span className="t-xs">· {r.assumptions.benchmark.sources.map((x) => `${x.firm.split(" ")[0]} ${x.asOf}`).join(", ")}</span></span></li>
              <li className="flex justify-between gap-3"><span>Margin per unit of scenario spread</span><span className="num text-ink">{r.assumptions.riskMarginFactor} <span className="t-xs">· your risk preference</span></span></li>
              <li className="flex justify-between gap-3"><span>Investable capital</span><span className="num text-ink">{usd(ws.portfolio.total)} <span className="t-xs">· {ws.portfolio.quality.status}, {ws.portfolio.quality.reconciliation.label.toLowerCase()}</span></span></li>
            </ul>
            {!r.assumptions.approved && <DataLabel kind="placeholder">Not approved yet</DataLabel>}
            <Link href="/policy" className="t-sm">Approve or reject on the Policy page</Link>
          </Disclose>
          <Disclose summary="Record what you decide">
            <form action={recordNewCapital} className="flex flex-col gap-2.5">
              <input type="hidden" name="amount" value={amount} />
              <input type="hidden" name="source" value={source} />
              <fieldset className="flex flex-col gap-1">
                <legend className="t-xs mb-1">Your decision (nothing is selected for you)</legend>
                {(wait
                  ? [["deferred", "Wait and verify first"], ["declined", "Act anyway, differently (describe below)"], ["partially_followed", "Act on part of the illustrative split"]]
                  : [["followed", "Follow the recommendation"], ["partially_followed", "Follow part of it"], ["declined", "Do something else"], ["deferred", "Decide later / keep cash"]]
                ).map(([v, l]) => (
                  <label key={v} className="inline-flex items-center gap-2.5 min-h-10 t-sm text-ink"><input type="radio" name="user_action" value={v} required className="w-[18px] h-[18px] accent-[var(--accent)]" /> {l}</label>
                ))}
              </fieldset>
              <label className="field">What you actually traded, if anything (optional)<input name="execution" placeholder="e.g. bought 3 VOO at $612 in your brokerage" className="input" /></label>
              <label className="field">Why (optional)<textarea name="note" rows={2} className="input" /></label>
              <button className="btn btn-primary">Save this decision</button>
              <p className="t-xs">Saving records the inputs, timestamps, alternatives, assumptions and your choice. The app never places trades.</p>
            </form>
          </Disclose>
        </Card>
        <AskButton question={`Explain the ${usd(amount)} new capital analysis, what is blocking it, and the strongest case against each alternative.`} className="btn w-full">Ask why</AskButton>
      </div>
    </div>
  );
}

export function parseAmount(raw: string | undefined): number {
  return Math.max(1, Math.min(1_000_000, Number(String(raw ?? "1250").replace(/[$,]/g, "")) || 1250));
}
