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
    price_framework: [{ price_zone: "< $35", action: "Add" }] },
}]);

const row = (over: Partial<PolicyRuleRow>): PolicyRuleRow => ({
  id: Math.random().toString(36).slice(2), scope: "company", subject: "AAA", normal_low: null, normal_high: null, high_conviction_low: null, high_conviction_high: null,
  hard_max: null, value: null, conditions: null, source_label: "Test", source_date: null, source_status: "latest_approved", approval: "approved",
  approved_at: over.approval && over.approval !== "approved" ? null : "2026-11-05T12:00:00Z", approval_note: null, created_at: "2026-11-05", ...over,
});
const approvedRules = [
  row({ subject: "AAA", normal_low: 0.03, normal_high: 0.10, hard_max: 0.10 }),
  row({ scope: "bucket", subject: "US broad-market equity", normal_low: 0.25, normal_high: 0.40, hard_max: 0.5 }),
  row({ scope: "bucket", subject: "International equity", normal_low: 0.12, normal_high: 0.20, hard_max: 0.3 }),
  row({ scope: "assumption", subject: "benchmark_return", normal_low: 0.048, normal_high: 0.075, value: 0.0665 }),
  row({ scope: "assumption", subject: "risk_margin_factor", value: 0.5 }),
  row({ scope: "portfolio", subject: "protected_reserve", value: 10000 }),
];
// SEC filings checked, nothing filed after the research date.
const quiet = new Map([["AAA", { cik: "1", company: "AAA", filings: [{ form: "10-Q", filed: "2026-08-01", reportDate: null, description: "Quarterly report", items: [], isEarnings: true, url: "u", category: "periodic" as const, note: "" }], lastEarnings: null, nextEarningsEstimate: null, source: "s", fetchedAt: "t" }]]);

