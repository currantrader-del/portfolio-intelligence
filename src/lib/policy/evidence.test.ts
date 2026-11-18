import { describe, expect, it } from "vitest";
import { ALTERNATIVES, assessVsAlternatives, refreshState, riskFreeFor, span, VOO, VOO_SPAN } from "./evidence";
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

describe("published forecasts per alternative", () => {
  it("keeps each source as published, with horizon, date and method; never averaged", () => {
    expect(VOO.forecasts.map((f) => [f.firm, f.low, f.high, f.kind, f.horizonYears, f.asOf])).toEqual([
      ["Vanguard", 0.048, 0.068, "range", [10, 10], "2026-09-30"],
      ["J.P. Morgan", 0.075, 0.075, "point", [10, 15], "2026-10-19"],
    ]);
    expect(VOO_SPAN).toEqual({ low: 0.048, high: 0.075 });
    expect(ALTERNATIVES.flatMap((x) => x.forecasts).every((f) => /^https:\/\//.test(f.url) && /^\d{4}-\d{2}-\d{2}$/.test(f.asOf) && f.method.length > 20)).toBe(true);
    expect(span([{ ...VOO.forecasts[0] }])).toEqual({ low: 0.048, high: 0.068 });
  });
  it("explains the withdrawn 6.7%: the average of Vanguard's 5.8% midpoint and J.P. Morgan's 7.5%, not the middle of 4.8–7.5%", () => {
    const vanguardMid = (0.048 + 0.068) / 2;
    expect(vanguardMid).toBeCloseTo(0.058, 6);
    expect((vanguardMid + 0.075) / 2).toBeCloseTo(0.0665, 6);
    expect((0.048 + 0.075) / 2).toBeCloseTo(0.0615, 6);
  });
  it("interpolates Treasury yields to the research horizon", () => {
    const y = { y2: { value: 4.46, date: "2026-11-05" }, y10: { value: 4.84, date: "2026-11-05" } };
    expect(riskFreeFor(2, y)!.rate).toBeCloseTo(0.0446, 4);
    expect(riskFreeFor(10, y)!.rate).toBeCloseTo(0.0484, 4);
    expect(riskFreeFor(6, y)!.rate).toBeCloseTo(0.0465, 4);
    expect(riskFreeFor(30, y)!.rate).toBeCloseTo(0.0484, 4);
    expect(riskFreeFor(5, { y2: null, y10: null })).toBeNull();
  });
});

describe("comparison with the alternatives reproduces the stored research", () => {
  const c = assessVsAlternatives(rddt, 157.77, at, { riskFree: { rate: 0.0465, detail: "test", asOf: "2026-11-05" }, weightNow: 0.041, limit: { normalHigh: 0.05, hcHigh: 0.065, max: 0.07 } })!;
  it("matches RDDT's 13.2% probability-weighted return and its scenario CAGRs at the reference price", () => {
    expect(c.expected).toBeCloseTo(0.132, 2);
    const by = Object.fromEntries(c.scenarios.map((s) => [s.name, s.annual]));
    expect(by.bear).toBeCloseTo(-0.025, 2);
    expect(by.base).toBeCloseTo(0.149, 2);
    expect(by.bull).toBeCloseTo(0.293, 2);
  });
  it("reports the odds and downside from the research's own probabilities, with no hidden premium", () => {
    expect(c.vsVoo).toBe("above_all");
    expect(c.probBeatVooLow).toBeCloseTo(0.65, 4); // base + bull beat 4.8%; the bear case does not
    expect(c.probBeatVooHigh).toBeCloseTo(0.65, 4);
    expect(c.probLoss).toBeCloseTo(0.35, 4);
    expect(c.judgment).toBe("favourable");
    expect(c.factors.map((f) => f.label)).toEqual(["Expected return vs VOO", "Vs a risk-free Treasury", "Odds of beating VOO", "Downside", "Valuation uncertainty", "Same horizon", "Concentration"]);
    expect(c.factors.find((f) => f.label === "Downside")!.leans).toBe("against");
  });
  it("calls it mixed when the expected return sits inside the VOO forecasts, and unfavourable below all of them", () => {
    const mk = (base: number) => parseConclusion({ reference_price: "$100", reference_date: "2026-09-11", valuation: { terminal_date: "2036-09-11", bear_value: 60, bear_probability: 0.3, base_value: base, base_probability: 0.5, bull_value: 260, bull_probability: 0.2 } });
    const within = assessVsAlternatives(mk(200), 100, at)!; // weighted value 170 over 10 years: about 5.4% a year
    expect(within.expected).toBeGreaterThan(0.048);
    expect(within.expected).toBeLessThan(0.075);
    expect(within.judgment).toBe("mixed");
    const below = assessVsAlternatives(parseConclusion({ reference_price: "$100", reference_date: "2026-09-11", valuation: { terminal_date: "2036-09-11", bear_value: 60, bear_probability: 0.5, base_value: 130, base_probability: 0.5 } }), 100, at)!;
    expect(below.judgment).toBe("unfavourable");
  });
  it("is not favourable when a high average rests on a long-shot bull case", () => {
    const lottery = parseConclusion({ reference_price: "$10", reference_date: "2026-09-11", valuation: { terminal_date: "2036-09-11", bear_value: 3, bear_probability: 0.6, base_value: 12, base_probability: 0.3, bull_value: 200, bull_probability: 0.1 } });
    const l = assessVsAlternatives(lottery, 10, at)!;
    expect(l.vsVoo).toBe("above_all");
    expect(l.probBeatVooLow).toBeLessThan(0.5);
    expect(l.judgment).toBe("mixed");
  });
  it("returns nothing rather than invent a number when scenarios are missing or don't sum to 100%", () => {
    expect(assessVsAlternatives(parseConclusion({ reference_price: "$10", valuation: {} }), 10, at)).toBeNull();
    const bad = parseConclusion({ reference_price: "$10", valuation: { terminal_date: "2031-12-31", bear_value: 5, bear_probability: 0.3, base_value: 20, base_probability: 0.3 } });
    expect(assessVsAlternatives(bad, 10, at)).toBeNull();
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
