import { describe, expect, it } from "vitest";
import { toResearchRecord } from "./records";
import { coverage } from "./status";

// Synthetic data only.
const now = new Date("2026-11-06T16:00:00Z");
const rec = (o: { completeness?: string; asOf?: string; ref?: string; current?: boolean; versions?: number } = {}) =>
  toResearchRecord("AAA", "AAA Corp", "held", Array.from({ length: o.versions ?? 1 }, (_, i) => ({
    id: `v${i}`, research_as_of: o.asOf ?? "2026-10-20", completeness: o.completeness ?? "complete", origin: "chatgpt_original", is_current: o.current ?? true,
    conclusion: { action: "HOLD", reference_price: o.ref ?? "$100", reference_date: o.asOf ?? "2026-10-20", valuation: { approx_holding_period_years: 3, bear_value: 60, base_value: 150, bull_value: 220, bear_probability: 0.25, base_probability: 0.5, bull_probability: 0.25 } },
  })));

describe("research coverage label", () => {
  it("is current for complete, fresh research near its reference price", () => {
    expect(coverage(rec(), 104, now, 120).key).toBe("current");
  });
  it("asks for a refresh when the price has moved far from the reference, up or down", () => {
    expect(coverage(rec(), 70, now, 120).key).toBe("refresh");
    expect(coverage(rec(), 140, now, 120).key).toBe("refresh");
  });
  it("asks for a refresh when research is past the freshness window", () => {
    expect(coverage(rec({ asOf: "2026-05-01" }), 100, now, 120).key).toBe("refresh");
  });
  it("marks partial research incomplete, never current", () => {
    expect(coverage(rec({ completeness: "partial" }), 100, now, 120).key).toBe("incomplete");
  });
  it("flags conflicting records with no current version", () => {
    expect(coverage(rec({ current: false, versions: 2 }), 100, now, 120).key).toBe("conflict");
  });
  it("reports no research when nothing is on file", () => {
    expect(coverage(undefined, 100, now, 120).key).toBe("none");
  });
});
