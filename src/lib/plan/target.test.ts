import { describe, expect, it } from "vitest";
import { buildPortfolio, type SnapshotInput } from "@/lib/portfolio/engine";
import { toResearchRecord } from "@/lib/research/records";
import { DEFAULT_PLAN, buyLevelOf, planFrom, planStatus } from "./target";

// Synthetic data only.
const now = new Date("2026-11-17T16:00:00Z");
const broker: SnapshotInput = {
  accountId: "b", accountName: "Broker", accountRole: "taxable_brokerage", asOf: "2026-11-17T14:00:00Z", sourceKind: "schwab_api", totalValue: null, cashValue: 1000,
  positions: [
    { symbol: "VOO", quantity: 10, price: 600, marketValue: 6000, costBasis: 6000 },
    { symbol: "VXUS", quantity: 20, price: 100, marketValue: 2000, costBasis: 2000 },
    { symbol: "AAA", quantity: 10, price: 100, marketValue: 1000, costBasis: 1000 },
  ],
};
const robo: SnapshotInput = { accountId: "r", accountName: "Robo", accountRole: "taxable_brokerage", asOf: "2026-09-30T21:00:00Z", totalValue: null, cashValue: 0, positions: [{ symbol: "VOO", quantity: 5, price: 600, marketValue: 3000, costBasis: 3000 }] };
const p = buildPortfolio([broker, robo], new Map(), null, {}, [], now, [], { amount: 10000, setAt: "2026-11-16T12:00:00Z" });
const rec = (symbol: string, action: string) => toResearchRecord(symbol, symbol, "watch", [{ id: symbol, research_as_of: "2026-11-10", completeness: "complete", origin: "claude_full", is_current: true, conclusion: { review_state: "adopted", action } }]);

describe("your plan", () => {
  it("reads buy levels from research actions", () => {
    expect(buyLevelOf("Watch. No new money now. Consider a small starter only below about $345 (about 10%)")).toBe(345);
    expect(buyLevelOf("Hold / no add (reconsider adding below ~$230; trim only above ~$330)")).toBe(230);
    expect(buyLevelOf("Hold / no add (consider a small add below $70 only after user trends stabilise)")).toBe(70);
    expect(buyLevelOf("Hold, no add. No trade before the results.")).toBeNull();
  });
  it("measures the investing account plus outside money, leaving other accounts out", () => {
    const st = planStatus(DEFAULT_PLAN, p, [], new Map(), "2026-11-17");
    expect(st.base).toBe(6000 + 2000 + 1000 + 1000 + 10000);
    const us = st.sleeves.find((s) => s.key === "us")!;
    expect(us.value).toBe(6000); // the other account's VOO is not counted
    expect(us.targetValue).toBe(9000);
    expect(us.gap).toBe(3000);
    expect(st.sleeves.find((s) => s.key === "stocks")!.value).toBe(1000);
  });
  it("shows the next dated step and the stocks nearest their buy levels", () => {
    const st = planStatus(DEFAULT_PLAN, p, [rec("ZZZ", "Watch; starter below about $90"), rec("YYY", "Watch; starter below about $50")], new Map([["ZZZ", 99], ["YYY", 100]]), "2026-11-19");
    expect(st.next?.date).toBe("2026-12-01");
    expect(st.earlier.map((s) => s.date)).toEqual(["2026-11-18"]);
    expect(st.waiting.map((w) => w.symbol)).toEqual(["ZZZ", "YYY"]);
    expect(st.waiting[0].away).toBeCloseTo(0.1, 5);
  });
  it("warns when stocks pass their limits", () => {
    const heavy = buildPortfolio([{ ...broker, positions: [{ symbol: "AAA", quantity: 100, price: 100, marketValue: 10000, costBasis: 10000 }] }], new Map(), null, {}, [], now);
    const st = planStatus(DEFAULT_PLAN, heavy, [], new Map(), "2026-11-17");
    expect(st.warnings.join(" ")).toMatch(/Stocks are 91%.*AAA is 90\.9%/);
  });
  it("falls back to the agreed plan when a saved one is malformed", () => {
    expect(planFrom(null)).toBe(DEFAULT_PLAN);
    expect(planFrom({ sleeves: [{ key: "us", label: "x", buy: "VOO", target: 0.5 }], steps: [] })).toBe(DEFAULT_PLAN);
  });
});
