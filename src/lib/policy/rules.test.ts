import { describe, expect, it } from "vitest";
import { auditRules, isRejected, policyFromRules, type PolicyRuleRow } from "./rules";
import { companyLimit } from "./limits";

// Synthetic rows; values mirror the shape of the real conflicts (two sources disagree on a maximum).
let i = 0;
const row = (o: Partial<PolicyRuleRow>): PolicyRuleRow => ({
  id: `r${i++}`, scope: "company", subject: "AAA", normal_low: null, normal_high: null, high_conviction_low: null, high_conviction_high: null,
  hard_max: null, value: null, conditions: null, source_label: "Test", source_date: null, source_status: "", approval: "approved",
  approved_at: null, approval_note: null, created_at: "2026-11-01", ...o,
});

describe("policy conflicts", () => {
  it("never labels a disputed maximum approved, and uses the stricter one", () => {
    const p = policyFromRules([
      row({ hard_max: 0.1, approval: "unresolved", source_label: "Baseline revised" }),
      row({ hard_max: 0.07, approval: "unresolved", source_label: "Company research" }),
      row({ hard_max: 0.035, approval: "superseded", source_label: "Baseline original" }),
    ]);
    expect(p.companies.AAA.status).toBe("conflict");
    expect(p.companies.AAA.hardMax).toBe(0.07);
    expect(p.audit.conflicts.map((c) => c.subject)).toEqual(["AAA"]);
    expect(p.audit.conflicts[0].differences[0]).toMatch(/Maximum: 10% \(Baseline revised, undated\) vs 7% \(Company research, undated\)/);
  });
  it("never uses a superseded rule", () => {
    const a = auditRules([row({ hard_max: 0.5, approval: "superseded" })]);
    expect(a.subjects[0]).toMatchObject({ status: "none", used: null });
  });
  it("uses a rule you approved over open candidates", () => {
    const p = policyFromRules([row({ hard_max: 0.05, approved_at: "2026-11-08" }), row({ hard_max: 0.2, approval: "unresolved" })]);
    expect(p.companies.AAA).toMatchObject({ status: "approved", hardMax: 0.05 });
  });
  it("treats two approved rows that disagree as a conflict", () => {
    const p = policyFromRules([row({ hard_max: 0.05 }), row({ hard_max: 0.12 })]);
    expect(p.companies.AAA).toMatchObject({ status: "conflict", hardMax: 0.05 });
  });
  it("never lets a proposal control: a lone proposal leaves nothing in control", () => {
    const p = policyFromRules([row({ hard_max: 0.07, approval: "proposed", approval_note: "Claude recommends: research limits" })]);
    expect(p.audit.subjects[0]).toMatchObject({ status: "proposed", authority: "none", used: null });
    expect(p.companies.AAA).toBeUndefined();
    expect(p.audit.decisions.map((s) => s.subject)).toEqual(["AAA"]);
    expect(p.audit.protectedReserve).toMatchObject({ value: 3000, status: "none" });
  });
  it("keeps an imported rule in control beside a proposal, and labels it imported", () => {
    const p = policyFromRules([row({ hard_max: 0.5 }), row({ hard_max: null, approval: "proposed" })]);
    expect(p.companies.AAA).toMatchObject({ status: "imported", authority: "imported", hardMax: 0.5 });
    expect(p.audit.decisions.map((s) => s.subject)).toEqual(["AAA"]);
  });
  it("uses the stricter disputed value as a labelled temporary safety limit", () => {
    const a = auditRules([row({ hard_max: 0.06 }), row({ hard_max: 0.07, approval: "unresolved" })]);
    expect(a.subjects[0]).toMatchObject({ status: "conflict", authority: "safety" });
    expect(Number(a.subjects[0].used!.hard_max)).toBe(0.06);
  });
  it("retires the old placeholders and the withdrawn benchmark and margin: kept in history, never used", () => {
    const a = auditRules([
      row({ scope: "assumption", subject: "benchmark_return", normal_low: 0.048, normal_high: 0.075, value: 0.0665, approved_at: "2026-11-08" }),
      row({ scope: "assumption", subject: "risk_margin_factor", value: 0.5, approval: "proposed" }),
      row({ scope: "assumption", subject: "etf_expected_return", value: 0.07, approval: "proposed" }),
      row({ scope: "assumption", subject: "hurdle_over_etf", value: 0.03, approval: "proposed" }),
      row({ scope: "assumption", subject: "research_freshness_days", value: 120, approval: "proposed" }),
    ]);
    expect(a.subjects).toHaveLength(0);
    expect(a.decisions).toHaveLength(0);
    expect(a.retired).toHaveLength(5);
  });
});

