/**
 * Exposure limits: proposals for the owner's approval, and monitoring of the approved ones.
 *
 * Limits are stored as ordinary policy rules (scope "portfolio", subject "exposure:<dimension>:<key>")
 * so they go through the same approve / reject flow as every other rule. A proposal controls nothing:
 * only an approved rule is monitored as policy. Each rule has three different numbers:
 *   normal range  - where the exposure is expected to sit; outside it is information, not an instruction;
 *   review        - above this, the app asks for a deliberate decision (keep, trim, or stop adding);
 *   ceiling       - the most the policy allows; new money must not push the exposure above it.
 * Being under a limit is never a reason to buy, and being above the normal range is never by itself a
 * reason to sell.
 *
 * Only exposures that are material for this portfolio get a proposal. Exposures already governed by an
 * approved rule (international equity, the high-risk sleeve, single companies) are not duplicated.
 */
import type { PolicyRuleRow } from "@/lib/policy/rules";
import type { DimensionKey, ExposureReport } from "./engine";
import { BENCHMARK } from "./reference";

export type EvidenceClass = "evidence-based" | "benchmark-anchored" | "risk-management judgment" | "your preference";
export type ExposureLimitProposal = {
  subject: string; // exposure:<dimension>:<key>
  dimension: DimensionKey;
  key: string;
  label: string;
  normal: { low: number; high: number } | null;
  review: number;
  ceiling: number;
  evidence: { review: EvidenceClass; ceiling: EvidenceClass; normal: EvidenceClass | null };
  why: string;
  /** One sentence shown on the Policy decision card. */
  short: string;
  sources: { label: string; url: string; date: string }[];
};

export const PROPOSAL_DATE = "2026-11-08";
export const PROPOSAL_LABEL = "Exposure limits proposal (app research, for your approval)";

const N1A = { label: "SEC Form N-1A, Item 9(b)(1) Instruction 4: a fund 'concentrates' when it invests more than 25% of net assets in one industry", url: "https://www.sec.gov/about/forms/formn-1a.pdf", date: "2023-12-11" };
const ACWI = { label: `${BENCHMARK.source.label}`, url: BENCHMARK.source.url, date: BENCHMARK.source.asOf };
const FINRA = { label: "FINRA, Concentrate on Concentration Risk (qualitative guidance, no numeric limit)", url: "https://www.finra.org/investors/insights/concentration-risk", date: "2022-06-15" };
const NASDAQ = { label: "Nasdaq-100 calendar returns (2022: -32.97%) and Nasdaq Composite 2000-2002 decline (-78%), Wikipedia", url: "https://en.wikipedia.org/wiki/Nasdaq-100", date: "2026-11-08" };
const SPDJI = { label: "S&P Dow Jones Indices, S&P 500 brochure: emerging markets about 10% of global equity value (EM ex-China 7%, China 3%, June 2025)", url: "https://www.spglobal.com/spdji/en/documents/additional-material/sp-500-brochure.pdf", date: "2025-06-30" };

