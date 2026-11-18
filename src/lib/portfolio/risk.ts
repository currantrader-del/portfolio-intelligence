/**
 * Layer 2: risk analytics from daily price history. Everything here is HYPOTHETICAL:
 * today's holdings held at past prices. It describes how the current mix has behaved,
 * not what the person actually earned.
 */
import type { History } from "@/lib/market/history";
import { isEtf, LOOKTHROUGH } from "@/lib/portfolio/classify";

export const RISK_VERSION = "risk@2";
const TD = 252;

export type Position = { symbol: string; quantity: number; value: number };
export type Point = { date: string; value: number };
export type HoldingRisk = { symbol: string; weight: number; vol: number | null; beta: number | null; betaQqq: number | null; betaSemis: number | null; ret: number | null; maxDrawdown: number | null; historyDays: number; partial: boolean };
export type Scenario = { key: string; name: string; basis: string; dollars: number; pct: number; lines: { symbol: string; move: number; dollars: number }[]; notShocked: { symbol: string; value: number }[] };
/** How the prices behind the history were built: total return (adjusted) or price only. */
export type PriceBasis = { adjusted: string[]; priceOnly: string[]; providers: string[]; mixed: boolean };
export type RiskReport = {
  asOf: string | null;
  start: string | null;
  series: Point[]; // hypothetical portfolio value
  benchmark: Point[]; // SPY scaled to the same starting value
  stats: { ret: number | null; benchRet: number | null; vol: number | null; benchVol: number | null; maxDrawdown: number | null; drawdownFrom: string | null; drawdownTo: string | null; beta: number | null; worstMonth: { ret: number; from: string; to: string } | null };
  holdings: HoldingRisk[];
  concentration: { top: { symbol: string; weight: number }[]; topFive: number; effectiveN: number; largest: { symbol: string; weight: number } | null };
  scenarios: Scenario[];
  missing: string[];
  partial: string[];
  priceBasis: PriceBasis;
  codeVersion: string;
};

/** Closes for every benchmark date, carried forward; before a symbol's first bar its first close is used. */
export function align(dates: string[], h: History | undefined): { closes: number[]; first: string | null } {
  if (!h?.bars.length) return { closes: [], first: null };
  const out: number[] = [];
  let j = 0;
  let last = h.bars[0].close;
  for (const d of dates) {
    while (j < h.bars.length && h.bars[j].date <= d) last = h.bars[j++].close;
    out.push(last);
  }
  return { closes: out, first: h.bars[0].date };
}

