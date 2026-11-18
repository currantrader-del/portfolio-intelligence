import { describe, expect, it } from "vitest";
import { buildPortfolio, type SnapshotInput } from "@/lib/portfolio/engine";
import { policyFromRules, type PolicyRuleRow } from "@/lib/policy/rules";
import { toResearchRecord } from "@/lib/research/records";
import { currentPortfolioDecision, outsideAvailable, preferenceFromRow } from "./currentPortfolio";

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
const pref = (amount: number) => ({ amount, setAt: "2026-11-01T04:30:00Z", note: null });
const outside = (amount: number) => ({ amount, setAt: "2026-11-01T04:30:00Z" });
const port = (cash: number, figure: number | null, ledger: Parameters<typeof buildPortfolio>[4] = [], extra: SnapshotInput[] = []) =>
  buildPortfolio([broker(cash), ...extra], new Map(), policy, {}, ledger, now, [], figure === null ? null : outside(figure));

describe("outside money available (2026-11-16: a standing figure, no savings balance, no reserve)", () => {
  it("is your figure, whatever any old savings balance on file says", () => {
    expect(outsideAvailable({ portfolio: port(200, 10000), plannedIn: 0 }).amount).toBe(10000);
    expect(outsideAvailable({ portfolio: port(200, 10000, [], [savingsSnap(500)]), plannedIn: 0 }).amount).toBe(10000);
    expect(outsideAvailable({ portfolio: port(200, 10000), plannedIn: 0 }).detail).not.toMatch(/reserve|savings/i);
  });
  it("counts nothing without a figure", () => {
    const t = outsideAvailable({ portfolio: port(200, null), plannedIn: 0 });
    expect(t.amount).toBe(0);
    expect(t.detail).toMatch(/have not entered/);
  });
  it("takes off a deposit that reached the brokerage after the figure was set, so it is never counted twice", () => {
    const dep = [{ accountId: "a", tradeDate: "2026-11-03", kind: "deposit" as const, symbol: null, quantity: null, price: null, amount: 2500 }];
    const p = port(200, 10000, dep);
    expect(p.cashDetail.outside).toMatchObject({ figure: 10000, movedIn: 2500, remaining: 7500 });
    expect(outsideAvailable({ portfolio: p, plannedIn: 0 }).amount).toBe(7500);
    // A deposit before the figure was set, or into another account, is not taken off.
    const early = [{ ...dep[0], tradeDate: "2026-10-20" }, { ...dep[0], accountId: "acorns" }];
    expect(port(200, 10000, early).cashDetail.outside.remaining).toBe(10000);
  });
  it("subtracts transfers already planned into the brokerage", () => {
    expect(outsideAvailable({ portfolio: port(200, 10000), plannedIn: 1500 }).amount).toBe(8500);
  });
  it("never changes the portfolio value, weights or room under a limit", () => {
    const withIt = port(200, 10000), without = port(200, null);
    expect(withIt.total).toBe(without.total);
    expect(withIt.holdings.map((h) => h.weight)).toEqual(without.holdings.map((h) => h.weight));
    expect(withIt.exposures.find((e) => e.symbol === "AAA")!.headroomDollars).toBe(without.exposures.find((e) => e.symbol === "AAA")!.headroomDollars);
    expect(withIt.investableCapital - without.investableCapital).toBe(10000);
  });
  it("leaves savings-account snapshots out of every figure", () => {
    expect(port(200, null, [], [savingsSnap(13000)]).total).toBe(port(200, null).total);
    expect(port(200, null, [], [savingsSnap(13000)]).cashDetail.accounts.map((a) => a.id)).toEqual(["a"]);
  });
});

describe("current portfolio decision", () => {
  const args = (over: Partial<Parameters<typeof currentPortfolioDecision>[0]> = {}) => ({
    portfolio: port(200, 10000),
    research: [research("ADD", "Add")], policy, now, filings: quiet, holdingsConfirmed: true, preference: pref(10000), ...over,
  });

  it("uses outside money only for the stock add that qualifies, only what it needs, and says to transfer it first", () => {
    const d = currentPortfolioDecision(args());
    const aaa = d.allocations.find((x) => x.symbol === "AAA")!;
    expect(aaa.amount).toBeGreaterThan(200);
    expect(d.funding.fromOutside).toBe(Math.ceil(aaa.amount - 200));
    expect(d.funding.fromOutside).toBeLessThan(10000);
    expect(d.allocations.reduce((a, x) => a + x.amount, 0)).toBeLessThanOrEqual(200 + d.funding.fromOutside + 0.01);
    expect(d.headline).toMatch(/^Add \$\d[\d,]* AAA/);
    expect(d.why).toMatch(/transfer \$[\d,]+ of the \$10,000 outside money to Broker first/);
    expect(d.confirm.join(" ")).toMatch(/Transfer \$[\d,]+ to Broker yourself first/);
    expect(d.alternatives.map((a) => a.key)).toEqual(["add", "new", "etf", "cash"]);
  });

  it("keeps the outside money where it is when no researched stock qualifies; the ETF is an alternative, not a reason to transfer", () => {
    const d = currentPortfolioDecision(args({ research: [research("HOLD / NO ADD", "Hold")] }));
    expect(d.funding.fromOutside).toBe(0);
    expect(d.headline).toMatch(/^Keep the \$10,000 where it is\. The \$200\.00 in Broker: (VOO|VXUS|AVUV) or keep it as cash/);
    expect(d.allocations.reduce((a, x) => a + x.amount, 0)).toBeLessThanOrEqual(200);
    expect(d.alternatives.find((a) => a.key === "etf")!.detail).toMatch(/not an opportunity the app is calling; you could move up to \$10,000/);
  });

  it("never treats outside money as buying power without a figure", () => {
    const d = currentPortfolioDecision(args({ portfolio: port(200, null), preference: null }));
    expect(d.funding.fromOutside).toBe(0);
    expect(d.allocations.reduce((a, x) => a + x.amount, 0)).toBeLessThanOrEqual(200);
  });

  it("projects allocation on both denominators; a transfer grows the invested portfolio but not investable capital", () => {
    const d = currentPortfolioDecision(args());
    const p = args().portfolio;
    expect(d.projected.invested).toEqual({ before: p.total, after: p.total + d.funding.fromOutside });
    expect(d.projected.investable.after).toBe(p.investableCapital);
    const aaa = d.projected.rows.find((x) => x.symbol === "AAA")!;
    expect(aaa.afterInvested).toBeLessThanOrEqual(0.10 + 1e-9);
    expect(aaa.afterInvestable).toBeLessThan(aaa.afterInvested);
    expect(d.projected.outside.after).toBe(10000 - d.funding.fromOutside);
  });

  it("does nothing when there is no cash and nothing qualifies", () => {
    const d = currentPortfolioDecision(args({ portfolio: port(0, 10000), research: [research("HOLD / NO ADD", "Hold")] }));
    expect(d.allocations).toEqual([]);
    expect(d.headline).toMatch(/^Do nothing now: keep the \$10,000 where it is/);
  });
});

describe("capital preference row", () => {
  it("reads the newest row and honours a cleared one", () => {
    expect(preferenceFromRow({ outputs: { max_transfer: 10000 }, computed_at: "t" })).toEqual({ amount: 10000, setAt: "t", note: null });
    expect(preferenceFromRow({ outputs: { outside_capital: 8000 }, computed_at: "t" })).toEqual({ amount: 8000, setAt: "t", note: null });
    expect(preferenceFromRow({ outputs: { cleared: true }, computed_at: "t" })).toBeNull();
    expect(preferenceFromRow(null)).toBeNull();
  });
});
