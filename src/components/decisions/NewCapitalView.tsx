import Form from "next/form";
import { ActionForm, SubmitButton } from "@/components/forms";
import Link from "next/link";
import type { Workspace } from "@/lib/workspace";
import { newCapital, ruleRowsOf, type MoneySource, type NewCapitalResult, type OptionLabel } from "@/lib/decision/newCapital";
import { WATCHED } from "@/lib/decision/exposureImpact";
import { cancelTransfer, planTransfer, recordNewCapital } from "@/app/(app)/decisions/actions";
import { loadDecisionFilings } from "@/lib/alerts/events";
import { AskButton } from "@/components/AskPanel";
import { pctStr, usd } from "@/lib/format";
import { Card, CardHead, DataLabel, Disclose, Dot, Pill } from "@/components/ui";

const LABEL_TONE: Record<OptionLabel, "gain" | "warn" | "neutral" | "solid" | "alert"> = {
  Candidate: "solid", "Valid option": "neutral", "Refresh required": "warn", "Research needed": "warn", "Research not approved": "warn", "No limit set": "warn", "At limit": "warn", "Not ahead of VOO": "neutral", "Research says hold": "neutral", "Condition not met": "warn", "Limit not approved": "warn", "Trim review": "alert",
};
const KIND: Record<string, string> = { stock: "Existing position", new_stock: "New position", etf: "Diversified ETF", cash: "Always available", trim: "Reduce exposure" };
const GATE_LINK: Record<string, { href: string; label: string }> = {
  holdings: { href: "/portfolio/reconcile", label: "Check accounts" },
  research: { href: "/research", label: "Refresh research" },
};

/**
 * Investment Decision card set for new cash. The engine decides; this only lays it out.
 * The analysis (what the research and the numbers say, and the leaning) always shows. A split is "ready to
 * execute" only when the money, the holdings and the research are all verified; otherwise it is conditional.
 */
export async function NewCapitalView({ ws, amount, source, confirmed, action }: { ws: Workspace; amount: number; source: MoneySource; confirmed: boolean; action: string }) {
  const filings = await loadDecisionFilings(ws);
  const r = newCapital({ amount, source, holdingsConfirmed: confirmed, transfers: ws.transfers, portfolio: ws.portfolio, research: ws.research, policy: ws.policy, now: ws.now, quotes: ws.quotes, filings, yields: ws.yields, rules: ruleRowsOf(ws.policy) });
  const rec = r.recommendation;
  const wait = r.status !== "ready";
  const open = r.gates.filter((g) => !g.ok);

  return (
    <div className="grid grid-cols-1 gap-3 lg:gap-4 lg:grid-cols-12 items-start">
      <div className="lg:col-span-6 flex flex-col gap-3 lg:gap-4 min-w-0">
        <Form action={action} className="card card-tight !gap-2">
          <div className="flex items-end gap-2">
            <label className="field flex-1">Amount
              <span className="flex items-center rounded-[12px] border border-line-strong bg-ground px-3 min-h-11"><span className="text-muted">$</span><input name="amount" defaultValue={amount} inputMode="decimal" aria-label="Amount in dollars" className="w-full min-h-11 bg-transparent px-1 num outline-none text-ink" /></span>
            </label>
            <label className="field flex-1">The money is
              <select name="source" defaultValue={source} className="input">
                <option value="planned">New, not deposited yet</option>
                <option value="deposited">New, already deposited</option>
                <option value="existing">Cash I already hold</option>
              </select>
            </label>
          </div>
          <span className="flex items-center justify-between gap-2">
            <label className="inline-flex items-center gap-2.5 min-h-11 t-sm text-ink"><input type="checkbox" name="confirmed" value="1" defaultChecked={confirmed} className="w-[18px] h-[18px] accent-[var(--accent)]" /> I checked my accounts today and the holdings match</label>
            <button className="btn shrink-0">Update</button>
          </span>
        </Form>

        <Card labelledBy="res-h">
          <CardHead id="res-h" cap="Result" right={wait ? <Pill tone="warn">Conditional · not ready to execute</Pill> : <DataLabel kind="recommendation">Ready to execute</DataLabel>} />
          <div className="flex flex-col gap-1">
            <span className="text-[20px] font-semibold tracking-tight leading-snug">{rec.headline}</span>
            <span className="t-sm">{r.lean}</span>
            <span className="t-xs">{r.funds.detail}.</span>
            <span className="t-xs">{wait ? `This is the recommendation on current evidence, and what to do once ${open.length === 1 ? "the open condition below is" : `the ${open.length} open conditions below are`} met. It is not an order to place now. Keeping cash is always a valid choice.` : `The money, your holdings and the research are verified, and every limit used is one you approved. Confidence ${rec.confidence}/10.`}</span>
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

        <AccountCashCard ws={ws} />

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
        <ExposureCard r={r} />
        <OptionsCard r={r} />
        <Card flush>
          <Disclose open={!wait} summary={wait ? "The split once the conditions are met" : `Why this split · confidence ${rec.confidence}/10`}>
            <div className="num text-[17px] text-ink">{rec.allocations.length ? rec.allocations.map((x) => `${usd(x.amount)} ${x.symbol}`).join(" + ") : "Nothing allocated"}</div>
            {wait && <p className="t-sm warn">Conditional, not ready to execute: {open.map((g) => g.label.toLowerCase()).join("; ")} still open.</p>}
            <ul className="list-disc pl-4 t-sm flex flex-col gap-1">{rec.rationale.map((x) => <li key={x}>{x}</li>)}</ul>
            {rec.wouldChange.length > 0 && <p className="t-sm"><span className="text-ink font-semibold">Would change it:</span> {rec.wouldChange.join(" ")}</p>}
          </Disclose>
          <AssumptionsDisclose r={r} ws={ws} />
          <RecordDisclose wait={wait} hidden={{ amount: String(amount), source, ...(confirmed ? { confirmed: "1" } : {}) }} />
        </Card>
        <AskButton question={`Explain the ${usd(amount)} new capital recommendation, what to check before acting, and the strongest case against each alternative.`} className="btn w-full">Ask why</AskButton>
      </div>
    </div>
  );
}

