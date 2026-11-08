import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHead, Disclose, Metric, Pill } from "@/components/ui";
import { TradeRunner } from "@/components/TradeRunner";
import { loadTrades, markOpen, scanStatus, type Trade } from "@/lib/trades/job";
import { evaluate, scoreboard, type Result } from "@/lib/trades/trades";
import { shortDate } from "@/lib/format";
import { markTaken } from "./actions";

export const dynamic = "force-dynamic";

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;
const tone = (x: number | null | undefined) => (x === null || x === undefined ? null : x >= 0 ? ("gain" as const) : ("loss" as const));
const STATUS = { open: "Open", target: "Hit target", stop: "Stopped out", ended: "Ended" } as const;
const name = (t: Trade) => (t.idea.option ? `${t.idea.symbol} $${t.idea.option.strike} ${t.idea.option.type} ${shortDate(t.idea.option.expiry)}` : `${t.idea.symbol} stock`);

function TradeRow({ t, r }: { t: Trade; r: Result }) {
  const i = t.idea;
  return (
    <li className="border-t border-line">
      <Disclose summary={
        <span className="flex items-center justify-between gap-2 w-full min-w-0">
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-ink font-semibold truncate">{name(t)}</span>
            {t.taken && <Pill small tone="info">Taken</Pill>}
            {r.status !== "open" && <Pill small tone={r.status === "target" ? "gain" : r.status === "stop" ? "alert" : "neutral"}>{STATUS[r.status]}</Pill>}
          </span>
          <span className="t-sm num shrink-0"><span className={r.returnPct !== null ? (r.returnPct >= 0 ? "gain" : "loss") : ""}>{pct(r.returnPct)}</span> <span className="t-xs">VOO {pct(r.vooPct)}</span></span>
        </span>
      }>
        <div className="flex flex-col gap-2 t-sm">
          <p className="text-ink">{i.thesis}</p>
          <p><span className="text-ink font-semibold">Why now: </span>{i.whyNow}</p>
          <p className="num">Stock at entry ${t.entry.underlying.toFixed(2)}{t.entry.premium ? ` · option $${t.entry.premium.toFixed(2)}${t.entry.premiumSource === "estimate" ? " (estimated, no live quote)" : ""}` : ""} · target ${i.target} · stop ${i.stop} · ends {shortDate(i.endDate)}</p>
          <p className="t-xs">{i.confidence} confidence · {(i.probability * 100).toFixed(0)}% chance of target first · expected {pct(i.expectedPct)} on the stock vs {pct(i.hurdlePct)} needed to beat VOO plus margin · reward {i.rewardRisk.toFixed(1)}x risk{i.sizeUsd ? ` · suggested size ${usd(i.sizeUsd)}` : ""}</p>
          {i.chart && (
            <div className="t-xs flex flex-col gap-0.5">
              <p><span className="text-ink font-semibold">Chart at entry: </span>{i.chart.trend}{i.chart.rsi14 !== null ? ` · RSI ${i.chart.rsi14}${i.chart.rsiLabel && i.chart.rsiLabel !== "neutral" ? ` (${i.chart.rsiLabel})` : ""}` : ""}{i.chart.atr14 ? ` · normal day ±$${i.chart.atr14.toFixed(2)}` : ""}{i.chart.support ? ` · support $${i.chart.support}` : ""}{i.chart.resistance ? ` · resistance $${i.chart.resistance}` : ""}{i.chart.volumeVs50d !== null ? ` · volume ${i.chart.volumeVs50d}× normal` : ""}</p>
              {i.chart.notes.map((n) => <p key={n}>{n}</p>)}
            </div>
          )}
          {r.underlyingPct !== null && t.idea.option && <p className="t-xs">Stock moved {pct(r.underlyingPct)} since entry{r.priced === "none" ? "; no live option price right now" : r.priced === "intrinsic" ? "; option valued at expiry" : ""}.</p>}
          <div><span className="text-ink font-semibold">Risks</span><ul className="list-disc pl-5 t-xs">{i.risks.map((x) => <li key={x}>{x}</li>)}</ul></div>
          {i.wouldChange && <p className="t-xs"><span className="text-ink font-semibold">Would drop it if: </span>{i.wouldChange}</p>}
          <p className="t-xs">Sources: {i.sources.map((s, k) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer">{k ? ", " : ""}{s.title || new URL(s.url).hostname}</a>)}</p>
          <Link href={`/research/${i.symbol}`} className="t-sm">Open {i.symbol}</Link>
          {t.taken ? (
            <p className="t-xs">You took this trade {shortDate(t.taken.at)}{t.taken.price ? ` at $${t.taken.price}` : ""}{t.taken.quantity ? `, ${t.taken.quantity} ${i.option ? "contracts" : "shares"}` : ""}{t.taken.note ? `. ${t.taken.note}` : ""}.</p>
          ) : r.status === "open" && (
            <Disclose summary={<span className="t-sm">I took this trade</span>}>
              <form action={markTaken} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="idea_id" value={t.id} />
                <label className="flex flex-col t-xs">Price paid<input name="price" inputMode="decimal" className="min-h-10 w-28 rounded-[10px] bg-surface-2 border border-line px-2 text-[15px]" /></label>
                <label className="flex flex-col t-xs">{i.option ? "Contracts" : "Shares"}<input name="quantity" inputMode="decimal" className="min-h-10 w-24 rounded-[10px] bg-surface-2 border border-line px-2 text-[15px]" /></label>
                <label className="flex flex-col t-xs grow">Note<input name="note" maxLength={300} className="min-h-10 w-full rounded-[10px] bg-surface-2 border border-line px-2 text-[15px]" /></label>
                <button className="btn btn-sm">Save</button>
              </form>
            </Disclose>
          )}
        </div>
      </Disclose>
    </li>
  );
}

/** Short-term trade ideas: rare, held to a bar, locked in as paper trades and scored against VOO. */
export default async function TradesPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const db = await createClient();
  const [st, trades, sp] = await Promise.all([scanStatus(db), loadTrades(db), searchParams]);
  const open = trades.filter((t) => !t.close);
  const marks = await markOpen(open, new Date());
  const live = new Map(open.map((t) => [t.id, evaluate(t.idea, t.entry, marks.get(t.id)!)]));
  const closed = trades.filter((t) => t.close);
  const sb = scoreboard(closed.map((t) => ({ result: t.close!.result, sizeUsd: t.idea.sizeUsd })));
  const last = st.latest;

  return (
    <div className="flex flex-col gap-3 lg:gap-4 max-w-3xl">
      <div className="flex flex-col gap-1">
        <span className="cap">Short term</span>
        <h1 className="h1">Trade ideas</h1>
        <p className="t-sm">A few trades a year, only when the evidence is strong: a dated reason, a target, a stop and an end date, and an expected result that beats simply holding VOO over the same days. Every idea is locked in as a paper trade the moment it is made and tracked automatically, so the scoreboard shows honestly whether these ideas are worth acting on. It looks once a week on its own; you can ask any time. It never trades.</p>
      </div>
      {sp.saved && <p role="status" className="t-sm text-ink">Saved. The paper record is unchanged; your actual trade is noted beside it.</p>}

      <Card className="!gap-2">
        <TradeRunner running={st.running} />
        {last && (
          <p className="t-xs">
            Last search {shortDate(last.at)} · {last.trigger === "weekly" ? "weekly" : "by you"}{last.focus ? ` · ${last.focus}` : ""} · ${last.costUsd.toFixed(2)} ·{" "}
            {!last.ok ? <span className="warn">failed: {last.error}</span> : last.ideaIds.length ? `${last.ideaIds.length} idea${last.ideaIds.length > 1 ? "s" : ""}` : "no trade cleared the bar"}
          </p>
        )}
        {last?.ok && !last.ideaIds.length && last.noneReason && <p className="t-sm">{last.noneReason}</p>}
        {last?.ok && last.rejected.length > 0 && (
          <Disclose summary={<span className="t-xs">Turned down by the app&apos;s checks · {last.rejected.length}</span>}>
            <ul className="list-disc pl-5 t-xs">{last.rejected.map((x) => <li key={x.symbol + x.why}>{x.symbol}: {x.why}</li>)}</ul>
          </Disclose>
        )}
      </Card>

      <Card labelledBy="tr-score" className="!gap-3">
        <CardHead id="tr-score" title="Scoreboard vs VOO" right={<span className="t-xs">{sb.closed} closed</span>} />
        {sb.scored ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Metric label="Beat VOO" value={`${sb.beatVoo} of ${sb.scored}`} />
            <Metric label="Avg return" value={pct(sb.avgReturnPct)} tone={tone(sb.avgReturnPct)} />
            <Metric label="VOO same days" value={pct(sb.avgVooPct)} />
            <Metric label="Edge in dollars" value={usd(sb.edgeUsd)} tone={tone(sb.edgeUsd)} note="at suggested sizes" />
          </div>
        ) : <p className="t-sm">No closed paper trades yet. Ideas close when they reach their target, stop or end date.</p>}
      </Card>

      <Card labelledBy="tr-open" className="!gap-0" flush>
        <div className="px-4 pt-4 pb-2 lg:px-5"><CardHead id="tr-open" title="Open" right={<span className="t-xs">return · VOO since entry</span>} /></div>
        {open.length ? <ul className="flex flex-col">{open.map((t) => <TradeRow key={t.id} t={t} r={live.get(t.id)!} />)}</ul> : <p className="t-sm px-4 pb-4 lg:px-5">No open ideas. That is the normal state.</p>}
      </Card>

      {closed.length > 0 && (
        <Card labelledBy="tr-closed" className="!gap-0" flush>
          <div className="px-4 pt-4 pb-2 lg:px-5"><CardHead id="tr-closed" title="Closed" /></div>
          <ul className="flex flex-col">{closed.map((t) => <TradeRow key={t.id} t={t} r={t.close!.result} />)}</ul>
        </Card>
      )}
    </div>
  );
}
