import { unresolvedFiling } from "@/lib/research/status";
import { actionNow } from "./actionNow";
/**
 * Position review (the "material alert" workflow): add / hold / trim / exit with sizes,
 * policy limits and tax visibility. Deterministic; the AI may explain it but not change the numbers.
 */
import type { Workspace } from "@/lib/workspace";
import { scenarioReturnsAt, zoneFor } from "@/lib/research/valuation";
import { researchAgeDays } from "@/lib/research/records";
import type { FilingsResult } from "@/lib/market/sec";
import { assessVsAlternatives, refreshState, researchStance, riskFreeFor } from "@/lib/policy/evidence";
import { combinedWeight, levelState, levelsFor, roomTo, sellToReach, snapshotOf, weightAfterTrade, type Levels } from "./positionMath";

export const REVIEW_CODE_VERSION = "position-review@4";

/**
 * Every option is sized on combined exposure (direct + through funds) over the invested portfolio. Sale proceeds
 * stay as brokerage cash, so the denominator does not change and fund exposure remains after an exit.
 *   basis "research"      the size the research in use calls for
 *   basis "hypothetical"  a size shown for comparison only
 *   basis "blocked"       not supported now (the reason is in `note`)
 */
export type ReviewOption = { key: "add" | "hold" | "trim" | "trim_normal" | "exit"; label: string; dollars: number; weightAfter: number; tax: string; available: boolean; note: string; basis: "research" | "hypothetical" | "blocked" | "current" };