/**
 * Each account's own cash and what it can do. Cash never moves between accounts on its own; savings can fund the
 * brokerage only through a transfer you plan here (recorded only, nothing is moved).
 */
export function AccountCashCard({ ws }: { ws: Workspace }) {
  const cd = ws.portfolio.cashDetail;
  const accounts = cd.accounts ?? [];
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? "Unknown account";
  const sources = accounts.filter((a) => a.use === "savings" || a.use === "self_directed");
  const targets = accounts.filter((a) => a.canBuyChosen);
  return (
    <Card labelledBy="acct-h" className="!gap-2.5">
      <CardHead id="acct-h" title="Cash by account" right={<span className="t-xs">can buy today: {usd(cd.spendableNow)}</span>} />
      <ul className="flex flex-col">
        {accounts.map((a) => (
          <li key={a.id} className="flex items-start justify-between gap-3 py-1.5 border-t border-line first:border-t-0">
            <span className="flex flex-col min-w-0"><span className="t-sm text-ink">{a.name}</span><span className="t-xs">{a.use === "savings" ? `${a.note}. ${usd(cd.deployableSavings)} could be transferred.` : a.note}</span>
              {a.basis && <span className={`t-xs ${a.basis.confirmed ? "" : "warn"}`}>{a.basis.detail}{a.basis.checks.length ? ` ${a.basis.checks.join(" ")}` : ""}</span>}</span>
            <span className="flex flex-col items-end shrink-0"><span className="t-sm num text-ink">{usd(a.cash, 2)}</span>{a.basis && <Pill small tone={a.basis.confirmed ? "gain" : "warn"}>{a.basis.confirmed ? (a.basis.status === "manual" ? "Your entry" : "Statement") : a.basis.status === "derived" ? "Worked out" : "Check"}</Pill>}</span>
          </li>
        ))}
      </ul>
      {ws.transfers.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-2">
          <span className="t-xs text-ink">Planned transfers (recorded only; counted as conditional until the money shows)</span>
          {ws.transfers.map((t) => (
            <ActionForm key={t.id} action={cancelTransfer} success="Transfer cancelled" className="flex items-center justify-between gap-2">
              <input type="hidden" name="id" value={t.id} />
              <span className="t-xs">{usd(t.amount, 2)} from {name(t.fromAccountId)} to {name(t.toAccountId)}, {t.date}</span>
              <SubmitButton className="btn btn-sm shrink-0" pendingText="Cancelling…">Cancel</SubmitButton>
            </ActionForm>
          ))}
        </div>
      )}
      {sources.length > 0 && targets.length > 0 && (
        <div className="border-t border-line -mb-2">
          <Disclose summary="Plan a transfer to the brokerage account">
            <ActionForm action={planTransfer} success="Transfer recorded as planned" className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                <label className="field">From<select name="from" className="input" defaultValue={sources.find((a) => a.use === "savings")?.id ?? sources[0].id}>{sources.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                <label className="field">To<select name="to" className="input" defaultValue={targets[0].id}>{targets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                <label className="field">Amount<input name="amount" inputMode="decimal" className="input" placeholder={cd.deployableSavings >= 1 ? String(Math.floor(cd.deployableSavings)) : "0"} /></label>
                <label className="field">Date<input name="date" type="date" className="input" defaultValue={ws.now.toISOString().slice(0, 10)} /></label>
              </div>
              <span className="t-xs">This only records your plan; it moves no money.</span>
              <SubmitButton className="btn self-start" pendingText="Saving…">Record planned transfer</SubmitButton>
            </ActionForm>
          </Disclose>
        </div>
      )}
    </Card>
  );
}

export function parseAmount(raw: string | undefined): number {
  return Math.max(1, Math.min(1_000_000, Number(String(raw ?? "1250").replace(/[$,]/g, "")) || 1250));
}

/** Each way of using the money compared on what it does to the whole portfolio's exposure. */
export function ExposureCard({ r }: { r: NewCapitalResult }) {
  const shown = r.exposure.impacts.filter((x) => x.label !== "Existing holding");
  return (
  <Card labelledBy="ex-h" className="!gap-2">
    <CardHead id="ex-h" title="Effect on your whole portfolio" right={<span className="t-xs">before → after</span>} />
    <div className="overflow-x-auto -mx-1">
      <table className="w-full t-xs num">
        <thead><tr className="text-muted"><th className="text-left font-normal px-1">If {usd(r.funds.used)} goes to</th>{WATCHED.filter((w) => w.key !== "us").map((w) => <th key={w.key} className="text-right font-normal px-1">{w.key === "nvda" ? "NVDA" : w.key === "tech" ? "Tech" : w.key === "semis" ? "Chips" : w.key === "ai" ? "AI infra" : "EM"}</th>)}</tr></thead>
        <tbody>
          <tr className="border-t border-line"><td className="text-left px-1 py-1">Today</td>{WATCHED.filter((w) => w.key !== "us").map((w) => { const row = shown[0]?.rows.find((x) => x.key === w.key); return <td key={w.key} className="text-right px-1">{row ? pctStr(row.before) : "—"}</td>; })}</tr>
          {shown.map((x) => (
            <tr key={x.symbol} className="border-t border-line"><td className={`text-left px-1 py-1 ${x.symbol === r.exposure.choice ? "text-ink font-semibold" : ""}`}>{x.symbol === "CASH" ? "Keep cash" : x.symbol}</td>
              {WATCHED.filter((w) => w.key !== "us").map((w) => { const row = x.rows.find((y) => y.key === w.key); return <td key={w.key} className={`text-right px-1 ${row?.crosses ? "warn" : ""}`}>{row ? pctStr(row.after) : "—"}</td>; })}</tr>
          ))}
        </tbody>
      </table>
    </div>
    <ul className="list-disc pl-4 t-sm flex flex-col gap-1">{r.exposure.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
    <span className="t-xs">% of your invested portfolio after the money moves in (savings that stay put are not counted), including what each fund holds; each company counted once. Levels: NVIDIA&apos;s limit and the exposure levels on file ({shown[0]?.rows.find((x) => x.key === "semis")?.level?.status ?? "proposed"}). Industry and theme figures are lower bounds.</span>
  </Card>

  );
}

/** Every option (holdings, new ideas, ETFs, cash, trims) with the research, valuation and limit checks behind its label. */
export function OptionsCard({ r }: { r: NewCapitalResult }) {
  return (
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
              {o.expectedReturn !== null && <span>exp. {pctStr(o.expectedReturn)}/yr (research model)</span>}
              {o.forecast && <span>forecasts {o.forecast.forecasts.map((f) => (f.kind === "range" ? `${pctStr(f.low)}–${pctStr(f.high)}` : pctStr(f.low))).join(" · ")}</span>}
              {o.assessment && <span>model vs VOO: {o.assessment.judgment}{o.assessment.comparison === "approximate" ? ` (approx., ${o.assessment.horizonYears.toFixed(1)}-yr vs 10-yr)` : ""}</span>}{o.stance && <span>research: {o.stance.kind === "add" ? "add" : o.stance.kind === "conditional" ? "add only if a condition is met" : o.stance.kind}</span>}
              {o.weightNow !== null && <span>now {pctStr(o.weightNow)}{o.maxWeight !== null ? ` of ${pctStr(o.maxWeight, 0)}` : ""}</span>}
            </div>
            {o.reassessment && (
              <div className="flex flex-col gap-0.5 border-l-2 border-line pl-2">
                <span><span className="text-ink">Research conclusion ({o.reassessment.conclusion.asOf}{o.reassessment.conclusion.referencePrice ? `, at $${o.reassessment.conclusion.referencePrice}` : ""}):</span> {o.reassessment.conclusion.action}</span>
                <span><span className="text-ink">Recommendation now:</span> {o.reassessment.current}</span>
                {o.reassessment.changes.length > 0 && <span className="t-xs">Since then: {o.reassessment.changes.join("; ")}.</span>}
              </div>
            )}
            {o.zoneAction && <span>Research price band today: {o.zoneAction} (a prompt to research, not a trade).</span>}
            <ul className="list-disc pl-4 flex flex-col gap-0.5">{o.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            {o.assessment && (
              <ul className="flex flex-col gap-0.5 t-xs border-t border-line pt-1.5">{o.assessment.factors.map((f) => <li key={f.label}><span className="text-ink">{f.label}</span> ({f.leans === "for" ? "supports" : f.leans === "against" ? "weighs against" : "neutral"}): {f.finding}</li>)}</ul>
            )}
          </div>
        </details>
      ))}
    </div>
    <span className="t-xs">The research&apos;s conclusion guides the action until something material changes (price, valuation, results, filings, financing); then it is shown as the old conclusion and the stock is reassessed before any new money. A few-year stock case and VOO&apos;s 10-15-year forecasts are not like for like, so that comparison is context, not a pass/fail. Expected returns are model estimates from the research scenarios at today&apos;s price, and the scenario probabilities are the research&apos;s subjective assumptions. Each stock is compared with VOO&apos;s published forecasts (shown separately, never averaged), a Treasury for the same horizon, its downside and its concentration. A drop is never a buy signal by itself.</span>
  </Card>

  );
}

