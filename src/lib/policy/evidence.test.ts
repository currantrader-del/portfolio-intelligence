import { describe, expect, it } from "vitest";
import { benchmarkFrom, compareToIndex, EVIDENCE_BENCHMARK, refreshState, US_EQUITY_FORECASTS } from "./evidence";
import { parseConclusion } from "@/lib/research/valuation";
import type { FilingsResult } from "@/lib/market/sec";

// RDDT completed research (archives A and B agree), reference $157.77 on 2026-09-11, horizon 2031-12-31.
const rddt = parseConclusion({
  action: "HOLD / NO ADD", reference_price: "$157.77", reference_date: "2026-09-11",
  valuation: { terminal_date: "2031-12-31", bear_value: 138, bear_probability: 0.35, base_value: 329, base_probability: 0.5, bull_value: 615, bull_probability: 0.15 },
  price_framework: [
    { price_zone: "< $130", action: "Strong Buy review" }, { price_zone: "$130-$145", action: "Buy" }, { price_zone: "$145-$155", action: "Add if evidence intact" },
    { price_zone: "$155-$185", action: "Hold" }, { price_zone: "$185-$203", action: "Hold / no add" }, { price_zone: "$203-$235", action: "Trim review" }, { price_zone: "> $235", action: "Strong trim / re-underwrite" },
  ],
});
const at = new Date("2026-09-11T00:00:00Z");

describe("benchmark from published forecasts", () => {
  it("spans Vanguard 4.8–6.8% and J.P. Morgan 7.5%, middle = average of each source's midpoint", () => {
    expect(EVIDENCE_BENCHMARK).toMatchObject({ low: 0.048, high: 0.075, mid: 0.0665 });
    expect(US_EQUITY_FORECASTS.every((s) => /^https:\/\//.test(s.url) && /^\d{4}-\d{2}-\d{2}$/.test(s.asOf))).toBe(true);
    expect(benchmarkFrom([{ firm: "x", asset: "y", low: 0.05, high: 0.05, horizon: "", asOf: "", url: "" }])).toMatchObject({ low: 0.05, high: 0.05, mid: 0.05 });
  });
});

describe("return comparison reproduces the stored research", () => {
  const c = compareToIndex(rddt, 157.77, at, EVIDENCE_BENCHMARK, 0.5)!;
  it("matches RDDT's 13.2% probability-weighted return and its scenario CAGRs at the reference price", () => {
    expect(c.expected).toBeCloseTo(0.132, 2);
    const by = Object.fromEntries(c.scenarios.map((s) => [s.name, s.annual]));
    expect(by.bear).toBeCloseTo(-0.025, 2);
    expect(by.base).toBeCloseTo(0.149, 2);
    expect(by.bull).toBeCloseTo(0.293, 2);
  });
  it("computes the margin from the stock's own spread and the bar from the top of the index range", () => {
    const mean = c.scenarios.reduce((a, s) => a + s.probability * s.annual, 0);
    const sd = Math.sqrt(c.scenarios.reduce((a, s) => a + s.probability * (s.annual - mean) ** 2, 0));
    expect(c.spread).toBeCloseTo(sd, 4);
    expect(c.margin).toBeCloseTo(0.5 * sd, 4);
    expect(c.bar).toBeCloseTo(0.075 + 0.5 * sd, 4);
    expect(c.clears).toBe(c.expected >= c.bar);
    expect(c.probTrailIndex).toBeCloseTo(0.35, 4); // only the bear case trails 6.65%
  });
  it("needs a larger return from a wider spread", () => {
    const wide = parseConclusion({ reference_price: "$10", reference_date: "2026-09-11", valuation: { terminal_date: "2031-12-31", bear_value: 2, bear_probability: 0.4, base_value: 20, base_probability: 0.4, bull_value: 60, bull_probability: 0.2 } });
    expect(compareToIndex(wide, 10, at, EVIDENCE_BENCHMARK)!.margin).toBeGreaterThan(c.margin);
  });
  it("returns nothing rather than invent a number when scenarios are missing or don't sum to 100%", () => {
    expect(compareToIndex(parseConclusion({ reference_price: "$10", valuation: {} }), 10, at, EVIDENCE_BENCHMARK)).toBeNull();
    const bad = parseConclusion({ reference_price: "$10", valuation: { terminal_date: "2031-12-31", bear_value: 5, bear_probability: 0.3, base_value: 20, base_probability: 0.3 } });
    expect(compareToIndex(bad, 10, at, EVIDENCE_BENCHMARK)).toBeNull();
  });
});

const filings = (list: Partial<FilingsResult["filings"][number]>[]): FilingsResult => ({
  cik: "1", company: "X", lastEarnings: null, nextEarningsEstimate: null, source: "s", fetchedAt: "t",
  filings: list.map((f) => ({ form: "8-K", filed: "2026-10-01", reportDate: null, description: "", items: [], isEarnings: false, url: "u", category: "other", note: "", ...f })) as FilingsResult["filings"],
});

describe("event-driven refresh", () => {
  it("is current when nothing was filed after the research and the price stays in its zone", () => {
    expect(refreshState({ asOf: "2026-09-13", pc: rddt, price: 160, filings: filings([{ form: "10-Q", filed: "2026-08-07" }]) }).status).toBe("current");
  });
  it("asks for a refresh after new results, a financing, or a material 8-K", () => {
    const f = filings([{ form: "10-Q", filed: "2026-11-05" }, { form: "424B5", filed: "2026-10-02" }, { form: "8-K", filed: "2026-10-03", items: ["1.01"] }, { form: "8-K", filed: "2026-10-04", items: ["7.01"] }]);
    const s = refreshState({ asOf: "2026-09-13", pc: rddt, price: 160, filings: f });
    expect(s.status).toBe("refresh");
    expect(s.triggers.map((t) => t.kind)).toEqual(["results", "financing", "material_event"]);
  });
  it("treats an 8-K item 2.02 as results", () => {
    expect(refreshState({ asOf: "2026-09-13", pc: null, price: null, filings: filings([{ form: "8-K", filed: "2026-10-30", items: ["2.02", "9.01"] }]) }).triggers[0].kind).toBe("results");
  });
  it("flags a move from the research's 'hold' zone into its 'buy' zone: a drop is checked, not bought", () => {
    const s = refreshState({ asOf: "2026-09-13", pc: rddt, price: 95.1, filings: filings([]) });
    expect(s.status).toBe("refresh");
    expect(s.triggers[0]).toMatchObject({ kind: "zone_change" });
    expect(s.triggers[0].detail).toMatch(/Strong Buy review/);
  });
  it("is 'unverified', never 'current', when filings could not be retrieved", () => {
    expect(refreshState({ asOf: "2026-09-13", pc: rddt, price: 160, filings: null }).status).toBe("unverified");
  });
  it("does not use age: two-year-old research with no events is current", () => {
    expect(refreshState({ asOf: "2024-09-13", pc: null, price: null, filings: filings([{ form: "10-Q", filed: "2024-08-01" }]) }).status).toBe("current");
  });
});
