/**
 * Your plan (2026-11-17: "a single plan"): one target mix for the investing account plus your outside money,
 * dated steps to get there, and the stocks waiting for their research buy levels.
 *
 * The plan itself is data: the latest model_runs row of kind "target_plan" (outputs = TargetPlan), or the
 * plan agreed on 2026-11-17 when none is saved. Everything here is pure; nothing trades or moves money.
 */
import type { Bucket } from "@/lib/portfolio/classify";
import { isEtf } from "@/lib/portfolio/classify";
import type { PortfolioView } from "@/lib/portfolio/engine";
import type { ResearchRecord } from "@/lib/research/records";
import { zoneKind } from "@/lib/policy/zoneKind";

export type SleeveKey = "us" | "small" | "intl" | "stocks";
export type Sleeve = { key: SleeveKey; label: string; buy: string; target: number };
export type PlanStep = { date: string; text: string };
export type TargetPlan = {
  adopted: string;
  /** What the plan is for, in one or two sentences. */
  goal: string;
  sleeves: Sleeve[];
  /** Most in individual stocks, and in any one stock, as shares of the plan's money. */
  stocksMax: number; singleMax: number;
  steps: PlanStep[];
  routine: string[];
  docUrl?: string;
};

export const DEFAULT_PLAN: TargetPlan = {
  adopted: "2026-11-17",
  goal: "Beat the S&P 500 over the long run (10+ years) without one stock sinking you. Most money goes into low-cost funds every month; individual stocks only at their researched buy levels, at most 30% in all and 12% in any one.",
  sleeves: [
    { key: "us", label: "US market", buy: "VOO", target: 0.45 },
    { key: "small", label: "Small-cap value", buy: "AVUV", target: 0.10 },
    { key: "intl", label: "International", buy: "VXUS", target: 0.15 },
    { key: "stocks", label: "Stocks", buy: "at buy levels only", target: 0.30 },
  ],
  stocksMax: 0.30, singleMax: 0.12,
  steps: [
    { date: "2026-11-18", text: "Open NVDA after its results; trim about 7 shares only if its page says to, and put that money into VOO. Then buy about $700 VOO and $500 AVUV with the cash in Schwab." },
    { date: "2026-12-01", text: "Transfer $3,300 to Schwab. Buy $2,500 VOO and $400 AVUV; leave $400 as cash for stock buy levels." },
    { date: "2027-01-04", text: "Transfer $3,300 to Schwab. Buy $2,500 VOO and $400 AVUV; leave $400 as cash." },
    { date: "2027-02-01", text: "Transfer $3,400 to Schwab. Buy $2,500 VOO and $400 AVUV; leave $500 as cash." },
  ],
  routine: [
    "First business day of each month: put new money into the fund furthest below its target (usually VOO).",
    "If a stock reaches its buy level, read its page and decide on a $500-1,000 starter.",
    "Nothing else: no trades on headlines or a bad day.",
  ],
  docUrl: "https://claude.ai/artifact/HXjeATMTNyuQg1iNEnp5vw",
};

/** A saved plan row's outputs, checked; anything malformed falls back to the default. */
export function planFrom(raw: unknown): TargetPlan {
  const o = raw as Partial<TargetPlan> | null;
  if (!o || !Array.isArray(o.sleeves) || !o.sleeves.length || !Array.isArray(o.steps)) return DEFAULT_PLAN;
  const sum = o.sleeves.reduce((a, s) => a + (Number(s?.target) || 0), 0);
  if (Math.abs(sum - 1) > 0.02) return DEFAULT_PLAN;
  return { ...DEFAULT_PLAN, ...o } as TargetPlan;
}

const SLEEVE_OF: Partial<Record<Bucket, SleeveKey>> = {
  "US broad-market equity": "us",
  "Small/mid-cap": "small",
  "International equity": "intl",
  "Quality/growth individual stocks": "stocks",
  "Asymmetric/high-risk growth sleeve": "stocks",
};

