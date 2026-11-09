import Form from "next/form";
import Link from "next/link";
import type { Workspace } from "@/lib/workspace";
import { currentDecisionFor } from "@/lib/decision/currentPortfolio";
import { loadDecisionFilings } from "@/lib/alerts/events";
import { saveCapitalPreference } from "@/app/(app)/decisions/actions";
import { ActionForm, SubmitButton } from "@/components/forms";
import { AskButton } from "@/components/AskPanel";
import { pctStr, usd } from "@/lib/format";
import { Card, CardHead, DataLabel, Disclose, Pill } from "@/components/ui";
import { AccountCashCard, AssumptionsDisclose, ExposureCard, OptionsCard, RecordDisclose } from "@/components/decisions/NewCapitalView";

const ALT_TONE = (s: string): "gain" | "warn" | "neutral" => (/^Qualifies|In the recommendation/.test(s) ? "gain" : /Always valid|Valid option|None ready/.test(s) ? "neutral" : "warn");

/**
 * Current Portfolio: the default Decisions view. No amount to type: it uses the cash in the account that buys and,
 * only when a researched stock needs it, savings under your standing transfer limit. The engine decides; this lays it out.
 */
export async function CurrentPortfolioView({ ws, confirmed }: { ws: Workspace; confirmed: boolean }) {
  const filings = await loadDecisionFilings(ws);
  const d = currentDecisionFor(ws, filings, confirmed);
  const r = d.result;
  const tr = d.money.transferable;
  const wait = d.status !== "ready";
  const invName = ws.portfolio.cashDetail.investingAccount?.name ?? "your brokerage account";

  return (
    <div className="grid grid-cols-1 gap-3 lg:gap-4 lg:grid-cols-12 items-start">
      <div className="lg:col-span-6 flex flex-col gap-3 lg:gap-4 min-w-0">
        <Card labelledBy="best-h">
          <CardHead id="best-h" cap="Best action now" right={!d.allocations.length ? <Pill>No action needed</Pill> : wait ? <Pill tone="warn">Conditional · confirm first</Pill> : <DataLabel kind="recommendation">Ready to execute</DataLabel>} />
          <div className="flex flex-col gap-1.5">
            <span className="text-[20px] font-semibold tracking-tight leading-snug">{d.headline}</span>
            <span className="t-sm">{d.why}</span>
            {d.allocations.length > 0 && (
              <span className="t-sm num text-ink">{d.allocations.map((x) => `${usd(x.amount)} ${x.symbol}`).join(" + ")} <span className="t-xs">· funded by: {d.funding.detail}</span></span>
            )}
            <span className="t-xs">Based on your recorded holdings, approved research, today&apos;s prices, your limits and the cash you have. No new research or AI was used. Keeping cash is always a valid choice{d.allocations.length ? `; confidence ${r.recommendation.confidence}/10` : ""}.</span>
          </div>
        </Card>

        {d.allocations.length > 0 && (
          <Card labelledBy="pj-h" className="!gap-2">
            <CardHead id="pj-h" title="Projected allocation" right={<span className="t-xs">before → after</span>} />
            <div className="overflow-x-auto -mx-1">
              <table className="w-full t-xs num">
                <thead><tr className="text-muted"><th className="text-left font-normal px-1"></th><th className="text-right font-normal px-1">Of invested portfolio</th><th className="text-right font-normal px-1">Of all investable</th><th className="text-right font-normal px-1">Limit</th></tr></thead>
                <tbody>
                  {d.projected.rows.map((x) => (
                    <tr key={x.symbol} className="border-t border-line"><td className="text-left px-1 py-1 text-ink">{usd(x.amount)} {x.symbol}{x.lookthrough ? "*" : ""}</td>
                      <td className="text-right px-1">{pctStr(x.before)} → <span className={x.limit !== null && x.afterInvested > x.limit + 0.0005 ? "warn" : "text-ink"}>{pctStr(x.afterInvested)}</span></td>
                      <td className="text-right px-1">{pctStr(x.beforeInvestable)} → {pctStr(x.afterInvestable)}</td>
                      <td className="text-right px-1">{x.limit !== null ? `${pctStr(x.limit, 0)} of invested` : "—"}</td></tr>
                  ))}
                  <tr className="border-t border-line"><td className="text-left px-1 py-1">Invested portfolio</td><td className="text-right px-1">{usd(d.projected.invested.before)} → {usd(d.projected.invested.after)}</td><td className="text-right px-1">{usd(d.projected.investable.before)} (unchanged)</td><td /></tr>
                  <tr className="border-t border-line"><td className="text-left px-1 py-1">Savings</td><td className="text-right px-1" colSpan={2}>{usd(d.projected.savingsAboveReserve.before)} → {usd(d.projected.savingsAboveReserve.after)}</td><td /></tr>
                </tbody>
              </table>
            </div>
            <span className="t-xs">Limits apply to the invested portfolio after the purchase. Moving savings into {invName} is an internal transfer: it grows the invested portfolio but not your total investable capital, and it is not new money. {d.projected.rows.some((x) => x.lookthrough) ? "* Company exposure includes its share inside your ETFs, counted once." : ""}</span>
          </Card>
        )}

        <Card labelledBy="cf-h" className="!gap-2.5">
          <CardHead id="cf-h" title="Before you act" right={d.confirm.length ? <Pill>{d.confirm.length}</Pill> : null} />
          {d.confirm.length ? <ol className="flex flex-col gap-1.5 t-sm list-decimal pl-5">{d.confirm.map((t) => <li key={t}>{t}</li>)}</ol> : <p className="t-sm">Nothing to confirm.</p>}
          <Form action="/decisions" className="flex items-center justify-between gap-2 border-t border-line pt-2">
            <label className="inline-flex items-center gap-2.5 min-h-11 t-sm text-ink"><input type="checkbox" name="confirmed" value="1" defaultChecked={confirmed} className="w-[18px] h-[18px] accent-[var(--accent)]" /> I checked my accounts today and the holdings match</label>
            <button className="btn shrink-0">Update</button>
          </Form>
        </Card>

        <Card labelledBy="mn-h" className="!gap-2">
          <CardHead id="mn-h" title="Money you could deploy" />
          <ul className="flex flex-col t-sm">
            <li className="flex justify-between gap-3 py-1.5"><span className="flex flex-col"><span className="text-ink">Cash in {invName}</span><span className="t-xs">The only cash that can buy a chosen stock or ETF{d.money.brokerageConfirmed ? "" : ". Worked out from records, not confirmed: check it in the broker's app"}</span></span><span className="num text-ink">{usd(d.money.brokerageCash, 2)}</span></li>
            {d.money.plannedIn > 0 && <li className="flex justify-between gap-3 py-1.5 border-t border-line"><span className="flex flex-col"><span className="text-ink">Transfers you planned</span><span className="t-xs">Counted once, until the money shows in the account</span></span><span className="num text-ink">{usd(d.money.plannedIn, 2)}</span></li>}
            <li className="flex justify-between gap-3 py-1.5 border-t border-line"><span className="flex flex-col"><span className="text-ink">Savings you could transfer</span><span className="t-xs">{tr.detail}</span></span><span className="num text-ink">{usd(tr.amount)}</span></li>
            <li className="flex justify-between gap-3 py-1.5 border-t border-line"><span className="flex flex-col"><span className="text-ink">Invested portfolio</span><span className="t-xs">Schwab, Acorns and Roth holdings plus their cash. Every weight and limit uses this; savings never change it</span></span><span className="num text-ink">{usd(ws.portfolio.total)}</span></li>
            <li className="flex justify-between gap-3 py-1.5 border-t border-line"><span className="flex flex-col"><span className="text-ink">Total investable capital</span><span className="t-xs">Invested portfolio plus savings, for planning and liquidity</span></span><span className="num text-ink">{usd(ws.portfolio.investableCapital)}</span></li>
          </ul>
          <div className="border-t border-line -mb-2">
            <Disclose summary={ws.capitalPreference ? `Your standing transfer limit: ${usd(ws.capitalPreference.maxTransfer)}` : "Set your standing transfer limit"}>
              <ActionForm action={saveCapitalPreference} success="Preference saved" className="flex flex-col gap-2">
                <p className="t-sm">I am willing to transfer up to this much from savings to {invName} if a sufficiently attractive investment opportunity is identified.</p>
                <label className="field">Most I would transfer<input name="max_transfer" inputMode="decimal" defaultValue={ws.capitalPreference?.maxTransfer ?? ""} placeholder="10000" className="input num" /></label>
                <span className="t-xs">A maximum for evaluating opportunities, not a plan to invest and not buying power. The amount actually considered is min(this limit, savings), less any transfers already planned. The app never moves money.</span>
                <SubmitButton className="btn self-start" pendingText="Saving…">Save limit</SubmitButton>
              </ActionForm>
            </Disclose>
          </div>
        </Card>
      </div>

      <div className="lg:col-span-6 flex flex-col gap-3 lg:gap-4 min-w-0">
        <Card className="!gap-1 !pb-2" labelledBy="alt-h">
          <div className="mb-1.5"><CardHead id="alt-h" title="Alternatives considered" /></div>
          <div className="list">
            {d.alternatives.map((a) => (
              <details key={a.key} className="disclose border-t border-line first:border-t-0">
                <summary className="!min-h-14">
                  <span className="flex flex-col min-w-0 gap-0.5">
                    <span className="font-semibold text-ink">{a.title}</span>
                    <span className="t-xs">{a.key === "add" ? "Existing researched holding" : a.key === "new" ? "New researched position" : a.key === "etf" ? "Diversified ETF" : "Savings or brokerage cash"}</span>
                  </span>
                  <Pill small tone={ALT_TONE(a.status)}>{a.status}</Pill>
                </summary>
                <div className="disclose-body t-sm">
                  <p>{a.detail}</p>
                  {a.href && <Link href={a.href} className="t-sm">Open {a.symbol ?? "research"}</Link>}
                </div>
              </details>
            ))}
          </div>
        </Card>
        <ExposureCard r={r} />
        <Card flush>
          <Disclose summary="Every option in detail">
            <OptionsCard r={d.capacity} />
          </Disclose>
          <Disclose summary="Cash and transfers by account">
            <AccountCashCard ws={ws} />
          </Disclose>
          <AssumptionsDisclose r={r} ws={ws} />
          <RecordDisclose wait={wait} hidden={{ mode: "current", ...(confirmed ? { confirmed: "1" } : {}) }} />
        </Card>
        <AskButton question="Explain my Current Portfolio decision on the Decisions page: why this is the best action now, what to confirm first, and the strongest case for each alternative. Use the stored research only." className="btn w-full">Ask why</AskButton>
        <p className="t-xs">Trying a deposit or transfer that has not happened? Use <Link href="/decisions?tab=whatif">What-if</Link>.</p>
      </div>
    </div>
  );
}
