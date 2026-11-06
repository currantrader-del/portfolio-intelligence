import { describe, expect, it } from "vitest";
import { align, beta, buildRisk, maxDrawdown, worstWindow } from "./risk";
import { parseStooqHistory, parseYahooHistory, type History } from "@/lib/market/history";

const days = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10));
const hist = (symbol: string, closes: number[], start = 0): History => {
  const d = days(closes.length + start).slice(start);
  return { symbol, bars: closes.map((close, i) => ({ date: d[i], close })), provider: "yahoo", adjusted: true, fetchedAt: "" };
};

describe("history parsing", () => {
  it("reads Yahoo daily bars, preferring adjusted closes and skipping gaps", () => {
    const body = { chart: { result: [{ timestamp: [1767276000, 1767362400, 1767448800], meta: { exchangeTimezoneName: "America/New_York" }, indicators: { quote: [{ close: [10, 11, 12] }], adjclose: [{ adjclose: [9.5, null, 11.5] }] } }] } };
    const h = parseYahooHistory("AAA", body)!;
    expect(h.adjusted).toBe(true);
    expect(h.bars.map((b) => b.close)).toEqual([9.5, 11.5]);
  });
  it("reads Stooq CSV", () => {
    const h = parseStooqHistory("AAA", "Date,Open,High,Low,Close,Volume\n2026-01-02,1,1,1,10,5\n2026-01-05,1,1,1,11,5\nbad,row")!;
    expect(h.bars).toEqual([{ date: "2026-01-02", close: 10 }, { date: "2026-01-05", close: 11 }]);
  });
});

describe("risk math", () => {
  it("aligns and carries forward, using the first close before a late start", () => {
    const a = align(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"], hist("AAA", [5, 6], 1));
    expect(a.closes).toEqual([5, 5, 6, 6]);
  });
  it("computes drawdown, worst window and beta", () => {
    expect(maxDrawdown([100, 120, 90, 130], ["a", "b", "c", "d"])).toEqual({ dd: -0.25, from: "b", to: "c" });
    expect(worstWindow([100, 90, 80, 100], ["a", "b", "c", "d"], 2)).toMatchObject({ ret: expect.closeTo(-0.2), from: "a", to: "c" });
    const b = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.01 : -0.01));
    expect(beta(b.map((x) => 2 * x), b)).toBeCloseTo(2);
    expect(beta([0.1], [0.1])).toBeNull();
  });

  it("builds a hypothetical series and beta-driven scenarios, leaving cash alone", () => {
    const n = 60;
    const spy = Array.from({ length: n }, (_, i) => 100 * (1 + 0.01 * Math.sin(i)));
    const aaa = spy.map((x, i) => (i === 0 ? 50 : 50 * (1 + 2 * (x / spy[0] - 1))));
    const histories = new Map([["SPY", hist("SPY", spy)], ["QQQ", hist("QQQ", spy)], ["SOXX", hist("SOXX", spy)], ["AAA", hist("AAA", aaa)]]);
    const lastA = aaa[n - 1];
    const r = buildRisk({ positions: [{ symbol: "AAA", quantity: 10, value: 10 * lastA }], cash: 1000, investable: 1000 + 10 * lastA, histories });
    expect(r.series).toHaveLength(n);
    expect(r.series[n - 1].value).toBeCloseTo(1000 + 10 * lastA);
    const h = r.holdings[0];
    expect(h.beta).toBeGreaterThan(1.8);
    const s = r.scenarios.find((x) => x.key === "spy20")!;
    expect(s.dollars).toBeCloseTo(10 * lastA * h.beta! * -0.2, 6);
    expect(r.scenarios.find((x) => x.key === "single50")?.dollars).toBeCloseTo(-5 * lastA);
    expect(r.concentration.largest?.symbol).toBe("AAA");
  });

  it("lists holdings with no history instead of inventing it", () => {
    const histories = new Map([["SPY", hist("SPY", Array.from({ length: 30 }, (_, i) => 100 + i))]]);
    const r = buildRisk({ positions: [{ symbol: "BBB", quantity: 1, value: 100 }], cash: 0, investable: 100, histories });
    expect(r.missing).toEqual(["BBB"]);
    expect(r.series.every((p) => p.value === 100)).toBe(true);
  });
});

import { holdingsPeriodChange, periodMoves } from "./risk";
describe("period moves", () => {
  it("measures a week of change for symbols and for today's holdings", () => {
    const h = new Map([["AAA", hist("AAA", [10, 10, 10, 11, 12, 12, 15])]]);
    expect(periodMoves(h, ["AAA", "ZZZ"], 5)).toEqual([{ symbol: "AAA", from: "2026-01-02", to: "2026-01-07", change: 0.5 }]);
    expect(holdingsPeriodChange([{ symbol: "AAA", quantity: 2, value: 30 }], h, 5, 100)).toEqual({ dollars: 10, pct: 0.1, covered: 30 });
  });
});
