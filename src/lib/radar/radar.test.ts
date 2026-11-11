import { describe, expect, it } from "vitest";
import { classify, ideaResult, metricsOf, shortlist, validateRadarIdea, type Candidate } from "./radar";

const bars = (closes: number[]) => closes.map((close, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, close, high: close, low: close, open: close, volume: 1e6 }));
const ramp = (from: number, to: number, n = 260) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));

describe("radar screen", () => {
  it("measures a year of price behaviour", () => {
    const m = metricsOf(bars(ramp(100, 150)))!;
    expect(m.ret12m).toBeCloseTo(0.5, 1);
    expect(m.fromHigh).toBe(0);
    expect(m.above200).toBe(true);
  });
  it("sorts leaders and pullbacks in leaders, and leaves laggards out", () => {
    const lead = classify("AAA", "Tech", { price: 150, ret12m: 0.5, ret3m: 0.1, fromHigh: -0.02, above200: true }, 0.15, null);
    expect(lead?.kind).toBe("leader");
    const pull = classify("BBB", "Health", { price: 80, ret12m: 0.3, ret3m: -0.2, fromHigh: -0.2, above200: false }, 0.15, null);
    expect(pull?.kind).toBe("pullback");
    expect(classify("CCC", "Energy", { price: 50, ret12m: 0.02, ret3m: 0, fromHigh: -0.1, above200: false }, 0.15, null)).toBeNull();
  });
  it("leaves out excluded names and keeps at most two per sector", () => {
    const c = (symbol: string, sector: string, score: number): Candidate => ({ symbol, sector, kind: "leader", price: 100, ret12m: 0.4, vsSpy12m: 0.2, fromHigh: -0.01, why: "", score });
    const list = shortlist([c("A", "Tech", 5), c("B", "Tech", 4), c("C", "Tech", 3), c("D", "Energy", 2), c("E", "Energy", 1)], new Set(["D"]));
    expect(list.map((x) => x.symbol)).toEqual(["A", "B", "E"]);
  });
});

describe("radar ideas", () => {
  const ctx = { price: 100, exclude: new Set(["NVDA"]), shortlist: new Set(["AAA"]), vooPrice: 690, now: new Date("2026-11-12T14:00:00Z") };
  const good = { symbol: "AAA", name: "Aaa Corp", idea: "Margins are rising faster than the market expects as the new product line scales.", why_now: "Q3 results on 2026-10-30 beat guidance.", risks: ["Demand could slow"], would_change: "Margins fall back", evidence: [{ title: "Q3 8-K", url: "https://www.sec.gov/x", kind: "results", date: "2026-10-30" }], strength: "strong" };
  it("accepts a dated, sourced idea and locks in the prices", () => {
    const v = validateRadarIdea(good, ctx);
    expect("idea" in v && v.idea).toMatchObject({ symbol: "AAA", price: 100, vooPrice: 690, strength: "strong", fromShortlist: true });
  });
  it("turns down held or researched names, missing sources, and ideas resting only on analyst or social inputs", () => {
    expect(validateRadarIdea({ ...good, symbol: "NVDA" }, ctx)).toMatchObject({ rejected: expect.stringMatching(/held/) });
    expect(validateRadarIdea({ ...good, evidence: [] }, ctx)).toMatchObject({ rejected: "no sources" });
    expect(validateRadarIdea({ ...good, evidence: [{ title: "Upgrade", url: "https://x.com/a", kind: "analyst" }, { title: "Post", url: "https://reddit.com/b", kind: "social" }] }, ctx)).toMatchObject({ rejected: expect.stringMatching(/only on analyst/) });
    expect(validateRadarIdea(good, { ...ctx, price: null })).toMatchObject({ rejected: "no live price" });
  });
  it("scores an idea against VOO over the same days", () => {
    const r = ideaResult({ price: 100, vooPrice: 600 }, 110, 630);
    expect(r.returnPct).toBeCloseTo(0.1);
    expect(r.edgePct).toBeCloseTo(0.05);
  });
});
