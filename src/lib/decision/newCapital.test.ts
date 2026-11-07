import { describe, expect, it } from "vitest";
import { buildPortfolio, type SnapshotInput } from "@/lib/portfolio/engine";
import { readPolicy } from "@/lib/policy/limits";
import { policyFromRules, type PolicyRuleRow } from "@/lib/policy/rules";
import { toResearchRecord } from "@/lib/research/records";
import { newCapital } from "./newCapital";

// Synthetic data only.
const now = new Date("2026-11-05T16:00:00Z");
const snap: SnapshotInput = {
  accountId: "a", accountName: "Broker", accountRole: "taxable_brokerage", asOf: "2026-11-04T21:00:00Z", totalValue: null, cashValue: 0,
  positions: [
    { symbol: "VOO", quantity: 10, price: 700, marketValue: 7000, costBasis: null },
    { symbol: "VXUS", quantity: 10, price: 80, marketValue: 800, costBasis: null },
    { symbol: "AAA", quantity: 20, price: 25, marketValue: 500, costBasis: null },
    { symbol: "BBB", quantity: 5, price: 280, marketValue: 1400, costBasis: null },
  ],
};
const savings: SnapshotInput = { accountId: "s", accountName: "Savings", accountRole: "cash", asOf: "2026-11-04T23:59:00Z", totalValue: 12000, cashValue: 12000, positions: [] };
const legacy = readPolicy("v2", {
  target_allocation_policies: { latest_approved_v2_revised: [
    { bucket: "U.S. broad-market equity", normal: "25-40%", hard_max: "50%" },
    { bucket: "International equity", normal: "12-20%", hard_max: "30%" },
  ] },
  single_company_frameworks: { latest_approved_v2_revised: { AAA: { normal: "~3-10%", conditional_hard_max: "~10%" } } },
});
const research = (refPrice: string, completeness = "complete", asOf = "2026-10-20") => toResearchRecord("AAA", "AAA", "held", [{
  id: "v1", research_as_of: asOf, completeness, origin: "chatgpt_original", is_current: true,
  conclusion: { action: "HOLD / NO ADD", classification: "Growth", reference_price: refPrice, reference_date: asOf,
    valuation: { approx_holding_period_years: 4, bear_value: 20, base_value: 90, bull_value: 200, bear_probability: 0.3, base_probability: 0.5, bull_probability: 0.2 },
    price_framework: [{ price_zone: "< $35", action: "Strong Add research trigger" }] },
}]);

const row = (over: Partial<PolicyRuleRow>): PolicyRuleRow => ({
  id: Math.random().toString(36).slice(2), scope: "company", subject: "AAA", normal_low: null, normal_high: null, high_conviction_low: null, high_conviction_high: null,
  hard_max: null, value: null, conditions: null, source_label: "Test", source_date: null, source_status: "latest_approved", approval: "approved",
  approved_at: null, approval_note: null, created_at: "2026-11-05", ...over,
});
const approvedRules = [
  row({ subject: "AAA", normal_low: 0.03, normal_high: 0.10, hard_max: 0.10 }),
  row({ scope: "bucket", subject: "US broad-market equity", normal_low: 0.25, normal_high: 0.40, hard_max: 0.5 }),
  row({ scope: "bucket", subject: "International equity", normal_low: 0.12, normal_high: 0.20, hard_max: 0.3 }),
  row({ scope: "assumption", subject: "etf_expected_return", value: 0.07 }),
  row({ scope: "assumption", subject: "hurdle_over_etf", value: 0.03 }),
  row({ scope: "portfolio", subject: "protected_reserve", value: 10000 }),
];

describe("new capital: evidence gates", () => {
  it("is WAIT / REVIEW with placeholders, unknown savings and an unresearched holding", () => {
    const p = buildPortfolio([snap], new Map(), legacy, {}, [], now);
    const r = newCapital({ amount: 1250, portfolio: p, research: [research("$26")], policy: legacy, now });
    expect(r.status).toBe("wait_review");
    expect(r.recommendation.headline).toBe("WAIT / REVIEW");
    expect(r.recommendation.illustrative).toBe(true);
    const open = r.gates.filter((g) => !g.ok).map((g) => g.key);
    expect(open).toEqual(expect.arrayContaining(["cash", "assumptions", "research"]));
    expect(r.toVerify.join(" ")).toMatch(/BBB: full research/);
    expect(r.options.find((o) => o.kind === "cash")!.label).toBe("Valid option");
  });

  it("stays on wait while the portfolio is not reconciled", () => {
    const policy = policyFromRules(approvedRules);
    const p = buildPortfolio([{ ...snap, positions: snap.positions.filter((x) => x.symbol !== "BBB") }, savings], new Map(), policy, {}, [], now);
    expect(p.quality.reconciliation.complete).toBe(false);
    expect(p.quality.reconciliation.gaps.join(" ")).toMatch(/No transactions recorded/);
    expect(p.quality.reconciliation.gaps.join(" ")).toMatch(/Cost basis missing for 3 positions/);
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26")], policy, now });
    expect(r.gates.find((g) => g.key === "holdings")).toMatchObject({ ok: false });
    expect(r.status).toBe("wait_review");
  });

  it("becomes actionable only when every gate passes", () => {
    const policy = policyFromRules(approvedRules);
    const withBasis = { ...snap, positions: snap.positions.filter((x) => x.symbol !== "BBB").map((x) => ({ ...x, costBasis: x.marketValue })) };
    const ledger = [{ accountId: "a", tradeDate: "2026-10-01", kind: "deposit" as const, symbol: null, quantity: null, price: null, amount: 500 }];
    const p = buildPortfolio([withBasis, savings], new Map(), policy, {}, ledger, now);
    expect(p.quality.reconciliation).toMatchObject({ complete: true, label: "Reconciled" });
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26")], policy, now });
    expect(r.gates.every((g) => g.ok)).toBe(true);
    expect(r.status).toBe("actionable");
    expect(r.recommendation.allocations[0]).toEqual({ symbol: "AAA", amount: 400 });
  });
});