/** The proposals, written down so every number has a stated basis. Percentages are of the invested portfolio. */
export const PROPOSALS: ExposureLimitProposal[] = [
  {
    subject: "exposure:industry:Semiconductors & Semiconductor Equipment", dimension: "industry", key: "Semiconductors & Semiconductor Equipment", label: "Semiconductors (direct + through funds)",
    normal: null, review: 0.25, ceiling: 0.35,
    evidence: { review: "evidence-based", ceiling: "risk-management judgment", normal: null },
    why: "25% in one industry is the SEC's definition of a concentrated fund, so above it the portfolio behaves like a sector fund and deserves a deliberate decision. The 35% ceiling is a judgment: technology-heavy markets have fallen 33% in a single year (Nasdaq-100, 2022) and 78% peak to trough (Nasdaq Composite, 2000-2002), and chip stocks usually fall harder than the Nasdaq; at 35%, a 50% chip decline costs about 17% of the portfolio, which the rest of the plan can absorb, and it still allows your approved 18% NVIDIA maximum plus normal index weights. No normal range is proposed: there is no evidence-based 'right' amount of semiconductors.",
    short: "Review above 25% (the SEC's line for a concentrated fund) and cap semiconductors at 35% so one chip downturn cannot sink the plan.",
    sources: [N1A, NASDAQ, FINRA],
  },
  {
    subject: "exposure:sector:Information Technology", dimension: "sector", key: "Information Technology", label: "Information Technology sector",
    normal: { low: 0.3, high: 0.45 }, review: 0.45, ceiling: 0.55,
    evidence: { normal: "benchmark-anchored", review: "risk-management judgment", ceiling: "risk-management judgment" },
    why: "The global market itself holds about 31% in technology (MSCI ACWI), so 30% is the neutral starting point. Your approved plan allows up to 50% in individual growth stocks, most of them technology, which justifies a tilt up to about 45%. Above that, one sector drives most of the result; 55% is the most the plan can hold while the other ten sectors still matter.",
    short: "Keep technology between the world market's 31% and 45%, review above 45%, and never above 55%.",
    sources: [ACWI],
  },
  {
    subject: "exposure:theme:AI infrastructure", dimension: "theme", key: "AI infrastructure", label: "AI infrastructure theme",
    normal: null, review: 0.3, ceiling: 0.4,
    evidence: { normal: null, review: "risk-management judgment", ceiling: "risk-management judgment" },
    why: "Chips, chip equipment, AI servers and AI data centers all depend on one driver: the data-center spending plans of a handful of cloud companies. They tend to fall together when those plans are cut, across industries and countries, so the theme is watched as one risk. The thresholds mirror the industry rule (review at about a quarter to a third of the portfolio, ceiling 40%) because the theme is wider than one industry. This is a judgment, not a published standard.",
    short: "Treat chips, AI servers and AI data centers as one risk: review above 30%, ceiling 40%.",
    sources: [FINRA],
  },
  {
    subject: "exposure:market:Emerging", dimension: "market", key: "Emerging", label: "Emerging markets",
    normal: { low: 0.05, high: 0.12 }, review: 0.15, ceiling: 0.2,
    evidence: { normal: "benchmark-anchored", review: "risk-management judgment", ceiling: "risk-management judgment" },
    why: "Emerging markets are about 10% of world stock market value, so 5-12% is a neutral-to-modest range. They carry extra currency, political and Taiwan/China risk, so above 15% deserves a decision and 20% is the ceiling. This sits inside your approved International equity range (12-20%, max 30%), which still applies.",
    short: "Keep emerging markets near their ~10% world weight (5-12%), review above 15%, ceiling 20%.",
    sources: [SPDJI, ACWI],
  },
];

export const NOT_PROPOSED: { exposure: string; reason: string }[] = [
  { exposure: "International equity and the US share", reason: "Already governed by your approved International equity range (12-20%, max 30%). A second geography limit would duplicate it." },
  { exposure: "Speculative / early-stage tech", reason: "Already governed by your approved high-risk growth sleeve (5-12%, max 20%)." },
  { exposure: "Single companies (NVIDIA, Alphabet, ...)", reason: "Already governed by your approved company limits, which include fund look-through." },
  { exposure: "Other sectors, other industries and single countries", reason: "None is material in this portfolio (each under about 13% of the invested portfolio, and Taiwan, the largest foreign country, is 3.5%). A limit would be monitoring for its own sake." },
];

/** Policy rows to insert for proposals that are not already on file (one live row per subject). */
export function proposalRows(existing: Pick<PolicyRuleRow, "scope" | "subject" | "approval">[]): Record<string, unknown>[] {
  const live = new Set(existing.filter((r) => r.scope === "portfolio" && r.approval !== "superseded").map((r) => r.subject));
  return PROPOSALS.filter((p) => !live.has(p.subject)).map((p) => ({
    scope: "portfolio", subject: p.subject,
    normal_low: p.normal?.low ?? null, normal_high: p.normal?.high ?? null,
    value: p.review, hard_max: p.ceiling,
    conditions: `Normal ${p.normal ? `${pct(p.normal.low)}-${pct(p.normal.high)} (${p.evidence.normal})` : "none proposed"}; review above ${pct(p.review)} (${p.evidence.review}); ceiling ${pct(p.ceiling)} (${p.evidence.ceiling}). Percent of the invested portfolio, direct plus through funds. ${p.why} Sources: ${p.sources.map((s) => `${s.label} (${s.date}) ${s.url}`).join("; ")}`.slice(0, 2000),
    source_label: PROPOSAL_LABEL, source_date: PROPOSAL_DATE, source_status: "app_proposal", approval: "proposed", approved_at: null,
    approval_note: `Claude recommends: ${p.short}`,
  }));
}

