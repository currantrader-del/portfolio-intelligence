/**
 * The saved Nov 8, 2026 IREN investigation (research version 13eea72b, run 137d7efb), copied from its final
 * checkpoint: valuation inputs and sources verbatim, findings and documents with their check status,
 * and the earlier versions' values. Used to validate the record without re-running it.
 */
import type { ScenarioSpec } from "../investigate/valuationCalc";
import type { PriorVersion, SavedValuation } from "../validate";

export const IREN_NOV8_SPECS: ScenarioSpec[] = [
  { name: "bear", probability: 0.37, method: "ev_ebitda", floor_value: 2,
    inputs: { revenue: 4500000000, multiple: 5, net_debt: 21000000000, ebitda_margin: 0.58, diluted_shares: 680000000 },
    sources: { revenue: "estimate: contracted >$4B ARR (F5) delivered late, little growth after; TTM $900M", multiple: "estimate: distressed lessor; below Cantor 6.5x (F38)", net_debt: "estimate: company net debt $4.43B (F10) plus build funded by debt (F8, F14) plus debt-like prepayments (F47)", ebitda_margin: "estimate: 86% AI Cloud gross margin (F3) less cash SG&A (F20) and SBC (F17)", diluted_shares: "estimate: 424.4M (D2) plus ATM at low prices (F35), RSUs (F26), more equity" },
    rationale: "Delivery slips into Q2 CY27 (F30), Microsoft pulls back (F48), equity funds the gap at about $20. Computed equity value is negative at 5x, so I floor at $2." },
  { name: "base", probability: 0.45, method: "ev_ebitda",
    inputs: { revenue: 7500000000, multiple: 7, net_debt: 22500000000, ebitda_margin: 0.62, diluted_shares: 620000000 },
    sources: { revenue: "estimate: contracted >$4B ARR plus about 3.5B from the 2027 build, partly late and financing-paced (F46); consensus FY28 about $7.4B is secondary and stale (F37)", multiple: "estimate: close to Cantor 6.5x (F38)", net_debt: "estimate: earlier $22B on smaller build, plus debt-like prepayments (deferred revenue $2.5B now, F47); revenue cut lowers build", ebitda_margin: "estimate: 65% before SBC in the earlier base, trimmed for part of SBC (F17)", diluted_shares: "estimate: 424.4M (D2) + about 106M ATM at $21.64 (F35) + 52M RSUs (F26, D2) + some extra equity for the gap" },
    rationale: "Contracted $4B+ ARR delivered by Feb-Apr 2027 plus roughly half to two-thirds of the 2027 expansion contracted at $17-22M/MW (F40) and funded without distress." },
  { name: "bull", probability: 0.18, method: "ev_ebitda",
    inputs: { revenue: 12500000000, multiple: 9, net_debt: 34000000000, ebitda_margin: 0.66, diluted_shares: 700000000 },
    sources: { revenue: "estimate: full 0.8GW by end-2027 at $20M+/MW plus further growth", multiple: "estimate: premium for owned power and IG backlog", net_debt: "estimate: capex of about $15B (F8) plus follow-on builds plus prepayments", ebitda_margin: "estimate: scale lowers SG&A and SBC share; AI Cloud 86% (F3)", diluted_shares: "estimate: more shares than before; converts (F22, F23) partly in the money, offset by capped calls" },
    rationale: "Microsoft accepts Horizon 2-4 and expands, new 5-year contracts at $22M/MW with 90% prepayment hold." },
];

export const IREN_NOV8_VALUATION: SavedValuation = {
  specs: IREN_NOV8_SPECS, horizon_date: "2029-06-30",
  result: { weighted_value: 18.38, annualized_return: -0.0599, scenarios: [{ name: "bear", value_per_share: 2 }, { name: "base", value_per_share: 16.21 }, { name: "bull", value_per_share: 57.5 }] },
};

