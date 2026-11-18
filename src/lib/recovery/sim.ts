/**
 * Recovery odds: how likely a stock is to reach a price within a period, from its own price behaviour.
 *
 * Method (code only, no AI):
 *  - Take the stock's daily log returns over the last two years, remove their average (so a past rally or slump
 *    is not projected forward) and add a market-like drift (VOO's mid forecast). What remains is the stock's own
 *    volatility, fat tails and calm/stormy spells.
 *  - Resample those returns in 20-day blocks (a block bootstrap keeps volatility clustering) to build many paths.
 *  - "Touch" = at least one daily close at or above the price within the period; "close above" = the close on the
 *    last day of the period is at or above it. Touching is always at least as likely as closing above.
 * The odds describe price behaviour only. They know nothing about the business, results or valuation; the
 * research answers those. They are shown only while the out-of-sample calibration check passes (calibrate.ts).
 */

export const TRADING_DAYS = 252;
export const HORIZONS = [
  { key: "2m", label: "2 months", days: 42 },
  { key: "6m", label: "6 months", days: 126 },
  { key: "1y", label: "1 year", days: 252 },
  { key: "2y", label: "2 years", days: 504 },
] as const;
export type HorizonKey = (typeof HORIZONS)[number]["key"];

/** A market-like annual drift: the middle of VOO's published 10-year forecasts (about 4.8%-7.5%). */
export const MARKET_DRIFT = 0.06;
export const LOOKBACK_DAYS = 504;
const BLOCK = 20;

/** Small, fast, seeded random numbers, so the same inputs always give the same odds. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) if (closes[i] > 0 && closes[i - 1] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}

/** Demeaned returns plus the market-like drift, per day. */
export function centred(returns: number[], drift = MARKET_DRIFT): number[] {
  const n = returns.length;
  if (!n) return [];
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  // Log drift that gives `drift` a year in expected (arithmetic) terms.
  const mu = Math.log(1 + drift) / TRADING_DAYS - variance / 2;
  return returns.map((r) => r - mean + mu);
}

export type Odds = { target: number; horizon: HorizonKey; touch: number; closeAbove: number };

/**
 * Odds of reaching each target (prices above or below today) within each horizon. For a target below today,
 * "touch" and "close above" read as "falls to" and "closes at or below".
 */
export function recoveryOdds(args: { price: number; returns: number[]; targets: number[]; horizons?: readonly { key: HorizonKey; days: number }[]; paths?: number; seed?: number }): Odds[] {
  const horizons = args.horizons ?? HORIZONS;
  const r = args.returns;
  if (r.length < BLOCK * 3 || !(args.price > 0) || !args.targets.length) return [];
  const paths = args.paths ?? 4000;
  const maxDays = Math.max(...horizons.map((h) => h.days));
  const rand = rng(args.seed ?? 1);
  const logTargets = args.targets.map((t) => Math.log(t / args.price));
  // counts[target][horizon]
  const touch = logTargets.map(() => horizons.map(() => 0));
  const close = logTargets.map(() => horizons.map(() => 0));
  const ends = horizons.map((h) => h.days);
  for (let p = 0; p < paths; p++) {
    let x = 0, day = 0;
    let hi = -Infinity, lo = Infinity;
    let hIdx = 0;
    while (day < maxDays) {
      const start = Math.floor(rand() * (r.length - BLOCK));
      for (let k = 0; k < BLOCK && day < maxDays; k++, day++) {
        x += r[start + k];
        if (x > hi) hi = x;
        if (x < lo) lo = x;
        while (hIdx < ends.length && day + 1 === ends[hIdx]) {
          for (let t = 0; t < logTargets.length; t++) {
            const up = logTargets[t] >= 0;
            if (up ? hi >= logTargets[t] : lo <= logTargets[t]) touch[t][hIdx]++;
            if (up ? x >= logTargets[t] : x <= logTargets[t]) close[t][hIdx]++;
          }
          hIdx++;
        }
      }
    }
  }
  const out: Odds[] = [];
  args.targets.forEach((target, t) => horizons.forEach((h, i) => out.push({ target, horizon: h.key, touch: touch[t][i] / paths, closeAbove: close[t][i] / paths })));
  return out;
}

/** The two-year return window ending at `end` (exclusive), from adjusted closes. */
export function windowReturns(closes: number[], end: number, lookback = LOOKBACK_DAYS): number[] {
  return centred(logReturns(closes.slice(Math.max(0, end - lookback - 1), end)));
}
