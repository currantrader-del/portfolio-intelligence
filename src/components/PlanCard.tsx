import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Bar, Card, CardHead, Disclose, Pill } from "@/components/ui";
import { shortDate, usd } from "@/lib/format";
import { getQuotes } from "@/lib/market/quotes";
import { DEFAULT_PLAN, WATCH_FUNDS, buyLevelOf, lowsFrom, noLongerGood, planFrom, planStatus, type Dropped, type Low, type TargetPlan } from "@/lib/plan/target";
import { getHistory } from "@/lib/market/history";
import { metricsOf, type Candidate, type RadarIdea } from "@/lib/radar/radar";
import { parseConclusion } from "@/lib/research/valuation";
import { usableVersion, type VersionRow } from "@/lib/research/records";
import { loadDecisionFilings } from "@/lib/alerts/events";
import { holdingActions } from "@/lib/decision/actions";
import { currentDecisionFor } from "@/lib/decision/currentPortfolio";
import type { Workspace } from "@/lib/workspace-core";

async function loadPlan(db: SupabaseClient): Promise<TargetPlan> {
  const { data } = await db.from("model_runs").select("outputs").eq("kind", "target_plan").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  return data ? planFrom(data.outputs) : DEFAULT_PLAN;
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const range = (r: { low: number; high: number } | null) => (r ? `${pct(r.low)}–${pct(r.high)}` : null);
const VERB_TONE = { "Buy more": "gain", Hold: "neutral", Trim: "warn", "Reassess first": "warn" } as const;
/** How far back "no longer good" looks. */
const DROPPED_DAYS = 120;

/**
 * The home screen (2026-11-17, Brendan: "What's the plan? What's the goal? How do I get there? What am I waiting for?
 * What's some new opportunities to look at? What opportunities are no longer good and why?"): one card per question.
 * 2026-11-18 audit: "How you get there" no longer carries written trades or dated transfers. It lists what the one
 * decision engine says for each stock you own (the same list Stocks & funds shows) and the Decisions answer for cash.
 */
export async function PlanCard({ db, ws }: { db: SupabaseClient; ws: Workspace }) {
  const plan = await loadPlan(db).catch(() => DEFAULT_PLAN);
  const needQuotes = ws.research.filter((r) => buyLevelOf((r.current?.parsed as { action?: string } | null)?.action) && !ws.portfolio.holdings.some((h) => h.symbol === r.symbol)).map((r) => r.symbol);
  const [quotes, filings] = await Promise.all([getQuotes(needQuotes).catch(() => new Map()), loadDecisionFilings(ws).catch(() => new Map())]);
  const prices = new Map([...quotes].map(([k, q]) => [k, q.price as number]));
  const st = planStatus(plan, ws.portfolio, ws.research, prices, ws.policy);
  const actions = holdingActions(ws, filings);
  const toDo = actions.filter((a) => a.now.verb !== "Hold");
  const holds = actions.filter((a) => a.now.verb === "Hold").map((a) => a.symbol);
  const cash = (() => { try { return currentDecisionFor(ws, filings); } catch { return null; } })();
  const [lows, radar, dropped] = await Promise.all([
    findLows(plan, ws).catch(() => [] as Low[]),
    latestRadar(db).catch(() => null),
    findDropped(db, ws).catch(() => [] as Dropped[]),
  ]);
  return (
    <>
      <Card labelledBy="goal-h" className="!gap-2">
        <CardHead id="goal-h" cap="The goal" right={plan.docUrl ? <a href={plan.docUrl} target="_blank" rel="noreferrer" className="t-xs no-underline hover:text-ink">The written plan</a> : undefined} />
        <p className="t-sm text-ink leading-snug">{plan.goal}</p>
        {st.warnings.map((w) => <p key={w} className="t-sm warn">{w}</p>)}
      </Card>

      <Card labelledBy="where-h" className="!gap-2">
        <CardHead id="where-h" cap="Where you are" right={<span className="t-xs">vs your approved ranges</span>} />
        <span className="t-xs">Invested portfolio {usd(st.base)}, every account: {st.accounts.map((a) => `${a.name} ${usd(a.value)}`).join(", ")}. Weights and limits use this figure.</span>
        {st.buckets.map((b) => {
          const r = range(b.normal);
          return (
            <div key={b.bucket} className="flex flex-col gap-1">
              <div className="flex justify-between gap-3 t-sm">
                <span className="text-ink">{b.label}{b.buy ? <span className="t-xs"> · {b.buy}</span> : null}</span>
                <span className="num"><span className="text-ink">{pct(b.weight)}</span> <span className="t-xs">{r ? `range ${r}` : "no range"}{b.hardMax !== null ? `, max ${pct(b.hardMax)}` : ""}</span></span>
              </div>
              <Bar value={b.weight} scale={Math.max(b.hardMax ?? b.normal?.high ?? b.weight, b.weight) * 1.15} markers={b.normal ? [b.normal.low, b.normal.high] : []} tone={b.status === "over_max" ? "loss" : b.status === "above" ? "warn" : "copper"} thin label={`${b.label} ${pct(b.weight)}`} />
              <span className="t-xs">{!b.approved ? "No approved range for this group yet." : b.status === "below" ? "Below its range: information only, never a reason on its own to buy." : b.status === "above" ? "Above its normal range, under the maximum: add nothing here; no sale needed." : b.status === "over_max" ? "Above your approved maximum: a review, not an automatic sale." : "Within its range."}</span>
            </div>
          );
        })}
        <span className="t-xs">Cash you can invest now: {usd(st.spendable)}{st.account ? ` in ${st.account}` : ""}. Outside money: {usd(st.outside)}, available but not committed, and not counted in any weight until you transfer it. Everything together: {usd(st.potential)}.</span>
        <span className="t-xs">Gain or loss on what you hold: {st.unrealized.amount >= 0 ? "+" : "−"}{usd(Math.abs(st.unrealized.amount))} (price vs what you paid, {st.unrealized.known} holdings{st.unrealized.unknown ? `; ${st.unrealized.unknown} without a cost basis are left out` : ""}). This is not your total return: deposits, cash and dividends are not in it.</span>
      </Card>

      <Card labelledBy="how-h" className="!gap-2">
        <CardHead id="how-h" cap="What to do now" right={<span className="t-xs">same answer as Stocks & funds and Decisions</span>} />
        {toDo.length ? (
          <ul className="t-sm flex flex-col">
            {toDo.map((a) => (
              <li key={a.symbol} className="flex flex-col gap-0.5 py-1.5 border-t border-line first:border-t-0">
                <span className="flex justify-between gap-3"><Link href={`/research/${a.symbol}`} className="no-underline text-ink font-semibold">{a.symbol}</Link><Pill small tone={VERB_TONE[a.now.verb]}>{a.now.verb}</Pill></span>
                <span className="t-xs">{a.now.headline}</span>
              </li>
            ))}
          </ul>
        ) : <p className="t-sm">No stock you own needs a trade now.</p>}
        {holds.length > 0 && <span className="t-xs">Hold: {holds.join(", ")}.</span>}
        {cash && (
          <div className="flex flex-col gap-0.5 border-t border-line pt-2">
            <span className="t-xs">Cash and new money · <Link href="/decisions">Decisions</Link></span>
            <p className="t-sm text-ink leading-snug">{cash.headline}</p>
          </div>
        )}
        <Disclose summary={<span className="t-sm">The monthly routine and the rules</span>}>
          <ul className="t-xs flex flex-col gap-1">{plan.routine.map((r) => <li key={r}>{r}</li>)}</ul>
          <p className="t-xs mt-2">Rules: the ranges and maximums above are the ones you approved (see Policy). A research trim level is a recommendation, not a policy limit. You place every order and transfer yourself.</p>
        </Disclose>
      </Card>

      <Card labelledBy="wait-h" className="!gap-1">
        <CardHead id="wait-h" cap="What you're waiting for" right={<span className="t-xs">stocks at their buy level</span>} />
        {st.waiting.length ? (
          <ul className="t-sm flex flex-col">
            {st.waiting.slice(0, 6).map((w) => (
              <li key={w.symbol} className="flex justify-between gap-3 py-1.5 border-t border-line first:border-t-0">
                <Link href={`/research/${w.symbol}`} className="no-underline text-ink">{w.symbol}{w.owned ? <span className="t-xs"> · owned</span> : null}</Link>
                <span className="num text-right">{w.away <= 0 ? <Pill small tone="gain">At its level: read its page</Pill> : <span className="t-xs">{usd(w.price, 2)} · {(w.away * 100).toFixed(0)}% above {usd(w.level)}</span>}</span>
              </li>
            ))}
          </ul>
        ) : <p className="t-sm">No researched stock has a buy level yet.</p>}
        <span className="t-xs pt-1">When one reaches its level, read its page and Decisions before buying. Otherwise, do nothing.</span>
      </Card>

      <Card labelledBy="opp-h" className="!gap-1">
        <CardHead id="opp-h" cap="New opportunities to look at" right={<span className="t-xs">free · from prices</span>} />
        {lows.length ? (
          <ul className="t-sm flex flex-col">
            {lows.slice(0, 5).map((l) => (
              <li key={l.symbol} className="flex flex-col py-1.5 border-t border-line first:border-t-0">
                <span className="flex justify-between gap-3"><Link href={`/research/${l.symbol}`} className="no-underline text-ink">{l.symbol} <span className="t-xs">· {l.kind === "stock" ? "researched stock" : l.kind === "plan_fund" ? "plan fund" : "fund"}</span></Link><span className="num">{usd(l.price, 2)}</span></span>
                <span className="t-xs">{l.note}</span>
              </li>
            ))}
          </ul>
        ) : <p className="t-sm">Nothing is far below its high right now: not your plan funds, the broad funds watched ({WATCH_FUNDS.join(", ")}) or your researched stocks.</p>}
        {radar && (
          <p className="t-xs pt-1">Radar ({shortDate(radar.at)}): {radar.ideas.length ? radar.ideas.map((i) => i.symbol).join(", ") + " worth a research look" : radar.pullbacks.length ? `no strong new ideas; S&P 500 stocks beating the market but pulled back: ${radar.pullbacks.join(", ")} (screen only, not researched)` : "no new ideas this week"}. <Link href="/radar">Radar</Link></p>
        )}
      </Card>

      <Card labelledBy="drop-h" className="!gap-1">
        <CardHead id="drop-h" cap="No longer good, and why" right={<span className="t-xs">last {DROPPED_DAYS / 30} months</span>} />
        {dropped.length ? (
          <ul className="t-sm flex flex-col">
            {dropped.slice(0, 5).map((d) => (
              <li key={d.symbol} className="flex flex-col gap-0.5 py-1.5 border-t border-line first:border-t-0">
                <span className="flex justify-between gap-3"><Link href={`/research/${d.symbol}`} className="no-underline text-ink">{d.symbol}</Link><span className="t-xs">{d.kind === "passed" ? "you passed" : "research changed"}{d.since ? ` · ${shortDate(d.since)}` : ""}</span></span>
                <span className="t-xs"><span className="text-ink-2">Was:</span> {d.was}</span>
                <span className="t-xs"><span className="text-ink-2">Now:</span> {d.now}</span>
              </li>
            ))}
          </ul>
        ) : <p className="t-sm">No idea has been dropped recently: no research went from buy to hold or avoid, and nothing was moved to Passed.</p>}
      </Card>
    </>
  );
}

/** Plan funds, watched broad funds and researched stocks, with their 52-week high (daily prices, cached an hour). */
async function findLows(plan: TargetPlan, ws: Workspace): Promise<Low[]> {
  const researched = ws.research.filter((r) => r.current).map((r) => r.symbol);
  const symbols = [...new Set([...plan.funds.map((s) => s.buy).filter((s) => /^[A-Z]{2,5}$/.test(s)), ...WATCH_FUNDS, ...researched])];
  const highs = new Map<string, { price: number; high: number }>();
  await Promise.all(symbols.map(async (s) => {
    const h = await getHistory(s, "1y").catch(() => null);
    const m = h ? metricsOf(h.bars) : null;
    const price = ws.quotes.get(s)?.price ?? m?.price;
    if (m && price) highs.set(s, { price, high: m.price / (1 + m.fromHigh) });
  }));
  return lowsFrom(plan, highs, researched);
}

/** The latest weekly Radar: its ideas, or the screen's top pullbacks when it named none. */
async function latestRadar(db: SupabaseClient): Promise<{ at: string; ideas: RadarIdea[]; pullbacks: string[] } | null> {
  const { data } = await db.from("model_runs").select("computed_at, outputs").eq("kind", "radar_run").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const o = data.outputs as { ideas?: RadarIdea[]; screen?: { candidates?: Candidate[] } | null };
  const pullbacks = (o.screen?.candidates ?? []).filter((c) => c.kind === "pullback").slice(0, 3).map((c) => c.symbol);
  return { at: data.computed_at as string, ideas: o.ideas ?? [], pullbacks };
}

/** Research in use vs the version before it, and ideas you moved to Passed. */
async function findDropped(db: SupabaseClient, ws: Workspace): Promise<Dropped[]> {
  const since = new Date(ws.now.getTime() - DROPPED_DAYS * 864e5).toISOString().slice(0, 10);
  const { data } = await db.from("companies").select("symbol, research_versions(id, research_as_of, completeness, origin, is_current, conclusion)");
  const versions = new Map<string, { asOf: string; action: string | null }[]>();
  for (const c of (data ?? []) as { symbol: string; research_versions: VersionRow[] | null }[]) {
    const r = ws.research.find((x) => x.symbol === c.symbol);
    const cur = r?.current ?? null;
    if (!cur) continue;
    const prev = (c.research_versions ?? []).filter((v) => usableVersion(v) && v.id !== cur.id && v.research_as_of < cur.research_as_of).sort((a, b) => b.research_as_of.localeCompare(a.research_as_of))[0];
    if (!prev) continue;
    versions.set(c.symbol, [{ asOf: cur.research_as_of, action: cur.parsed.action }, { asOf: prev.research_as_of, action: parseConclusion(prev.conclusion).action }]);
  }
  const passed = ws.research.filter((r) => r.pipeline.stage === "passed").map((r) => ({ symbol: r.symbol, note: r.pipeline.note, at: r.pipeline.stageUpdatedAt }));
  return noLongerGood(versions, passed, since);
}
