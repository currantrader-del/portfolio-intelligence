import { describe, expect, it } from "vitest";
import { estimateHistory, parseReport, researchFacts } from "./report";

const ctx = { symbol: "NOW", fileName: "now.pdf", documentId: "d1", costUsd: 0.21, model: "m", now: new Date("2026-11-11T18:00:00Z") };

describe("analyst reports", () => {
  it("keeps the rating, values, estimates and the comparison, cleaning numbers", () => {
    const r = parseReport({
      symbol: "now", publisher: "Morningstar", report_date: "2026-10-30", rating: "4 stars", fair_value: "$125", price_target: null,
      estimates: [{ metric: "Revenue", period: "fy2026", value: 13.2, unit: "USD bn", page: 3 }, { metric: "eps", period: "FY2026", value: "n/a" }],
      points: ["Sticky workflows"], risks: ["AI disruption"],
      comparison: { agree: ["Durable growth"], differ: ["Fair value $125 today vs the app's $110.60 by Dec 2029"], not_in_research: ["Pricing change in 2027"], summary: "Morningstar is higher." },
    }, ctx)!;
    expect(r).toMatchObject({ symbol: "NOW", fairValue: 125, priceTarget: null, rating: "4 stars", reportDate: "2026-10-30" });
    expect(r.estimates).toEqual([{ metric: "revenue", period: "FY2026", value: 13.2, unit: "USD bn", page: 3 }]);
    expect(r.comparison.notInResearch).toEqual(["Pricing change in 2027"]);
  });
  it("returns nothing for a reply with no usable content", () => {
    expect(parseReport({ comparison: { summary: "x" } }, ctx)).toBeNull();
    expect(parseReport(null, ctx)).toBeNull();
  });
  it("lines up the same estimate across reports, oldest first", () => {
    const h = estimateHistory([
      { publisher: "B", reportDate: "2026-11-05", at: "", estimates: [{ metric: "eps", period: "FY2026", value: 4.2, unit: "USD", page: null }] },
      { publisher: "A", reportDate: "2026-08-01", at: "", estimates: [{ metric: "eps", period: "FY2026", value: 4.0, unit: "USD", page: null }, { metric: "revenue", period: "FY2026", value: 13, unit: "USD bn", page: null }] },
    ]);
    expect(h[0]).toMatchObject({ metric: "eps", period: "FY2026", points: [{ date: "2026-08-01", value: 4.0 }, { date: "2026-11-05", value: 4.2 }] });
  });
  it("labels the app's scenario values as future prices, not fair value", () => {
    const t = researchFacts("NOW", { action: "Hold", classification: null, confidence: "medium", thesis: "t", referencePrice: 100, referenceDate: "2026-11-07", scenarios: [{ name: "base", value: 110.6, probability: 0.5 }], weightedValue: 110.6, horizonDate: "2029-12-31", zones: [], allocation: null }, "2026-11-07", 99.6);
    expect(t).toMatch(/future prices at the horizon date/);
    expect(t).toMatch(/by 2029-12-31/);
  });
});
