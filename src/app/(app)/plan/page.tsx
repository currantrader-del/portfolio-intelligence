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
  // The stored plan is never rewritten; it is flagged when what it was built on changed since.
  const check = plan && last ? outdatedVerdict({
    writtenAt: last.at, events: await loadContextEvents(db, last.at).catch(() => []),
    text: [plan.summary, plan.cash.now, plan.cash.waitFor, ...plan.nextActions].join(" "),
    currentReserve: (await getWorkspace()).portfolio.cashDetail.protectedReserve,
  }) : null;

  return (
    <div className="flex flex-col gap-3 lg:gap-4 max-w-3xl">
      <div className="flex flex-col gap-1">
        <span className="cap">Portfolio plan</span>
        <h1 className="h1">Your plan</h1>
        <p className="t-sm">Built from your research, holdings, cash, policy and the latest market briefing. It rebuilds after each AI research, after a policy change and every Monday. Older plans are kept as history. It proposes; you decide, and it never trades.</p>
      </div>

      <Card className="!gap-2">
        <PlanRunner running={st.running} hasPlan={!!plan} />
        {when && <p className="t-xs">Last built {shortDate(last!.at)} {when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET · {last!.trigger === "research" ? "after new research" : last!.trigger === "weekly" ? "weekly" : last!.trigger === "policy" ? "after a policy change" : "by you"} · ${last!.costUsd.toFixed(2)}</p>}
        {last && !last.ok && <p role="alert" className="t-sm warn">The last build failed: {last.error}</p>}
        {check && <OutdatedNotice v={check} what="plan" />}
      </Card>

      {!plan ? (
        !last && <p className="t-sm">No plan yet. Build it once; after that it keeps itself up to date.</p>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
