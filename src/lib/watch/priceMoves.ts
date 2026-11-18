/**
 * Price-movement alerts (2026-11-10 direction): a notification when an owned stock or ETF moves past your
 * percentage threshold, even when no action is needed. Code only, no AI, and never a buy or sell signal.
 *  - Thresholds by kind of holding: broad-market ETFs about 3%, established stocks 5%, speculative stocks 8%.
 *  - One alert per threshold crossing per direction per trading day; a larger move escalates (2x, 3x the
 *    threshold, and so on); everything resets at the next session.
 *  - Watchlist moves are optional (off by default).
 * Investment-intelligence alerts (buy, approaching, thesis change, urgent risk, trim review) live in decisionAlerts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { bucketOf, type Bucket } from "@/lib/portfolio/classify";
import { save } from "@/lib/intel/jobs";

export type MoveClass = "broad_etf" | "stock" | "speculative";
export const MOVE_CLASS_LABEL: Record<MoveClass, string> = { broad_etf: "Broad-market ETFs", stock: "Established stocks and sector ETFs", speculative: "Speculative or highly volatile stocks" };
export type Delivery = "immediate" | "daily";

export type AlertPrefs = {
  /** Percent, per kind of holding. */
  thresholds: Record<MoveClass, number>;
  /** Your choice of kind for a symbol, over the app's default. */
  classOverrides: Record<string, MoveClass>;
  priceMoves: boolean; watchlistMoves: boolean; intelligence: boolean;
  priceDelivery: Delivery; intelligenceDelivery: Delivery;
};
export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  thresholds: { broad_etf: 3, stock: 5, speculative: 8 }, classOverrides: {},
  priceMoves: true, watchlistMoves: false, intelligence: true, priceDelivery: "immediate", intelligenceDelivery: "immediate",
};
/** The daily summary goes out with the first check at or after this time (ET, minutes after midnight). */
export const DAILY_SUMMARY_AT_MIN = 15 * 60 + 45;

export function moveClassOf(symbol: string, bucket: Bucket, overrides: Record<string, MoveClass> = {}): MoveClass {
  if (overrides[symbol]) return overrides[symbol];
  if (bucket === "Asymmetric/high-risk growth sleeve") return "speculative";
  if (bucket === "Quality/growth individual stocks" || bucket === "Sector ETFs") return "stock";
  return "broad_etf";
}

export type MoveItem = { symbol: string; dayPct: number | null; price: number; quoteAt: string | null; held: boolean; bucket: Bucket };
export type MoveAlert = {
  id: string; symbol: string; dir: "up" | "down"; level: number; thresholdPct: number; cls: MoveClass;
  dayPct: number; relPct: number | null; price: number; held: boolean; title: string; body: string; href: string; priority: "high" | "default";
};

const QUOTE_FRESH_MIN = 45;
const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`;
const et = (iso: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(iso));
export const etDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

/**
 * The moves that crossed a new level today. `sentToday` holds the highest level already alerted per
 * "SYMBOL|up" or "SYMBOL|down" for today's session. Pure.
 */
export function priceMoveAlerts(a: { items: MoveItem[]; prefs: AlertPrefs; marketDayPct: number | null; sentToday: Map<string, number>; now: Date }): MoveAlert[] {
  const out: MoveAlert[] = [];
  const day = etDay(a.now);
  for (const it of a.items) {
    if (it.dayPct === null || !Number.isFinite(it.dayPct)) continue;
    if (!it.held && !a.prefs.watchlistMoves) continue;
    // A stale or statement price never alerts.
    if (!it.quoteAt || a.now.getTime() - Date.parse(it.quoteAt) > QUOTE_FRESH_MIN * 60_000) continue;
    const cls = moveClassOf(it.symbol, it.bucket, a.prefs.classOverrides);
    const t = a.prefs.thresholds[cls];
    if (!(t > 0)) continue;
    const level = Math.floor((Math.abs(it.dayPct) * 100 + 1e-9) / t);
    if (level < 1) continue;
    const dir = it.dayPct >= 0 ? "up" : "down";
    if (level <= (a.sentToday.get(`${it.symbol}|${dir}`) ?? 0)) continue;
    const rel = a.marketDayPct === null ? null : it.dayPct - a.marketDayPct;
    const crossed = t * level;
    const escalated = level > 1 ? ` That is ${level}x your ${t}% level.` : "";
    out.push({
      id: `move:${day}:${it.symbol}:${dir}:${level}`, symbol: it.symbol, dir, level, thresholdPct: t, cls, dayPct: it.dayPct, relPct: rel, price: it.price, held: it.held,
      title: `${it.symbol} ${pct(it.dayPct)} today${rel !== null ? ` (${pct(rel)} vs the market)` : ""}`,
      body: `Price move only, not a buy or sell signal. ${it.held ? "Your holding" : "Watchlist stock"} moved past ${crossed}% (${MOVE_CLASS_LABEL[cls].toLowerCase()}: ${t}% level).${escalated} Next alert at ${t * (level + 1)}%. Delayed quote ${et(it.quoteAt)} ET, $${it.price.toFixed(2)}.`,
      href: it.held ? `/decisions/review/${it.symbol}` : `/research/${it.symbol}`,
      priority: level >= 2 ? "high" : "default",
    });
  }
  return out.sort((x, y) => Math.abs(y.dayPct) - Math.abs(x.dayPct));
}

/** One notification for several moves (or one). */
export function formatMovePush(moves: MoveAlert[], daily = false): { title: string; body: string; priority: "high" | "default" } {
  const priority = moves.some((m) => m.priority === "high") ? "high" : "default";
  if (moves.length === 1 && !daily) return { title: `Price move: ${moves[0].title}`, body: moves[0].body, priority };
  return {
    title: daily ? `Today's price moves: ${moves.length}` : `Price moves: ${moves.map((m) => `${m.symbol} ${pct(m.dayPct)}`).join(", ")}`,
    body: `${moves.map((m) => `${m.title}: past your ${m.thresholdPct * m.level}% level`).join("\n")}\nPrice moves only, not buy or sell signals.`,
    priority: daily ? "default" : priority,
  };
}

export function prefsFrom(o: unknown): AlertPrefs {
  const x = (o ?? {}) as Partial<AlertPrefs>;
  const th = { ...DEFAULT_ALERT_PREFS.thresholds };
  for (const k of Object.keys(th) as MoveClass[]) { const v = Number(x.thresholds?.[k]); if (v > 0 && v <= 50) th[k] = v; }
  const ov: Record<string, MoveClass> = {};
  for (const [s, c] of Object.entries(x.classOverrides ?? {})) if (c in MOVE_CLASS_LABEL) ov[s.toUpperCase()] = c as MoveClass;
  const b = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const dl = (v: unknown): Delivery => (v === "daily" ? "daily" : "immediate");
  return {
    thresholds: th, classOverrides: ov,
    priceMoves: b(x.priceMoves, true), watchlistMoves: b(x.watchlistMoves, false), intelligence: b(x.intelligence, true),
    priceDelivery: dl(x.priceDelivery), intelligenceDelivery: dl(x.intelligenceDelivery),
  };
}

export async function loadAlertPrefs(db: SupabaseClient): Promise<AlertPrefs> {
  const { data } = await db.from("model_runs").select("outputs").eq("kind", "alert_prefs").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  return prefsFrom(data?.outputs ?? null);
}

export async function saveAlertPrefs(db: SupabaseClient, p: AlertPrefs) {
  return save(db, "alert_prefs", "alert-prefs@1", {}, p);
}

export { bucketOf };
