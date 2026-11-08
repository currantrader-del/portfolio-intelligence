import { createClient } from "@/lib/supabase/server";
import { loadSpend, type BudgetClass } from "@/lib/costs/spend";
import { measuredEstimates } from "@/lib/research/costEstimates";
import { DAILY_CAP, spentToday } from "@/lib/intel/start";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardHead, Pill } from "@/components/ui";
import { saveCostSettings } from "./actions";

const usd = (n: number) => `$${n.toFixed(2)}`;
const CLASS: Record<BudgetClass, { title: string; what: string }> = {
  everyday: { title: "Everyday AI", what: "Morning briefing, your questions, the weekly plan and trade scan" },
  research: { title: "Research", what: "Quick screens, research updates and full investigations (started by you)" },
};

export default async function CostsPage() {
  const db = await createClient();
  const now = new Date();
  const [s, est, today] = await Promise.all([loadSpend(db, now), measuredEstimates(db, now), spentToday(db, now)]);
  const monthName = now.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div className="flex flex-col gap-3 lg:gap-4 max-w-3xl">
      <div className="flex flex-col gap-1">
        <span className="cap">Costs</span>
        <h1 className="h1">AI spending</h1>
        <p className="t-sm">What the app&apos;s AI has cost in {monthName}, by feature and by model, against your two monthly budgets. Code-only work (prices, filing checks, re-pricing research, validation) costs nothing and is not listed.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {(["everyday", "research"] as const).map((c) => {
          const v = s.classes[c];
          const pct = Math.min(100, (v.spent / Math.max(0.01, v.budget)) * 100);
          return (
            <Card key={c} className="!gap-1.5">
              <CardHead title={CLASS[c].title} right={v.over ? <Pill small tone="alert">Budget reached</Pill> : v.projected > v.budget ? <Pill small tone="warn">On pace to exceed</Pill> : <Pill small tone="gain">Within budget</Pill>} />
              <span className="t-xs">{CLASS[c].what}</span>
              <span className="text-ink text-xl tabular-nums">{usd(v.spent)} <span className="t-sm">of {usd(v.budget)}</span></span>
              <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden" aria-hidden="true"><div className="h-full" style={{ width: `${pct}%`, background: v.over ? "var(--loss)" : "var(--accent)" }} /></div>
              <span className="t-xs">{c === "everyday" ? `At this pace about ${usd(v.projected)} by month end.` : "Research is started by you, so it is not projected."} {usd(Math.max(0, v.left))} left.</span>
            </Card>
          );
        })}
      </div>

      <Card className="!gap-2">
        <CardHead title="By feature" right={<span className="t-xs">{usd(s.total)} this month · {usd(s.last7)} in the last 7 days</span>} />
        {s.byFeature.length === 0 ? <p className="t-sm">Nothing spent this month yet.</p> : (
          <table className="t-sm w-full"><tbody>
            {s.byFeature.map((f) => (
              <tr key={f.feature} className="border-b border-line last:border-b-0">
                <td className="py-1.5 pr-2">{f.label} <span className="t-xs">· {CLASS[f.cls].title.toLowerCase()}</span></td>
                <td className="py-1.5 pr-2 text-right t-xs">{f.runs} run{f.runs === 1 ? "" : "s"}</td>
                <td className="py-1.5 text-right tabular-nums">{usd(f.cost)}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </Card>

      <Card className="!gap-2">
        <CardHead title="By model" />
        <table className="t-sm w-full"><tbody>
          {s.byModel.map((m) => <tr key={m.model} className="border-b border-line last:border-b-0"><td className="py-1.5">{m.model}</td><td className="py-1.5 text-right tabular-nums">{usd(m.cost)}</td></tr>)}
        </tbody></table>
        <p className="t-xs">Investigations use several models; their cost is split by what each run recorded.</p>
      </Card>

      <Card className="!gap-2">
        <CardHead title="Before you start a run" />
        <ul className="t-sm flex flex-col gap-1">
          <li>Research update: about {usd(est.update.low)}–{usd(est.update.high)} <span className="t-xs">({est.update.basis})</span></li>
          <li>Full investigation: about {usd(est.full.low)}–{usd(est.full.high)} <span className="t-xs">({est.full.basis})</span></li>
          <li>Quick screen: about $0.25 · a question: about $0.10 · plan rebuild: about $0.10</li>
        </ul>
        <p className="t-xs">Anything estimated above {usd(s.settings.approveAbove)}, or that would pass a monthly budget, waits for you to confirm. The safety net of {usd(DAILY_CAP.total)} a day still applies ({usd(today.total)} spent today).</p>
      </Card>

      <Card className="!gap-2">
        <CardHead title="Budgets" />
        <ActionForm action={saveCostSettings} success="Budgets saved" className="flex flex-col gap-2">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label className="field">Everyday AI per month ($)<input name="everyday" inputMode="decimal" defaultValue={s.settings.everydayMonthly} className="input" required /></label>
            <label className="field">Research per month ($)<input name="research" inputMode="decimal" defaultValue={s.settings.researchMonthly} className="input" required /></label>
            <label className="field">Ask me above ($ per run)<input name="approve" inputMode="decimal" defaultValue={s.settings.approveAbove} className="input" required /></label>
          </div>
          <SubmitButton className="btn btn-sm self-start" pendingText="Saving…">Save budgets</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
