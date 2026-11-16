import { describe, expect, it } from "vitest";
import { buildPortfolio, type SnapshotInput } from "@/lib/portfolio/engine";
import { policyFromRules, type PolicyRuleRow } from "@/lib/policy/rules";
import { etfCheckQuestion, etfFacts, validateEtfCheck } from "./etf";

// Synthetic data only.
const now = new Date("2026-11-16T16:00:00Z");
const snap: SnapshotInput = {
  accountId: "a", accountName: "Broker", accountRole: "taxable_brokerage", asOf: "2026-11-16T14:00:00Z", totalValue: null, cashValue: 1000,
  positions: [
    { symbol: "VOO", quantity: 10, price: 700, marketValue: 7000, costBasis: 7000 },
    { symbol: "AVUV", quantity: 10, price: 100, marketValue: 1000, costBasis: 1000 },
    { symbol: "NVDA", quantity: 5, price: 200, marketValue: 1000, costBasis: 1000 },
  ],
};
const row = (over: Partial<PolicyRuleRow>): PolicyRuleRow => ({
  id: Math.random().toString(36).slice(2), scope: "bucket", subject: "Small/mid-cap", normal_low: 0.05, normal_high: 0.12, high_conviction_low: null, high_conviction_high: null,
  hard_max: 0.2, value: null, conditions: null, source_label: "Test", source_date: null, source_status: "latest_approved", approval: "approved",
  approved_at: "2026-11-05T12:00:00Z", approval_note: null, created_at: "2026-11-05", ...over,
});
const p = buildPortfolio([snap], new Map(), policyFromRules([row({})]), {}, [], now);

describe("ETF facts (free, from the app's own data)", () => {
  it("shows what you hold, the policy group and the room left in it", () => {
    const f = etfFacts("avuv", p, now);
    expect(f.symbol).toBe("AVUV");
    expect(f.held).toMatchObject({ value: 1000 });
    expect(f.bucket).toBe("Small/mid-cap");
    expect(f.group).toMatchObject({ low: 0.05, high: 0.12, roomToHigh: 200 }); // 12% of $10,000 minus $1,000 held
    expect(f.profile?.holdingsCount).toBeGreaterThan(100);
  });
  it("finds your stocks among a fund's largest holdings", () => {
    const f = etfFacts("VOO", p, now);
    expect(f.overlaps.find((o) => o.with === "NVDA")).toMatchObject({ kind: "stock" });
  });
  it("says plainly when the app has no fund data", () => {
    const f = etfFacts("ZZZZ", p, now);
    expect(f.profile).toBeNull();
    expect(f.gaps.join(" ")).toMatch(/no holdings data on file/);
    expect(etfCheckQuestion({ symbol: "ZZZZ", today: "2026-11-16", facts: f, price: null })).toMatch(/no fund data on file/);
  });
});

describe("ETF check answer", () => {
  const good = {
    as_of: "2026-11-16", name: "Avantis U.S. Small Cap Value ETF", expense_ratio_pct: 0.25, aum_usd_bn: 15, holdings_count: 790,
    valuation: { pe: 11.5, pb: 1.4, vs_sp500: "Much cheaper than the S&P 500 (P/E about 25)." }, factor_tilt: "Small, value, profitable.",
    returns: { y1_pct: 8, y3_ann_pct: 9, y5_ann_pct: 14, voo_y1_pct: 15, voo_y5_ann_pct: 15, as_of: "2026-10-31" },
    role: "Small-cap value diversifier.", risks: ["Value can lag for years"], verdict: "Add", amount: "$500", why: "Room under the range; little overlap.",
    sources: [{ title: "Avantis", url: "https://avantisinvestors.com/x", date: "2026-11-15" }], not_verified: [],
  };
  it("accepts a well-formed answer", () => {
    const c = validateEtfCheck(good, "2026-11-16");
    expect("error" in c).toBe(false);
    expect(c).toMatchObject({ verdict: "Add", amount: "$500", expense_ratio_pct: 0.25 });
  });
  it("refuses an answer without a verdict, sources or a reason, and drops impossible numbers", () => {
    expect(validateEtfCheck({ ...good, verdict: "Buy now!" }, "2026-11-16")).toMatchObject({ error: expect.stringMatching(/verdict/) });
    expect(validateEtfCheck({ ...good, sources: [] }, "2026-11-16")).toMatchObject({ error: expect.stringMatching(/sources/) });
    expect(validateEtfCheck({ ...good, why: "" }, "2026-11-16")).toMatchObject({ error: expect.stringMatching(/reason/) });
    const c = validateEtfCheck({ ...good, expense_ratio_pct: 40, verdict: "Hold" }, "2026-11-16");
    expect(c).toMatchObject({ expense_ratio_pct: null, amount: "" });
  });
});
