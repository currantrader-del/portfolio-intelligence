import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHead, Disclose, Pill } from "@/components/ui";
import { PlanRunner } from "@/components/PlanRunner";
import { planStatus } from "@/lib/plan/job";
import { shortDate } from "@/lib/format";
import { OutdatedNotice } from "@/components/OutdatedNotice";
import { loadContextEvents } from "@/lib/freshness/contextEvents";
import { outdatedVerdict } from "@/lib/freshness/outdated";
import { getWorkspace } from "@/lib/workspace";
import { HOLDINGS_FRESH_DAYS, newCapital, ruleRowsOf } from "@/lib/decision/newCapital";
import { loadDecisionFilings } from "@/lib/alerts/events";

export const dynamic = "force-dynamic";

const STANCE_TONE = { Constructive: "gain", Neutral: "neutral", Cautious: "warn" } as const;
const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const actionTone = (a: string) => (/refresh|review/i.test(a) ? "warn" : /\bno add|\bhold\b|wait/i.test(a) ? "neutral" : /trim|sell|avoid|exit/i.test(a) ? "alert" : /\badd|\bbuy/i.test(a) ? "gain" : "neutral");

/** The portfolio plan: market stance, a target and action for each position, the cash plan, and what is stale. */
export default async function PlanPage() {
  const db = await createClient();
  const st = await planStatus(db);
  const last = st.latest;
  const plan = last?.ok ? last.plan : null;
  const when = last ? new Date(last.at) : null;
  const ws = await getWorkspace();
  const audit = ws.policy?.audit;
  // The stored plan is never rewritten; it is flagged when what it was built on changed since, or when it
  // relies on assumptions that are no longer in force (retired hurdles, resolved conflicts, guide ranges as targets).
  const check = plan && last ? outdatedVerdict({
    writtenAt: last.at, events: await loadContextEvents(db, last.at).catch(() => []),
    text: [plan.summary, plan.cash.now, plan.cash.waitFor, ...plan.nextActions, ...plan.positions.map((x) => `${x.symbol}: ${x.action} ${x.reason}`), ...(plan.opportunities ?? []).map((o) => `${o.symbol}: ${o.vsVoo} ${o.reason}`)].join(" "),
    currentReserve: ws.portfolio.cashDetail.protectedReserve,
    policy: audit ? {
      approved: audit.subjects.filter((x) => x.scope === "company" && x.authority === "you" && x.used?.approved_at).map((x) => ({ symbol: x.subject, at: x.used!.approved_at! })),
      imported: audit.imported.map((x) => x.subject),
    } : null,
    perSymbol: plan.positions.map((x) => ({ symbol: x.symbol, text: `${x.action} ${x.reason}` })),
  }) : null;
  const outdated = !!check?.outdated;

  // The current view, computed now from today's facts without any AI call.
  const cd = ws.portfolio.cashDetail;
  const filings = await loadDecisionFilings(ws).catch(() => new Map());
  const nc = newCapital({ amount: Math.max(1, cd.spendableNow), source: "existing", transfers: ws.transfers, portfolio: ws.portfolio, research: ws.research, policy: ws.policy, now: ws.now, quotes: ws.quotes, filings, yields: ws.yields, rules: ruleRowsOf(ws.policy) });
  const brokers = ws.portfolio.accounts.filter((a) => a.role !== "cash" && a.role !== "protected_savings");
  const unverified = brokers.filter((a) => a.ageDays > HOLDINGS_FRESH_DAYS || a.tradesAfter > 0);
  const reserveRule = audit?.subjects.find((x) => x.subject === "protected_reserve");

  return (
    <div className="flex flex-col gap-3 lg:gap-4 max-w-3xl">
      <div className="flex flex-col gap-1">
        <span className="cap">Portfolio plan</span>
        <h1 className="h1">Your plan</h1>
        <p className="t-sm">Built from your research, holdings, cash, policy and the latest market briefing. It rebuilds every Monday morning or when you tap Rebuild (about $0.10). A policy, holdings or research change never rebuilds it automatically; it is marked outdated instead. Older plans are kept as history. It proposes; you decide, and it never trades.</p>
      </div>

      <Card className="!gap-2">
        <PlanRunner running={st.running} hasPlan={!!plan} />
        {when && <p className="t-xs">Last built {shortDate(last!.at)} {when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET · {last!.trigger === "research" ? "after new research" : last!.trigger === "weekly" ? "weekly" : last!.trigger === "policy" ? "after a policy change" : "by you"} · ${last!.costUsd.toFixed(2)}</p>}
        {last && !last.ok && <p role="alert" className="t-sm warn">The last build failed: {last.error}</p>}
        {check && <OutdatedNotice v={check} what="plan" />}
      </Card>

      <Card labelledBy="pl-now" className="!gap-2">
        <CardHead id="pl-now" title="Where things stand today" right={<Pill small>Computed now · no AI</Pill>} />
        <ul className="flex flex-col gap-1.5 t-sm">
          <li><span className="text-ink font-semibold">Protected reserve:</span> {money(cd.protectedReserve)} in savings, {reserveRule?.authority === "you" ? "approved by you" : "app default, not approved"}. A firm restriction: never invested and never counted as buying power.</li>
          <li><span className="text-ink font-semibold">Cash you could invest:</span> {money(cd.spendableNow)} in your brokerage account{cd.deployableSavings >= 1 ? `, plus ${money(cd.deployableSavings)} of savings above the reserve` : ""}. {unverified.length ? "Estimated, not confirmed" : "Verified by recent statements"}. Investing it, or leaving it in cash, are both valid.</li>
          <li><span className="text-ink font-semibold">Holdings:</span> {unverified.length ? `estimated. ${unverified.map((a) => `${a.name} is known from a ${a.asOf.slice(0, 10)} statement${a.tradesAfter ? ` plus recorded trades` : ""}`).join("; ")}. Check them before acting on a dollar amount.` : "verified by statements within a week."}</li>
          <li><span className="text-ink font-semibold">New money today:</span> {nc.lean.replace(/^Lean: /, "")} <Link href="/decisions" className="t-sm">Details</Link></li>
          {audit && <li><span className="text-ink font-semibold">Policy:</span> {audit.subjects.filter((x) => x.authority === "you").length} rules approved by you{audit.imported.length ? `; ${audit.imported.length} imported ${audit.imported.length === 1 ? "guideline" : "guidelines"} awaiting your review (they act as ceilings, not targets)` : ""}{audit.conflicts.length ? `; ${audit.conflicts.length} open limit ${audit.conflicts.length > 1 ? "conflicts" : "conflict"}` : "; no open limit conflicts"}. <Link href="/policy" className="t-sm">Policy</Link></li>}
        </ul>
        <p className="t-xs">Allocation ranges are guidelines and ceilings, never targets to fill. Being below a range, or below 5% cash, is not a reason to buy, sell or wait.</p>
      </Card>

      {!plan ? (
        !last && <p className="t-sm">No plan yet. Build it once; after that it rebuilds every Monday.</p>
      ) : (
        <OldPlan outdated={outdated} at={last!.at}>
          <Card labelledBy="pl-sum" className="!gap-2">
            <CardHead id="pl-sum" title="In short" right={<Pill small tone={STANCE_TONE[plan.market.stance as keyof typeof STANCE_TONE] ?? "neutral"}>Market: {plan.market.stance}</Pill>} />
            <p className="text-[15px] leading-relaxed">{plan.summary}</p>
            {plan.nextActions.length > 0 && (
              <ol className="list-decimal pl-5 flex flex-col gap-1 t-sm text-ink">{plan.nextActions.map((a) => <li key={a}>{a}</li>)}</ol>
            )}
          </Card>

          {(plan.opportunities?.length ?? 0) > 0 && (
            <Card labelledBy="pl-opp" className="!gap-0" flush>
              <div className="px-4 pt-4 pb-2 lg:px-5"><CardHead id="pl-opp" title="Opportunities" right={<span className="t-xs">Ready for decision, vs VOO</span>} /></div>
              <ul className="flex flex-col">
                {plan.opportunities.map((o) => (
                  <li key={o.symbol} className="border-t border-line">
                    <Disclose summary={
                      <span className="flex items-center justify-between gap-2 w-full min-w-0">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="text-ink font-semibold">{o.symbol}</span>
                          <Pill small tone={o.verdict === "Buy now" ? "gain" : o.verdict === "Wait for price" ? "warn" : "neutral"}>{o.verdict}</Pill>
                        </span>
                        <span className="t-sm num shrink-0">{o.verdict === "Buy now" && o.amountUsd ? money(o.amountUsd) : o.buyBelow ? `below $${o.buyBelow}` : ""}</span>
                      </span>
                    }>
                      <div className="flex flex-col gap-1.5 t-sm">
                        <p>{o.reason}</p>
                        {(o.expectedReturn || o.vsVoo) && <p className="t-xs">{o.expectedReturn ? `Expected ${o.expectedReturn}` : ""}{o.expectedReturn && o.vsVoo ? " · " : ""}{o.vsVoo ? `vs VOO: ${o.vsVoo}` : ""}{o.buyBelow ? ` · buy below $${o.buyBelow}` : ""}</p>}
                        <Link href={`/research/${o.symbol}`} className="t-sm">Open {o.symbol}</Link>
                      </div>
                    </Disclose>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card labelledBy="pl-pos" className="!gap-0" flush>
            <div className="px-4 pt-4 pb-2 lg:px-5"><CardHead id="pl-pos" title="Positions" right={<span className="t-xs">now → target</span>} /></div>
            <ul className="flex flex-col">
              {plan.positions.map((p) => (
                <li key={p.symbol} className="border-t border-line">
                  <Disclose summary={
                    <span className="flex items-center justify-between gap-2 w-full min-w-0">
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="text-ink font-semibold">{p.symbol}</span>
                        {p.status === "idea" && <Pill small>Idea</Pill>}
                        <Pill small tone={actionTone(p.action)}>{p.action.length > 28 ? `${p.action.slice(0, 27)}…` : p.action}</Pill>
                      </span>
                      <span className="t-sm num shrink-0">{pct(p.currentPct)} → {pct(p.targetPct)}</span>
                    </span>
                  }>
                    <div className="flex flex-col gap-1.5 t-sm">
                      {p.action.length > 28 && <p className="text-ink">{p.action}</p>}
                      <p>{p.reason}</p>
                      <p className="t-xs">Priority {p.priority}{p.maxPct !== null ? ` · policy max ${pct(p.maxPct)}` : ""}{p.researchAsOf ? ` · research ${shortDate(p.researchAsOf)}` : " · no research on file"}</p>
                      {p.flags.map((f) => <p key={f} className="t-xs warn">{f}</p>)}
                      <Link href={`/research/${p.symbol}`} className="t-sm">Open {p.symbol}</Link>
                    </div>
                  </Disclose>
                </li>
              ))}
            </ul>
          </Card>

          <Card labelledBy="pl-cash" className="!gap-2">
            <CardHead id="pl-cash" title="Cash" right={plan.cash.deployable !== null ? <span className="t-sm num">{money(plan.cash.deployable)} deployable</span> : null} />
            <p className="t-sm"><span className="text-ink font-semibold">Now: </span>{plan.cash.now || "—"}</p>
            <p className="t-sm"><span className="text-ink font-semibold">Wait for: </span>{plan.cash.waitFor || "—"}</p>
          </Card>

          {plan.stale.length > 0 && (
            <Card labelledBy="pl-stale" className="!gap-2">
              <CardHead id="pl-stale" title="Refresh before acting" />
              <ul className="flex flex-col gap-1 t-sm">{plan.stale.map((s) => <li key={s.symbol}><Link href={`/research/${s.symbol}`} className="text-ink font-semibold">{s.symbol}</Link> · {s.why}</li>)}</ul>
            </Card>
          )}

          <Card flush>
            <Disclose summary={<span className="t-sm">Market view</span>}>
              <div className="flex flex-col gap-2 t-sm">
                <p><span className="text-ink font-semibold">Short term: </span>{plan.market.shortTerm}</p>
                <p><span className="text-ink font-semibold">Long term: </span>{plan.market.longTerm}</p>
              </div>
            </Disclose>
            {plan.problems.length > 0 && (
              <Disclose summary={<span className="t-sm">Checks the app made · {plan.problems.length}</span>}>
                <ul className="list-disc pl-5 flex flex-col gap-0.5 t-xs">{plan.problems.map((x) => <li key={x}>{x}</li>)}</ul>
              </Disclose>
            )}
          </Card>
        </OldPlan>
      )}
    </div>
  );
}

/** An outdated plan stays readable as history, folded away so it is not mistaken for the current view. */
function OldPlan({ outdated, at, children }: { outdated: boolean; at: string; children: React.ReactNode }) {
  if (!outdated) return <>{children}</>;
  return (
    <Card flush>
      <Disclose summary={<span className="t-sm">The plan of {shortDate(at)}, as it was written (outdated, kept as history)</span>}>
        <div className="flex flex-col gap-3">{children}</div>
      </Disclose>
    </Card>
  );
}
