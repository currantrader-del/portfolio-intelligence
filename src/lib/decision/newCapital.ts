/**
 * The new-capital decision ("I have $1,250, where should it go?").
 * Deterministic: ranks held, researched stocks by expected return at today's price against a broad ETF,
 * applies policy headroom, and always keeps "hold as cash" on the table.
 */
import type { PortfolioView } from "@/lib/portfolio/engine";
import { DEFAULT_ETF_FOR_BUCKET, type Bucket } from "@/lib/portfolio/classify";
import type { Policy } from "@/lib/policy/limits";
import type { ResearchRecord } from "@/lib/research/records";
import { researchAgeDays } from "@/lib/research/records";
import { expectedReturnAt, zoneFor } from "@/lib/research/valuation";

export const CODE_VERSION = "new-capital@1";

/** Assumptions the user can change later. Shown on screen whenever they are used. */
export const DEFAULT_ASSUMPTIONS = {
  etfExpectedReturn: 0.07, // long-run broad-equity estimate, nominal, before tax
  hurdlePoints: 0.03, // a stock must beat the ETF by this much to be preferred (policy has no hurdle yet)
  partialResearchShare: 0.5, // at most this share of new cash goes to a stock whose research is partial
};

export type Option = {
  kind: "stock" | "etf" | "cash";
  symbol: string;
  price: number | null;
  priceSource: "quote" | "statement" | null;
  expectedReturn: number | null;
  headroomDollars: number | null;
  weightNow: number | null;
  maxWeight: number | null;
  eligible: boolean;
  notes: string[];
  researchAction: string | null;
  zoneAction: string | null;
  refreshFirst?: boolean; // would qualify on the numbers, but the price has moved too far from the research
};

export type NewCapitalResult = {
  amount: number;
  asOf: string;
  options: Option[];
  recommendation: { allocations: { symbol: string; amount: number }[]; confidence: number; headline: string; rationale: string[]; wouldChange: string[] };
  assumptions: typeof DEFAULT_ASSUMPTIONS & { hurdleSource: "policy" | "default" };
  warnings: string[];
};

/** A move this large since the research reference price means the research needs a targeted refresh before it sizes anything. */
export const BIG_MOVE = 0.25;

const ETF_BUCKETS: Bucket[] = ["US broad-market equity", "International equity", "Small/mid-cap"];

