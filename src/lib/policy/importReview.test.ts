import { describe, expect, it } from "vitest";
import { auditRules, type PolicyRuleRow } from "./rules";
import { reviewImported } from "./importReview";

// The 12 rules imported from Portfolio Baseline v2 (revised), as stored: approval "approved", approved_at empty.
let i = 0;
const imp = (scope: PolicyRuleRow["scope"], subject: string, nl: number | null, nh: number | null, hl: number | null, hh: number | null, max: number | null): PolicyRuleRow => ({
  id: `i${i++}`, scope, subject, normal_low: nl, normal_high: nh, high_conviction_low: hl, high_conviction_high: hh, hard_max: max, value: null, conditions: null,
  source_label: "Portfolio Baseline v2 (revised)", source_date: null, source_status: "latest_approved", approval: "approved", approved_at: null, approval_note: null, created_at: "2026-11-06",
});
const rows = [
  imp("bucket", "US broad-market equity", 0.25, 0.4, 0.2, 0.45, 0.5),
  imp("bucket", "International equity", 0.12, 0.2, 0.2, 0.25, 0.3),
  imp("bucket", "Small/mid-cap", 0.05, 0.12, 0.12, 0.18, 0.2),
  imp("bucket", "Sector ETFs", 0, 0.05, 0.05, 0.08, 0.1),
  imp("bucket", "Quality/growth individual stocks", 0.2, 0.35, 0.35, 0.45, 0.5),
  imp("bucket", "Asymmetric/high-risk growth sleeve", 0.05, 0.12, 0.12, 0.18, 0.2),
  imp("bucket", "Bonds", 0, 0.05, 0.05, 0.1, 0.15),
  imp("bucket", "Deployable cash", 0.05, 0.15, null, null, null),
  imp("company", "NVDA", 0.06, 0.1, 0.1, 0.15, 0.18),
  imp("company", "NOW", 0.04, 0.07, 0.07, 0.1, 0.12),
  imp("company", "IONQ", 0.005, 0.02, 0.02, 0.04, 0.05),
  imp("generic_company", "generic", 0.04, 0.08, 0.08, 0.12, 0.18),
  // Approved by you: not part of the review.
  { ...imp("company", "GOOGL", 0.05, 0.07, 0.07, 0.085, 0.1), approved_at: "2026-11-08T13:22:04Z" },
];

describe("review of imported rules", () => {
  const r = reviewImported(auditRules(rows), (s) => (s === "NVDA" ? 0.176 : null));
  it("reviews only the 12 imported rules, never the ones you approved", () => {
    expect(r.retain.length + r.exceptions.length).toBe(12);
    expect([...r.retain, ...r.exceptions].some((x) => x.subject === "GOOGL")).toBe(false);
  });
  it("retains 7, keeps NVDA/NOW/IONQ as interim ceilings, and revises the U.S. index cap and the generic ranges", () => {
    expect(r.retain).toHaveLength(7);
    expect(r.exceptions.filter((x) => x.verdict === "interim").map((x) => x.subject).sort()).toEqual(["IONQ", "NOW", "NVDA"]);
    const us = r.exceptions.find((x) => x.subject === "US broad-market equity")!;
    expect(us.verdict).toBe("revise");
    expect(us.revised).toMatchObject({ normal_low: 0.25, normal_high: 0.4, hard_max: null, high_conviction_low: null });
    const g = r.exceptions.find((x) => x.subject === "generic")!;
    expect(g.revised).toMatchObject({ normal_low: null, normal_high: null, hard_max: 0.18 });
    expect(r.exceptions.find((x) => x.subject === "NVDA")!.reason).toMatch(/17.6% including ETFs/);
  });
});
