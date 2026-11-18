import { describe, expect, it } from "vitest";
import { expectedReturnAt, parseConclusion, parseZone, zoneFor } from "./valuation";

const aaa = {
  action: "HOLD / NO ADD", classification: "Speculative", reference_price: "$50", reference_date: "2026-09-10",
  valuation: { approx_holding_period_years: 4, bear_value: 20, base_value: 90, bull_value: 200, bear_probability: 0.3, base_probability: 0.5, bull_probability: 0.2, probability_weighted_terminal_value: 68 },
  price_framework: [
    { price_zone: "< $35", action: "Strong Add research trigger" },
    { price_zone: "$35–$40", action: "Add candidate" },
    { price_zone: "$40–$55", action: "Hold" },
    { price_zone: "> $70", action: "Re-underwrite / potential Trim" },
  ],
};

describe("research valuation", () => {
  it("computes the annualized return at the reference price and date", () => {
    const pc = parseConclusion(aaa);
    expect(pc.weightedValue).toBeCloseTo(91.0, 1);
    expect(pc.referencePrice).toBe(50);
    const er = expectedReturnAt(pc, 50, new Date("2026-09-10T00:00:00Z"))!;
    expect(er).toBeCloseTo(Math.pow(91 / 50, 1 / 4) - 1, 2);
  });

  it("re-prices at a lower price", () => {
    const pc = parseConclusion(aaa);
    const atRef = expectedReturnAt(pc, 50, new Date("2026-11-05T00:00:00Z"))!;
    const at34 = expectedReturnAt(pc, 33.8, new Date("2026-11-05T00:00:00Z"))!;
    expect(at34).toBeGreaterThan(atRef);
  });

  it("finds the price zone", () => {
    const pc = parseConclusion(aaa);
    expect(zoneFor(pc.zones, 33.8)?.action).toBe("Strong Add research trigger");
    expect(zoneFor(pc.zones, 45)?.action).toBe("Hold");
    expect(zoneFor(pc.zones, 60)).toBeNull();
    expect(parseZone("> $70", "x")).toEqual({ low: 70, high: Infinity, action: "x", label: "> $70" });
  });

  it("uses an explicit terminal date when present", () => {
    const pc = parseConclusion({ valuation: { terminal_date: "2031-12-31", bear_value: 100, base_value: 300, bull_value: 600, bear_probability: 0.3, base_probability: 0.5, bull_probability: 0.2 } });
    expect(pc.horizonDate).toBe("2031-12-31");
    expect(pc.weightedValue).toBeCloseTo(300, 0);
  });

  it("returns nulls for conclusions without a valuation", () => {
    const pc = parseConclusion({ action: "HOLD" });
    expect(expectedReturnAt(pc, 100, new Date())).toBeNull();
  });
});
