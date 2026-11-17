import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Bar, Card, CardHead, Disclose, Pill } from "@/components/ui";
import { shortDate, usd } from "@/lib/format";
import { getQuotes } from "@/lib/market/quotes";
import { DEFAULT_PLAN, buyLevelOf, planFrom, planStatus, type TargetPlan } from "@/lib/plan/target";
import type { Workspace } from "@/lib/workspace-core";

async function loadPlan(db: SupabaseClient): Promise<TargetPlan> {
  const { data } = await db.from("model_runs").select("outputs").eq("kind", "target_plan").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  return data ? planFrom(data.outputs) : DEFAULT_PLAN;
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

/** The home screen's one plan: mix vs target, the next dated step, and the stocks nearest their buy levels. */
export async function PlanCard({ db, ws }: { db: SupabaseClient; ws: Workspace }) {
  const plan = await loadPlan(db).catch(() => DEFAULT_PLAN);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(ws.now);
  const needQuotes = ws.research.filter((r) => buyLevelOf((r.current?.parsed as { action?: string } | null)?.action) && !ws.portfolio.holdings.some((h) => h.symbol === r.symbol)).map((r) => r.symbol);
  const quotes = await getQuotes(needQuotes).catch(() => new Map());
  const prices = new Map([...quotes].map(([k, q]) => [k, q.price as number]));
  const st = planStatus(plan, ws.portfolio, ws.research, prices, today);
  return (
    <Card labelledBy="plan-h" className="!gap-3">
      <CardHead id="plan-h" cap="Your plan" right={plan.docUrl ? <a href={plan.docUrl} target="_blank" rel="noreferrer" className="t-xs no-underline hover:text-ink">The full plan</a> : undefined} />

      {st.next ? (
        <div className="flex flex-col gap-1">
          <span className="t-xs">Next step · {st.next.date === today ? "today" : shortDate(st.next.date)}</span>
          <p className="text-ink font-semibold leading-snug">{st.next.text}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <span className="t-xs">Every month</span>
          <p className="text-ink font-semibold leading-snug">{plan.routine[0]}</p>
        </div>
      )}
      {st.warnings.map((w) => <p key={w} className="t-sm warn">{w}</p>)}

      <div className="flex flex-col gap-2">
        <span className="t-xs">Mix now vs target · {st.account ?? "investing account"} plus {usd(st.outside)} outside money = {usd(st.base)}</span>
        {st.sleeves.map((s) => (
          <div key={s.key} className="flex flex-col gap-1">
            <div className="flex justify-between gap-3 t-sm">
              <span className="text-ink">{s.label} <span className="t-xs">· {s.buy}</span></span>
              <span className="num"><span className="text-ink">{pct(s.weight)}</span> <span className="t-xs">of {pct(s.target)}</span></span>
            </div>
            <Bar value={s.weight} scale={Math.max(s.target, s.weight) * 1.15} markers={[s.target]} tone={s.key === "stocks" && s.weight > s.target ? "warn" : "copper"} thin label={`${s.label} ${pct(s.weight)} of ${pct(s.target)} target`} />
            <span className="t-xs">{s.gap > 50 ? (s.key === "stocks" ? `Room for ${usd(s.gap)} more, only at buy levels` : `${usd(s.gap)} to add`) : s.gap < -50 ? `${usd(-s.gap)} over target: add nothing here` : "On target"}</span>
          </div>
        ))}
        <span className="t-xs">Cash in {st.account ?? "the account"} {usd(st.cash)}, outside money {usd(st.outside)}{st.other > 0 ? `, other funds ${usd(st.other)} (keep, don't add)` : ""}. Acorns is left out.</span>
      </div>

      {st.waiting.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="t-xs">Waiting for a buy level</span>
          <ul className="t-sm flex flex-col">
            {st.waiting.slice(0, 4).map((w) => (
              <li key={w.symbol} className="flex justify-between gap-3 py-1 border-t border-line">
                <Link href={`/research/${w.symbol}`} className="no-underline text-ink">{w.symbol}{w.owned ? <span className="t-xs"> · owned</span> : null}</Link>
                <span className="num">{w.away <= 0 ? <Pill small tone="gain">At its level</Pill> : <span className="t-xs">{usd(w.price, 2)} · {(w.away * 100).toFixed(0)}% above {usd(w.level)}</span>}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Disclose summary={<span className="t-sm">Steps and monthly routine</span>}>
        <ol className="t-sm flex flex-col gap-1.5 list-decimal pl-5">
          {[...st.earlier, ...(st.next ? [st.next] : []), ...st.later].map((s) => <li key={s.date} className={s.date < today ? "opacity-60" : undefined}><span className="text-ink">{shortDate(s.date)}:</span> {s.text}</li>)}
        </ol>
        <ul className="t-xs flex flex-col gap-1 mt-2">{plan.routine.map((r) => <li key={r}>{r}</li>)}</ul>
        <p className="t-xs mt-2">Rules: stocks at most {pct(plan.stocksMax)} in all and {pct(plan.singleMax)} each. You place every order and transfer yourself.</p>
      </Disclose>
    </Card>
  );
}
