import { describe, expect, it } from "vitest";
import type { Bar } from "@/lib/market/history";
import { checkOwnTrades, closeIsFinal, proposalsFromPlan, shadowReport, startDateFor, startFromHistory, type ShadowTest } from "./shadow";

// Made-up numbers only (the repo is public).
const days = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17"];
const series = (closes: number[], raw?: number[]): Bar[] => days.map((date, i) => ({ date, close: closes[i], ...(raw ? { raw: raw[i] } : {}) }));
const hist = new Map<string, Bar[]>([
  ["VOO", series([100, 101, 104, 103, 108, 110])],
  ["RDDT", series([200, 190, 195, 185, 182, 180])],
  // A dividend after the start: adjusted closes sit below the raw ones; the start price is the raw close.
  ["AVUV", series([49.5, 50, 51, 52, 53, 54.45], [50, 50.5, 51.5, 52.5, 53.5, 55])],
]);
const test = (o: Partial<ShadowTest> = {}): ShadowTest => ({
  id: "t1", name: "Trim RDDT, buy AVUV", origin: "you", createdAt: "2026-11-10T15:00:00Z", startDate: "2026-11-10", rationale: "",
  source: { planAt: null, researchVersionId: null, researchAsOf: null, action: null },
  base: { holdings: [{ symbol: "RDDT", qty: 10, avgCost: 150, price: 199 }, { symbol: "VOO", qty: 5, avgCost: 90, price: 99 }], cash: 100, accountIds: ["a1"], holdingsAsOf: "2026-11-05", estimated: true },
  trades: [{ side: "sell", symbol: "RDDT", amount: 50, unit: "pct_holding" }, { side: "buy", symbol: "AVUV", amount: 100, unit: "pct_proceeds" }],
  assumptions: { costRate: 0.0005, taxRate: 0.22 }, ...o,
});
const after = new Date("2026-11-18T14:00:00Z");

describe("shadow test start", () => {
  it("starts at the first close after creation, never before", () => {
    expect(startDateFor(new Date("2026-11-10T15:00:00Z"))).toBe("2026-11-10"); // Tue 10 AM ET
    expect(startDateFor(new Date("2026-11-10T22:00:00Z"))).toBe("2026-11-11"); // Tue 5 PM ET
    expect(startDateFor(new Date("2026-11-13T22:00:00Z"))).toBe("2026-11-16"); // Fri evening -> Mon
    expect(closeIsFinal("2026-11-10", new Date("2026-11-10T20:30:00Z"))).toBe(false); // 3:30 PM ET
    expect(closeIsFinal("2026-11-10", new Date("2026-11-10T21:20:00Z"))).toBe(true);
    expect(startFromHistory(test(), hist, new Date("2026-11-10T20:30:00Z"))).toBeNull();
    expect(startFromHistory(test(), hist, after)).toEqual({ testId: "t1", startDate: "2026-11-10", prices: { VOO: 100, RDDT: 200, AVUV: 50 } });
  });
  it("is pending until the start close exists", () => {
    const r = shadowReport(test(), null, [], hist, null);
    expect(r.status).toBe("pending");
    expect(r.now).toBeNull();
  });
});