export type SleeveStatus = Sleeve & { value: number; weight: number; targetValue: number; gap: number };
export type Waiting = { symbol: string; level: number; price: number; away: number; owned: boolean; action: string };
export type PlanStatus = {
  plan: TargetPlan;
  /** Investing account (holdings + cash) plus outside money still available. */
  base: number; account: string | null; cash: number; outside: number; other: number;
  sleeves: SleeveStatus[];
  stocksWeight: number; biggest: { symbol: string; weight: number } | null;
  warnings: string[];
  next: PlanStep | null; later: PlanStep[]; earlier: PlanStep[];
  waiting: Waiting[];
};

/** "starter below about $345", "add below ~$230", "below $70": the first buy level in a research action. */
export function buyLevelOf(action: string | null | undefined): number | null {
  if (!action) return null;
  const m = action.match(/(?:starter|add|adding|buy)[^.;]*?below\s+(?:about\s+|~\s*)?\$\s*(\d[\d,]*(?:\.\d+)?)/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Pure: where the plan stands today. `prices` covers researched stocks you don't own. */
export function planStatus(plan: TargetPlan, p: PortfolioView, research: ResearchRecord[], prices: Map<string, number>, today: string): PlanStatus {
  const acct = p.cashDetail.investingAccount;
  const id = acct?.id ?? null;
  const inAcct = (h: PortfolioView["holdings"][number]) => (id ? h.byAccount?.[id] ?? 0 : h.value);
  const cash = acct?.cash ?? 0;
  const outside = p.cashDetail.outside.remaining;
  const held = p.holdings.map((h) => ({ h, v: inAcct(h) })).filter((x) => x.v > 0.005);
  const base = r2(held.reduce((a, x) => a + x.v, 0) + cash + outside);
  const by = new Map<SleeveKey, number>();
  let other = 0;
  for (const { h, v } of held) {
    const k = SLEEVE_OF[h.bucket];
    if (k) by.set(k, (by.get(k) ?? 0) + v); else other += v;
  }
  const sleeves = plan.sleeves.map((s) => {
    const value = r2(by.get(s.key) ?? 0);
    const targetValue = r2(s.target * base);
    return { ...s, value, weight: base ? value / base : 0, targetValue, gap: r2(targetValue - value) };
  });
  const stocks = held.filter((x) => !isEtf(x.h.symbol) && SLEEVE_OF[x.h.bucket] === "stocks");
  const stocksWeight = base ? stocks.reduce((a, x) => a + x.v, 0) / base : 0;
  const top = stocks.sort((a, b) => b.v - a.v)[0];
  const biggest = top && base ? { symbol: top.h.symbol, weight: top.v / base } : null;
  const warnings = [
    ...(stocksWeight > plan.stocksMax ? [`Stocks are ${(stocksWeight * 100).toFixed(0)}% of your plan money, above the ${(plan.stocksMax * 100).toFixed(0)}% limit: new money goes to funds until they're back under.`] : []),
    ...(biggest && biggest.weight > plan.singleMax ? [`${biggest.symbol} is ${(biggest.weight * 100).toFixed(1)}%, above the ${(plan.singleMax * 100).toFixed(0)}% limit for one stock.`] : []),
  ];
  const steps = [...plan.steps].sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = steps.filter((s) => s.date >= today);
  const waiting: Waiting[] = [];
  for (const r of research) {
    const action = (r.current?.parsed as { action?: string } | null | undefined)?.action ?? null;
    const level = buyLevelOf(action);
    if (!level) continue;
    const owned = p.holdings.find((h) => h.symbol === r.symbol);
    const price = owned?.price ?? prices.get(r.symbol) ?? null;
    if (!price) continue;
    waiting.push({ symbol: r.symbol, level, price, away: price / level - 1, owned: !!owned, action: action! });
  }
  waiting.sort((a, b) => a.away - b.away);
  return {
    plan, base, account: acct?.name ?? null, cash: r2(cash), outside: r2(outside), other: r2(other),
    sleeves, stocksWeight, biggest, warnings,
    next: upcoming[0] ?? null, later: upcoming.slice(1), earlier: steps.filter((s) => s.date < today),
    waiting,
  };
}

/** Broad funds watched for big drops, beside the plan's own funds (2026-11-17: "funds that are low"). */
export const WATCH_FUNDS = ["VTI", "QQQ", "VUG", "VTV", "SCHD", "VEA", "VWO", "SMH"];
/** How far below the 52-week high counts as "down a lot". */
export const DROP = { planFund: -0.10, otherFund: -0.15, stock: -0.25 };

export type Low = { symbol: string; kind: "plan_fund" | "fund" | "stock" | "radar"; fromHigh: number; price: number; note: string };

/** Pure: funds and researched stocks well below their 52-week high, deepest drop first. */
export function lowsFrom(plan: TargetPlan, highs: Map<string, { price: number; high: number }>, researched: string[]): Low[] {
  const planFunds = new Set(plan.sleeves.map((s) => s.buy).filter((s) => /^[A-Z]{2,5}$/.test(s)));
  const out: Low[] = [];
  for (const [symbol, { price, high }] of highs) {
    if (!(high > 0) || !(price > 0)) continue;
    const fromHigh = price / high - 1;
    const pct = `${Math.round(-fromHigh * 100)}%`;
    if (planFunds.has(symbol) && fromHigh <= DROP.planFund) out.push({ symbol, kind: "plan_fund", fromHigh, price, note: `${pct} below its high: a reason to move a planned transfer forward, not to change the plan` });
    else if (!planFunds.has(symbol) && WATCH_FUNDS.includes(symbol) && fromHigh <= DROP.otherFund) out.push({ symbol, kind: "fund", fromHigh, price, note: `${pct} below its high: run its ETF check before buying` });
    else if (researched.includes(symbol) && fromHigh <= DROP.stock) out.push({ symbol, kind: "stock", fromHigh, price, note: `${pct} below its high: check its research page; a drop alone is not a reason to buy` });
  }
  return out.sort((a, b) => a.fromHigh - b.fromHigh);
}

/** A research action that says to buy: a buy level in its words, or a buy/add instruction first. */
export function isBuyAction(action: string | null | undefined): boolean {
  if (!action) return false;
  return buyLevelOf(action) !== null || zoneKind(action) === "buy";
}

export type Dropped = { symbol: string; since: string; was: string; now: string; kind: "research" | "passed" };
const firstSentence = (s: string, max = 160) => {
  const t = s.replace(/\s+/g, " ").trim();
  const m = t.match(/^(.+?[.;])(\s|$)/);
  const one = m ? m[1] : t;
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/**
 * Pure: ideas that are no longer good, newest first. A stock is listed when its research in use no longer says to
 * buy but the version before it did (with both actions, so the reason is the research's own words), or when you
 * moved it to Passed with a note. `versions` is newest first per symbol.
 */
export function noLongerGood(versions: Map<string, { asOf: string; action: string | null }[]>, passed: { symbol: string; note: string | null; at: string | null }[], sinceIso: string): Dropped[] {
  const out: Dropped[] = [];
  for (const [symbol, vs] of versions) {
    const [cur, prev] = vs;
    if (!cur || !prev || cur.asOf < sinceIso) continue;
    if (isBuyAction(prev.action) && !isBuyAction(cur.action)) out.push({ symbol, since: cur.asOf, was: firstSentence(prev.action ?? ""), now: firstSentence(cur.action ?? "No action written."), kind: "research" });
  }
  for (const p of passed) {
    if (out.some((o) => o.symbol === p.symbol) || (p.at && p.at < sinceIso)) continue;
    out.push({ symbol: p.symbol, since: p.at ?? "", was: "On your idea list", now: p.note ? firstSentence(p.note) : "Moved to Passed (no reason written).", kind: "passed" });
  }
  return out.sort((a, b) => b.since.localeCompare(a.since));
}
