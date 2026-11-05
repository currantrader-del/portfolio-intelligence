import { describe, expect, it } from "vitest";
import { buildPortfolio, type SnapshotInput } from "./engine";
import type { Quote } from "@/lib/market/quotes";

const snap = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  accountId: "a1", accountName: "Broker", accountRole: "taxable_brokerage", asOf: "2026-10-31T21:00:00Z", totalValue: 1100, cashValue: 100,
  positions: [
    { symbol: "VOO", quantity: 1, price: 600, marketValue: 600, costBasis: 500 },
    { symbol: "AAA", quantity: 10, price: 40, marketValue: 400, costBasis: 450 },
  ],
  ...over,
});
const q = (symbol: string, price: number, prevClose: number): Quote => ({ symbol, price, prevClose, asOf: "2026-11-05T16:00:00Z", provider: "yahoo", delayClass: "delayed" });

describe("portfolio engine", () => {
  it("falls back to statement prices when there are no quotes", () => {
    const p = buildPortfolio([snap()], new Map(), null);
    expect(p.total).toBe(1100);
    expect(p.cash).toBe(100);
    expect(p.dayDollar).toBeNull();
    expect(p.holdings[0]).toMatchObject({ symbol: "VOO", priceSource: "statement", value: 600, unrealized: 100 });
  });

  it("reprices with quotes and attributes the day's move", () => {
    const quotes = new Map([["VOO", q("VOO", 594, 600)], ["AAA", q("AAA", 36, 40)]]);
    const p = buildPortfolio([snap()], quotes, null, { AAA: "Speculative" });
    // VOO -6, AAA -40 -> -46 on a 1100 start
    expect(p.dayDollar).toBe(-46);
    expect(p.dayPct).toBeCloseTo(-46 / 1100, 6);
    const aaa = p.holdings.find((h) => h.symbol === "AAA")!;
    expect(aaa.contributionPts).toBeCloseTo((-40 / 1100) * 100, 6);
    expect(aaa.bucket).toBe("Asymmetric/high-risk growth sleeve");
  });

  it("combines accounts and leaves cost basis unknown when any lot lacks it", () => {
    const b = snap({ accountId: "a2", accountName: "Acorns", cashValue: 0, positions: [{ symbol: "VOO", quantity: 1, price: 600, marketValue: 600, costBasis: null }] });
    const p = buildPortfolio([snap(), b], new Map(), null);
    const voo = p.holdings.find((h) => h.symbol === "VOO")!;
    expect(voo.quantity).toBe(2);
    expect(voo.costBasis).toBeNull();
    expect(voo.accounts).toEqual(["Broker", "Acorns"]);
  });

  it("adds ETF look-through to company exposure", () => {
    const s = snap({ cashValue: 0, positions: [
      { symbol: "VOO", quantity: 1, price: 1000, marketValue: 1000, costBasis: null },
      { symbol: "NVDA", quantity: 1, price: 100, marketValue: 100, costBasis: null },
    ] });
    const p = buildPortfolio([s], new Map(), null);
    const nvda = p.exposures.find((e) => e.symbol === "NVDA")!;
    expect(nvda.viaEtfs).toBeCloseTo(75 / 1100, 6);
    expect(nvda.total).toBeCloseTo(175 / 1100, 6);
  });
});
