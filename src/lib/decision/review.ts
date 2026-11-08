/**
 * Position review (the "material alert" workflow): add / hold / trim / exit with sizes,
 * policy limits and tax visibility. Deterministic; the AI may explain it but not change the numbers.
 */
import type { Workspace } from "@/lib/workspace";
import { scenarioReturnsAt, zoneFor } from "@/lib/research/valuation";
import { researchAgeDays } from "@/lib/research/records";
import type { FilingsResult } from "@/lib/market/sec";
import { assessVsAlternatives, refreshState, researchStance, riskFreeFor } from "@/lib/policy/evidence";

export const REVIEW_CODE_VERSION = "position-review@3";

export type ReviewOption = { key: "add" | "hold" | "trim" | "exit"; label: string; dollars: number; weightAfter: number; tax: string; available: boolean; note: string };

export function reviewPosition(ws: Workspace, symbol: string, filings?: FilingsResult | null) {
  const p = ws.portfolio;
  const h = p.holdings.find((x) => x.symbol === symbol);
  if (!h) return null;
  const r = ws.research.find((x) => x.symbol === symbol);
  const v = r?.current ?? null;
  const exp = p.exposures.find((e) => e.symbol === symbol);
  const lim = ws.policy?.companies[symbol];
  const max = exp?.max ?? 0.1;
  const hasLimit = exp?.hasLimit ?? false;
  const weight = exp?.total ?? h.weight;
  const age = r ? researchAgeDays(r, ws.now) : null;
  const st = v ? refreshState({ asOf: v.research_as_of, pc: v.parsed, price: h.price, filings: filings ?? null }) : null;
  const years = v?.parsed.horizonDate ? Math.max(0.25, (new Date(v.parsed.horizonDate).getTime() - ws.now.getTime()) / (365.25 * 864e5)) : 10;
  const cmp = v ? assessVsAlternatives(v.parsed, h.price, ws.now, {
    riskFree: riskFreeFor(years, ws.yields ?? { y2: null, y10: null }), weightNow: weight,
    limit: hasLimit ? { normalHigh: lim?.normal?.high ?? null, hcHigh: lim?.highConviction?.high ?? null, max } : null, completeness: v.completeness, confidence: v.parsed.confidence,
  }) : null;
  const favourable = cmp?.judgment === "favourable";
  const stance = v ? researchStance(v.parsed, h.price) : null;
  const approvedLimit = lim?.authority === "you";
  const er = st?.status === "refresh" ? null : cmp?.expected ?? null;
  const zone = v ? zoneFor(v.parsed.zones, h.price) : null;

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
    { key: "add", label: "Add", dollars: Math.round(addDollars), weightAfter: max, tax: "No tax on a purchase", available: hasLimit && addDollars > 1, note: !hasLimit ? "No company limit of its own yet, so no room to add" : addDollars > 1 ? `Up to your ${(max * 100).toFixed(0)}% maximum` : "At its maximum" },
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
  } else if (st?.status === "refresh") {
    suggestion = {
      key: "hold",
      label: "Hold. Refresh the research first.",
      reason: `Something has happened since the research (${st.triggers.filter((t) => t.kind !== "unverified").map((t) => t.detail).join("; ")}). The old scenarios are not relied on until a targeted update says whether it touches the thesis. A lower price alone is never a reason to add.`,
      confidence: 4,
    };
  } else if (stance?.kind === "conditional") {
    suggestion = { key: "hold", label: "Hold. Add only once the research's condition is met.", reason: `The research at this price says: ${stance.text}. Its condition (${stance.condition}) is not confirmed, so adding is not supported yet.${cmp ? ` ${cmp.summary}` : ""}`, confidence: 5 };
  } else if (stance && stance.kind !== "add" && stance.kind !== "trim") {
    suggestion = { key: "hold", label: "Hold. Don't add.", reason: `The completed research concludes: ${stance.text}.${cmp ? ` ${cmp.summary}` : ""}${favourable ? " The modeled return alone looks better, but the research's conclusion weighs uncertainty, downside and conditions the model leaves out, so it stands." : ""}`, confidence: 5 };
  } else if (cmp && favourable && hasLimit && approvedLimit && addDollars > 1 && v.completeness === "complete" && stance?.kind === "add" && st?.status === "current") {
    reasons.push(cmp.summary);
    if (zone) reasons.push(`The price is in the research's "${zone.label}" band (${zone.action}).`);
    suggestion = { key: "add", label: "Consider adding", reason: reasons.join(" "), confidence: /specul/i.test(v.parsed.classification ?? "") ? 5 : 6 };
  } else if (cmp && !favourable) {
    suggestion = { key: "hold", label: cmp.judgment === "unfavourable" ? "Hold. Don't add." : "Hold", reason: `${cmp.summary} Holding is not the same as selling: a trim needs its own reason (limit, thesis or a clearly worse outlook than VOO).`, confidence: 5 };
  } else {
    suggestion = { key: "hold", label: "Hold", reason: v.completeness !== "complete" ? "Research is partial, so it doesn't support a sizing change."
      : st?.status === "unverified" ? "SEC filings could not be checked, so the research can't be confirmed current. No change until it is."
      : !hasLimit ? "No company limit of its own, so no room to add." : !approvedLimit ? "Its limit is not one you approved, so no room to add." : "Nothing in the numbers calls for a change.", confidence: 5 };
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
    scenarios: v && st?.status !== "refresh" ? scenarioReturnsAt(v.parsed, h.price, ws.now) : [],
    repriceNote: st && st.status !== "current" ? st.triggers.map((t) => t.detail).join("; ") : null,
    comparison: cmp,
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
