import { describe, expect, it } from "vitest";
import { auditRules, policyFromRules, type PolicyRuleRow } from "./rules";

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
  it("uses an approved rule over open candidates", () => {
    const p = policyFromRules([row({ hard_max: 0.05 }), row({ hard_max: 0.2, approval: "unresolved" })]);
    expect(p.companies.AAA).toMatchObject({ status: "approved", hardMax: 0.05 });
  });
  it("treats two approved rows that disagree as a conflict", () => {
    const p = policyFromRules([row({ hard_max: 0.05 }), row({ hard_max: 0.12 })]);
    expect(p.companies.AAA).toMatchObject({ status: "conflict", hardMax: 0.05 });
  });
  it("marks a lone proposed value as proposed, and assumptions without approval as not approved", () => {
    const p = policyFromRules([row({ scope: "assumption", subject: "etf_expected_return", value: 0.07, approval: "proposed" })]);
    expect(p.audit.assumptions.etfExpectedReturn).toMatchObject({ value: 0.07, status: "proposed" });
    expect(p.audit.assumptions.hurdle).toMatchObject({ status: "none", source: "App default" });
    expect(p.hurdleOverEtfPoints).toBeNull();
    expect(p.audit.protectedReserve).toMatchObject({ value: 10000, status: "none" });
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
    const p = policyFromRules([row({ hard_max: 0.07 }), row({ hard_max: 0.1, approval: "unresolved", approval_note: "Provisional" })]);
    expect(p.companies.AAA).toMatchObject({ status: "approved", provisional: false, hardMax: 0.07 });
  });
});