export const IREN_NOV8_FINDINGS = [
  { id: "F1", key: false, check: { status: "verified" } },
  { id: "F2", key: false, check: { status: "verified" } },
  { id: "F3", key: true, check: { status: "verified" } },
  { id: "F4", key: false, check: { status: "verified" } },
  { id: "F5", key: true, check: { status: "verified" } },
  { id: "F6", key: false, check: { status: "verified" } },
  { id: "F7", key: false, check: { status: "verified" } },
  { id: "F8", key: true, check: { status: "verified" } },
  { id: "F9", key: false, check: { status: "verified" } },
  { id: "F10", key: true, check: { status: "verified" } },
  { id: "F11", key: false, check: { status: "verified" } },
  { id: "F12", key: false, check: { status: "verified" } },
  { id: "F13", key: false, check: { status: "verified" } },
  { id: "F14", key: true, check: { status: "verified" } },
  { id: "F15", key: false, check: { status: "verified" } },
  { id: "F16", key: false, check: { status: "verified" } },
  { id: "F17", key: true, check: { status: "verified" } },
  { id: "F18", key: false, check: { status: "verified" } },
  { id: "F19", key: false, check: { status: "verified" } },
  { id: "F20", key: true, check: { status: "verified" } },
  { id: "F21", key: false, check: { status: "verified" } },
  { id: "F22", key: true, check: { status: "verified" } },
  { id: "F23", key: true, check: { status: "verified" } },
  { id: "F24", key: false, check: { status: "verified" } },
  { id: "F25", key: false, check: { status: "verified" } },
  { id: "F26", key: true, check: { status: "verified" } },
  { id: "F27", key: false, check: { status: "verified" } },
  { id: "F28", key: false, check: { status: "estimate" } },
  { id: "F29", key: false, check: { status: "secondary_unverifiable" } },
  { id: "F30", key: true, check: { status: "verified" } },
  { id: "F31", key: false, check: { status: "verified" } },
  { id: "F32", key: false, check: { status: "verified" } },
  { id: "F33", key: true, check: { status: "verified" } },
  { id: "F34", key: false, check: { status: "secondary_unverifiable" } },
  { id: "F35", key: true, check: { status: "calculation" } },
  { id: "F36", key: false, check: { status: "secondary_unverifiable" } },
  { id: "F37", key: true, check: { status: "secondary_unverifiable" } },
  { id: "F38", key: true, check: { status: "secondary_unverifiable" } },
  { id: "F39", key: true, check: { status: "calculation" } },
  { id: "F40", key: true, check: { status: "verified" } },
  { id: "F41", key: true, check: { status: "quote_found_value_not_in_quote" } },
  { id: "F42", key: true, check: { status: "verified" } },
  { id: "F43", key: true, check: { status: "quote_not_found" } },
  { id: "F44", key: false, check: { status: "quote_found_value_not_in_quote" } },
  { id: "F45", key: true, check: { status: "verified" } },
  { id: "F46", key: true, check: { status: "verified" } },
  { id: "F47", key: true, check: { status: "verified" } },
  { id: "F48", key: true, check: { status: "secondary_unverifiable" } },
  { id: "F49", key: true, check: { status: "calculation" } }
];

export const IREN_NOV8_INVENTORY = [
  { id: "D1", status: "fully_reviewed", kind: "10-K", required: true, },
  { id: "D2", status: "fully_reviewed", kind: "10-Q", required: true, },
  { id: "D3", status: "fully_reviewed", kind: "earnings_release", required: true, },
  { id: "D4", status: "fully_reviewed", kind: "financing", required: true, },
  { id: "D5", status: "fully_reviewed", kind: "financing", required: true, },
  { id: "D6", status: "fully_reviewed", kind: "financing", required: true, },
  { id: "D7", status: "fully_reviewed", kind: "financing", required: true, },
  { id: "D8", status: "fully_reviewed", kind: "financing", required: true, },
  { id: "D9", status: "fully_reviewed", kind: "financing", required: true, },
  { id: "D10", status: "fully_reviewed", kind: "financing", required: true, },
  { id: "D11", status: "fully_reviewed", kind: "financing", required: true, },
  { id: "D12", status: "fully_reviewed", kind: "proxy", required: true, },
  { id: "D13", status: "fully_reviewed", kind: "material_8k", required: true, },
  { id: "D14", status: "fully_reviewed", kind: "material_8k", required: true, },
  { id: "D15", status: "fully_reviewed", kind: "material_8k", required: false, },
  { id: "D16", status: "fully_reviewed", kind: "material_8k", required: false, },
  { id: "D17", status: "fully_reviewed", kind: "material_8k", required: false, },
  { id: "D18", status: "fully_reviewed", kind: "material_8k", required: false, },
  { id: "D19", status: "fully_reviewed", kind: "transcript", required: true, title: "IREN Q1 FY27 earnings call transcript (Nov 5, 2026)", },
  { id: "D20", status: "fully_reviewed", kind: "presentation", required: true, },
  { id: "D21", status: "fully_reviewed", kind: "presentation", required: false, }
];