describe("new capital: a drop is not a buy signal", () => {
  it("does not re-price research after a large decline", () => {
    const policy = policyFromRules(approvedRules);
    const p = buildPortfolio([snap, savings], new Map(), policy, {}, [], now);
    const r = newCapital({ amount: 1000, portfolio: p, research: [research("$40")], policy, now }); // $25 is 37% below $40
    const aaa = r.options.find((o) => o.symbol === "AAA")!;
    expect(aaa.label).toBe("Refresh required");
    expect(aaa.expectedReturn).toBeNull();
    expect(aaa.notes.join(" ")).toMatch(/Not re-priced/);
    expect(r.recommendation.allocations.find((x) => x.symbol === "AAA")).toBeUndefined();
    expect(r.status).toBe("wait_review");
  });

  it("treats partial research as needing completion, not as a smaller buy", () => {
    const policy = policyFromRules(approvedRules);
    const p = buildPortfolio([snap, savings], new Map(), policy, {}, [], now);
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26", "partial")], policy, now });
    expect(r.options.find((o) => o.symbol === "AAA")!.label).toBe("Refresh required");
  });
});

describe("new capital: ceilings and money source", () => {
  it("fills a stock only to the top of its normal range", () => {
    const tight = policyFromRules([...approvedRules.filter((x) => x.subject !== "AAA"), row({ subject: "AAA", normal_low: 0.03, normal_high: 0.05, hard_max: 0.10 })]);
    const p = buildPortfolio([{ ...snap, positions: snap.positions.filter((x) => x.symbol !== "BBB") }, savings], new Map(), tight, {}, [], now);
    const r = newCapital({ amount: 1250, portfolio: p, research: [research("$26")], policy: tight, now });
    // investable = 8300 + 2000 deployable savings = 10300; new money -> 11550; 5% = 577.5; minus 500 held = 77.5
    expect(r.recommendation.allocations[0]).toEqual({ symbol: "AAA", amount: 77 });
    expect(r.options.find((o) => o.symbol === "AAA")!.maxWeight).toBe(0.05);
  });

  it("does not grow the portfolio when the money is cash already held", () => {
    const policy = policyFromRules(approvedRules);
    const p = buildPortfolio([snap, savings], new Map(), policy, {}, [], now);
    const fromNew = newCapital({ amount: 1000, source: "new", portfolio: p, research: [research("$26")], policy, now });
    const fromCash = newCapital({ amount: 1000, source: "existing", portfolio: p, research: [research("$26")], policy, now });
    const room = (x: typeof fromNew) => x.options.find((o) => o.symbol === "AAA")!.headroomDollars!;
    expect(room(fromNew) - room(fromCash)).toBeCloseTo(100, 1); // 10% of the extra 1000
    const tooMuch = newCapital({ amount: 5000, source: "existing", portfolio: p, research: [], policy, now });
    expect(tooMuch.gates.find((g) => g.key === "cash")!.ok).toBe(false);
  });
});

describe("new capital: policy conflicts", () => {
  it("uses the stricter limit and blocks actionability until you choose", () => {
    const rules = [...approvedRules.filter((x) => x.subject !== "AAA"),
      row({ subject: "AAA", normal_low: 0.03, normal_high: 0.05, hard_max: 0.10, approval: "unresolved", source_label: "Baseline" }),
      row({ subject: "AAA", normal_low: 0.03, normal_high: 0.05, hard_max: 0.07, approval: "unresolved", source_label: "Company research", source_date: "2026-09-10" })];
    const policy = policyFromRules(rules);
    expect(policy.companies.AAA.hardMax).toBe(0.07);
    expect(policy.companies.AAA.status).toBe("conflict");
    expect(policy.audit.conflicts[0].differences[0]).toMatch(/Maximum: 10% \(Baseline, undated\) vs 7% \(Company research, 2026-09-10\)/);
    const p = buildPortfolio([snap, savings], new Map(), policy, {}, [], now);
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26")], policy, now });
    expect(r.gates.find((g) => g.key === "limits")!.ok).toBe(false);
    expect(r.status).toBe("wait_review");
  });
});