export function AssumptionsDisclose({ r, ws }: { r: NewCapitalResult; ws: Workspace }) {
  return (
  <Disclose summary="Assumptions and sources">
    <ul className="list-disc pl-4 t-sm flex flex-col gap-0.5">{r.assumptions.items.map((x) => <li key={x}>{x}</li>)}</ul>
    <ul className="t-sm flex flex-col gap-1">
      {r.assumptions.alternatives.flatMap((alt) => alt.forecasts.map((f) => (
        <li key={`${alt.symbol}-${f.firm}-${f.asset}`} className="flex justify-between gap-3"><span>{alt.symbol}: {f.firm}, {f.asset}</span><span className="num text-ink text-right">{f.kind === "range" ? `${pctStr(f.low)}–${pctStr(f.high)}` : pctStr(f.low)} <span className="t-xs">· {f.horizonYears[0] === f.horizonYears[1] ? f.horizonYears[0] : f.horizonYears.join("–")} yrs, {f.asOf}</span></span></li>
      )))}
      {r.assumptions.riskFree10y && <li className="flex justify-between gap-3"><span>10-year Treasury (risk-free)</span><span className="num text-ink">{pctStr(r.assumptions.riskFree10y.rate, 2)} <span className="t-xs">· FRED {r.assumptions.riskFree10y.asOf}</span></span></li>}
      <li className="flex justify-between gap-3"><span>Invested portfolio (limit denominator)</span><span className="num text-ink">{usd(ws.portfolio.total)} <span className="t-xs">· {ws.portfolio.quality.status}, {ws.portfolio.quality.reconciliation.label.toLowerCase()}</span></span></li>
    </ul>
    <p className="t-xs">Vanguard does not say what its range endpoints represent; J.P. Morgan does not say whether its figure is a median or a mean. Treat both as uncertain.</p>
    <Link href="/policy" className="t-sm">Sources and your limits on the Policy page</Link>
  </Disclose>
  );
}

