/**
 * Schwab quotes and past trades, read-only (2026-11-11).
 *  - Quotes: real-time prices for the alert checks and the morning run, when Schwab is connected. The free
 *    Yahoo/Stooq quotes stay as the fallback for anything Schwab does not return.
 *  - Trades: your Schwab buys and sells are copied into the ledger (transactions, source "schwab_api"), once
 *    each (matched by Schwab's activity id), and only those after the first Schwab sync, so trades already on
 *    file from statements are never entered twice. Snapshots stay the source of positions; a trade dated on
 *    or before the latest snapshot does not roll forward on top of it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Quote } from "@/lib/market/quotes";
import { save } from "@/lib/intel/jobs";
import { SCHWAB_VERSION, connection, schwabGet } from "./client";

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r2 = (x: number) => Math.round(x * 100) / 100;

/* ---------------------------------------------------------------- quotes */

type SchwabQuote = { symbol?: string; realtime?: boolean; quote?: { lastPrice?: number; closePrice?: number; tradeTime?: number; quoteTime?: number }; regular?: { regularMarketLastPrice?: number; regularMarketTradeTime?: number } };

/** Pure: Schwab's quote map to app quotes. The regular-session price is used when present, so a pre-market print is not read as a move. */
export function mapQuotes(body: unknown): Map<string, Quote> {
  const out = new Map<string, Quote>();
  for (const [k, v] of Object.entries((body ?? {}) as Record<string, SchwabQuote>)) {
    const price = n(v?.regular?.regularMarketLastPrice) ?? n(v?.quote?.lastPrice);
    const t = n(v?.regular?.regularMarketTradeTime) ?? n(v?.quote?.tradeTime) ?? n(v?.quote?.quoteTime);
    if (!price || price <= 0 || !t) continue;
    const prev = n(v?.quote?.closePrice);
    const symbol = (v.symbol ?? k).toUpperCase();
    out.set(symbol, { symbol, price, prevClose: prev && prev > 0 ? prev : null, asOf: new Date(t).toISOString(), provider: "schwab", delayClass: v.realtime === false ? "delayed" : "realtime" });
  }
  return out;
}

/** Schwab quotes for plain tickers (indexes such as ^VIX are left to the free source). Empty when Schwab is not connected. */
export async function schwabQuotes(db: SupabaseClient, symbols: string[], now = new Date()): Promise<Map<string, Quote>> {
  const syms = [...new Set(symbols.map((s) => s.toUpperCase()))].filter((s) => /^[A-Z][A-Z0-9.\-/]{0,9}$/.test(s));
  if (!syms.length) return new Map();
  const c = await connection(db, now).catch(() => null);
  if (!c?.connected) return new Map();
  const out = new Map<string, Quote>();
  for (let i = 0; i < syms.length; i += 100) {
    const q = new URLSearchParams({ symbols: syms.slice(i, i + 100).join(","), fields: "quote,regular" });
    for (const [s, v] of mapQuotes(await schwabGet(db, `/marketdata/v1/quotes?${q}`))) out.set(s, v);
  }
  return out;
}

/** Overlays Schwab quotes on the free ones; any Schwab failure leaves the free quotes as they were. */
export async function withSchwabQuotes(db: SupabaseClient, free: Map<string, Quote>, symbols: string[]): Promise<Map<string, Quote>> {
  const s = await schwabQuotes(db, symbols).catch((e) => { console.error(`schwab quotes: ${(e as Error).message}`); return new Map<string, Quote>(); });
  if (!s.size) return free;
  const out = new Map(free);
  for (const [k, v] of s) out.set(k, v);
  return out;
}

/* ---------------------------------------------------------------- trades */

type TransferItem = { instrument?: { symbol?: string; assetType?: string }; amount?: number; price?: number; cost?: number; feeType?: string };
type SchwabTxn = { activityId?: number | string; time?: string; tradeDate?: string; type?: string; status?: string; netAmount?: number; transferItems?: TransferItem[] };

export type MappedTrade = { activityId: string; tradeDate: string; kind: "buy" | "sell"; symbol: string; quantity: number; price: number; amount: number };