export function newCapital(args: {
  amount: number;
  portfolio: PortfolioView;
  research: ResearchRecord[];
  policy: Policy | null;
  now: Date;
  assumptions?: Partial<typeof DEFAULT_ASSUMPTIONS>;
}): NewCapitalResult {
  const { amount, portfolio, research, policy, now } = args;
  const a = { ...DEFAULT_ASSUMPTIONS, ...args.assumptions };
  const hurdle = policy?.hurdleOverEtfPoints ?? a.hurdlePoints;
  const freshDays = policy?.researchFreshnessDays ?? 120;
  const postTotal = portfolio.total + amount;
  const warnings: string[] = [];

  const stale = portfolio.oldestHoldingsAsOf ? (now.getTime() - new Date(portfolio.oldestHoldingsAsOf).getTime()) / 86_400_000 : null;
  if (stale !== null && stale > 3) warnings.push(`Holdings come from statements up to ${Math.floor(stale)} days old. Anything bought since then is not counted.`);
  if (portfolio.pricedLive < portfolio.holdings.length) warnings.push("Some prices are from statements, not live quotes.");

  // Stock options: every held single stock, researched or not.
  const stockOptions: Option[] = portfolio.exposures.map((e) => {
    const h = portfolio.holdings.find((x) => x.symbol === e.symbol)!;
    const r = research.find((x) => x.symbol === e.symbol);
    const notes: string[] = [];
    let er: number | null = null;
    let eligible = true;
    let zoneAction: string | null = null;
    let refreshFirst = false;
    const v = r?.current;
    if (!r || (!v && !r.conflict)) { notes.push("No stored research"); eligible = false; }
    else if (r.conflict) { notes.push("Research records conflict; needs a targeted refresh first"); eligible = false; }
    else if (v) {
      er = expectedReturnAt(v.parsed, h.price, now);
      if (er === null) { notes.push("Research has no scenario valuation to re-price"); eligible = false; }
      if (v.completeness !== "complete") notes.push(`Research is ${v.completeness}; position capped at ${Math.round(a.partialResearchShare * 100)}% of new cash`);
      const age = researchAgeDays(r, now);
      if (age !== null && age > freshDays) { notes.push(`Research is ${age} days old (limit ${freshDays})`); eligible = false; }
      zoneAction = zoneFor(v.parsed.zones, h.price)?.action ?? null;
    }
    // New cash fills a position only up to the top of its normal range. Going higher needs the policy's
    // high-conviction conditions, which is a separate, explicit decision.
    const normalHigh = policy?.companies[e.symbol]?.normal?.high ?? null;
    const ceiling = Math.min(e.max, normalHigh ?? e.max);
    const maxDollars = ceiling * postTotal - e.total * portfolio.total;
    const headroom = Math.max(0, Math.round(maxDollars * 100) / 100);
    if (headroom <= 0) {
      notes.push(ceiling < e.max ? `At the top of its normal range (${pct(ceiling)}); higher needs a high-conviction decision` : `At or above its ${pct(e.max)} maximum (including ETF look-through)`);
      eligible = false;
    } else if (ceiling < e.max) notes.push(`New cash fills it only to the top of its normal range, ${pct(ceiling)}`);
    const ref = v?.parsed.referencePrice ?? null;
    if (ref && h.price < ref * (1 - BIG_MOVE)) {
      notes.push(`Price is ${Math.round((1 - h.price / ref) * 100)}% below the research reference. Refresh the research first: a drop this large may mean the scenarios no longer hold`);
      eligible = false;
      refreshFirst = true;
    } else if (ref && h.price > ref * (1 + BIG_MOVE)) {
      notes.push(`Price is ${Math.round((h.price / ref - 1) * 100)}% above the research reference; the scenarios may be out of date`);
    }
    if (er !== null && er < a.etfExpectedReturn + hurdle) { notes.push(`Expected return does not clear the ETF + ${pct(hurdle)} hurdle`); eligible = false; }
    return {
      kind: "stock", symbol: e.symbol, price: h.price, priceSource: h.priceSource, expectedReturn: er, headroomDollars: headroom,
      weightNow: e.total, maxWeight: ceiling, eligible, notes, researchAction: v?.parsed.action ?? null, zoneAction, refreshFirst,
    };
  });

  // ETF option: the most underweight core bucket.
  const ranked = portfolio.buckets
    .filter((b) => ETF_BUCKETS.includes(b.bucket))
    .map((b) => ({ b, gap: (b.normal ? (b.normal.low + b.normal.high) / 2 : 0) - b.weight }))
    .sort((x, y) => y.gap - x.gap);
  const etfBucket = ranked[0]?.b.bucket ?? "US broad-market equity";
  const etfSymbol = DEFAULT_ETF_FOR_BUCKET[etfBucket] ?? "VOO";
  const etfHolding = portfolio.holdings.find((h) => h.symbol === etfSymbol);
  const etfRow = portfolio.buckets.find((b) => b.bucket === etfBucket);
  const etf: Option = {
    kind: "etf", symbol: etfSymbol, price: etfHolding?.price ?? null, priceSource: etfHolding?.priceSource ?? null,
    expectedReturn: a.etfExpectedReturn, headroomDollars: null, weightNow: etfRow?.weight ?? null, maxWeight: etfRow?.hardMax ?? null, eligible: true,
    notes: [`${etfBucket} is ${etfRow ? pct(etfRow.weight) : "0%"} of the portfolio${etfRow?.normal ? `, normal range ${pct(etfRow.normal.low)}–${pct(etfRow.normal.high)}` : ""}`, `Expected return is an assumption (${pct(a.etfExpectedReturn)}), not a forecast`],
    researchAction: null, zoneAction: null,
  };
  const cash: Option = {
    kind: "cash", symbol: "CASH", price: null, priceSource: null, expectedReturn: null, headroomDollars: null, weightNow: portfolio.total ? portfolio.cash / portfolio.total : 0,
    maxWeight: null, eligible: true, notes: ["Policy: new cash does not have to be invested immediately", `The $${(policy?.protectedSavingsFloor ?? 10000).toLocaleString()} protected savings floor is excluded from sizing`],
    researchAction: null, zoneAction: null,
  };

  const eligible = stockOptions.filter((o) => o.eligible).sort((x, y) => (y.expectedReturn ?? 0) - (x.expectedReturn ?? 0));
  const allocations: { symbol: string; amount: number }[] = [];
  const rationale: string[] = [];
  const wouldChange: string[] = [];
  let remaining = amount;
  let confidence = 6;

  const top = eligible[0];
  for (const cand of eligible) {
    if (remaining < 1) break;
    const r = research.find((x) => x.symbol === cand.symbol)!;
    const partial = r.current?.completeness !== "complete";
    const cap = partial ? amount * a.partialResearchShare : amount;
    const toStock = Math.floor(Math.min(cap, cand.headroomDollars ?? 0, remaining));
    if (toStock <= 0) continue;
    const limitedByRoom = (cand.headroomDollars ?? 0) < Math.min(cap, remaining);
    allocations.push({ symbol: cand.symbol, amount: toStock });
    remaining -= toStock;
    rationale.push(`${cand.symbol}: about ${pct(cand.expectedReturn!)} a year expected at today's price, against ${pct(a.etfExpectedReturn)} assumed for ${etfSymbol}. $${toStock.toLocaleString()}${limitedByRoom ? ` fills it to its ${pct(cand.maxWeight ?? 0)} ceiling` : ""}.`);
    if (cand.researchAction && /no add/i.test(cand.researchAction)) rationale.push(`${cand.symbol}'s research said "${cand.researchAction}" at $${r.current?.parsed.referencePrice ?? "?"}; the lower price is what changes the answer.`);
    if (cand.zoneAction) rationale.push(`${cand.symbol} is in the research's "${cand.zoneAction}" band. Bands are prompts to research, never automatic trades.`);
    if (partial) { confidence -= 1; rationale.push(`${cand.symbol}'s research is partial, so it gets at most ${Math.round(a.partialResearchShare * 100)}% of the new cash.`); }
    if (/specul|asymmetric/i.test(r.current?.parsed.classification ?? "")) confidence -= 1;
    wouldChange.push(`${cand.symbol} rising until its expected return is below ${pct(a.etfExpectedReturn + hurdle)}, or new evidence against its thesis.`);
  }
  if (remaining > 0) {
    allocations.push({ symbol: etfSymbol, amount: Math.round(remaining * 100) / 100 });
    rationale.push(top
      ? `The rest goes to ${etfSymbol}, the most underweight core bucket (${etfBucket}).`
      : `No stock qualifies right now, so the simple choice wins: ${etfSymbol} for the most underweight core bucket (${etfBucket}).`);
  }
  const pending = stockOptions.filter((o) => o.refreshFirst && o.expectedReturn !== null && o.expectedReturn >= a.etfExpectedReturn + hurdle && (o.headroomDollars ?? 0) > 0);
  if (pending.length) {
    rationale.push(`${pending.map((o) => `${o.symbol} (about ${pct(o.expectedReturn!)} a year if its research still holds)`).join(" and ")} would qualify on the numbers, but ${pending.length > 1 ? "their prices have" : "its price has"} fallen so far since the research that ${pending.length > 1 ? "they need" : "it needs"} a targeted refresh first.`);
    wouldChange.unshift(`A targeted research refresh on ${pending.map((o) => o.symbol).join(" and ")} that confirms the thesis. That could move part of this cash there.`);
    confidence -= 1;
  }
  if (warnings.length) confidence -= 1;
  const noResearch = stockOptions.filter((o) => !o.eligible && !o.refreshFirst && o.expectedReturn === null).map((o) => o.symbol);
  if (noResearch.length) wouldChange.push(`Research on ${noResearch.join(", ")} (missing or conflicting today) could add candidates.`);

  const headline = allocations.map((x) => `$${x.amount.toLocaleString()} ${x.symbol}`).join(" + ");
  return {
    amount,
    asOf: now.toISOString(),
    options: [...stockOptions.sort((x, y) => (y.expectedReturn ?? -1) - (x.expectedReturn ?? -1)), etf, cash],
    recommendation: { allocations, confidence: Math.max(2, Math.min(10, confidence)), headline, rationale, wouldChange },
    assumptions: { ...a, hurdlePoints: hurdle, hurdleSource: policy?.hurdleOverEtfPoints != null ? "policy" : "default" },
    warnings,
  };
}

export function pct(n: number, digits = 1) {
  return `${(n * 100).toFixed(digits)}%`;
}