export const returns = (xs: number[]) => xs.slice(1).map((x, i) => (xs[i] ? x / xs[i] - 1 : 0));
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
export function stdev(xs: number[]): number | null {
  if (xs.length < 20) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
export function beta(r: number[], b: number[]): number | null {
  const n = Math.min(r.length, b.length);
  if (n < 20) return null;
  const rr = r.slice(-n), bb = b.slice(-n);
  const mr = mean(rr), mb = mean(bb);
  let cov = 0, vb = 0;
  for (let i = 0; i < n; i++) { cov += (rr[i] - mr) * (bb[i] - mb); vb += (bb[i] - mb) ** 2; }
  return vb ? cov / vb : null;
}
export function maxDrawdown(values: number[], dates: string[] = []): { dd: number; from: string | null; to: string | null } {
  let peak = values[0] ?? 0, pi = 0, dd = 0, from = 0, to = 0;
  values.forEach((v, i) => {
    if (v > peak) { peak = v; pi = i; }
    const d = peak ? v / peak - 1 : 0;
    if (d < dd) { dd = d; from = pi; to = i; }
  });
  return { dd, from: dates[from] ?? null, to: dates[to] ?? null };
}
export function worstWindow(values: number[], dates: string[], len = 21): { ret: number; from: string; to: string } | null {
  if (values.length <= len) return null;
  let worst: { ret: number; from: string; to: string } | null = null;
  for (let i = len; i < values.length; i++) {
    const r = values[i] / values[i - len] - 1;
    if (!worst || r < worst.ret) worst = { ret: r, from: dates[i - len], to: dates[i] };
  }
  return worst;
}

/** Which symbols are total-return (adjusted closes) and which are price only, and whether they mix. */
export function priceBasis(histories: Map<string, History>, symbols: string[]): PriceBasis {
  const adjusted: string[] = [], priceOnly: string[] = [], providers = new Set<string>();
  for (const s of new Set(symbols)) {
    const h = histories.get(s);
    if (!h) continue;
    providers.add(h.provider);
    (h.adjusted ? adjusted : priceOnly).push(s);
  }
  return { adjusted, priceOnly, providers: [...providers], mixed: adjusted.length > 0 && priceOnly.length > 0 };
}

const clampMove = (m: number) => Math.max(-0.95, Math.min(1, m));

export function buildRisk(args: { positions: Position[]; cash: number; investable: number; histories: Map<string, History>; exposures?: { symbol: string; total: number }[] }): RiskReport {
  const { positions, cash, investable, histories } = args;
  const spy = histories.get("SPY");
  const dates = spy?.bars.map((b) => b.date) ?? [];
  const missing: string[] = [];
  const partial: string[] = [];
  const aligned = new Map<string, number[]>();
  for (const p of positions) {
    const a = align(dates, histories.get(p.symbol));
    if (!a.closes.length) { missing.push(p.symbol); continue; }
    if (a.first && dates[0] && a.first > dates[0]) partial.push(p.symbol);
    aligned.set(p.symbol, a.closes);
  }
  const bench = (sym: string) => align(dates, histories.get(sym)).closes;
  const spyR = returns(bench("SPY"));
  const qqqR = returns(bench("QQQ"));
  const soxR = returns(bench("SOXX"));

  // Hypothetical value: today's share counts at each past close, cash flat. Missing symbols held at today's value.
  const flat = positions.filter((p) => !aligned.has(p.symbol)).reduce((s, p) => s + p.value, 0) + cash;
  const series: Point[] = dates.map((d, i) => ({ date: d, value: flat + positions.reduce((s, p) => s + (aligned.has(p.symbol) ? p.quantity * aligned.get(p.symbol)![i] : 0), 0) }));
  const vals = series.map((s) => s.value);
  const pr = returns(vals);
  const spyCl = bench("SPY");
  const benchmark = spyCl.length && vals.length ? spyCl.map((c, i) => ({ date: dates[i], value: (c / spyCl[0]) * vals[0] })) : [];
  const dd = maxDrawdown(vals, dates);
  const sd = stdev(pr);
  const bsd = stdev(spyR);

  const holdings: HoldingRisk[] = positions.map((p) => {
    const cl = aligned.get(p.symbol);
    const h = histories.get(p.symbol);
    if (!cl) return { symbol: p.symbol, weight: investable ? p.value / investable : 0, vol: null, beta: null, betaQqq: null, betaSemis: null, ret: null, maxDrawdown: null, historyDays: 0, partial: false };
    // Only use the part of the window where the symbol actually traded.
    const startIdx = Math.max(0, dates.findIndex((d) => d >= (h?.bars[0].date ?? "")));
    const own = cl.slice(startIdx);
    const r = returns(own);
    const cut = (x: number[]) => x.slice(startIdx);
    const v = stdev(r);
    return {
      symbol: p.symbol,
      weight: investable ? p.value / investable : 0,
      vol: v === null ? null : v * Math.sqrt(TD),
      beta: beta(r, cut(spyR)),
      betaQqq: beta(r, cut(qqqR)),
      betaSemis: beta(r, cut(soxR)),
      ret: own.length > 1 ? own[own.length - 1] / own[0] - 1 : null,
      maxDrawdown: own.length > 1 ? maxDrawdown(own).dd : null,
      historyDays: own.length,
      partial: startIdx > 0,
    };
  });

  // Concentration with ETF look-through when exposures are supplied.
  const w = (args.exposures?.length ? args.exposures.map((e) => ({ symbol: e.symbol, weight: e.total })) : holdings.map((h) => ({ symbol: h.symbol, weight: h.weight }))).sort((a, b) => b.weight - a.weight);
  const hw = holdings.map((h) => h.weight).filter((x) => x > 0);
  const hhi = hw.reduce((s, x) => s + x * x, 0);

  // A holding without a measured beta is not shocked with an assumed one; it is listed instead.
  const scenario = (key: string, name: string, basis: string, moveOf: (h: HoldingRisk) => number | null): Scenario => {
    const notShocked: { symbol: string; value: number }[] = [];
    const lines = holdings.flatMap((h) => {
      const p = positions.find((x) => x.symbol === h.symbol)!;
      const m = moveOf(h);
      if (m === null) { notShocked.push({ symbol: h.symbol, value: p.value }); return []; }
      const move = clampMove(m);
      return [{ symbol: h.symbol, move, dollars: p.value * move }];
    }).filter((l) => Math.abs(l.dollars) >= 0.5).sort((a, b) => a.dollars - b.dollars);
    const dollars = lines.reduce((s, l) => s + l.dollars, 0);
    const gap = notShocked.length ? ` Not included (no measured beta): ${notShocked.map((x) => x.symbol).join(", ")}.` : "";
    return { key, name, basis: basis + gap, dollars, pct: investable ? dollars / investable : 0, lines, notShocked };
  };
  const scenarios: Scenario[] = [
    scenario("spy20", "S&P 500 falls 20%", "Each holding moves by its measured beta to the S&P 500 (SPY) over the chosen range.", (h) => (h.beta === null ? null : h.beta * -0.2)),
    scenario("qqq30", "Nasdaq 100 falls 30%", "Each holding moves by its measured beta to the Nasdaq 100 (QQQ) over the chosen range.", (h) => (h.betaQqq === null ? null : h.betaQqq * -0.3)),
    scenario("semis35", "Semiconductors fall 35%", "Each holding moves by its measured beta to semiconductor stocks (SOXX). Beta is a rough guide for non-chip companies.", (h) => (h.betaSemis === null ? null : h.betaSemis * -0.35)),
  ];
  const largestStock = w.find((x) => !isEtf(x.symbol) && positions.some((p) => p.symbol === x.symbol));
  if (largestStock) {
    const s = largestStock.symbol;
    scenarios.push(scenario("single50", `${s} falls 50%`, `Only ${s} moves, plus its approximate weight inside your index ETFs. Everything else is unchanged.`, (h) => (h.symbol === s ? -0.5 : (LOOKTHROUGH[h.symbol]?.[s] ?? 0) * -0.5)));
  }
  const ww = worstWindow(vals, dates);
  if (ww) {
    scenarios.push({ key: "worstmonth", name: "Repeat of the worst 21 trading days in the range", basis: `Today's holdings lost ${(Math.abs(ww.ret) * 100).toFixed(1)}% from ${ww.from} to ${ww.to} at the prices of that time.${missing.length ? ` Held flat: ${missing.join(", ")}.` : ""}`, dollars: ww.ret * (vals[vals.length - 1] ?? 0), pct: investable ? (ww.ret * (vals[vals.length - 1] ?? 0)) / investable : 0, lines: [], notShocked: [] });
  }

  return {
    asOf: dates.at(-1) ?? null,
    start: dates[0] ?? null,
    series,
    benchmark,
    stats: {
      ret: vals.length > 1 ? vals[vals.length - 1] / vals[0] - 1 : null,
      benchRet: spyCl.length > 1 ? spyCl[spyCl.length - 1] / spyCl[0] - 1 : null,
      vol: sd === null ? null : sd * Math.sqrt(TD),
      benchVol: bsd === null ? null : bsd * Math.sqrt(TD),
      maxDrawdown: vals.length > 1 ? dd.dd : null,
      drawdownFrom: dd.from,
      drawdownTo: dd.to,
      beta: beta(pr, spyR),
      worstMonth: ww,
    },
    holdings,
    concentration: { top: w.slice(0, 5), topFive: w.slice(0, 5).reduce((s, x) => s + x.weight, 0), effectiveN: hhi ? 1 / hhi : 0, largest: w[0] ?? null },
    scenarios,
    missing,
    partial,
    priceBasis: priceBasis(histories, [...positions.map((p) => p.symbol), "SPY"]),
    codeVersion: RISK_VERSION,
  };
}

/** Change of each symbol over the last `sessions` closes (5 = one week). */
export function periodMoves(histories: Map<string, History>, symbols: string[], sessions: number): { symbol: string; from: string; to: string; change: number }[] {
  const out: { symbol: string; from: string; to: string; change: number }[] = [];
  for (const s of symbols) {
    const b = histories.get(s)?.bars ?? [];
    if (b.length <= sessions) continue;
    const a = b[b.length - 1 - sessions], z = b[b.length - 1];
    out.push({ symbol: s, from: a.date, to: z.date, change: z.close / a.close - 1 });
  }
  return out;
}

/** Hypothetical change of today's holdings over the last `sessions` closes, in dollars and percent of investable. */
export function holdingsPeriodChange(positions: Position[], histories: Map<string, History>, sessions: number, investable: number): { dollars: number; pct: number; covered: number } | null {
  let dollars = 0, covered = 0;
  for (const p of positions) {
    const b = histories.get(p.symbol)?.bars ?? [];
    if (b.length <= sessions) continue;
    const a = b[b.length - 1 - sessions].close, z = b[b.length - 1].close;
    dollars += p.quantity * (z - a);
    covered += p.value;
  }
  if (!covered) return null;
  return { dollars, pct: investable ? dollars / investable : 0, covered };
}
