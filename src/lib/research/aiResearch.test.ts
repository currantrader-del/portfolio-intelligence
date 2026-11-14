import { describe, expect, it } from "vitest";
import { extractJson, validateReport, PHASES } from "./aiResearch";
import { parseConclusion } from "./valuation";

// Synthetic company and numbers only.
const body = (n: number) => `Phase ${n} text. `.repeat(30);
const good = () => ({
  summary: "Watch: solid growth but the price already assumes most of it.",
  action: "Buy below $40",
  classification: "Quality growth",
  confidence: "Moderate",
  thesis: "Growing share in a growing market with improving margins.",
  reference_price: 51,
  valuation: { bear_value: 30, bear_probability: 0.25, base_value: 55, base_probability: 0.5, bull_value: 80, bull_probability: 0.25, terminal_date: "2028-12-31", method: "Revenue x margin x multiple" },
  price_framework: [{ price_zone: "< $40", action: "Buy" }, { price_zone: "$40–$60", action: "Hold" }, { price_zone: "> $60", action: "Trim review" }],
  allocation: { target_pct: 3, max_pct: 5, note: "Within policy" },
  would_change: ["Two quarters of slowing growth"],
  not_verified: ["Consensus estimates"],
  phases: PHASES.map((p) => ({ number: p.n, title: p.title, body_markdown: body(p.n) })),
  sources: [1, 2, 3].map((i) => ({ title: `Source ${i}`, url: `https://example.com/${i}`, date: "2026-11-01" })),
});
const ctx = { today: "2026-11-07", appPrice: 50 };

describe("extractJson", () => {
  it("reads a fenced block after prose", () => expect(extractJson('Done.\n```json\n{"a":1}\n```')).toEqual({ a: 1 }));
  it("reads a bare object", () => expect(extractJson('{"a":2}')).toEqual({ a: 2 }));
  it("returns null for no JSON", () => expect(extractJson("no report")).toBeNull());
});

describe("validateReport", () => {
  it("accepts a full report as complete and keeps it readable by the decision rules", () => {
    const r = validateReport(good(), ctx);
    if ("error" in r) throw new Error(r.error);
    expect(r.completeness).toBe("complete");
    expect(r.problems).toEqual([]);
    expect(r.phases).toHaveLength(6);
    const parsed = parseConclusion(r.conclusion);
    expect(parsed.referencePrice).toBe(50); // the app's quote, not the model's 51
    expect(parsed.referenceDate).toBe("2026-11-07");
    expect(parsed.scenarios).toHaveLength(3);
    expect(parsed.weightedValue).toBeCloseTo(55);
    expect(parsed.horizonDate).toBe("2028-12-31");
    expect(parsed.zones).toHaveLength(3);
    expect(r.conclusion.model_reference_price).toBe(51);
  });

  it("marks a report partial when phases, probabilities, horizon or sources fall short", () => {
    const g = good();
    g.phases = g.phases.slice(0, 4);
    g.valuation.bull_probability = 0.5;
    g.valuation.terminal_date = "2026-01-01";
    g.sources = g.sources.slice(0, 1);
    const r = validateReport(g, ctx);
    if ("error" in r) throw new Error(r.error);
    expect(r.completeness).toBe("partial");
    expect(r.problems.join(" | ")).toMatch(/Phase 5.*Phase 6|Phase 5/);
    expect(r.problems.some((p) => p.includes("add up to 1.25"))).toBe(true);
    expect(r.problems).toContain("Valuation has no future horizon date");
    expect(r.problems).toContain("Only 1 usable source link");
  });

  it("flags scenarios out of order and unusable price bands", () => {
    const g = good();
    g.valuation.bear_value = 90;
    g.price_framework = [{ price_zone: "cheap", action: "Buy" }];
    const r = validateReport(g, ctx);
    if ("error" in r) throw new Error(r.error);
    expect(r.problems).toContain("Scenario values are not ordered bear ≤ base ≤ bull");
    expect(r.problems).toContain("No usable price bands");
  });

  it("falls back to the model's price only when the app has none, and says so", () => {
    const r = validateReport(good(), { today: "2026-11-07", appPrice: null });
    if ("error" in r) throw new Error(r.error);
    expect(r.conclusion.reference_price).toBe(51);
    expect(r.conclusion.reference_price_source).toBe("the research's own figure");
  });

  it("drops non-web source links", () => {
    const g = good();
    g.sources.push({ title: "local", url: "file:///etc/passwd", date: "2026-11-01" });
    const r = validateReport(g, ctx);
    if ("error" in r) throw new Error(r.error);
    expect(r.sources.every((s) => s.url.startsWith("https://"))).toBe(true);
  });

  it("rejects a reply with no report", () => expect(validateReport(null, ctx)).toEqual({ error: "The research did not end with a readable report." }));
});
