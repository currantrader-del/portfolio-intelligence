import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardHead, Disclose, Pill } from "@/components/ui";
import { shortDate } from "@/lib/format";
import { MAX_APP_ACTIVE, PORTFOLIOS, type Result, type ShadowReport } from "@/lib/shadow/shadow";
import type { ShadowEntry } from "@/lib/shadow/store";
import { createOwnShadowTest, stopShadowTest } from "@/app/(app)/plan/actions";

type Row = ShadowEntry & { report: ShadowReport };
const usd = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const pctS = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)}%`;
const res = (r: Result) => `${signed(r.gain)} (${pctS(r.pct)})`;
const qtyS = (n: number) => (n >= 10 ? n.toFixed(1) : n.toFixed(3)).replace(/\.?0+$/, "");

/** The change's edge over leaving the portfolio as it was, at the latest close. */
function edge(r: ShadowReport): number | null {
  return r.now ? r.now.hypothetical.gain - r.now.original.gain : null;
}

export function ShadowTests({ rows }: { rows: Row[] }) {
  const active = rows.filter((r) => !r.close);
  const closed = rows.filter((r) => r.close);
  return (
    <Card labelledBy="pl-shadow" className="!gap-2" flush>
      <div className="px-4 pt-4 lg:px-5 flex flex-col gap-1">
        <CardHead id="pl-shadow" title="Shadow tests" right={<Pill small>Paper only · no AI</Pill>} />
        <p className="t-xs">Each test freezes your portfolio, makes a proposed change on paper at the next market close, and tracks it forward against leaving it alone, your real trades, and all in VOO, from the same starting money. The app adds a test when the weekly plan proposes a researched Trim or Exit (at most {MAX_APP_ACTIVE} at a time, proceeds to VOO); you can add your own below. Nothing here trades.</p>
      </div>
      {active.length === 0 && <p className="t-sm px-4 lg:px-5">No active tests yet.</p>}
      <ul className="flex flex-col">
        {active.map((r) => <TestRow key={r.test.id} r={r} />)}
      </ul>
      {closed.length > 0 && (
        <Disclose summary={<span className="t-sm px-4 lg:px-5">Stopped tests · {closed.length} (kept as history)</span>}>
          <ul className="flex flex-col">{closed.map((r) => <TestRow key={r.test.id} r={r} />)}</ul>
        </Disclose>
      )}
      <div className="border-t border-line">
        <Disclose summary={<span className="t-sm">Test your own change</span>}>
          <OwnTestForm />
        </Disclose>
      </div>
    </Card>
  );
}

function TestRow({ r }: { r: Row }) {
  const { test: t, report: rep } = r;
  const e = edge(rep);
  const reached = rep.horizons.filter((h) => h.results);
  const cols = [{ key: "now", label: rep.asOf ? `Since start (${shortDate(rep.asOf)})` : "Since start", results: rep.now }, ...reached.map((h) => ({ key: h.key, label: h.label, results: h.results }))];
  return (
    <li className="border-t border-line">
      <Disclose summary={
        <span className="flex items-center justify-between gap-2 w-full min-w-0">
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-ink font-semibold truncate">{t.name}</span>
            <Pill small>{t.origin === "app" ? "App" : "You"}</Pill>
          </span>
          <span className="t-sm num shrink-0">{rep.status === "pending" ? `starts ${shortDate(rep.startDate)}` : e === null ? "—" : `${signed(e)} vs no change`}</span>
        </span>
      }>
        <div className="flex flex-col gap-2 t-sm">
          {t.rationale && <p>{t.rationale}</p>}
          <p className="t-xs">Created {shortDate(t.createdAt)}{t.source.researchAsOf ? ` · research of ${shortDate(t.source.researchAsOf)}` : ""} · portfolio as of {t.base.holdingsAsOf ? shortDate(t.base.holdingsAsOf) : "unknown"}{t.base.estimated ? " (estimated holdings)" : ""}{r.close ? ` · stopped ${shortDate(r.close.endDate)}` : ""}</p>
          {rep.status === "pending" ? (
            <p>Trades are priced at the close on {shortDate(rep.startDate)}, after you created the test, so nothing uses hindsight. {t.trades.map((x) => `${x.side === "sell" ? "Sell" : "Buy"} ${x.symbol} ${x.unit === "usd" ? `$${x.amount.toLocaleString("en-US")}` : x.unit === "pct_holding" ? `${x.amount}% of the holding` : `with ${x.amount}% of the proceeds`}`).join(" · ")}</p>
          ) : rep.resolved && (
            <>
              <ul className="flex flex-col gap-0.5">
                {rep.resolved.trades.map((x) => <li key={`${x.side}${x.symbol}`}>{x.side === "sell" ? "Sell" : "Buy"} {qtyS(x.qty)} {x.symbol} at ${x.price.toFixed(2)} ({usd(x.value)}) on {shortDate(rep.startDate)}</li>)}
              </ul>
              <p className="t-xs">Starting money {usd(rep.resolved.startValue)} in every portfolio. Trading costs {usd(rep.resolved.costs)} (0.05% a trade). {rep.resolved.realizedGain !== null ? `Estimated tax on the sells ${usd(rep.resolved.taxEstimate)} (22% of a ${signed(rep.resolved.realizedGain)} gain, an assumption; not deducted below).` : ""} Exposure: {rep.resolved.exposure.map((x) => `${x.symbol} ${x.before.toFixed(1)}% → ${x.after.toFixed(1)}%`).join(", ")}.{rep.flows ? ` Deposits and withdrawals since the start (${signed(rep.flows)}) are added to every portfolio as cash.` : ""}</p>
              {rep.now && (
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full t-sm num">
                    <thead><tr className="t-xs text-left"><th className="font-normal px-1"><span className="sr-only">Portfolio</span></th>{cols.map((c) => <th key={c.key} className="font-normal px-1 text-right">{c.label}</th>)}</tr></thead>
                    <tbody>
                      {PORTFOLIOS.map((p) => (
                        <tr key={p.key} className="border-t border-line">
                          <td className="px-1 py-1 text-ink whitespace-nowrap" title={p.long}>{p.label}</td>
                          {cols.map((c) => <td key={c.key} className="px-1 py-1 text-right whitespace-nowrap">{c.results ? res(c.results[p.key]) : "—"}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="t-xs">Gain or loss after trading costs. No change: your portfolio as it was. With change: the same portfolio with the trades above. Actual: as it was plus the real trades you record. All VOO: the same starting money in VOO.</p>
              {rep.risk && (
                <p className="t-xs">Risk so far: {PORTFOLIOS.map((p) => { const k = rep.risk![p.key]; return `${p.label}: largest ${k.largest ? `${k.largest.symbol} ${k.largest.pct.toFixed(0)}%` : "—"}, drawdown ${k.maxDrawdown ?? 0}%${k.volatility !== null ? `, volatility ${k.volatility}% a year` : ""}`; }).join(" · ")}.</p>
              )}
              <p className="t-xs">Totals include dividends (adjusted closes). Not reached yet: {rep.horizons.filter((h) => !h.results).map((h) => `${h.label} (${shortDate(h.date)})`).join(", ") || "none"}.{rep.missing.length ? ` No price history for ${rep.missing.join(", ")}, held flat.` : ""}</p>
              {rep.resolved.notes.map((n) => <p key={n} className="t-xs warn">{n}</p>)}
            </>
          )}
          {!r.close && (
            <ActionForm action={stopShadowTest} success="Test stopped" className="self-start">
              <input type="hidden" name="id" value={t.id} />
              <SubmitButton className="btn btn-sm" pendingText="Stopping…">Stop tracking</SubmitButton>
            </ActionForm>
          )}
        </div>
      </Disclose>
    </li>
  );
}

function OwnTestForm() {
  return (
    <ActionForm action={createOwnShadowTest} success="Test created" resetOnSuccess className="flex flex-col gap-2">
      <label className="field">Name<input name="name" className="input" placeholder="Trim RDDT by half, buy AVUV" required maxLength={80} /></label>
      <label className="field">Why (optional)<textarea name="rationale" className="input" rows={2} maxLength={900} /></label>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="grid grid-cols-[4.75rem_minmax(0,1fr)_minmax(0,1fr)_6.5rem] gap-1.5 items-end">
          <label className="field">{i === 0 ? "Trade" : <span className="sr-only">Trade {i + 1}</span>}<select name={`side${i}`} defaultValue={i === 0 ? "sell" : "buy"} className="input"><option value="sell">Sell</option><option value="buy">Buy</option></select></label>
          <label className="field">{i === 0 ? "Symbol" : <span className="sr-only">Symbol {i + 1}</span>}<input name={`symbol${i}`} className="input uppercase" autoCapitalize="characters" maxLength={10} /></label>
          <label className="field">{i === 0 ? "Amount" : <span className="sr-only">Amount {i + 1}</span>}<input name={`amount${i}`} inputMode="decimal" className="input" /></label>
          <label className="field">{i === 0 ? "Unit" : <span className="sr-only">Unit {i + 1}</span>}<select name={`unit${i}`} defaultValue={i === 0 ? "pct_holding" : "pct_proceeds"} className="input"><option value="pct_holding">% held</option><option value="pct_proceeds">% sales</option><option value="usd">$</option></select></label>
        </div>
      ))}
      <p className="t-xs">Sell a % of the shares you hold (% held) or a dollar amount. Buy with a % of the sales in this test (% sales) or a dollar amount from your brokerage cash. Sells come first. Prices are the next market close. Fractional shares are allowed on paper.</p>
      <SubmitButton className="btn btn-sm self-start" pendingText="Creating…">Start this test</SubmitButton>
    </ActionForm>
  );
}
