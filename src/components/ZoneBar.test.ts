import { describe, expect, it } from "vitest";
import { zoneKind } from "./ZoneBar";

// Wording taken from real research bands.
describe("zoneKind", () => {
  it("treats starter and buy wording as the buy zone", () => {
    expect(zoneKind("Consider a small starter (about 1-2% of investable capital), only from planned cash.")).toBe("add");
    expect(zoneKind("Expected value is about 60% above price. A small starter is reasonable, but only from planned cash, never the reserve.")).toBe("add");
    expect(zoneKind("Add research: consider adding")).toBe("add");
  });
  it("does not colour 'no add' or 'do not buy' bands as buy zones", () => {
    expect(zoneKind("Watch / no add. Fair range if the 2027 EPS path of ~$16 holds.")).toBe("hold");
    expect(zoneKind("No add. Little margin of safety against the bear case.")).toBe("hold");
    expect(zoneKind("Watch. Fair to cheap on cash flow. Do not buy just because the price fell.")).toBe("hold");
    expect(zoneKind("No new money. The expected return is too low for cycle-peak risk.")).toBe("hold");
    expect(zoneKind("Avoid chasing. The price would assume most of the bull case.")).toBe("hold");
  });
  it("marks trim and sell bands", () => {
    expect(zoneKind("Trim review: consider reducing")).toBe("trim");
    expect(zoneKind("Hold; do not sell on volatility")).toBe("hold");
    expect(zoneKind("Hold, no add. After the print, trim to about 12% unless the Nov 17 tests all pass.")).toBe("hold");
    expect(zoneKind("Trim toward 12% look-through even if the tests pass.")).toBe("trim");
  });
});
