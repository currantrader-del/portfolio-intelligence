import { describe, expect, it } from "vitest";
import { zoneKind } from "./zoneKind";

describe("zoneKind (shared by the What to do verb and the price bar)", () => {
  it("reads 'no new money' bands as hold even when they mention adding (MU, 2026-11-16)", () => {
    expect(zoneKind("No new money. At $690 expected return is about zero; a lower price alone is not a reason to add.")).toBe("hold");
    expect(zoneKind("Expected return is about zero; a lower price alone is not a reason to add.")).toBe("hold");
    expect(zoneKind("Not attractive at this price; don't buy on a dip without new results.")).toBe("hold");
  });
  it("keeps the leading instruction (NVDA, 2026-11-14)", () => {
    expect(zoneKind("Hold, no add. Wait for results; after the print trim to 12% unless conditions are met.")).toBe("hold");
    expect(zoneKind("Trim back toward 15% of the portfolio.")).toBe("trim");
  });
  it("still finds real buy and trim bands", () => {
    expect(zoneKind("Starter eligible (small, about 1-2% if an MU limit is approved).")).toBe("buy");
    expect(zoneKind("Expected value well above price; a small starter is reasonable from planned cash.")).toBe("buy");
    expect(zoneKind("Expected return is negative here; take profits down to the cap.")).toBe("trim");
    expect(zoneKind("Fair value range; do not trim, keep the position.")).toBe("hold");
  });
});
