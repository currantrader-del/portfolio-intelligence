import { createClient } from "@/lib/supabase/server";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardHead, DataLabel, Disclose } from "@/components/ui";
import { shortDate, usd } from "@/lib/format";
import { HORIZONS } from "@/lib/recovery/sim";
import { MAX_BUCKET_GAP, MAX_MEAN_GAP } from "@/lib/recovery/calibrate";
import { defaultTargets, latestCalibration, oddsFor, parseTargets } from "@/lib/recovery/job";
import { runRecoveryCheck } from "@/app/(app)/research/actions";

const pc = (x: number) => (x < 0.01 ? "<1%" : x > 0.99 ? ">99%" : `${Math.round(x * 100)}%`);

/**
 * Recovery odds: the chance of touching, and of closing at or above, chosen prices within 2 months to 2 years,
 * from the stock's own price behaviour. Hidden until the out-of-sample calibration check passes.
 */
export async function RecoveryCard({ symbol, price, priceAsOf, targetsRaw }: { symbol: string; price: number | null; priceAsOf: string | null; targetsRaw?: string }) {
  const db = await createClient();
  const cal = await latestCalibration(db).catch(() => null);
  const ready = !!cal?.passed && cal.fresh;
  const odds = ready ? await oddsFor(symbol, (p, high52) => parseTargets(targetsRaw, p) ?? defaultTargets(p, high52), price, priceAsOf).catch(() => null) : null;
  const targets = odds?.targets ?? [];

  return (
    <Card labelledBy="rec-h">
      <CardHead id="rec-h" title="Recovery odds" right={<DataLabel kind="model" />} />
      {!ready ? (
        <>
          <p className="t-sm">
            {!cal ? "Not shown yet: the odds appear only after a check on past prices shows they are honest. The check has not run yet."
              : !cal.passed ? `Not shown: the latest check (${shortDate(cal.at)}) found the odds off by ${Math.round(cal.byKind.touch.meanGap * 100)} points on average (allowed: ${Math.round(MAX_MEAN_GAP * 100)}), so they would mislead.`
              : `Not shown: the last passing check is from ${shortDate(cal.at)} and needs renewing.`}
          </p>
          <ActionForm action={runRecoveryCheck} success="Check started: it takes a minute or two. Reload this page after.">
            <SubmitButton className="btn btn-sm self-start" pendingText="Starting…">Run the check (free, no AI)</SubmitButton>
          </ActionForm>
        </>
      ) : !odds ? (
        <p className="t-sm">Not enough price history for {symbol} to compute the odds.</p>
      ) : (
        <>
          <p className="t-xs">From {usd(odds.price, 2)} ({odds.priceAsOf.slice(0, 10)}). Each cell: chance of <span className="text-ink">touching</span> the price at least once (a daily close at or above it) · chance of <span className="text-ink">closing at or above</span> it on the last day.</p>
          <div className="overflow-x-auto -mx-1">
            <table className="t-sm w-full min-w-[420px]">
              <thead><tr className="t-xs text-left"><th className="px-1 py-1 font-medium">Price</th>{HORIZONS.map((h) => <th key={h.key} className="px-1 py-1 font-medium">{h.label}</th>)}</tr></thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t} className="border-t border-line">
                    <td className="px-1 py-1.5 whitespace-nowrap">{usd(t, t >= 100 ? 0 : 2)} <span className="t-xs">{t >= odds.price ? "+" : ""}{Math.round((t / odds.price - 1) * 100)}%{Math.abs(t - odds.high52) < 0.01 * t ? " · 52-wk high" : ""}</span></td>
                    {HORIZONS.map((h) => { const o = odds.odds.find((x) => x.target === t && x.horizon === h.key); return <td key={h.key} className="px-1 py-1.5 whitespace-nowrap">{o ? <>{pc(o.touch)} <span className="t-xs">· {pc(o.closeAbove)}</span></> : "—"}</td>; })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form className="flex flex-wrap items-end gap-2" method="get">
            <label className="t-xs flex flex-col gap-1">Ask about other prices
              <input name="targets" defaultValue={targetsRaw ?? ""} placeholder="e.g. 120, 150, 170" inputMode="decimal" className="input min-h-10 w-48" />
            </label>
            <button className="btn btn-sm" type="submit">Show odds</button>
          </form>
          <Disclose summary={<span className="t-xs">How these odds are made and checked</span>}>
            <div className="t-xs flex flex-col gap-1">
              <p>They resample {symbol}&apos;s own daily moves over the last {Math.round(odds.historyDays / 252 * 10) / 10} years in 20-day blocks, with its past trend removed and a market-like 6% a year added. So they reflect how much the stock moves, not whether its business will improve. They do not use the research, results or news.</p>
              <p>Checked {shortDate(cal!.at)} on {cal!.stocks} large US stocks, {cal!.cases.toLocaleString()} past cases, using only prices known at each date: average gap between predicted and actual {Math.round(cal!.byKind.touch.meanGap * 100)} points for touching and {Math.round(cal!.byKind.close.meanGap * 100)} for closing (allowed {Math.round(MAX_MEAN_GAP * 100)}; worst group within {Math.round(MAX_BUCKET_GAP * 100)}).</p>
              <ul className="list-disc pl-4">{cal!.limits.map((l) => <li key={l}>{l}</li>)}</ul>
            </div>
          </Disclose>
        </>
      )}
    </Card>
  );
}
