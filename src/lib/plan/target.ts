/**
 * Your plan (2026-11-17: "a single plan"; corrected 2026-11-18 after Brendan's audit): the goal, where the whole
 * portfolio stands against your APPROVED policy, what the app's one decision engine says to do now, and the stocks
 * waiting for their research buy levels.
 *
 * What the plan no longer does (2026-11-18 audit):
 *  - no limits of its own: the 12% one-stock and 30% all-stocks caps and the 45/10/15/30 mix came from a written
 *    plan, not from approved policy, so every range and maximum here comes from the policy the app loads;
 *  - no dated trades or transfers: the Dec 1 / Jan 4 / Feb 1 schedule for the outside money is gone; outside money
 *    is available capital, compared by the Decisions engine, never a commitment;
 *  - no Schwab-only denominator: weights use the invested portfolio across every account (Acorns included), the
 *    same denominator as limits, Stocks & funds and Decisions; outside money never changes a weight.
 * Everything here is pure; nothing trades or moves money.
 */
import type { Bucket } from "@/lib/portfolio/classify";
import type { PortfolioView } from "@/lib/portfolio/engine";
import type { Policy } from "@/lib/policy/limits";
import type { ResearchRecord } from "@/lib/research/records";
import { zoneKind } from "@/lib/policy/zoneKind";

/** Which fund new money buys for each broad bucket. Not a target: the ranges come from policy. */
export type PlanFund = { bucket: Bucket; label: string; buy: string };
export type TargetPlan = {
  adopted: string;
  /** What the plan is for, in one or two sentences. */
  goal: string;
  funds: PlanFund[];
  routine: string[];
  docUrl?: string;
};

export const DEFAULT_PLAN: TargetPlan = {
  adopted: "2026-11-18",
  goal: "Beat the S&P 500 over the long run (10+ years) without one stock sinking you: low-cost funds as the core, individual stocks only when their research supports it, all inside the limits you approved.",
  funds: [
    { bucket: "US broad-market equity", label: "US market", buy: "VOO" },
    { bucket: "Small/mid-cap", label: "Small-cap value", buy: "AVUV" },
    { bucket: "International equity", label: "International", buy: "VXUS" },
  ],
  routine: [
    "Once a month: read the monthly briefing and this page. Act only on what \"What to do now\" lists.",
    "New money: Decisions compares adding to a stock, a new researched stock, a fund, or keeping cash. Outside money stays where it is unless that comparison says otherwise and you decide to move it.",
    "If a stock reaches its buy level, read its page before deciding. A drop alone is never a reason to buy, and being above a preferred size alone is never a forced sale.",
  ],
  docUrl: "https://claude.ai/artifact/HXjeATMTNyuQg1iNEnp5vw",
};

/** A saved plan row's outputs, checked; anything malformed falls back to the default. Older rows' steps and caps are ignored. */
export function planFrom(raw: unknown): TargetPlan {
  const o = raw as Partial<TargetPlan> | null;
  if (!o || typeof o !== "object") return DEFAULT_PLAN;
  return {
    ...DEFAULT_PLAN,
    ...(typeof o.goal === "string" && o.goal ? { goal: o.goal } : {}),
    ...(Array.isArray(o.funds) && o.funds.length ? { funds: o.funds } : {}),
    ...(Array.isArray(o.routine) && o.routine.length ? { routine: o.routine } : {}),
    ...(typeof o.docUrl === "string" ? { docUrl: o.docUrl } : {}),
  };
}

