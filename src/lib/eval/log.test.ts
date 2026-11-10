import { describe, expect, it } from "vitest";
import { paperResult, type PaperDecision } from "./log";

const d = (side: "buy" | "trim"): PaperDecision => ({ symbol: "AAA", side, price: 100, vooPrice: 500, at: "2026-11-10T16:00:00Z", reason: "r", researchVersionId: "v", researchAsOf: "2026-11-08", alertId: "a" });

describe("paper decisions against VOO over the same period", () => {
  it("a buy beats VOO when the stock rises more", () => {
    const r = paperResult(d("buy"), 110, 510);
    expect(r.returnPct).toBeCloseTo(0.10, 6);
    expect(r.vooPct).toBeCloseTo(0.02, 6);
    expect(r.edgePct).toBeCloseTo(0.08, 6);
  });
  it("a trim is right when the stock then does worse than VOO", () => {
    expect(paperResult(d("trim"), 90, 505).edgePct).toBeCloseTo(0.10 - 0.01, 6);
  });
  it("no comparison without both prices", () => {
    expect(paperResult({ ...d("buy"), vooPrice: null }, 110, 510).edgePct).toBeNull();
  });
});
