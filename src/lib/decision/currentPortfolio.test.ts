import { describe, expect, it } from "vitest";
import { buildPortfolio, type SnapshotInput } from "@/lib/portfolio/engine";
import { policyFromRules, type PolicyRuleRow } from "@/lib/policy/rules";
import { toResearchRecord } from "@/lib/research/records";
import { currentPortfolioDecision, preferenceFromRow, transferableSavings } from "./currentPortfolio";

// Synthetic data only.
const now = new Date("2026-11-05T16:00:00Z");
const broker = (cash: number): SnapshotInput => ({
  accountId: "a", accountName: "Broker", accountRole: "taxable_brokerage", asOf: "2026-11-04T21:00:00Z", totalValue: null, cashValue: cash,
  positions: [
    { symbol: "VOO", quantity: 10, price: 700, marketValue: 7000, costBasis: 7000 },
    { symbol: "VXUS", quantity: 10, price: 80, marketValue: 800, costBasis: 800 },
    { symbol: "AAA", quantity: 20, price: 25, marketValue: 500, costBasis: 500 },
  ],
});
const savingsSnap = (balance: number, id = "s", name = "Savings"): SnapshotInput => ({ accountId: id, accountName: name, accountRole: "cash", asOf: "2026-11-04T23:59:00Z", totalValue: balance, cashValue: balance, positions: [] });
const research = (action: string, zone: string) => toResearchRecord("AAA", "AAA", "held", [{
  id: "v1", research_as_of: "2026-10-20", completeness: "complete", origin: "chatgpt_original", is_current: true,
  conclusion: { review_state: "adopted", action, classification: "Growth", reference_price: "$25", reference_date: "2026-10-20",
    valuation: { approx_holding_period_years: 4, bear_value: 20, base_value: 90, bull_value: 200, bear_probability: 0.3, base_probability: 0.5, bull_probability: 0.2 },
    price_framework: [{ price_zone: "< $35", action: zone }] },
}]);
const row = (over: Partial<PolicyRuleRow>): PolicyRuleRow => ({
  id: Math.random().toString(36).slice(2), scope: "company", subject: "AAA", normal_low: null, normal_high: null, high_conviction_low: null, high_conviction_high: null,
  hard_max: null, value: null, conditions: null, source_label: "Test", source_date: null, source_status: "latest_approved", approval: "approved",
  approved_at: "2026-11-05T12:00:00Z", approval_note: null, created_at: "2026-11-05", ...over,
});
const policy = policyFromRules([
  row({ subject: "AAA", normal_low: 0.03, normal_high: 0.10, hard_max: 0.10 }),
  row({ scope: "bucket", subject: "US broad-market equity", normal_low: 0.25, normal_high: 0.40, hard_max: 0.9 }),
  row({ scope: "bucket", subject: "International equity", normal_low: 0.12, normal_high: 0.20, hard_max: 0.3 }),
  row({ scope: "portfolio", subject: "protected_reserve", value: 3000 }),
]);
const quiet = new Map([["AAA", { cik: "1", company: "AAA", filings: [{ form: "10-Q", filed: "2026-08-01", reportDate: null, description: "Quarterly report", items: [], isEarnings: true, url: "u", category: "periodic" as const, note: "" }], lastEarnings: null, nextEarningsEstimate: null, source: "s", fetchedAt: "t" }]]);
const pref = (maxTransfer: number) => ({ maxTransfer, setAt: "2026-11-09T04:30:00Z", note: null });

describe("transferable savings", () => {
  const p = (bal: number, extra: SnapshotInput[] = []) => buildPortfolio([broker(200), savingsSnap(bal), ...extra], new Map(), policy, {}, [], now);
  it("is min(limit, savings): no protected reserve is held back", () => {
    expect(transferableSavings({ portfolio: p(13000), transfers: [], preference: pref(10000), now }).amount).toBe(10000);
    expect(transferableSavings({ portfolio: p(20000), transfers: [], preference: pref(10000), now }).amount).toBe(10000);
    expect(transferableSavings({ portfolio: p(5000), transfers: [], preference: pref(10000), now }).amount).toBe(5000);
    expect(transferableSavings({ portfolio: p(3000), transfers: [], preference: pref(10000), now }).amount).toBe(3000);
    expect(transferableSavings({ portfolio: p(0), transfers: [], preference: pref(10000), now }).amount).toBe(0);
    expect(transferableSavings({ portfolio: p(13000), transfers: [], preference: pref(10000), now }).detail).not.toMatch(/reserve/);
  });
  it("counts nothing without a standing limit", () => {
    const t = transferableSavings({ portfolio: p(13000), transfers: [], preference: null, now });
    expect(t.amount).toBe(0);
    expect(t.detail).toMatch(/not set a standing transfer limit/);
  });
  it("subtracts transfers already planned, so an internal transfer is never counted twice", () => {
    const transfers = [{ id: "t", fromAccountId: "s", toAccountId: "a", amount: 1500, date: "2026-11-05", note: null, createdAt: "2026-11-05T10:00:00Z" }];
    expect(transferableSavings({ portfolio: p(13000), transfers, preference: pref(10000), now }).amount).toBe(8500);
    expect(transferableSavings({ portfolio: p(1000), transfers, preference: pref(10000), now }).amount).toBe(0);
  });
  it("adds every savings account on file and says so", () => {
    const t = transferableSavings({ portfolio: p(3000, [savingsSnap(3000, "s2", "USAA Savings")]), transfers: [], preference: pref(10000), now });
    expect(t.savings).toBe(6000);
    expect(t.detail).toMatch(/across 2 savings accounts/);
  });
});

