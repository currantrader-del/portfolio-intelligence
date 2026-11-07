import { describe, expect, it } from "vitest";
import { toResearchRecord } from "./records";
import { coverage, suggestStage } from "./status";

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
  it("does not ask for research just because there is no live price", () => {
    expect(coverage(rec(), null, now, 120).key).toBe("current");
    expect(coverage(rec({ asOf: "2026-05-01" }), null, now, 120).key).toBe("refresh");
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

describe("suggested stage", () => {
  const base = { stage: "researching", held: false, coverageKey: "current" as const, hasResearch: true, action: "Watch below $60", screenVerdict: "Mixed" };
  it("suggests Ready when research is complete and current", () => {
    expect(suggestStage(base)?.stage).toBe("ready");
    expect(suggestStage({ ...base, stage: "ready" })).toBeNull();
  });
  it("suggests Passed when the research says avoid, with the reason", () => {
    expect(suggestStage({ ...base, action: "Avoid at this price" })).toMatchObject({ stage: "passed", reason: "The research says: Avoid at this price" });
  });
  it("keeps stale research in Researching and moves screened ideas along", () => {
    expect(suggestStage({ ...base, stage: "ready", coverageKey: "refresh" })?.stage).toBe("researching");
    expect(suggestStage({ ...base, stage: "idea", hasResearch: false, coverageKey: "none" })?.stage).toBe("screening");
    expect(suggestStage({ ...base, stage: "idea", hasResearch: false, coverageKey: "none", screenVerdict: "Weak on screen" })?.stage).toBe("passed");
  });
  it("never second-guesses holdings or a pass", () => {
    expect(suggestStage({ ...base, held: true })).toBeNull();
    expect(suggestStage({ ...base, stage: "passed" })).toBeNull();
  });
});
