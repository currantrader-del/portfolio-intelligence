/**
 * Position review (the "material alert" workflow): add / hold / trim / exit with sizes,
 * policy limits and tax visibility. Deterministic; the AI may explain it but not change the numbers.
 */
import type { Workspace } from "@/lib/workspace";
import { BIG_MOVE, DEFAULT_ASSUMPTIONS } from "./newCapital";
import { expectedReturnAt, repriceCheck, scenarioReturnsAt, zoneFor } from "@/lib/research/valuation";
import { researchAgeDays } from "@/lib/research/records";

export const REVIEW_CODE_VERSION = "position-review@1";

export type ReviewOption = { key: "add" | "hold" | "trim" | "exit"; label: string; dollars: number; weightAfter: number; tax: string; available: boolean; note: string };

export function reviewPosition(ws: Workspace, symbol: string) {
  const p = ws.portfolio;
  const h = p.holdings.find((x) => x.symbol === symbol);
  if (!h) return null;
  const r = ws.research.find((x) => x.symbol === symbol);
  const v = r?.current ?? null;
  const exp = p.exposures.find((e) => e.symbol === symbol);
  const lim = ws.policy?.companies[symbol];
  const max = exp?.max ?? 0.1;
  const weight = exp?.total ?? h.weight;
  const age = r ? researchAgeDays(r, ws.now) : null;
  const freshDays = ws.policy?.researchFreshnessDays ?? 120;
  const check = v ? repriceCheck(v.parsed, h.price, age, freshDays) : null;
  const er = v && check?.ok ? expectedReturnAt(v.parsed, h.price, ws.now) : null;
  const zone = v ? zoneFor(v.parsed.zones, h.price) : null;
  const hurdle = ws.policy?.audit?.assumptions.hurdle.value ?? ws.policy?.hurdleOverEtfPoints ?? DEFAULT_ASSUMPTIONS.hurdlePoints;
  const etf = ws.policy?.audit?.assumptions.etfExpectedReturn.value ?? DEFAULT_ASSUMPTIONS.etfExpectedReturn;

  // Taxable share of the position (retirement accounts carry no tax on sale).
  const taxable = p.accounts.filter((a) => a.role === "taxable_brokerage").map((a) => a.name);
  const inTaxable = h.accounts.some((a) => taxable.includes(a));
  const taxText = (sellDollars: number) => {
    if (!inTaxable) return "No tax: retirement account";
    if (h.costBasis === null || h.unrealized === null) return "Tax: unknown (cost basis missing)";
    const gain = (h.unrealized / h.value) * sellDollars;
    return gain >= 0 ? `Realizes about $${Math.round(gain).toLocaleString()} gain (rate depends on holding period)` : `Realizes about $${Math.round(-gain).toLocaleString()} loss, which can offset gains`;
  };

  const addDollars = Math.max(0, exp?.headroomDollars ?? 0);
  const trimTarget = lim?.normal?.low ?? null;
  const trimDollars = trimTarget !== null ? Math.max(0, h.value - trimTarget * p.total) : 0;
  const options: ReviewOption[] = [
    { key: "add", label: "Add", dollars: Math.round(addDollars), weightAfter: max, tax: "No tax on a purchase", available: addDollars > 1, note: addDollars > 1 ? `Up to your ${(max * 100).toFixed(0)}% maximum` : "At its maximum" },
    { key: "hold", label: "Hold", dollars: 0, weightAfter: weight, tax: "None", available: true, note: `Stay at ${(weight * 100).toFixed(1)}%` },
    { key: "trim", label: "Trim", dollars: Math.round(trimDollars), weightAfter: trimTarget ?? weight, tax: taxText(trimDollars), available: trimDollars > 1, note: trimTarget !== null ? `To the ${(trimTarget * 100).toFixed(0)}% low end of its normal range` : "No normal range in policy" },
    { key: "exit", label: "Exit", dollars: Math.round(h.value), weightAfter: 0, tax: taxText(h.value), available: true, note: "Sell the whole position" },
  ];

  let suggestion: { key: ReviewOption["key"]; label: string; reason: string; confidence: number };
  const reasons: string[] = [];
  if (!v) {
    suggestion = { key: "hold", label: "Hold. Research first.", reason: r?.conflict ? "The stored research conflicts, so no sizing change is supported until a targeted refresh." : "There is no stored research to support adding or selling.", confidence: 3 };
  } else if (weight > max) {
    suggestion = { key: "hold", label: "Review. Don't add.", reason: `It is above its ${(max * 100).toFixed(0)}% maximum. Your policy treats that as a review trigger, not an automatic sale.`, confidence: 5 };
  } else if (v.parsed.referencePrice && Math.abs(h.price / v.parsed.referencePrice - 1) > BIG_MOVE) {
    const move = h.price / v.parsed.referencePrice - 1;
    suggestion = {
      key: "hold",
      label: "Hold. Refresh the research first.",
      reason: `The price is ${Math.round(Math.abs(move) * 100)}% ${move < 0 ? "below" : "above"} the $${v.parsed.referencePrice} the research was set at. The old scenarios are not re-priced at this price: a move that large can change the probabilities, financing and cash-flow assumptions. A targeted update (what changed, and does it touch the thesis?) comes before sizing anything.`,
      confidence: 4,
    };
  } else if (er !== null && er >= etf + hurdle && addDollars > 1 && v.completeness === "complete" && (age ?? 0) <= freshDays) {
    reasons.push(`Expected return at $${h.price.toFixed(2)} is about ${(er * 100).toFixed(1)}% a year, above the ${((etf + hurdle) * 100).toFixed(0)}% bar.`);
    if (zone) reasons.push(`The price is in the research's "${zone.label}" band (${zone.action}).`);
    reasons.push("Before adding, check whether anything new (filings, financing, guidance) changes the scenarios. A lower price alone doesn't.");
    suggestion = { key: "add", label: "Consider adding, after a news check", reason: reasons.join(" "), confidence: /specul/i.test(v.parsed.classification ?? "") ? 5 : 6 };
  } else if (er !== null && er < etf) {
    suggestion = { key: "hold", label: "Hold. Don't add.", reason: `Expected return at today's price (${(er * 100).toFixed(1)}%) is below the ${(etf * 100).toFixed(0)}% ETF assumption.`, confidence: 5 };
  } else {
    suggestion = { key: "hold", label: "Hold", reason: v.completeness !== "complete" ? "Research is partial, so it doesn't support a sizing change." : "Nothing in the numbers calls for a change.", confidence: 5 };
  }

  return {
    symbol,
    price: h.price,
    priceSource: h.priceSource,
    dayPct: h.dayPct,
    value: h.value,
    weight,
    max,
    expectedReturn: er,
    scenarios: v && check?.ok ? scenarioReturnsAt(v.parsed, h.price, ws.now) : [],
    repriceNote: check?.reason ?? null,
    zone,
    researchVersionId: v?.id ?? null,
    researchAsOf: v?.research_as_of ?? null,
    researchAge: age,
    completeness: v?.completeness ?? null,
    thesis: v?.parsed.thesis ?? null,
    researchAction: v?.parsed.action ?? null,
    referencePrice: v?.parsed.referencePrice ?? null,
    options,
    suggestion,
  };
}