const usd0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

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

  // One snapshot for every option: direct + through funds over the invested portfolio.
  const snap = snapshotOf(p, symbol) ?? { symbol, direct: h.value, viaFunds: 0, invested: p.total };
  const combined = exp ? weight : combinedWeight(snap);
  const levels: Levels = levelsFor(ws.policy, symbol, v ? { allocation: v.parsed.allocation, asOf: v.research_as_of } : null);
  const state = levelState(combined, levels);
  const pc = (x: number) => `${(x * 100).toFixed(1)}%`;
  const viaNote = snap.viaFunds > 0.5 ? ` ${usd0(snap.viaFunds)} through funds stays, so it is ${pc(weightAfterTrade(snap, -snap.direct))} after.` : "";
  const proceedsNote = "Proceeds stay as brokerage cash.";

  // Room to add stops at the lower of the research level and the maximum; fund data gaps never create room.
  const addCap = levels.researchReview ? Math.min(levels.researchReview.value, max) : max;
  const addDollars = Math.max(0, Math.min(exp?.headroomDollars ?? 0, roomTo(snap, addCap)));
  const research = levels.researchReview && combined > levels.researchReview.value + 1e-9 ? sellToReach(snap, levels.researchReview.value) : null;
  const normalTop = levels.normal && combined > levels.normal.high + 1e-9 && (!levels.researchReview || levels.normal.high < levels.researchReview.value) ? sellToReach(snap, levels.normal.high) : null;
  const options: ReviewOption[] = [
    { key: "add", label: "Add", dollars: Math.round(addDollars), weightAfter: weightAfterTrade(snap, addDollars), tax: "No tax on a purchase", available: false, basis: "blocked",
      note: !hasLimit ? "No company limit of its own yet, so no room to add" : addDollars <= 1 ? `No room under ${pc(addCap)}` : `Not supported now. Room of ${usd0(addDollars)} to ${pc(addCap)} (${levels.researchReview && addCap < max ? "the research level" : "the maximum"}) is not a reason to add` },
    { key: "hold", label: "Hold", dollars: 0, weightAfter: combined, tax: "None", available: true, basis: "current", note: `Stay at ${pc(combined)} combined (${pc(snap.direct / (snap.invested || 1))} direct + ${pc(snap.viaFunds / (snap.invested || 1))} through funds)` },
    ...(research ? [{ key: "trim" as const, label: "Trim", dollars: Math.round(research.dollars), weightAfter: research.weightAfter, tax: taxText(research.dollars), available: research.dollars > 1, basis: "research" as const,
      note: `To ${pc(levels.researchReview!.value)} combined, the level the ${levels.researchReview!.source} says to trim back to. ${proceedsNote}${research.reachable ? "" : " Funds alone are above it, so even selling every share leaves it higher."}` }] : []),
    ...(normalTop ? [{ key: "trim_normal" as const, label: research ? "Trim more" : "Trim", dollars: Math.round(normalTop.dollars), weightAfter: normalTop.weightAfter, tax: taxText(normalTop.dollars), available: normalTop.dollars > 1, basis: "hypothetical" as const,
      note: `Hypothetical: to the ${pc(levels.normal!.high)} top of the normal range.${levels.researchReview ? " The research does not call for this." : ""} ${proceedsNote}${normalTop.reachable ? "" : " Funds alone are above it."}` }] : []),
    { key: "exit", label: "Exit", dollars: Math.round(snap.direct), weightAfter: weightAfterTrade(snap, -snap.direct), tax: taxText(snap.direct), available: true, basis: "hypothetical", note: `Hypothetical: sell every directly held share. ${proceedsNote}${viaNote}` },
  ];

  let suggestion: { key: ReviewOption["key"]; label: string; reason: string; confidence: number };
  const reasons: string[] = [];
  if (!v) {
    suggestion = { key: "hold", label: "Hold. Research first.", reason: r?.conflict ? "The stored research conflicts, so no sizing change is supported until a targeted refresh." : "There is no stored research to support adding or selling.", confidence: 3 };
  } else if (weight > max) {
    suggestion = { key: "hold", label: "Review. Don't add.", reason: `It is above its ${(max * 100).toFixed(0)}% maximum. Your policy treats that as a review trigger, not an automatic sale.`, confidence: 5 };
  } else if (research && research.dollars > 1) {
    suggestion = {
      key: "trim",
      label: "Trim to the research level, or hold until the next review",
      reason: `The ${levels.researchReview!.source} says to keep ${symbol} at or below ${pc(levels.researchReview!.value)} combined and trim back if it goes above. It is ${pc(combined)} now, so the research-backed size is about ${usd0(research.dollars)} of ${symbol} shares, which brings it to ${pc(research.weightAfter)} with the proceeds kept as cash. It stays under the ${pc(max)} maximum either way.${research.dollars < 250 ? " The amount is small, so holding until the next review is also consistent with the research." : ""}`,
      confidence: 5,
    };
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
    const add = options.find((o) => o.key === "add")!;
    add.available = true; add.basis = "research"; add.note = `Up to ${pc(addCap)} combined`;
  } else if (cmp && !favourable) {
    suggestion = { key: "hold", label: cmp.judgment === "unfavourable" ? "Hold. Don't add." : "Hold", reason: `${cmp.summary} Holding is not the same as selling: a trim needs its own reason (limit, thesis or a clearly worse outlook than VOO).`, confidence: 5 };
  } else {
    suggestion = { key: "hold", label: "Hold", reason: v.completeness !== "complete" ? "Research is partial, so it doesn't support a sizing change."
      : st?.status === "unverified" ? "SEC filings could not be checked, so the research can't be confirmed current. No change until it is."
      : !hasLimit ? "No company limit of its own, so no room to add." : !approvedLimit ? "Its limit is not one you approved, so no room to add." : "Nothing in the numbers calls for a change.", confidence: 5 };
  }

  // The one plain action at this price, with the research's price levels (same rule as the alerts and research page).
  const unread = (st?.status === "refresh" ? st.triggers.filter((t) => t.kind === "results" || t.kind === "financing" || t.kind === "material_event").map((t) => t.detail.replace(/^[^:]+: /, ""))[0] ?? null : null)
    ?? (filings === undefined && v && r ? unresolvedFiling(v.research_as_of, r.filingCheck) : null);
  const now = actionNow({
    symbol, price: h.price, held: true, unreadFiling: unread, preliminary: !!v && !r?.authoritative,
    research: v && r?.authoritative ? { pc: v.parsed, asOf: v.research_as_of, openQuestions: v.completeness === "complete" ? 0 : Math.max(1, ((v.conclusion as { completion?: { reasons?: unknown[] } })?.completion?.reasons ?? []).length) } : null,
    trim: research && research.dollars > 1 ? { dollars: research.dollars, toPct: levels.researchReview!.value * 100, why: `it is ${pc(combined)} combined, above the ${pc(levels.researchReview!.value)} the ${levels.researchReview!.source} says to trim back to (proceeds stay as cash).` } : weight > max ? null : null,
  });

  return {
    symbol,
    now,
    price: h.price,
    priceSource: h.priceSource,
    dayPct: h.dayPct,
    value: h.value,
    weight: combined,
    max,
    levels,
    levelState: state,
    snapshot: snap,
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