describe("shadow test results", () => {
  const start = startFromHistory(test(), hist, after)!;
  it("applies the trades at the start close with costs, and estimates tax separately", () => {
    const r = shadowReport(test(), start, [], hist, null);
    expect(r.resolved!.startValue).toBe(2600);
    expect(r.resolved!.trades.map((t) => [t.side, t.symbol, Math.round(t.qty * 100) / 100, t.price])).toEqual([["sell", "RDDT", 5, 200], ["buy", "AVUV", 19.98, 50]]);
    expect(r.resolved!.costs).toBe(1);
    expect(r.resolved!.taxEstimate).toBe(55); // 22% of the $250 gain
    expect(r.resolved!.exposure.find((e) => e.symbol === "RDDT")).toEqual({ symbol: "RDDT", before: 76.92, after: 38.48 });
    // One week later: total return from adjusted closes.
    const w = r.horizons.find((h) => h.key === "1w")!.results!;
    expect(w.original).toEqual({ value: 2450, gain: -150, pct: -5.77 });
    expect(w.hypothetical.value).toBeCloseTo(2648.9, 0);
    expect(w.voo).toEqual({ value: 2860, gain: 260, pct: 10 });
    expect(r.horizons.find((h) => h.key === "1m")!.results).toBeNull();
    expect(r.risk!.original.largest).toEqual({ symbol: "RDDT", pct: 73.47 });
    expect(r.risk!.voo.maxDrawdown).toBeCloseTo(-1, 1);
    expect(r.risk!.voo.volatility).not.toBeNull();
  });
  it("adds deposits to every portfolio as cash, and tracks your real trades in the actual portfolio", () => {
    const ledger = [
      { accountId: "a1", tradeDate: "2026-11-12", kind: "transfer_in", symbol: null, quantity: null, price: null, amount: 500 },
      { accountId: "a1", tradeDate: "2026-11-12", kind: "buy", symbol: "VOO", quantity: 2, price: 104, amount: -208 },
      { accountId: "a1", tradeDate: "2026-11-12", kind: "dividend", symbol: "VOO", quantity: null, price: null, amount: 3 },
      { accountId: "other", tradeDate: "2026-11-12", kind: "deposit", symbol: null, quantity: null, price: null, amount: 9999 },
    ];
    const r = shadowReport(test(), start, ledger, hist, null);
    expect(r.flows).toBe(500);
    const w = r.horizons.find((h) => h.key === "1w")!.results!;
    expect(w.original).toEqual({ value: 2950, gain: -150, pct: -4.84 });
    expect(w.actual).toEqual({ value: 2962, gain: -138, pct: -4.45 });
    expect(w.voo.gain).toBe(260);
  });
  it("stops at the close date of a closed test", () => {
    const r = shadowReport(test(), start, [], hist, { testId: "t1", at: "2026-11-12T22:00:00Z", endDate: "2026-11-12", reason: "" });
    expect(r.status).toBe("closed");
    expect(r.asOf).toBe("2026-11-12");
    expect(r.horizons.every((h) => h.results === null)).toBe(true);
  });
});

describe("app proposals and your own tests", () => {
  const supported = (s: string) => (s === "IONQ" || s === "RDDT" || s === "NOW" ? { versionId: `v-${s}`, asOf: "2026-11-08" } : null);
  const pos = (symbol: string, action: string, currentPct: number | null, targetPct: number | null) =>
    ({ symbol, status: "held" as const, currentPct, targetPct, action, reason: "r", researchAsOf: "2026-11-08", plan: { action, thesis: "t", invalidation: null } });
  it("creates tests only for researched Trim-to-target or Exit, at most three, never twice for one company", () => {
    const out = proposalsFromPlan([pos("RDDT", "Trim", 8, 4), pos("GOOGL", "Trim", 6, 5), pos("NOW", "Trim", 3, null), pos("IONQ", "Exit", 2, 0), pos("NVDA", "Hold", 5, 5)],
      { supported, activeApp: 1, activeSymbols: new Set(["IONQ"]), planAt: "2026-11-10T14:00:00Z" });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Trim RDDT to 4%, buy VOO");
    expect(out[0].trades).toEqual([{ side: "sell", symbol: "RDDT", amount: 50, unit: "pct_holding" }, { side: "buy", symbol: "VOO", amount: 100, unit: "pct_proceeds" }]);
    expect(out[0].source.researchVersionId).toBe("v-RDDT");
    expect(proposalsFromPlan([pos("RDDT", "Trim", 8, 4)], { supported, activeApp: 3, activeSymbols: new Set(), planAt: "" })).toEqual([]);
  });
  it("checks your own trades", () => {
    const held = new Set(["RDDT"]);
    expect(checkOwnTrades([{ side: "sell", symbol: "RDDT", amount: 50, unit: "pct_holding" }, { side: "buy", symbol: "AVUV", amount: 100, unit: "pct_proceeds" }], held)).toBeNull();
    expect(checkOwnTrades([{ side: "sell", symbol: "MU", amount: 50, unit: "pct_holding" }], held)).toMatch(/not in your portfolio/);
    expect(checkOwnTrades([{ side: "sell", symbol: "RDDT", amount: 150, unit: "pct_holding" }], held)).toMatch(/at most 100/);
    expect(checkOwnTrades([], held)).toMatch(/at least one/);
  });
});
