/**
 * The out-of-sample check that decides whether recovery odds are shown at all.
 *
 * For many stocks and many past start dates, the odds are computed using ONLY the two years of prices before the
 * start date, then compared with what actually happened next. Predictions are grouped (0-10%, 10-20%, ...); in a
 * well-calibrated model, things given 30% happen about 30% of the time. The check passes when every group with
 * enough cases is within 8 points and the average gap is within 5 points. Each period (2 months ... 2 years) is also
 * checked on its own (2026-11-12): a period that passes is shown even when a longer one fails, which stays hidden.
 *
 * Limits, stated with the result: the stocks are today's large US companies (survivorship: the ones that
 * collapsed are missing, which flatters upside odds); five years of free daily data is one market regime; start
 * dates overlap, so the cases are not independent. Passing means the odds are honest about price behaviour,
 * not that they foresee anything about a company.
 */
import { HORIZONS, recoveryOdds, windowReturns, LOOKBACK_DAYS, type HorizonKey } from "./sim";

export const CALIBRATION_VERSION = "recovery-calibration@2";
export const MOVES = [-0.2, 0.1, 0.25, 0.5];
const STEP = 21;
const MIN_CASES = 40;
export const MAX_BUCKET_GAP = 0.08;
export const MAX_MEAN_GAP = 0.05;
/** A period needs at least this many past cases to be judged on its own. */
export const MIN_HORIZON_CASES = 200;

export type Bucket = { lo: number; hi: number; n: number; predicted: number; actual: number };
export type Calibration = {
  version: string; at: string; stocks: number; cases: number; passed: boolean;
  byKind: Record<"touch" | "close", { buckets: Bucket[]; meanGap: number; worstGap: number; brier: number }>;
  byHorizon: Record<string, { cases: number; meanGap: number; touch?: { meanGap: number; worstGap: number }; close?: { meanGap: number; worstGap: number }; passed?: boolean }>;
  /** Periods that pass the check on their own; only these are shown. Absent on checks before version 2. */
  horizonsPassed?: HorizonKey[];
  limits: string[];
};

type Case = { p: number; hit: boolean; horizon: HorizonKey };

export function calibrate(series: { symbol: string; closes: number[] }[], now = new Date(), paths = 300): Calibration {
  const touch: Case[] = [], close: Case[] = [];
  for (const s of series) {
    const c = s.closes;
    for (let start = LOOKBACK_DAYS + 1; start < c.length - HORIZONS[0].days; start += STEP) {
      const fits = HORIZONS.filter((h) => start + h.days < c.length);
      const price = c[start];
      const returns = windowReturns(c, start + 1);
      const targets = MOVES.map((m) => price * (1 + m));
      const odds = recoveryOdds({ price, returns, targets, horizons: fits, paths, seed: start * 31 + s.symbol.length });
      for (const o of odds) {
        const h = HORIZONS.find((x) => x.key === o.horizon)!;
        const future = c.slice(start + 1, start + 1 + h.days);
        const up = o.target >= price;
        const touched = up ? Math.max(...future) >= o.target : Math.min(...future) <= o.target;
        const last = future[future.length - 1];
        const closed = up ? last >= o.target : last <= o.target;
        touch.push({ p: o.touch, hit: touched, horizon: o.horizon });
        close.push({ p: o.closeAbove, hit: closed, horizon: o.horizon });
      }
    }
  }
  const summarize = (cases: Case[]) => {
    const buckets: Bucket[] = [];
    for (let i = 0; i < 10; i++) {
      const lo = i / 10, hi = (i + 1) / 10;
      const xs = cases.filter((x) => x.p >= lo && (i === 9 ? x.p <= hi : x.p < hi));
      if (!xs.length) continue;
      buckets.push({ lo, hi, n: xs.length, predicted: avg(xs.map((x) => x.p)), actual: avg(xs.map((x) => (x.hit ? 1 : 0))) });
    }
    const big = buckets.filter((b) => b.n >= MIN_CASES);
    const total = big.reduce((a, b) => a + b.n, 0) || 1;
    const meanGap = big.reduce((a, b) => a + Math.abs(b.predicted - b.actual) * b.n, 0) / total;
    const worstGap = big.reduce((a, b) => Math.max(a, Math.abs(b.predicted - b.actual)), 0);
    const brier = avg(cases.map((x) => (x.p - (x.hit ? 1 : 0)) ** 2));
    return { buckets, meanGap: r3(meanGap), worstGap: r3(worstGap), brier: r3(brier) };
  };
  const byKind = { touch: summarize(touch), close: summarize(close) };
  const byHorizon: Calibration["byHorizon"] = {};
  for (const h of HORIZONS) {
    const xs = touch.filter((x) => x.horizon === h.key), ys = close.filter((x) => x.horizon === h.key);
    if (!xs.length) continue;
    const t = summarize(xs), c = summarize(ys);
    const ok = xs.length >= MIN_HORIZON_CASES && [t, c].every((k) => k.meanGap <= MAX_MEAN_GAP && k.worstGap <= MAX_BUCKET_GAP);
    byHorizon[h.key] = { cases: xs.length, meanGap: t.meanGap, touch: { meanGap: t.meanGap, worstGap: t.worstGap }, close: { meanGap: c.meanGap, worstGap: c.worstGap }, passed: ok };
  }
  const passed = touch.length >= 500 && (["touch", "close"] as const).every((k) => byKind[k].meanGap <= MAX_MEAN_GAP && byKind[k].worstGap <= MAX_BUCKET_GAP);
  return {
    version: CALIBRATION_VERSION, at: now.toISOString(), stocks: series.length, cases: touch.length, passed, byKind, byHorizon,
    horizonsPassed: HORIZONS.filter((h) => byHorizon[h.key]?.passed).map((h) => h.key),
    limits: [
      "Stocks are today's large US companies, so ones that collapsed are missing (survivorship); this flatters upside odds.",
      "About five years of daily closes: one market regime.",
      "Start dates are a month apart and periods overlap, so cases are not independent.",
      "The odds use price behaviour only; they know nothing about results, valuation or news.",
    ],
  };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