describe("new capital: evidence gates", () => {
  it("gives analysis only when the cash is not known, and still lists every open check", () => {
    const p = buildPortfolio([snap], new Map(), legacy, {}, [], now);
    const r = newCapital({ amount: 1250, portfolio: p, research: [research("$26")], policy: legacy, now });
    expect(r.status).toBe("analysis_only");
    expect(r.lean).toMatch(/^Lean: /);
    expect(r.recommendation.illustrative).toBe(true);
    const open = r.gates.filter((g) => !g.ok).map((g) => g.key);
    expect(open).toEqual(expect.arrayContaining(["cash", "research"]));
    expect(r.gates.map((g) => g.key)).not.toContain("assumptions");
    expect(r.toVerify.join(" ")).toMatch(/BBB: full research/);
    expect(r.options.find((o) => o.kind === "cash")!.label).toBe("Valid option");
  });

  it("keeps dollar amounts illustrative while holdings are stale, but not for bookkeeping gaps", () => {
    const policy = policyFromRules(approvedRules);
    const stale = { ...snap, asOf: "2026-10-15T21:00:00Z", positions: snap.positions.filter((x) => x.symbol !== "BBB") };
    const p = buildPortfolio([stale, savings], new Map(), policy, {}, [], now);
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26")], policy, now, filings: quiet });
    expect(r.gates.find((g) => g.key === "holdings")).toMatchObject({ ok: false, detail: expect.stringMatching(/Broker is only known through 2026-10-15 \(20 days\)/) });
    expect(r.status).toBe("analysis_only");
    expect(r.recommendation.illustrative).toBe(true);
    expect(r.lean).toMatch(/^Lean: add to AAA/);
    // Trades recorded since the statement (confirmations) make the holdings known through the latest trade.
    const ledger = [{ accountId: "a", tradeDate: "2026-11-03", kind: "deposit" as const, symbol: null, quantity: null, price: null, amount: 100 }];
    const p2 = buildPortfolio([stale, savings], new Map(), policy, {}, ledger, now);
    expect(p2.quality.reconciliation.complete).toBe(false); // cost basis missing: noted, not blocking
    const r2 = newCapital({ amount: 400, portfolio: p2, research: [research("$26")], policy, now, filings: quiet });
    expect(r2.gates.find((g) => g.key === "holdings")).toMatchObject({ ok: true, detail: expect.stringMatching(/not blocking: .*Cost basis missing/) });
  });

  it("gives actionable dollar amounts only when every readiness check passes", () => {
    const policy = policyFromRules(approvedRules);
    const withBasis = { ...snap, positions: snap.positions.filter((x) => x.symbol !== "BBB").map((x) => ({ ...x, costBasis: x.marketValue })) };
    const ledger = [{ accountId: "a", tradeDate: "2026-10-01", kind: "deposit" as const, symbol: null, quantity: null, price: null, amount: 500 }];
    const p = buildPortfolio([withBasis, savings], new Map(), policy, {}, ledger, now);
    expect(p.quality.reconciliation).toMatchObject({ complete: true, label: "Reconciled" });
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26")], policy, now, filings: quiet });
    expect(r.gates.every((g) => g.ok)).toBe(true);
    expect(r.status).toBe("actionable");
    expect(r.recommendation.illustrative).toBe(false);
    expect(r.recommendation.allocations[0]).toEqual({ symbol: "AAA", amount: 400 });
    expect(r.options.find((o) => o.symbol === "AAA")!.assessment!.judgment).toBe("favourable");
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
    expect(aaa.verdicts!.research.detail).toMatch(/38% below the \$40 research reference/);
    expect(r.recommendation.allocations.find((x) => x.symbol === "AAA")).toBeUndefined();
    expect(r.status).toBe("analysis_only");
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
    const r = newCapital({ amount: 1250, portfolio: p, research: [research("$26")], policy: tight, now, filings: quiet });
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
  it("uses the stricter limit as a temporary safety limit and gives no new money until you decide", () => {
    const rules = [...approvedRules.filter((x) => x.subject !== "AAA"),
      row({ subject: "AAA", normal_low: 0.03, normal_high: 0.05, hard_max: 0.10, approval: "unresolved", source_label: "Baseline" }),
      row({ subject: "AAA", normal_low: 0.03, normal_high: 0.05, hard_max: 0.07, approval: "unresolved", source_label: "Company research", source_date: "2026-09-10" })];
    const policy = policyFromRules(rules);
    expect(policy.companies.AAA.hardMax).toBe(0.07);
    expect(policy.companies.AAA.status).toBe("conflict");
    expect(policy.audit.conflicts[0].differences[0]).toMatch(/Maximum: 10% \(Baseline, undated\) vs 7% \(Company research, 2026-09-10\)/);
    const p = buildPortfolio([snap, savings], new Map(), policy, {}, [], now);
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26")], policy, now, filings: quiet });
    expect(policy.companies.AAA.authority).toBe("safety");
    const aaa = r.options.find((o) => o.symbol === "AAA")!;
    expect(aaa.label).toBe("Limit not approved");
    expect(r.toVerify.join(" ")).toMatch(/AAA: decide which allocation limit controls/);
  });
});

describe("new capital: event-driven refresh and independent verdicts", () => {
  const policy = policyFromRules(approvedRules);
  const withBasis = { ...snap, positions: snap.positions.filter((x) => x.symbol !== "BBB").map((x) => ({ ...x, costBasis: x.marketValue })) };
  const ledger = [{ accountId: "a", tradeDate: "2026-10-01", kind: "deposit" as const, symbol: null, quantity: null, price: null, amount: 500 }];
  const p = buildPortfolio([withBasis, savings], new Map(), policy, {}, ledger, now);

  it("asks for a refresh after new results, even when the research is only weeks old", () => {
    const filed = new Map([["AAA", { ...quiet.get("AAA")!, filings: [{ ...quiet.get("AAA")!.filings[0], form: "10-Q", filed: "2026-11-03" }] }]]);
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26")], policy, now, filings: filed });
    const aaa = r.options.find((o) => o.symbol === "AAA")!;
    expect(aaa.label).toBe("Refresh required");
    expect(aaa.verdicts!.research.detail).toMatch(/New results since the research: 10-Q filed 2026-11-03/);
    expect(r.status).toBe("analysis_only");
    expect(r.recommendation.allocations.find((x) => x.symbol === "AAA")).toBeUndefined();
  });
  it("does not call research current when filings could not be checked", () => {
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26")], policy, now });
    expect(r.options.find((o) => o.symbol === "AAA")!.verdicts!.research.ok).toBe(false);
    expect(r.gates.find((g) => g.key === "research")!.ok).toBe(false);
  });
  it("does not let an old but event-free research block the decision", () => {
    const early = new Map([["AAA", { ...quiet.get("AAA")!, filings: [{ ...quiet.get("AAA")!.filings[0], filed: "2026-04-20" }] }]]);
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26", "complete", "2026-05-01")], policy, now, filings: early });
    expect(r.options.find((o) => o.symbol === "AAA")!.verdicts!.research.ok).toBe(true);
  });
  it("keeps the research's own 'hold' zone even when the return comparison clears", () => {
    const holdZone = toResearchRecord("AAA", "AAA", "held", [{ id: "v2", research_as_of: "2026-10-20", completeness: "complete", origin: "x", is_current: true,
      conclusion: { action: "HOLD", reference_price: "$26", reference_date: "2026-10-20",
        valuation: { approx_holding_period_years: 4, bear_value: 20, base_value: 90, bull_value: 200, bear_probability: 0.3, base_probability: 0.5, bull_probability: 0.2 },
        price_framework: [{ price_zone: "< $20", action: "Add" }, { price_zone: "$20–$40", action: "Hold / no add" }] } }]);
    const aaa = newCapital({ amount: 400, portfolio: p, research: [holdZone], policy, now, filings: quiet }).options.find((o) => o.symbol === "AAA")!;
    expect(aaa.label).toBe("Research says hold");
    expect(aaa.assessment!.judgment).toBe("favourable");
    expect(aaa.agreement).toBe("model_more_positive");
    expect(aaa.verdicts!.valuation.detail).toMatch(/HOLD conclusion stands/);
    expect(aaa.verdicts!.limit.ok).toBe(true);
    expect(aaa.verdicts!.valuation.ok).toBe(false);
    expect(aaa.eligible).toBe(false);
  });
  it("gives no new money to a researched company without its own limit", () => {
    const noLimit = policyFromRules([...approvedRules.filter((x) => x.subject !== "AAA"), row({ scope: "generic_company", subject: "generic", hard_max: 0.18 })]);
    const p2 = buildPortfolio([withBasis, savings], new Map(), noLimit, {}, ledger, now);
    const aaa = newCapital({ amount: 400, portfolio: p2, research: [research("$26")], policy: noLimit, now, filings: quiet }).options.find((o) => o.symbol === "AAA")!;
    expect(aaa.label).toBe("No limit set");
    expect(aaa.headroomDollars).toBe(0);
    expect(aaa.verdicts!.limit.detail).toMatch(/does not inherit the generic 18% maximum/);
  });
  it("gives no new money under a limit you have not approved: a missing approval is not just a warning", () => {
    const importedOnly = policyFromRules(approvedRules.map((x) => (x.scope === "assumption" ? x : { ...x, approved_at: null })));
    const p3 = buildPortfolio([withBasis, savings], new Map(), importedOnly, {}, ledger, now);
    const r = newCapital({ amount: 400, portfolio: p3, research: [research("$26")], policy: importedOnly, now, filings: quiet });
    const aaa = r.options.find((o) => o.symbol === "AAA")!;
    expect(aaa.label).toBe("Limit not approved");
    expect(aaa.eligible).toBe(false);
    expect(r.recommendation.allocations.find((x) => x.symbol === "AAA")).toBeUndefined();
    expect(r.toVerify.join(" ")).toMatch(/AAA: confirm or revise its imported limit/);
    // With no stock qualifying, a core ETF below the bottom of its range leads; otherwise VOO is the default.
    expect(r.recommendation.allocations).toEqual([{ symbol: "VXUS", amount: 400 }]);
    expect(r.options.find((o) => o.symbol === "VXUS")!.notes[0]).toMatch(/Below the bottom of its normal range/);
  });
  it("treats a conditional add in the research as no add until the condition is confirmed", () => {
    const cond = toResearchRecord("AAA", "AAA", "held", [{ id: "v3", research_as_of: "2026-10-20", completeness: "complete", origin: "x", is_current: true,
      conclusion: { action: "Hold / no add", reference_price: "$26", reference_date: "2026-10-20",
        valuation: { approx_holding_period_years: 4, bear_value: 20, base_value: 90, bull_value: 200, bear_probability: 0.3, base_probability: 0.5, bull_probability: 0.2 },
        price_framework: [{ price_zone: "< $35", action: "Consider a small add only if Q4 results confirm the turnaround." }] } }]);
    const r = newCapital({ amount: 400, portfolio: p, research: [cond], policy, now, filings: quiet });
    const aaa = r.options.find((o) => o.symbol === "AAA")!;
    expect(aaa.stance).toMatchObject({ kind: "conditional", condition: "only if Q4 results confirm the turnaround" });
    expect(aaa.label).toBe("Condition not met");
    expect(aaa.eligible).toBe(false);
    expect(r.toVerify.join(" ")).toMatch(/condition for adding must be confirmed first: only if Q4 results/);
  });
  it("sizes to the high-conviction range only when you approved it, its condition is met, and research and model support adding", () => {
    const hc = (approved_at: string | null, conditions: string | null) => policyFromRules([...approvedRules.filter((x) => x.subject !== "AAA"),
      row({ subject: "AAA", normal_low: 0.03, normal_high: 0.05, high_conviction_low: 0.05, high_conviction_high: 0.08, hard_max: 0.1, approved_at, conditions })]);
    const run = (pol: ReturnType<typeof hc>, filings?: typeof quiet) => newCapital({ amount: 400, portfolio: buildPortfolio([withBasis, savings], new Map(), pol, {}, ledger, now), research: [research("$26")], policy: pol, now, filings }).options.find((o) => o.symbol === "AAA")!;
    const yours = run(hc("2026-11-08T13:00:00Z", "A ceiling, not a reason to add."), quiet);
    expect(yours.highConviction).toBe(true);
    expect(yours.maxWeight).toBe(0.08);
    const conditional = run(hc("2026-11-08T13:00:00Z", "High conviction only after meaningful de-risking"), quiet);
    expect(conditional.highConviction).toBe(false);
    expect(conditional.maxWeight).toBe(0.05);
    expect(conditional.notes.join(" ")).toMatch(/not available: its condition is not confirmed \(only after meaningful de-risking\)/);
    const imported = run(hc(null, null), quiet);
    expect(imported.highConviction).toBe(false);
    expect(imported.notes.join(" ")).toMatch(/not available: you have not approved it/);
    expect(run(hc("2026-11-08T13:00:00Z", null)).highConviction).toBe(false); // filings unchecked
  });
});