/** Pure: Schwab's transaction list to buys and sells. Fees, cash lines and anything unclear are left out. */
export function mapTrades(body: unknown): MappedTrade[] {
  const out: MappedTrade[] = [];
  for (const t of Array.isArray(body) ? (body as SchwabTxn[]) : []) {
    if (t.type !== "TRADE" || (t.status && t.status !== "VALID") || t.activityId === undefined) continue;
    const leg = (t.transferItems ?? []).find((i) => i.instrument?.symbol && i.instrument.assetType !== "CURRENCY" && !i.feeType);
    const qty = n(leg?.amount), price = n(leg?.price), net = n(t.netAmount);
    const day = (t.tradeDate ?? t.time ?? "").slice(0, 10);
    if (!leg || qty === null || qty === 0 || price === null || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    // Schwab signs the share amount: positive for a buy, negative for a sell. The cash amount follows the net.
    const kind = qty > 0 ? "buy" : "sell";
    const amount = net !== null ? r2(net) : r2((kind === "buy" ? -1 : 1) * Math.abs(qty) * price);
    out.push({ activityId: String(t.activityId), tradeDate: day, kind, symbol: leg.instrument!.symbol!.replace(/\s+/g, "").toUpperCase(), quantity: Math.abs(qty), price, amount });
  }
  return out;
}

export type TradeSync = { ok: boolean; at: string; added: number; seen: number; error: string | null };

/** Copies new Schwab buys and sells since the first Schwab sync (at most 60 days back) into the ledger. */
export async function syncSchwabTrades(db: SupabaseClient, now = new Date()): Promise<TradeSync> {
  const out: TradeSync = { ok: false, at: now.toISOString(), added: 0, seen: 0, error: null };
  try {
    const { data: first } = await db.from("holding_snapshots").select("as_of").eq("source_kind", "schwab_api").order("as_of", { ascending: true }).limit(1).maybeSingle();
    if (!first) throw new Error("no Schwab sync yet");
    const start = new Date(Math.max(Date.parse(first.as_of as string), now.getTime() - 60 * 86_400_000));
    const nums = await schwabGet<{ accountNumber: string; hashValue: string }[]>(db, "/trader/v1/accounts/accountNumbers");
    const { data: accts } = await db.from("accounts").select("id, name, institution, account_role, external_ref_hint");
    const brokers = ((accts ?? []) as { id: string; name: string; institution: string; account_role: string; external_ref_hint: string | null }[])
      .filter((a) => a.account_role === "taxable_brokerage" && /schwab|thinkorswim/i.test(`${a.institution} ${a.name}`));
    const { data: have } = await db.from("transactions").select("note").eq("source_kind", "schwab_api").gte("trade_date", start.toISOString().slice(0, 10));
    const seen = new Set(((have ?? []) as { note: string | null }[]).map((r) => r.note?.match(/schwab activity (\S+)/)?.[1]).filter(Boolean));
    for (const a of nums ?? []) {
      const last4 = a.accountNumber.slice(-4);
      const byHint = brokers.filter((b) => (b.external_ref_hint ?? "").replace(/\D/g, "").slice(-4) === last4);
      const target = byHint.length === 1 ? byHint[0] : nums.length === 1 && brokers.length === 1 ? brokers[0] : null;
      if (!target) continue;
      const q = new URLSearchParams({ startDate: start.toISOString(), endDate: now.toISOString(), types: "TRADE" });
      const trades = mapTrades(await schwabGet(db, `/trader/v1/accounts/${a.hashValue}/transactions?${q}`));
      out.seen += trades.length;
      const fresh = trades.filter((t) => !seen.has(t.activityId));
      if (fresh.length) {
        const { error } = await db.from("transactions").insert(fresh.map((t) => ({ account_id: target.id, trade_date: t.tradeDate, kind: t.kind, symbol: t.symbol, quantity: t.quantity, price: t.price, amount: t.amount, source_kind: "schwab_api", note: `From Schwab (schwab activity ${t.activityId})` })));
        if (error) throw new Error(`Could not save trades: ${error.message}`);
        out.added += fresh.length;
      }
    }
    out.ok = true;
  } catch (e) {
    out.error = (e as Error).message.slice(0, 300);
  }
  await save(db, "schwab_trades_sync", SCHWAB_VERSION, { trigger: "sync" }, out).catch(() => null);
  return out;
}

/** Your Schwab trades on file, newest first. */
export async function recentSchwabTrades(db: SupabaseClient, limit = 10) {
  const { data } = await db.from("transactions").select("trade_date, kind, symbol, quantity, price, amount").eq("source_kind", "schwab_api").order("trade_date", { ascending: false }).limit(limit);
  return (data ?? []) as { trade_date: string; kind: "buy" | "sell"; symbol: string; quantity: number; price: number; amount: number }[];
}
