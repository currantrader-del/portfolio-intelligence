/**
 * One calculation for a company's exposure and its limits, used by Decisions, the position review, Plan's
 * improvement proposal, Today and the assistant, so every page shows the same numbers.
 *
 * Exposure is always DIRECT + THROUGH FUNDS, divided by the INVESTED PORTFOLIO (holdings plus the cash inside
 * the investment accounts; savings are never in it). Selling shares of the company itself leaves the fund
 * exposure in place, so an exit is never 0% while a fund still holds the company.
 *
 * Levels, kept apart on purpose:
 *   normal         the policy's normal range: a guide, never a target to fill
 *   highConviction the policy's high-conviction range
 *   researchReview the level the research in use says to review or trim back to (its allocation max_pct)
 *   hardMax        the policy maximum: the portfolio limit
 * Pure: no database, no network.
 */
import type { Policy, Range } from "@/lib/policy/limits";
import { companyLimit } from "@/lib/policy/limits";

/** Where sale proceeds, or the money for a purchase, go or come from. */
export type Funding =
  /** Sale proceeds stay as cash in the brokerage; a purchase uses cash already there. The invested portfolio is unchanged. */
  | "brokerage_cash"
  /** A purchase paid with money moved in from savings (or a new deposit): the invested portfolio grows by the amount. */
  | "new_money"
  /** Sale proceeds are withdrawn from the investment accounts: the invested portfolio shrinks by the amount. */
  | "withdrawn";

export type PositionSnapshot = {
  symbol: string;
  /** Dollars held directly. */
  direct: number;
  /** Dollars held through funds (look-through). */
  viaFunds: number;
  /** Invested portfolio in dollars: the denominator. */
  invested: number;
};

export type Levels = {
  normal: Range;
  highConviction: Range;
  researchReview: { value: number; source: string } | null;
  hardMax: number | null;
  hasOwnLimit: boolean;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function combinedWeight(s: PositionSnapshot): number {
  return s.invested > 0 ? (s.direct + s.viaFunds) / s.invested : 0;
}

/**
 * Combined weight after a trade of `dollars` of the company's own shares (positive buys, negative sells).
 * A sale can never take more than the direct holding; fund exposure is unchanged by either.
 */
export function weightAfterTrade(s: PositionSnapshot, dollars: number, funding: Funding = "brokerage_cash"): number {
  const trade = dollars < 0 ? -Math.min(-dollars, s.direct) : dollars;
  const direct = s.direct + trade;
  let invested = s.invested;
  if (trade > 0 && funding === "new_money") invested += trade;
  if (trade < 0 && funding === "withdrawn") invested += trade;
  return invested > 0 ? (direct + s.viaFunds) / invested : 0;
}

/**
 * Dollars of the company's own shares to sell so the combined weight comes down to `target`, with proceeds kept
 * as brokerage cash. Capped at the direct holding: when funds alone are above the target, `reachable` is false.
 */
export function sellToReach(s: PositionSnapshot, target: number): { dollars: number; reachable: boolean; weightAfter: number } {
  const need = Math.max(0, s.direct + s.viaFunds - target * s.invested);
  const dollars = Math.min(need, s.direct);
  return { dollars: r2(dollars), reachable: need <= s.direct + 0.005, weightAfter: weightAfterTrade(s, -dollars) };
}

/** Dollars of the company's own shares that could be bought before the combined weight reaches `ceiling`. */
export function roomTo(s: PositionSnapshot, ceiling: number, funding: Funding = "brokerage_cash"): number {
  const cur = s.direct + s.viaFunds;
  if (funding === "new_money") return r2(Math.max(0, ceiling >= 1 ? Infinity : (ceiling * s.invested - cur) / (1 - ceiling)));
  return r2(Math.max(0, ceiling * s.invested - cur));
}

/** The review level the research in use sets for its own weight (its allocation's max_pct), when it gives one. */
export function researchReviewLevel(allocation: Record<string, unknown> | null | undefined, hardMax: number | null, source: string): Levels["researchReview"] {
  const raw = Number((allocation ?? {}).max_pct);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const v = raw / 100;
  // A research level above the policy maximum is not a review level: the maximum governs.
  if (hardMax !== null && v > hardMax + 1e-9) return null;
  return { value: v, source };
}

export function levelsFor(policy: Policy | null, symbol: string, research: { allocation: Record<string, unknown> | null; asOf: string } | null): Levels {
  const c = policy?.companies[symbol];
  const lim = companyLimit(policy, symbol);
  const hardMax = lim.hasLimit ? lim.monitorMax : policy?.portfolioCeiling ?? null;
  return {
    normal: c?.normal ?? null,
    highConviction: c?.highConviction ?? null,
    researchReview: research ? researchReviewLevel(research.allocation, hardMax, `research ${research.asOf}`) : null,
    hardMax,
    hasOwnLimit: lim.hasLimit,
  };
}

/** Where the position sits against its levels, in the order they matter. */
export function levelState(w: number, l: Levels): { key: "over_max" | "over_review" | "above_normal" | "within" | "below" | "no_range"; text: string } {
  const p = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;
  if (l.hardMax !== null && w > l.hardMax + 1e-9) return { key: "over_max", text: `Above the ${p(l.hardMax)} maximum` };
  if (l.researchReview && w > l.researchReview.value + 1e-9) return { key: "over_review", text: `Above the ${p(l.researchReview.value)} level the research says to trim back to, under the ${l.hardMax !== null ? p(l.hardMax) : "policy"} maximum` };
  if (l.normal && w > l.normal.high + 1e-9) return { key: "above_normal", text: `Above the ${p(l.normal.low)}–${p(l.normal.high)} normal range${l.hardMax !== null ? `, under the ${p(l.hardMax)} maximum` : ""}` };
  if (l.normal && w < l.normal.low - 1e-9) return { key: "below", text: `Below the ${p(l.normal.low)}–${p(l.normal.high)} normal range` };
  if (l.normal) return { key: "within", text: `Within the ${p(l.normal.low)}–${p(l.normal.high)} normal range` };
  return { key: "no_range", text: l.hardMax !== null ? `Under the ${p(l.hardMax)} maximum; no normal range set` : "No range set" };
}

/** A position's snapshot from the workspace's exposure rows (fractions of the invested portfolio). */
export function snapshotOf(p: { total: number; exposures: { symbol: string; direct: number; viaEtfs: number }[]; holdings: { symbol: string; value: number }[] }, symbol: string): PositionSnapshot | null {
  const e = p.exposures.find((x) => x.symbol === symbol);
  const h = p.holdings.find((x) => x.symbol === symbol);
  if (!e && !h) return null;
  const direct = h?.value ?? (e ? e.direct * p.total : 0);
  return { symbol, direct, viaFunds: e ? e.viaEtfs * p.total : 0, invested: p.total };
}
