/**
 * Review of the rules imported from the old archive (Portfolio Baseline v2 revised, undated), held against
 * your current method (2026-11-08): beat the opportunity cost of simply owning VOO or holding savings;
 * company limits come from that company's own research and your approval; a limit is a risk ceiling, never a
 * buy signal; a company without its own limit gets no new money; holding cash is always allowed.
 *
 * Each imported rule gets one verdict with a reason:
 *  - retain:  consistent with the method, keep as is;
 *  - interim: keep only as a ceiling until research sets the company's own ranges (no new money above normal);
 *  - revise:  contradicts the method; a specific replacement is proposed. Nothing is written until you approve it.
 * Nothing here is ever treated as your approval.
 */
import type { PolicyAudit, PolicyRuleRow, SubjectAudit } from "./rules";

export type ImportVerdict = "retain" | "interim" | "revise";
export type Revision = Pick<PolicyRuleRow, "normal_low" | "normal_high" | "high_conviction_low" | "high_conviction_high" | "hard_max">;
export type ImportReviewItem = { scope: PolicyRuleRow["scope"]; subject: string; row: PolicyRuleRow; verdict: ImportVerdict; reason: string; revised?: Revision };

const pct = (v: number | string | null | undefined) => (v === null || v === undefined ? "none" : `${+(Number(v) * 100).toFixed(1)}%`);

/** Known judgments, by subject. Anything not listed is retained only if it has no obvious contradiction. */
function judge(s: SubjectAudit, weightOf: (symbol: string) => number | null): Omit<ImportReviewItem, "scope" | "subject" | "row"> {
  const r = s.used!;
  switch (s.subject) {
    case "US broad-market equity":
      return {
        verdict: "revise",
        reason: `VOO is the alternative every other investment has to beat, so it is where money goes when nothing beats it. A ${pct(r.hard_max)} maximum would force money into weaker options once it is reached. The imported high-conviction range (${pct(r.high_conviction_low)}–${pct(r.high_conviction_high)}) also starts below the normal range, which looks like a transcription error. Proposed: keep ${pct(r.normal_low)}–${pct(r.normal_high)} as a guide, no maximum, no high-conviction range.`,
        revised: { normal_low: r.normal_low, normal_high: r.normal_high, high_conviction_low: null, high_conviction_high: null, hard_max: null },
      };
    case "generic":
      return {
        verdict: "revise",
        reason: `The imported "any company" ranges (normal ${pct(r.normal_low)}–${pct(r.normal_high)}, high conviction ${pct(r.high_conviction_low)}–${pct(r.high_conviction_high)}) would let an unresearched company inherit an allocation, which your method rules out. Proposed: keep only the ${pct(r.hard_max)} absolute ceiling for any single company, with no ranges.`,
        revised: { normal_low: null, normal_high: null, high_conviction_low: null, high_conviction_high: null, hard_max: r.hard_max },
      };
    case "NVDA": {
      const w = weightOf("NVDA");
      return {
        verdict: "interim",
        reason: `No NVDA research sets its own limits; the 2026-11-07 AI research only repeated these numbers. ${w !== null ? `NVDA is about ${pct(w)} including ETFs, ` : ""}above both its normal (${pct(r.normal_low)}–${pct(r.normal_high)}) and high-conviction (${pct(r.high_conviction_low)}–${pct(r.high_conviction_high)}) ranges, so it gets no new money either way. Keep ${pct(r.hard_max)} as the review ceiling until research sets NVDA's own ranges. Being above the normal range is a review, not a sale.`,
      };
    }
    case "NOW":
      return { verdict: "interim", reason: `No NOW research sets its own limits; the 2026-11-07 AI research only repeated these numbers. Keep as an interim ceiling until research sets NOW's own ranges.` };
    case "IONQ":
      return { verdict: "interim", reason: `Marked provisional in the archive ("no IONQ research yet"); the 2026-11-07 AI research repeated it. ${pct(r.hard_max)} for a pre-profit company is below IREN's researched 7%, so it is not loose. Keep as an interim ceiling until research sets IONQ's own ranges.` };
    case "Deployable cash":
      return { verdict: "retain", reason: `A guide only: being below ${pct(r.normal_low)} is never a reason to sell, and being above ${pct(r.normal_high)} is never a reason to invest without a good option.` };
    case "Asymmetric/high-risk growth sleeve":
      return { verdict: "retain", reason: `Retain the ${pct(r.hard_max)} ceiling on high-risk names (IREN's research makes its own limit subject to this sleeve). The ${pct(r.normal_low)} lower end is not a target: being below it is not a reason to buy.` };
    case "Quality/growth individual stocks":
      return { verdict: "retain", reason: `An aggregate ceiling on individual stocks (${pct(r.hard_max)}) is consistent with company-by-company limits.` };
    default:
      return { verdict: "retain", reason: "A diversification guide and ceiling; nothing in your current method contradicts it." };
  }
}

export function reviewImported(audit: PolicyAudit, weightOf: (symbol: string) => number | null = () => null): { retain: ImportReviewItem[]; exceptions: ImportReviewItem[] } {
  const items = audit.imported.filter((s) => s.used).map((s) => ({ scope: s.scope, subject: s.subject, row: s.used!, ...judge(s, weightOf) }));
  return { retain: items.filter((x) => x.verdict === "retain"), exceptions: items.filter((x) => x.verdict !== "retain") };
}
