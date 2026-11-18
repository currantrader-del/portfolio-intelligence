/**
 * Technical analysis computed in code from daily bars, so the numbers are exact and checkable.
 * Pure. Used by the assistant's get_technicals tool and by the trade-idea checks. Technicals are
 * supporting evidence for timing and for where a stop and target belong, never a reason by themselves.
 */
import type { Bar } from "./history";

export type Level = { price: number; touches: number; lastTouched: string };
export type TA = {
  last: number; asOf: string;
  trend: "uptrend" | "downtrend" | "mixed";
  sma50: number | null; sma200: number | null;
  rsi14: number | null; rsiLabel: "overbought" | "oversold" | "neutral" | null;
  /** Average true range over 14 days, in dollars and as a share of price: the size of a normal day. */
  atr14: number | null; atrPct: number | null;
  support: Level[]; resistance: Level[];
  /** Volume of the last 5 days against the 50-day average (1.0 = normal). Null when the source has no volume. */
  volumeVs50d: number | null;
  /** Volume on up days divided by volume on down days over 20 days (above 1 = buying pressure). */
  upDownVolume20d: number | null;
  hasRange: boolean; hasVolume: boolean;
};

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function sma(closes: number[], n: number): number | null {
  return closes.length >= n ? mean(closes.slice(-n)) : null;
}

/** Wilder's 14-day RSI. */
export function rsi(closes: number[], n = 14): number | null {
  if (closes.length <= n) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return Math.round((100 - 100 / (1 + gain / loss)) * 10) / 10;
}

/** Average true range; falls back to close-to-close moves when the source gives no highs and lows. */
export function atr(bars: Bar[], n = 14): number | null {
  if (bars.length <= n) return null;
  const tr = bars.slice(1).map((b, i) => {
    const prev = bars[i].close;
    if (b.high == null || b.low == null) return Math.abs(b.close - prev);
    return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  });
  let a = mean(tr.slice(0, n));
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

/**
 * Support and resistance from swing points: a low (high) that is the lowest (highest) within `w` days
 * on each side. Nearby swings (within half a normal day's range, at least 1%) merge into one level;
 * more touches make a stronger level. Support is below the last price, resistance above, nearest first.
 */
export function levels(bars: Bar[], last: number, atrValue: number | null, w = 5): { support: Level[]; resistance: Level[] } {
  const lo = (b: Bar) => b.low ?? b.close, hi = (b: Bar) => b.high ?? b.close;
  const pts: { price: number; date: string }[] = [];
  for (let i = w; i < bars.length - w; i++) {
    const win = bars.slice(i - w, i + w + 1);
    if (lo(bars[i]) === Math.min(...win.map(lo))) pts.push({ price: lo(bars[i]), date: bars[i].date });
    if (hi(bars[i]) === Math.max(...win.map(hi))) pts.push({ price: hi(bars[i]), date: bars[i].date });
  }
  // The year's extremes always count, even when they are recent.
  const yr = bars.slice(-252);
  const hiBar = yr.reduce((a, b) => (hi(b) > hi(a) ? b : a), yr[0]);
  const loBar = yr.reduce((a, b) => (lo(b) < lo(a) ? b : a), yr[0]);
  if (hiBar) pts.push({ price: hi(hiBar), date: hiBar.date });
  if (loBar) pts.push({ price: lo(loBar), date: loBar.date });

  const tol = Math.max(0.01 * last, (atrValue ?? 0) * 0.5);
  const clusters: { prices: number[]; last: string }[] = [];
  for (const p of [...pts].sort((a, b) => a.price - b.price)) {
    const c = clusters[clusters.length - 1];
    if (c && p.price - mean(c.prices) <= tol) { c.prices.push(p.price); if (p.date > c.last) c.last = p.date; }
    else clusters.push({ prices: [p.price], last: p.date });
  }
  const all = clusters.map((c) => ({ price: r2(mean(c.prices)), touches: c.prices.length, lastTouched: c.last }));
  // A level within a sliver of the price is where it is now, not a level to bounce off.
  const gap = last * 0.005;
  return {
    support: all.filter((l) => l.price < last - gap).sort((a, b) => b.price - a.price).slice(0, 4),
    resistance: all.filter((l) => l.price > last + gap).sort((a, b) => a.price - b.price).slice(0, 4),
  };
}

export function analyze(bars: Bar[]): TA | null {
  if (bars.length < 30) return null;
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1];
  const s50 = sma(closes, 50), s200 = sma(closes, 200);
  const trend = s50 && s200 ? (last > s50 && s50 > s200 ? "uptrend" : last < s50 && s50 < s200 ? "downtrend" : "mixed") : s50 ? (last > s50 ? "uptrend" : "downtrend") : "mixed";
  const r = rsi(closes);
  const a = atr(bars);
  const hasVolume = bars.slice(-50).filter((b) => (b.volume ?? 0) > 0).length >= 40;
  let volumeVs50d: number | null = null, upDownVolume20d: number | null = null;
  if (hasVolume) {
    const v = bars.map((b) => b.volume ?? 0);
    volumeVs50d = Math.round((mean(v.slice(-5)) / mean(v.slice(-50))) * 100) / 100;
    let up = 0, down = 0;
    for (let i = bars.length - 20; i < bars.length; i++) { if (closes[i] > closes[i - 1]) up += v[i]; else if (closes[i] < closes[i - 1]) down += v[i]; }
    upDownVolume20d = down > 0 ? Math.round((up / down) * 100) / 100 : null;
  }
  return {
    last, asOf: bars[bars.length - 1].date, trend,
    sma50: s50 && r2(s50), sma200: s200 && r2(s200),
    rsi14: r, rsiLabel: r === null ? null : r >= 70 ? "overbought" : r <= 30 ? "oversold" : "neutral",
    atr14: a && r2(a), atrPct: a ? Math.round((a / last) * 10000) / 10000 : null,
    ...levels(bars, last, a),
    volumeVs50d, upDownVolume20d,
    hasRange: bars.slice(-20).every((b) => b.high != null && b.low != null), hasVolume,
  };
}

