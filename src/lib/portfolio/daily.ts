/**
 * Recorded history: one row per market day with what the app calculated that day.
 * Unlike the hypothetical risk series, these rows are what was actually shown at the time,
 * still labelled estimated unless every account was API-verified.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace } from "@/lib/workspace";

export type DailyRow = { as_of: string; investable: number; invested: number; cash: number; net_worth_tracked: number | null; spy_close: number | null; quality: "verified" | "estimated"; holdings_as_of: string | null };

const nyDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/** Upserts today's row. Skips when there are no live prices, so statement-only values are never recorded as a day. */
export async function recordDaily(db: SupabaseClient, ws: Workspace): Promise<void> {
  const p = ws.portfolio;
  const spy = ws.quotes.get("SPY");
  if (!ws.userId || !spy || p.pricedLive === 0 || !p.holdings.length) return;
  const row = {
    as_of: nyDate(spy.asOf),
    investable: p.investableCapital,
    invested: p.invested,
    cash: p.cash,
    net_worth_tracked: p.netWorthTracked,
    spy_close: spy.price,
    quality: p.quality.status === "verified" ? "verified" : "estimated",
    holdings_as_of: p.oldestHoldingsAsOf,
    positions: p.holdings.map((h) => ({ symbol: h.symbol, quantity: h.quantity, price: h.price, value: h.value })),
    recorded_at: new Date().toISOString(),
  };
  try {
    await db.from("portfolio_daily").upsert(row, { onConflict: "owner_id,as_of" });
  } catch {
    /* recording is best effort; never block the page */
  }
}

export async function loadDaily(db: SupabaseClient, days = 400): Promise<DailyRow[]> {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const { data } = await db.from("portfolio_daily").select("as_of, investable, invested, cash, net_worth_tracked, spy_close, quality, holdings_as_of").gte("as_of", since).order("as_of");
  return (data ?? []).map((r) => ({ ...r, investable: Number(r.investable), invested: Number(r.invested), cash: Number(r.cash), net_worth_tracked: r.net_worth_tracked == null ? null : Number(r.net_worth_tracked), spy_close: r.spy_close == null ? null : Number(r.spy_close) }));
}