describe("current portfolio decision", () => {
  const args = (over: Partial<Parameters<typeof currentPortfolioDecision>[0]> = {}) => ({
    portfolio: buildPortfolio([broker(200), savingsSnap(13000)], new Map(), policy, {}, [], now),
    research: [research("ADD", "Add")], policy, now, filings: quiet, holdingsConfirmed: true, preference: pref(10000), ...over,
  });

  it("uses savings only for the stock add that qualifies, and only what it needs", () => {
    const d = currentPortfolioDecision(args());
    const aaa = d.allocations.find((x) => x.symbol === "AAA")!;
    expect(aaa.amount).toBeGreaterThan(200);
    expect(d.funding.fromSavings).toBe(Math.ceil(aaa.amount - 200));
    expect(d.funding.fromSavings).toBeLessThan(10000);
    expect(d.allocations.reduce((a, x) => a + x.amount, 0)).toBeLessThanOrEqual(200 + d.funding.fromSavings + 0.01);
    expect(d.headline).toMatch(/^Add \$\d[\d,]* AAA/);
    expect(d.confirm.join(" ")).toMatch(/Transfer \$[\d,]+ from savings to Broker yourself/);
    expect(d.alternatives.map((a) => a.key)).toEqual(["add", "new", "etf", "cash"]);
  });

  it("does not move savings when no researched stock qualifies; the ETF is an alternative, not a reason to transfer", () => {
    const d = currentPortfolioDecision(args({ research: [research("HOLD / NO ADD", "Hold")] }));
    expect(d.funding.fromSavings).toBe(0);
    expect(d.headline).toMatch(/^No transfer from savings\. The \$200\.00 in Broker: (VOO|VXUS|AVUV) or keep it as cash/);
    expect(d.allocations.reduce((a, x) => a + x.amount, 0)).toBeLessThanOrEqual(200);
    expect(d.alternatives.find((a) => a.key === "etf")!.detail).toMatch(/not an opportunity the app is calling; you could move up to \$10,000/);
  });

  it("never treats savings as buying power without a standing limit", () => {
    const d = currentPortfolioDecision(args({ preference: null }));
    expect(d.funding.fromSavings).toBe(0);
    expect(d.allocations.reduce((a, x) => a + x.amount, 0)).toBeLessThanOrEqual(200);
  });

  it("projects allocation on both denominators; a transfer grows the invested portfolio but not investable capital", () => {
    const d = currentPortfolioDecision(args());
    const p = args().portfolio;
    expect(d.projected.invested).toEqual({ before: p.total, after: p.total + d.funding.fromSavings });
    expect(d.projected.investable.after).toBe(p.investableCapital);
    const aaa = d.projected.rows.find((x) => x.symbol === "AAA")!;
    expect(aaa.afterInvested).toBeLessThanOrEqual(0.10 + 1e-9); // its approved 10% limit, on the invested portfolio
    expect(aaa.afterInvestable).toBeLessThan(aaa.afterInvested);
    expect(d.projected.savingsAboveReserve.after).toBe(13000 - d.funding.fromSavings);
  });

  it("savings do not create room under a limit by being on file: only money actually moved in counts", () => {
    const withSavings = buildPortfolio([broker(200), savingsSnap(13000)], new Map(), policy, {}, [], now);
    const without = buildPortfolio([broker(200), savingsSnap(3000)], new Map(), policy, {}, [], now);
    expect(withSavings.total).toBe(without.total);
    expect(withSavings.exposures.find((e) => e.symbol === "AAA")!.headroomDollars).toBe(without.exposures.find((e) => e.symbol === "AAA")!.headroomDollars);
    expect(withSavings.holdings.map((h) => h.weight)).toEqual(without.holdings.map((h) => h.weight));
    expect(withSavings.investableCapital - without.investableCapital).toBe(10000);
  });

  it("does nothing when there is no cash and nothing qualifies", () => {
    const d = currentPortfolioDecision(args({ portfolio: buildPortfolio([broker(0), savingsSnap(3000)], new Map(), policy, {}, [], now), research: [research("HOLD / NO ADD", "Hold")] }));
    expect(d.allocations).toEqual([]);
    expect(d.headline).toMatch(/^Do nothing now/);
  });
});

describe("capital preference row", () => {
  it("reads the newest row and honours a cleared one", () => {
    expect(preferenceFromRow({ outputs: { max_transfer: 10000 }, computed_at: "t" })).toEqual({ maxTransfer: 10000, setAt: "t", note: null });
    expect(preferenceFromRow({ outputs: { cleared: true }, computed_at: "t" })).toBeNull();
    expect(preferenceFromRow(null)).toBeNull();
  });
});