describe("your approvals vs imported approvals", () => {
  it("labels an archive 'approved' row as imported, not as yours", () => {
    const p = policyFromRules([row({ hard_max: 0.12, approved_at: null })]);
    expect(p.companies.AAA).toMatchObject({ status: "imported", authority: "imported", hardMax: 0.12 });
    expect(p.audit.imported.map((s) => s.subject)).toEqual(["AAA"]);
  });
  it("lets your approval control and shows a later proposal as a decision without changing the numbers", () => {
    const p = policyFromRules([row({ hard_max: 0.1, approved_at: "2026-11-08T13:22:04Z" }), row({ hard_max: 0.08, approval: "proposed" })]);
    expect(p.companies.AAA).toMatchObject({ status: "approved", authority: "you", hardMax: 0.1 });
    expect(p.audit.decisions.map((s) => s.subject)).toEqual(["AAA"]);
  });
  it("RDDT case: an imported 6% ceiling plus completed research at 7% is an open conflict, using 6% until you decide", () => {
    const p = policyFromRules([
      row({ subject: "RDDT", hard_max: 0.06, approved_at: null, source_label: "Portfolio Baseline v2 (revised)" }),
      row({ subject: "RDDT", normal_low: 0.03, normal_high: 0.05, high_conviction_low: 0.05, high_conviction_high: 0.065, hard_max: 0.07, approval: "unresolved", source_label: "RDDT research", source_date: "2026-09-13", approval_note: "Claude recommends: completed research" }),
    ]);
    expect(p.companies.RDDT).toMatchObject({ status: "conflict", authority: "safety", hardMax: 0.06 });
    const d = p.audit.decisions.find((s) => s.subject === "RDDT")!;
    expect(d.recommended?.source_label).toBe("RDDT research");
    expect(d.differences.join(" ")).toMatch(/Maximum: 6% \(Portfolio Baseline v2 \(revised\), undated\) vs 7% \(RDDT research, 2026-09-13\)/);
  });
  it("keeps a rejected proposal in history, marked rejected", () => {
    const a = auditRules([row({ hard_max: 0.05, approved_at: "2026-11-08" }), row({ hard_max: 0.09, approval: "superseded", approval_note: "Claude recommends: x | Rejected by you on 2026-11-08." })]);
    expect(a.decisions).toHaveLength(0);
    expect(isRejected(a.subjects[0].history[0])).toBe(true);
  });
});

describe("companies without their own limit", () => {
  it("never inherit the generic maximum for new money", () => {
    const p = policyFromRules([row({ scope: "generic_company", subject: "generic", hard_max: 0.18, approved_at: null })]);
    expect(p.portfolioCeiling).toBe(0.18);
    expect(companyLimit(p, "ZZZ")).toEqual({ hasLimit: false, newMoneyMax: 0, monitorMax: 0.18 });
  });
  it("cap a company's own limit at the absolute ceiling", () => {
    const p = policyFromRules([row({ scope: "generic_company", subject: "generic", hard_max: 0.18 }), row({ hard_max: 0.25, approved_at: "2026-11-08" })]);
    expect(companyLimit(p, "AAA")).toEqual({ hasLimit: true, newMoneyMax: 0.18, monitorMax: 0.18 });
  });
});

describe("provisional limit", () => {
  it("uses the owner's provisional choice while the conflict stays open and unapproved", () => {
    const p = policyFromRules([
      row({ hard_max: 0.1, normal_low: 0.03, normal_high: 0.05, approval: "unresolved", source_label: "Baseline revised" }),
      row({ hard_max: 0.07, normal_low: 0.03, normal_high: 0.05, approval: "unresolved", source_label: "Company research", source_date: "2026-09-10", approval_note: "Provisional controlling limit per owner, pending approval" }),
    ]);
    expect(p.companies.AAA).toMatchObject({ status: "conflict", provisional: true, hardMax: 0.07, normal: { low: 0.03, high: 0.05 } });
    expect(p.audit.conflicts).toHaveLength(1);
  });
  it("follows the provisional row even when it is not the stricter one", () => {
    const p = policyFromRules([
      row({ hard_max: 0.05, approval: "unresolved" }),
      row({ hard_max: 0.08, approval: "unresolved", approval_note: "Provisional per owner" }),
    ]);
    expect(p.companies.AAA).toMatchObject({ hardMax: 0.08, provisional: true, status: "conflict" });
  });
  it("is not provisional once a row is approved", () => {
    const p = policyFromRules([row({ hard_max: 0.07, approved_at: "2026-11-08" }), row({ hard_max: 0.1, approval: "unresolved", approval_note: "Provisional" })]);
    expect(p.companies.AAA).toMatchObject({ status: "approved", provisional: false, hardMax: 0.07 });
  });
});
