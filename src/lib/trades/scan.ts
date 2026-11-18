/**
 * The market-wide first pass: chart setups found in code across ~500 large US stocks (plus holdings and
 * researched companies), so the AI spends its research on the best few instead of whatever it happens to
 * know about. Pure. A setup is a place where the risk is defined by the chart; it is not a trade until the
 * AI finds a reason (a catalyst, the fundamentals) and the idea clears the bar in trades.ts.
 */
import type { Bar } from "@/lib/market/history";
import type { TA } from "@/lib/market/ta";

export const SCAN_VERSION = "market-scan@1";
export const MIN_PRICE = 10;
export const MIN_DOLLAR_VOLUME = 20_000_000;
export const MIN_REWARD_RISK = 2;

export type SetupKind = "pullback" | "oversold" | "breakout" | "rally_into_resistance";
export type Setup = {
  symbol: string; sector: string | null; kind: SetupKind; direction: "up" | "down";
  price: number; entry: number; stop: number; target: number; rewardRisk: number; score: number;
  rsi14: number | null; trend: TA["trend"]; atr14: number; volumeVs50d: number | null; why: string;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const KIND_LABEL: Record<SetupKind, string> = {
  pullback: "Pullback to support in an uptrend",
  oversold: "Oversold at support",
  breakout: "Breaking out to a new high on volume",
  rally_into_resistance: "Rally into resistance in a downtrend (put setup)",
};
export const setupLabel = (k: SetupKind) => KIND_LABEL[k];

/** The best chart setup for one stock, or null. Stops sit beyond the level plus half a normal day. */
export function findSetup(symbol: string, sector: string | null, bars: Bar[], ta: TA): Setup | null {
  const p = ta.last, atr = ta.atr14;
  if (!atr || p < MIN_PRICE) return null;
  const vols = bars.slice(-20).map((b) => (b.volume ?? 0) * b.close);
  if (ta.hasVolume && vols.reduce((a, b) => a + b, 0) / vols.length < MIN_DOLLAR_VOLUME) return null;
  const sup = ta.support[0], res = ta.resistance[0];
  const yrHigh = Math.max(...bars.slice(-252).map((b) => b.high ?? b.close));
  const cands: Omit<Setup, "score" | "rewardRisk" | "symbol" | "sector" | "price" | "rsi14" | "trend" | "atr14" | "volumeVs50d">[] = [];
  const nearAbove = (lvl: number) => p >= lvl && p - lvl <= 1.5 * atr;
  const nearBelow = (lvl: number) => p <= lvl && lvl - p <= 1.5 * atr;
  const rsi = ta.rsi14 ?? 50;

  if (sup && ta.trend === "uptrend" && rsi >= 30 && rsi <= 48 && nearAbove(sup.price)) {
    cands.push({ kind: "pullback", direction: "up", entry: p, stop: sup.price - 0.5 * atr, target: res?.price ?? yrHigh, why: `Uptrend, RSI ${rsi}, ${r2((p - sup.price) / atr)} ATR above support at $${sup.price} (${sup.touches} touches)` });
  }
  if (sup && rsi <= 32 && nearAbove(sup.price) && ta.trend !== "downtrend") {
    cands.push({ kind: "oversold", direction: "up", entry: p, stop: sup.price - 0.5 * atr, target: res?.price ?? p + 3 * atr, why: `RSI ${rsi}, sitting on support at $${sup.price} (${sup.touches} touches)` });
  }
  if (ta.trend === "uptrend" && p >= yrHigh * 0.985 && (ta.volumeVs50d ?? 0) >= 1.3) {
    const stop = Math.min(p - 2 * atr, sup ? sup.price - 0.5 * atr : Infinity);
    cands.push({ kind: "breakout", direction: "up", entry: p, stop, target: p + 2.5 * (p - stop), why: `At the 52-week high ($${r2(yrHigh)}) with volume ${ta.volumeVs50d}x normal; target is a measured move` });
  }
  if (res && ta.trend === "downtrend" && rsi >= 52 && rsi <= 70 && nearBelow(res.price)) {
    cands.push({ kind: "rally_into_resistance", direction: "down", entry: p, stop: res.price + 0.5 * atr, target: sup?.price ?? p - 3 * atr, why: `Downtrend, RSI ${rsi}, rallied to within ${r2((res.price - p) / atr)} ATR of resistance at $${res.price}` });
  }

  let best: Setup | null = null;
  for (const c of cands) {
    const risk = Math.abs(c.entry - c.stop), reward = c.direction === "up" ? c.target - c.entry : c.entry - c.target;
    if (risk < atr || reward <= 0) continue;
    const rr = reward / risk;
    if (rr < MIN_REWARD_RISK) continue;
    const volOk = ta.upDownVolume20d !== null && (c.direction === "up" ? ta.upDownVolume20d >= 1 : ta.upDownVolume20d <= 1);
    const level = c.direction === "up" ? sup : res;
    const score = Math.min(rr, 5) + (volOk ? 0.5 : 0) + ((level?.touches ?? 0) >= 3 ? 0.5 : 0) + (c.kind === "pullback" || c.kind === "rally_into_resistance" ? 0.5 : 0);
    const s: Setup = { symbol, sector, ...c, price: p, entry: r2(c.entry), stop: r2(c.stop), target: r2(c.target), rewardRisk: r2(rr), score: r2(score), rsi14: ta.rsi14, trend: ta.trend, atr14: atr, volumeVs50d: ta.volumeVs50d };
    if (!best || s.score > best.score) best = s;
  }
  return best;
}

/** The top setups, best first, with at most `perSector` from any one sector so one theme cannot fill the list. */
export function rankSetups(all: Setup[], max = 15, perSector = 3): Setup[] {
  const out: Setup[] = [], bySector = new Map<string, number>();
  for (const s of [...all].sort((a, b) => b.score - a.score || b.rewardRisk - a.rewardRisk)) {
    const k = s.sector ?? s.symbol;
    if ((bySector.get(k) ?? 0) >= perSector) continue;
    bySector.set(k, (bySector.get(k) ?? 0) + 1);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** The shortlist as the AI sees it. */
export function setupsText(setups: Setup[], scanned: number): string {
  if (!setups.length) return `The app screened ${scanned} stocks and found no chart setup with at least ${MIN_REWARD_RISK}x reward to risk today.`;
  return [`The app screened ${scanned} stocks (S&P 500 plus your holdings and researched companies) for chart setups with at least ${MIN_REWARD_RISK}x reward to risk. Best first:`,
    ...setups.map((s, i) => `${i + 1}. ${s.symbol} (${s.sector ?? "—"}) ${KIND_LABEL[s.kind]}: price $${r2(s.price)}, stop $${s.stop}, target $${s.target}, ${s.rewardRisk}x. ${s.why}.`)].join("\n");
}
