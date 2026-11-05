import { describe, expect, it } from "vitest";
import { buildPortfolio, type SnapshotInput } from "@/lib/portfolio/engine";
import { readPolicy } from "@/lib/policy/limits";
import { toResearchRecord } from "@/lib/research/records";
import { newCapital } from "./newCapital";

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
const policy = readPolicy("v2", {
  target_allocation_policies: { latest_approved_v2_revised: [
    { bucket: "U.S. broad-market equity", normal: "25-40%", hard_max: "50%" },
    { bucket: "International equity", normal: "12-20%", hard_max: "30%" },
  ] },
  single_company_frameworks: { latest_approved_v2_revised: { AAA: { normal: "~3-10%", conditional_hard_max: "~10%" } } },
});
const irenVersion = (completeness: string) => ({
  id: "v1", research_as_of: "2026-09-10", completeness, origin: "chatgpt_original", is_current: true,
  conclusion: { action: "HOLD / NO ADD", classification: "Speculative", reference_price: "$30", reference_date: "2026-09-10",
    valuation: { approx_holding_period_years: 4, bear_value: 20, base_value: 90, bull_value: 200, bear_probability: 0.3, base_probability: 0.5, bull_probability: 0.2 },
    price_framework: [{ price_zone: "< $35", action: "Strong Add research trigger" }] },
});

describe("new capital decision", () => {
  it("sends cash to a researched stock whose expected return clears the hurdle, capped by its limit", () => {
    const p = buildPortfolio([snap], new Map(), policy);
    const research = [toResearchRecord("AAA", "AAA", "held", [irenVersion("complete")]), toResearchRecord("BBB", "Bco", "held", [
      { id: "g1", research_as_of: "2026-09-12", completeness: "partial", origin: "chatgpt_original", is_current: false, conclusion: {} },
      { id: "g2", research_as_of: "2026-09-26", completeness: "partial", origin: "chatgpt_original", is_current: false, conclusion: {} },
    ])];
    const r = newCapital({ amount: 1250, portfolio: p, research, policy, now });
    const aaa = r.options.find((o) => o.symbol === "AAA")!;
    expect(aaa.eligible).toBe(true);
    expect(aaa.zoneAction).toBe("Strong Add research trigger");
    const bbb = r.options.find((o) => o.symbol === "BBB")!;
    expect(bbb.eligible).toBe(false);
    expect(bbb.notes.join(" ")).toMatch(/conflict/);
    const total = r.recommendation.allocations.reduce((a, x) => a + x.amount, 0);
    expect(total).toBeCloseTo(1250, 2);
    const irenAlloc = r.recommendation.allocations.find((x) => x.symbol === "AAA")!.amount;
    // 10% of (9700 + 1250) - 500 = 595 headroom
    expect(irenAlloc).toBe(595);
    expect(r.options.at(-1)!.kind).toBe("cash");
  });

  it("caps partial research at half the new cash and lowers confidence", () => {
    const p = buildPortfolio([snap], new Map(), policy);
    const full = newCapital({ amount: 400, portfolio: p, research: [toResearchRecord("AAA", null, "held", [irenVersion("complete")])], policy, now });
    const part = newCapital({ amount: 400, portfolio: p, research: [toResearchRecord("AAA", null, "held", [irenVersion("partial")])], policy, now });
    expect(full.recommendation.allocations[0]).toEqual({ symbol: "AAA", amount: 400 });
    expect(part.recommendation.allocations[0]).toEqual({ symbol: "AAA", amount: 200 });
    expect(part.recommendation.confidence).toBeLessThan(full.recommendation.confidence);
  });

  it("falls back to the most underweight core ETF when no stock qualifies", () => {
    const p = buildPortfolio([snap], new Map(), policy);
    const r = newCapital({ amount: 1000, portfolio: p, research: [], policy, now });
    expect(r.recommendation.allocations).toEqual([{ symbol: "VXUS", amount: 1000 }]);
  });
});

describe("new capital ceilings", () => {
  it("fills a stock only to the top of its normal range, then moves on", () => {
    const tight = readPolicy("v2", {
      target_allocation_policies: { latest_approved_v2_revised: [{ bucket: "International equity", normal: "12-20%", hard_max: "30%" }] },
      single_company_frameworks: { latest_approved_v2_revised: { AAA: { normal: "~3-5%", conditional_hard_max: "~10%" } } },
    });
    const p = buildPortfolio([snap], new Map(), tight);
    const r = newCapital({ amount: 1250, portfolio: p, research: [toResearchRecord("AAA", null, "held", [irenVersion("complete")])], policy: tight, now });
    // 5% of (9700 + 1250) - 500 = 47.5
    expect(r.recommendation.allocations[0]).toEqual({ symbol: "AAA", amount: 47 });
    expect(r.recommendation.allocations[1].amount).toBeCloseTo(1203, 0);
    expect(r.options.find((o) => o.symbol === "AAA")!.notes.join(" ")).toMatch(/normal range/);
  });
});

describe("refresh first", () => {
  it("holds back a stock whose price fell far below its research reference", () => {
    const p = buildPortfolio([snap], new Map(), policy);
    const v = irenVersion("complete");
    v.conclusion.reference_price = "$50";
    const r = newCapital({ amount: 1000, portfolio: p, research: [toResearchRecord("AAA", null, "held", [v])], policy, now });
    const aaa = r.options.find((o) => o.symbol === "AAA")!;
    expect(aaa.eligible).toBe(false);
    expect(aaa.refreshFirst).toBe(true);
    expect(r.recommendation.allocations).toEqual([{ symbol: "VXUS", amount: 1000 }]);
    expect(r.recommendation.wouldChange[0]).toMatch(/targeted research refresh on AAA/);
  });
});
