import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { Tag } from "@/components/Tag";
import { shortDate, usd } from "@/lib/format";
import { recordTransaction, saveSavings } from "../actions";

const ROLE = { taxable_brokerage: "Taxable", retirement: "Retirement (Roth IRA)", cash: "Savings", protected_savings: "Savings" } as Record<string, string>;
const input = "rounded-lg border border-line-strong bg-ground px-3 min-h-10";

export default async function ReconcilePage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const sp = await searchParams;
  const ws = await getWorkspace();
  const p = ws.portfolio;
  const db = await createClient();
  const { data: txns } = await db.from("transactions").select("id, account_id, trade_date, kind, symbol, quantity, price, amount, note").order("trade_date", { ascending: false }).limit(50);
  const brokers = p.accounts.filter((a) => a.role !== "cash" && a.role !== "protected_savings");
  const today = ws.now.toISOString().slice(0, 10);
  const c = p.cashDetail;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/portfolio" className="text-sm no-underline">← Portfolio</Link>
        <h1 className="font-serif text-2xl sm:text-3xl font-semibold mt-1">Reconcile holdings and cash</h1>
        <p className="text-muted text-sm">Statements are the verified starting point. Anything after a statement date only counts if it is recorded here.</p>
      </div>
      {sp.saved && <p className="rounded-xl bg-accent-soft px-4 py-2 text-sm">Saved. Every page now uses it.</p>}

      <section aria-labelledby="st-h" className="flex flex-col gap-2">
        <h2 id="st-h" className="font-semibold">Statements on file</h2>
        <ul className="grid gap-2 sm:grid-cols-3">
          {brokers.map((a) => (
            <li key={a.id} className="bg-surface border border-line rounded-xl p-4 flex flex-col gap-1 text-sm">
              <div className="flex items-center justify-between gap-2"><span className="font-semibold">{a.name}</span><Tag tone={a.ageDays > 7 ? "warn" : "accent"}>{a.ageDays} days old</Tag></div>
              <div className="text-muted">{ROLE[a.role] ?? a.role} · {a.sourceKind} {shortDate(a.asOf)}</div>
              <div>Statement total <span className="font-mono">{usd(a.statementTotal)}</span></div>
              <div>Positions + cash <span className="font-mono">{usd(a.statementComputed)}</span> {a.statementGap === null ? null : Math.abs(a.statementGap) <= 1 ? <Tag tone="accent">Adds up</Tag> : <Tag tone="alert">Off by {usd(a.statementGap)}</Tag>}</div>
              <div>Recorded since: <span className="font-medium">{a.tradesAfter ? `${a.tradesAfter} entr${a.tradesAfter > 1 ? "ies" : "y"}` : "nothing"}</span></div>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">If you traded or moved money after these dates, record it below or upload a newer statement on the Import page. Until then every figure is labelled an estimate.</p>
      </section>

      <section aria-labelledby="cash-h" className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-3">
        <h2 id="cash-h" className="font-semibold">Cash and savings</h2>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><dt className="text-muted">Brokerage cash</dt><dd className="font-mono">{usd(c.brokerage)}</dd><dd className="text-xs text-muted">from statements</dd></div>
          <div><dt className="text-muted">Savings</dt><dd className="font-mono">{c.savings === null ? "Not entered" : usd(c.savings)}</dd><dd className="text-xs text-muted">{c.savingsAsOf ? `as of ${shortDate(c.savingsAsOf)}` : "enter below"}</dd></div>
          <div><dt className="text-muted">Protected reserve</dt><dd className="font-mono">{usd(c.protectedReserve)}</dd><dd className="text-xs text-muted">excluded from sizing{c.reserveShortfall > 0 && c.savings !== null ? ` · short ${usd(c.reserveShortfall)}` : ""}</dd></div>
          <div><dt className="text-muted">Deployable</dt><dd className="font-mono">{usd(c.deployable)}</dd><dd className="text-xs text-muted">brokerage + savings above reserve</dd></div>
        </dl>
        <form action={saveSavings} className="flex flex-wrap gap-2 items-end">
          <label className="text-sm flex flex-col gap-1">Account name<input name="name" defaultValue="Savings" className={input} /></label>
          <label className="text-sm flex flex-col gap-1">Balance<input name="balance" required inputMode="decimal" placeholder="$" className={`${input} w-32 font-mono`} /></label>
          <label className="text-sm flex flex-col gap-1">As of<input name="as_of" type="date" required defaultValue={today} className={input} /></label>
          <button className="min-h-10 px-4 rounded-lg bg-ink text-ground font-medium">Save balance</button>
        </form>
        <p className="text-xs text-muted">The app does not carry over savings figures from old research chats; enter today&apos;s balance.</p>
      </section>

      <section aria-labelledby="tx-h" className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-3">
        <h2 id="tx-h" className="font-semibold">Record a trade or cash movement</h2>
        <form action={recordTransaction} className="grid gap-2 grid-cols-2 sm:grid-cols-4">
          <label className="text-sm flex flex-col gap-1 col-span-2">Account
            <select name="account_id" required className={input}>{brokers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          </label>
          <label className="text-sm flex flex-col gap-1">Type
            <select name="kind" className={input}>
              {[["buy", "Buy"], ["sell", "Sell"], ["deposit", "Deposit"], ["withdrawal", "Withdrawal"], ["dividend", "Dividend"], ["interest", "Interest"], ["fee", "Fee"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="text-sm flex flex-col gap-1">Date<input name="trade_date" type="date" required defaultValue={today} className={input} /></label>
          <label className="text-sm flex flex-col gap-1">Symbol<input name="symbol" placeholder="for trades" className={`${input} font-mono uppercase`} /></label>
          <label className="text-sm flex flex-col gap-1">Shares<input name="quantity" inputMode="decimal" className={`${input} font-mono`} /></label>
          <label className="text-sm flex flex-col gap-1">Price<input name="price" inputMode="decimal" className={`${input} font-mono`} /></label>
          <label className="text-sm flex flex-col gap-1">Amount<input name="amount" inputMode="decimal" placeholder="cash moves" className={`${input} font-mono`} /></label>
          <label className="text-sm flex flex-col gap-1 col-span-2 sm:col-span-3">Note<input name="note" className={input} /></label>
          <button className="min-h-10 px-4 rounded-lg bg-ink text-ground font-medium self-end">Record</button>
        </form>
        <p className="text-xs text-muted">Trades need symbol, shares and price; the cash effect is calculated. Recording here never places a trade.</p>
        {(txns ?? []).length > 0 && (
          <ul className="flex flex-col divide-y divide-line text-sm">
            {(txns ?? []).map((t) => (
              <li key={t.id} className="py-2 flex flex-wrap justify-between gap-2">
                <span>{t.trade_date} · {p.accounts.find((a) => a.id === t.account_id)?.name ?? "Account"} · <span className="capitalize">{t.kind}</span>{t.symbol ? ` ${t.quantity} ${t.symbol} @ ${usd(Number(t.price), 2)}` : ""}</span>
                <span className="font-mono">{usd(Number(t.amount), 2)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {p.quality.missing.length > 0 && (
        <section aria-labelledby="m-h" className="bg-surface border border-line rounded-2xl p-5">
          <h2 id="m-h" className="font-semibold mb-2">Still missing</h2>
          <ul className="text-sm list-disc pl-5 flex flex-col gap-1">{p.quality.missing.map((m) => <li key={m}>{m}</li>)}</ul>
        </section>
      )}
    </div>
  );
}