/**
 * Where a stop and target sit against the chart, for a trade in `direction` from `entry`.
 * Problems are reasons to reject; notes are for the record.
 */
export function checkLevels(ta: Pick<TA, "support" | "resistance" | "atr14">, t: { direction: "up" | "down"; entry: number; target: number; stop: number }): { problems: string[]; notes: string[]; realisticRewardRisk: number | null } {
  const problems: string[] = [], notes: string[] = [];
  const up = t.direction === "up";
  const floor = up ? ta.support : ta.resistance;     // what should hold if the idea is right
  const ceiling = up ? ta.resistance : ta.support;   // what is in the way of the target
  const risk = Math.abs(t.entry - t.stop);
  if (ta.atr14 && risk < ta.atr14) problems.push(`the stop is only $${risk.toFixed(2)} away, less than one normal day's range ($${ta.atr14.toFixed(2)}), so ordinary noise would trigger it`);
  const near = floor.find((l) => Math.abs(l.price / t.entry - 1) <= 0.25);
  if (near) {
    const beyond = up ? t.stop < near.price : t.stop > near.price;
    if (!beyond) problems.push(`the stop ($${t.stop}) sits ${up ? "above" : "below"} ${up ? "support" : "resistance"} at $${near.price}; a normal test of that level would trigger it`);
    else notes.push(`Stop is beyond ${up ? "support" : "resistance"} at $${near.price} (${near.touches} touch${near.touches > 1 ? "es" : ""}).`);
  } else notes.push(`No ${up ? "support" : "resistance"} level within 25% of the price; the stop rests on the thesis alone.`);
  let realisticRewardRisk: number | null = null;
  const block = ceiling.find((l) => (up ? l.price > t.entry && l.price < t.target : l.price < t.entry && l.price > t.target));
  if (block) {
    realisticRewardRisk = Math.abs(block.price - t.entry) / risk;
    notes.push(`${up ? "Resistance" : "Support"} at $${block.price} (${block.touches} touch${block.touches > 1 ? "es" : ""}) lies before the target; reward to that level is ${realisticRewardRisk.toFixed(1)}x the risk.`);
    if (realisticRewardRisk < 1) problems.push(`${up ? "resistance" : "support"} at $${block.price} is closer than the stop, so the first likely stall pays less than the risk`);
  }
  return { problems, notes, realisticRewardRisk };
}
