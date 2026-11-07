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

  it("rolls holdings forward with recorded trades and keeps the estimate label", () => {
    const now = new Date("2026-11-05T16:00:00Z");
    const ledger = [
      { accountId: "a1", tradeDate: "2026-11-03", kind: "buy" as const, symbol: "AAA", quantity: 5, price: 38, amount: -190 },
      { accountId: "a1", tradeDate: "2026-11-04", kind: "deposit" as const, symbol: null, quantity: null, price: null, amount: 500 },
      { accountId: "a1", tradeDate: "2026-10-30", kind: "buy" as const, symbol: "AAA", quantity: 99, price: 1, amount: -99 }, // before the statement: ignored
    ];
    const p = buildPortfolio([snap()], new Map(), null, {}, ledger, now);
    const aaa = p.holdings.find((h) => h.symbol === "AAA")!;
    expect(aaa.quantity).toBe(15);
    expect(aaa.costBasis).toBe(450 + 190);
    expect(p.cashDetail.brokerage).toBe(100 - 190 + 500);
    expect(p.accounts[0].tradesAfter).toBe(2);
    expect(p.quality.status).toBe("estimated");
    expect(p.quality.reasons[0]).toMatch(/plus trades you recorded since/);
  });

  it("separates brokerage cash, deployable savings and the protected reserve", () => {
    const sav: SnapshotInput = { accountId: "s", accountName: "Savings", accountRole: "cash", asOf: "2026-11-04T23:59:00Z", totalValue: 14000, cashValue: 14000, positions: [] };
    const p = buildPortfolio([snap(), sav], new Map(), null);
    expect(p.cashDetail).toMatchObject({ brokerage: 100, savings: 14000, protectedReserve: 10000, deployableSavings: 4000, deployable: 4100 });
    // the reserve is excluded from the denominator
    expect(p.total).toBe(1000 + 100 + 4000);
    expect(p.holdings.find((h) => h.symbol === "VOO")!.weight).toBeCloseTo(600 / 5100, 6);
    expect(p.netWorthTracked).toBe(15100);
  });

  it("flags missing savings and statements that do not add up", () => {
    const p = buildPortfolio([snap({ totalValue: 1200 })], new Map(), null);
    expect(p.cashDetail.savings).toBeNull();
    expect(p.accounts[0].statementGap).toBe(100);
    expect(p.quality.missing.join(" ")).toMatch(/Savings balance not entered/);
    expect(p.quality.missing.join(" ")).toMatch(/differs from its positions plus cash by \$100.00/);
  });

  it("day contributions add up to the portfolio's day change", () => {
    const quotes = new Map([["VOO", q("VOO", 594, 600)], ["AAA", q("AAA", 42, 40)]]);
    const p = buildPortfolio([snap()], quotes, null);
    const sum = p.holdings.reduce((a, h) => a + (h.contributionPts ?? 0), 0);
    expect(sum / 100).toBeCloseTo(p.dayPct!, 10);
    expect(p.holdings.reduce((a, h) => a + h.weight, 0) + p.cash / p.total).toBeCloseTo(1, 10);
  });
});