/** Saves what you decided. The server re-runs the calculation from the hidden inputs; it never trusts numbers from the form. */
export function RecordDisclose({ wait, hidden }: { wait: boolean; hidden: Record<string, string> }) {
  return (
    <Disclose summary="Record what you decide">
      <ActionForm action={recordNewCapital} success="Decision saved" className="flex flex-col gap-2.5">
        {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <fieldset className="flex flex-col gap-1">
          <legend className="t-xs mb-1">Your decision (nothing is selected for you)</legend>
          {(wait
            ? [["deferred", "Wait until the conditions are met"], ["declined", "Act anyway, differently (describe below)"], ["partially_followed", "Act on part of the illustrative split"]]
            : [["followed", "Follow the recommendation"], ["partially_followed", "Follow part of it"], ["declined", "Do something else"], ["deferred", "Decide later / keep cash"]]
          ).map(([v, l]) => (
            <label key={v} className="inline-flex items-center gap-2.5 min-h-11 t-sm text-ink"><input type="radio" name="user_action" value={v} required className="w-[18px] h-[18px] accent-[var(--accent)]" /> {l}</label>
          ))}
        </fieldset>
        <label className="field">What you actually traded, if anything (optional)<input name="execution" placeholder="e.g. bought 3 VOO at $612 in your brokerage" className="input" /></label>
        <label className="field">Why (optional)<textarea name="note" rows={2} className="input" /></label>
        <SubmitButton className="btn btn-primary">Save this decision</SubmitButton>
        <p className="t-xs">Saving records the inputs, timestamps, alternatives, assumptions and your choice. The app never places trades.</p>
      </ActionForm>
    </Disclose>
  );
}