export type LimitState = "below_normal" | "within" | "above_normal" | "review" | "over_ceiling" | "no_range";
export type LimitCheck = {
  subject: string; label: string; status: "approved" | "proposed"; value: number; upper: number | null;
  normal: { low: number; high: number } | null; review: number | null; ceiling: number | null;
  state: LimitState; upperState: LimitState | null; message: string;
};

const stateOf = (x: number, normal: LimitCheck["normal"], review: number | null, ceiling: number | null): LimitState =>
  ceiling != null && x > ceiling ? "over_ceiling" : review != null && x > review ? "review" : normal && x > normal.high ? "above_normal" : normal && x < normal.low ? "below_normal" : normal ? "within" : "no_range";

/**
 * Checks each exposure rule (approved ones first; proposals are shown as proposals) against the report.
 * The base is the invested portfolio (savings excluded), as for every other policy limit.
 */
export function checkLimits(report: ExposureReport, rules: Pick<PolicyRuleRow, "scope" | "subject" | "approval" | "normal_low" | "normal_high" | "value" | "hard_max">[]): LimitCheck[] {
  const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  const out: LimitCheck[] = [];
  const bySubject = new Map<string, (typeof rules)[number]>();
  for (const r of rules) {
    if (r.scope !== "portfolio" || !r.subject.startsWith("exposure:")) continue;
    if (r.approval === "superseded") continue;
    const prev = bySubject.get(r.subject);
    if (!prev || (r.approval === "approved" && prev.approval !== "approved")) bySubject.set(r.subject, r);
  }
  for (const [subject, r] of bySubject) {
    const [, dim, ...rest] = subject.split(":");
    const key = rest.join(":");
    const d = report.dims[dim as DimensionKey];
    const line = d?.lines.find((l) => l.key === key);
    const toInv = (v: number) => (report.investable ? v / report.investable : 0);
    const value = line ? toInv(line.value) : 0;
    const upper = line?.upper !== undefined ? toInv(line.upper) : null;
    const normal = n(r.normal_low) !== null && n(r.normal_high) !== null ? { low: n(r.normal_low)!, high: n(r.normal_high)! } : null;
    const review = n(r.value), ceiling = n(r.hard_max);
    const state = stateOf(value, normal, review, ceiling);
    const upperState = upper !== null ? stateOf(upper, normal, review, ceiling) : null;
    const label = PROPOSALS.find((p) => p.subject === subject)?.label ?? key;
    const words: Record<LimitState, string> = {
      below_normal: "below its normal range. That is not a reason to buy.",
      within: "within its normal range.",
      above_normal: "above its normal range but under the review level. Worth knowing; no decision needed.",
      review: "above the review level: decide deliberately whether to keep it, stop adding, or trim. It is not an automatic sell.",
      over_ceiling: "over the ceiling: new money must not add to it, and a reduction plan is due.",
      no_range: ceiling != null ? `under the ${pct(review ?? ceiling)} review level.` : "monitored (no range set).",
    };
    const msg = `${label} is ${pct(value)}${upper !== null && upper > value + 0.005 ? ` (up to ${pct(upper)} counting fund holdings not itemized)` : ""}: ${words[state]}${upperState && upperState !== state && (upperState === "review" || upperState === "over_ceiling") ? ` At the top of its range it would be ${upperState === "review" ? "above the review level" : "over the ceiling"}.` : ""}`;
    out.push({ subject, label, status: r.approval === "approved" ? "approved" : "proposed", value, upper, normal, review, ceiling, state, upperState, message: msg });
  }
  const order: Record<LimitState, number> = { over_ceiling: 0, review: 1, above_normal: 2, below_normal: 3, within: 4, no_range: 5 };
  return out.sort((a, b) => (a.status === b.status ? order[a.state] - order[b.state] : a.status === "approved" ? -1 : 1));
}

function pct(x: number) { return `${Math.round(x * 1000) / 10}%`; }