export const IREN_NOV8_REVIEWS = [
  { docId: "D1", qa: Array(0).fill({}) }, { docId: "D1", qa: Array(0).fill({}) }, { docId: "D1", qa: Array(0).fill({}) }, { docId: "D1", qa: Array(0).fill({}) }, { docId: "D1", qa: Array(0).fill({}) }, { docId: "D2", qa: Array(0).fill({}) }, { docId: "D1", qa: Array(0).fill({}) }, { docId: "D2", qa: Array(0).fill({}) }, { docId: "D1", qa: Array(0).fill({}) }, { docId: "D2", qa: Array(0).fill({}) }, { docId: "D2", qa: Array(0).fill({}) }, { docId: "D2", qa: Array(0).fill({}) }, { docId: "D2", qa: Array(0).fill({}) }, { docId: "D5", qa: Array(0).fill({}) }, { docId: "D2", qa: Array(0).fill({}) }, { docId: "D6", qa: Array(0).fill({}) }, { docId: "D3", qa: Array(0).fill({}) }, { docId: "D4", qa: Array(0).fill({}) }, { docId: "D9", qa: Array(0).fill({}) }, { docId: "D7", qa: Array(0).fill({}) }, { docId: "D8", qa: Array(0).fill({}) }, { docId: "D10", qa: Array(0).fill({}) }, { docId: "D13", qa: Array(0).fill({}) }, { docId: "D14", qa: Array(0).fill({}) }, { docId: "D20", qa: Array(0).fill({}) }, { docId: "D15", qa: Array(0).fill({}) }, { docId: "D11", qa: Array(0).fill({}) }, { docId: "D16", qa: Array(0).fill({}) }, { docId: "D17", qa: Array(0).fill({}) }, { docId: "D18", qa: Array(0).fill({}) }, { docId: "D19", qa: Array(8).fill({}) }, { docId: "D12", qa: Array(0).fill({}) }, { docId: "D1", qa: Array(0).fill({}) }, { docId: "D3", qa: Array(0).fill({}) }, { docId: "D19", qa: Array(8).fill({}) }, { docId: "D1", qa: Array(0).fill({}) }, { docId: "D1", qa: Array(0).fill({}) }, { docId: "D21", qa: Array(0).fill({}) }, { docId: "D19", qa: Array(8).fill({}) }, { docId: "D21", qa: Array(0).fill({}) }, { docId: "D2", qa: Array(0).fill({}) }
];

export const IREN_NOV8_LOG = [
  { step: "read", note: "Read 33 of 33 section parts in full. Problems: D12 full: The reader's notes were not readable (cut at the length limit); D21 full: The reader's notes were not readable (cut at the length limit)" },
  { step: "read", note: "Read 2 of 2 section parts in full. Problems: D21 full: The reader's notes were not readable (cut at the length limit)" },
];

/** September (imported ChatGPT research, FY2030 horizon, values only) and Nov 7 (one-minute screen, FY2030, inputs in its text). */
export const IREN_PRIOR: PriorVersion[] = [
  { label: "the September 10 research", bear: 14.6, base: 76.6, bull: 184.8, pBear: 0.4, pBase: 0.45, pBull: 0.15 },
  { label: "the November 7 screen", bear: 4, base: 33, bull: 80, pBear: 0.35, pBase: 0.45, pBull: 0.2, specs: [
    { name: "bear", probability: 0.35, method: "ev_ebitda", floor_value: 4, inputs: { revenue: 3e9, ebitda_margin: 0.5, multiple: 6, net_debt: 14e9, diluted_shares: 520e6 }, sources: {}, rationale: "" },
    { name: "base", probability: 0.45, method: "ev_ebitda", inputs: { revenue: 7e9, ebitda_margin: 0.6, multiple: 8, net_debt: 15e9, diluted_shares: 560e6 }, sources: {}, rationale: "" },
    { name: "bull", probability: 0.2, method: "ev_ebitda", inputs: { revenue: 12e9, ebitda_margin: 0.65, multiple: 9, net_debt: 22e9, diluted_shares: 600e6 }, sources: {}, rationale: "" },
  ] },
];