export type BucketStatus = { bucket: Bucket; label: string; buy: string | null; value: number; weight: number; normal: { low: number; high: number } | null; hardMax: number | null; approved: boolean; status: "below" | "within" | "above" | "over_max" | "no_limit" };
export type Waiting = { symbol: string; level: number; price: number; away: number; owned: boolean; action: string };
export type PlanStatus = {
  plan: TargetPlan;
  /** The invested portfolio across all accounts (holdings + cash inside them): the denominator for every weight. */
  base: number;
  /** Cash that can buy today, in the account that trades. */
  spendable: number; account: string | null;
  /** Outside money: available, not committed; shown apart, never in a weight. */
  outside: number;
  /** base + outside: everything you could invest. */
  potential: number;
  accounts: { name: string; value: number; asOf: string; ageDays: number }[];
  buckets: BucketStatus[];
  /** Securities only: price vs cost basis. Not total return (deposits, cash and dividends are not in it). */
  unrealized: { amount: number; known: number; unknown: number };
  /** Only APPROVED maximums that are exceeded: these are review triggers, not automatic sales. */
  warnings: string[];
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
const STOCK_BUCKETS: Bucket[] = ["Quality/growth individual stocks", "Asymmetric/high-risk growth sleeve"];

/** Pure: where the plan stands today, on the same numbers every other page uses. `prices` covers researched stocks you don't own. */
export function planStatus(plan: TargetPlan, p: PortfolioView, research: ResearchRecord[], prices: Map<string, number>, policy: Policy | null): PlanStatus {
  const base = r2(p.total);
  const outside = r2(p.cashDetail.outside.remaining);
  const approvedBucket = (b: Bucket) => (policy?.buckets ?? []).some((x) => x.bucket === b && (x.status ?? "approved") === "approved");
  const order: Bucket[] = [...plan.funds.map((f) => f.bucket), ...STOCK_BUCKETS];
  const buckets: BucketStatus[] = order.map((b) => {
    const row = p.buckets.find((x) => x.bucket === b);
    const fund = plan.funds.find((f) => f.bucket === b);
    return {
      bucket: b, label: fund?.label ?? (b === "Quality/growth individual stocks" ? "Quality stocks" : "Higher-risk stocks"), buy: fund?.buy ?? null,
      value: r2(row?.value ?? 0), weight: row?.weight ?? 0, normal: row?.normal ?? null, hardMax: row?.hardMax ?? null, approved: approvedBucket(b), status: row?.status ?? "no_limit",
    };
  });
  const known = p.holdings.filter((h) => h.unrealized !== null);
  const unrealized = { amount: r2(known.reduce((a, h) => a + (h.unrealized ?? 0), 0)), known: known.length, unknown: p.holdings.length - known.length };
  const pc = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;
  const warnings = [
    ...buckets.filter((b) => b.status === "over_max" && b.approved && b.hardMax !== null).map((b) => `${b.label} is ${pc(b.weight)}, above your approved ${pc(b.hardMax!)} maximum. That is a review, not an automatic sale: add nothing there until it is back under.`),
    ...p.exposures.filter((e) => e.hasLimit && policy?.companies[e.symbol]?.status === "approved" && e.total > e.max + 1e-9).map((e) => `${e.symbol} is ${pc(e.total)} including funds, above its approved ${pc(e.max)} maximum. Review it; it is not an automatic sale.`),
  ];
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
    plan, base, spendable: r2(p.cashDetail.spendableNow), account: p.cashDetail.investingAccount?.name ?? null, outside, potential: r2(base + outside),
    accounts: p.accounts.filter((a) => a.role !== "cash" && a.role !== "protected_savings").map((a) => ({ name: a.name, value: r2(a.value), asOf: a.asOf, ageDays: a.ageDays })),
    buckets, unrealized, warnings, waiting,
  };
}

/** Broad funds watched for big drops, beside the plan's own funds (2026-11-17: "funds that are low"). */
export const WATCH_FUNDS = ["VTI", "QQQ", "VUG", "VTV", "SCHD", "VEA", "VWO", "SMH"];
/** How far below the 52-week high counts as "down a lot". */
export const DROP = { planFund: -0.10, otherFund: -0.15, stock: -0.25 };

export type Low = { symbol: string; kind: "plan_fund" | "fund" | "stock" | "radar"; fromHigh: number; price: number; note: string };

/** Pure: funds and researched stocks well below their 52-week high, deepest drop first. */
export function lowsFrom(plan: TargetPlan, highs: Map<string, { price: number; high: number }>, researched: string[]): Low[] {
  const planFunds = new Set(plan.funds.map((s) => s.buy));
  const out: Low[] = [];
  for (const [symbol, { price, high }] of highs) {
    if (!(high > 0) || !(price > 0)) continue;
    const fromHigh = price / high - 1;
    const pct = `${Math.round(-fromHigh * 100)}%`;
    if (planFunds.has(symbol) && fromHigh <= DROP.planFund) out.push({ symbol, kind: "plan_fund", fromHigh, price, note: `${pct} below its high: worth a look in Decisions if you have new money; not a reason to change the plan` });
    else if (!planFunds.has(symbol) && WATCH_FUNDS.includes(symbol) && fromHigh <= DROP.otherFund) out.push({ symbol, kind: "fund", fromHigh, price, note: `${pct} below its high: run its ETF check before buying` });
    else if (researched.includes(symbol) && fromHigh <= DROP.stock) out.push({ symbol, kind: "stock", fromHigh, price, note: `${pct} below its high: check its research page; a drop alone is not a reason to buy` });
  }
  return out.sort((a, b) => a.fromHigh - b.fromHigh);
}

/**
 * A research action whose leading instruction is to buy or add. "Watch ... consider a starter below $X" is a watch,
 * not a buy (2026-11-18: CBRS showed as "no longer good" going from Watch to Watch).
 */
export function isBuyAction(action: string | null | undefined): boolean {
  return !!action && zoneKind(action) === "buy";
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
