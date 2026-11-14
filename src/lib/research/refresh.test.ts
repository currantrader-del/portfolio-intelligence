import { describe, expect, it } from "vitest";
import { decideRefresh } from "./refresh";
import { classifyFiling } from "@/lib/market/filingClass";
import { parseSubmissions, type Filing } from "@/lib/market/sec";
import type { ParsedConclusion } from "./valuation";
import iren from "@/lib/market/__fixtures__/iren-submissions-2026-11-06.json";

// Scenario set shaped like the stored IREN research (bear 14.6 / base 76.6 / bull 184.8, reference $44.30 on 2026-09-10).
const pc: ParsedConclusion = {
  action: "HOLD / NO ADD", classification: "Speculative", confidence: "6/10", thesis: null, referencePrice: 44.3, referenceDate: "2026-09-10",
  scenarios: [{ name: "bear", value: 14.6, probability: 0.4 }, { name: "base", value: 76.6, probability: 0.45 }, { name: "bull", value: 184.8, probability: 0.15 }] as ParsedConclusion["scenarios"],
  weightedValue: 68, horizonDate: "2030-06-30", zones: [], allocation: null,
};
const base = { conclusion: pc, researchAsOf: "2026-09-10", completeness: "complete", priceAsOf: "2026-10-31", now: new Date("2026-11-06T15:00:00Z"), freshDays: 120 };
const f = (form: string, filed: string, items: string[] = [], accession?: string): Filing => ({ form, filed, reportDate: null, description: form, items, isEarnings: items.includes("2.02"), url: "", accession, ...classifyFiling(form, items) });

describe("decideRefresh", () => {
  it("is current when nothing changed", () => {
    const d = decideRefresh({ ...base, price: 45, filings: [] });
    expect(d).toMatchObject({ level: "current", triggers: [], notChecked: [] });
  });
  it("asks for a targeted refresh after a new quarterly report", () => {
    const d = decideRefresh({ ...base, price: 45, filings: [f("10-Q", "2026-11-06")] });
    expect(d.level).toBe("targeted_refresh");
    expect(d.triggers.map((t) => t.rule)).toEqual(["R3 new financial report"]);
  });
  it("ignores filings dated before the research or already reviewed by it", () => {
    const d = decideRefresh({ ...base, price: 45, filings: [f("10-K", "2026-08-27"), f("8-K", "2026-10-01", ["2.02"], "acc-1")], reviewedAccessions: ["acc-1"] });
    expect(d.level).toBe("current");
  });
  it("a very large drop alone is re-priced for free, not sent to paid research", () => {
    const d = decideRefresh({ ...base, price: 23.95, filings: [] });
    expect(d.level).toBe("current");
    expect(d.triggers).toEqual([]);
    expect(d.priceMove).toMatch(/^Very large price move: 46% below the \$44.3 reference.*no AI cost/);
  });
  it("flags a price outside the bear-to-bull range", () => {
    expect(decideRefresh({ ...base, price: 12, filings: [] }).triggers.map((t) => t.rule)).toContain("R8 price outside scenarios");
  });
  it("records what it could not check instead of passing it", () => {
    const d = decideRefresh({ ...base, price: null, filings: null });
    expect(d.level).toBe("current");
    expect(d.notChecked).toHaveLength(2);
  });
  it("on the real IREN filing list (as of 2026-11-06) finds no new report or financing after 2026-09-10", () => {
    const d = decideRefresh({ ...base, price: 23.95, filings: parseSubmissions(iren).filings });
    expect(d.triggers.map((t) => t.rule)).toEqual([]);
    expect(d.priceMove).toMatch(/^Very large price move/);
  });
});
