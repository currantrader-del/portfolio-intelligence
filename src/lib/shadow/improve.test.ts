import { describe, expect, it } from "vitest";
import type { Bar } from "@/lib/market/history";
import { assess, backtestCap, findCandidates, mixBuys, sameCandidates, summarizeEvidence, upsideGivenUp, validateReview, type ResearchFact } from "./improve";

// Made-up numbers only (the repo is public).
const research = (symbol: string, o: Partial<ResearchFact> = {}): ResearchFact => ({
  symbol, versionId: `v-${symbol}`, asOf: "2026-11-01", action: "Hold", thesis: "t", confidence: "medium",
  scenarios: [{ name: "bear", value: 50 }, { name: "base", value: 120 }, { name: "bull", value: 200 }], weighted: 125, complete: true, ...o,
});
const holding = (symbol: string, weight: number, o: Partial<{ quantity: number; price: number; etf: boolean }> = {}) =>
  ({ symbol, quantity: o.quantity ?? 100, price: o.price ?? 100, value: (o.quantity ?? 100) * (o.price ?? 100), weight, etf: o.etf ?? false });
const caps = (s: string) => (s === "AAA" ? { normalHigh: 0.05, max: 0.08 } : { normalHigh: null, max: 0.1 });

describe("candidates", () => {
  it("trims only on a trigger: over the policy line, or completed research that says Trim or Exit", () => {
    const c = findCandidates({
      total: 100_000, capFor: caps,
      holdings: [holding("AAA", 0.08), holding("BBB", 0.04), holding("CCC", 0.03), holding("DDD", 0.03), holding("VOO", 0.6, { etf: true })],
      research: [research("BBB"), research("CCC"), research("DDD", { complete: false })],
      plan: [{ symbol: "BBB", action: "Trim", targetPct: 2, reason: "Above fair value" }, { symbol: "CCC", action: "Hold", targetPct: 3, reason: "" }, { symbol: "DDD", action: "Exit", targetPct: 0, reason: "" }],
    });
    expect(c.map((x) => [x.symbol, x.trigger, x.targetPct, x.sellPct])).toEqual([["BBB", ["research_trim"], 2, 50], ["AAA", ["concentration"], 5, 37.5]]);
    expect(c[1].sellShares).toBe(37.5);
    expect(mixBuys(1000)).toEqual([{ symbol: "VOO", pct: 50, usd: 500 }, { symbol: "VXUS", pct: 25, usd: 250 }, { symbol: "AVUV", pct: 25, usd: 250 }]);
    expect(upsideGivenUp(c[0])).toEqual({ bullUsd: 5000, baseUsd: 1000 }); // 50 shares x (200 - 100) and x (120 - 100)
  });
  it("ignores tiny excesses", () => {
    expect(findCandidates({ total: 100_000, capFor: caps, holdings: [holding("AAA", 0.053)], research: [], plan: [] })).toEqual([]);
  });
});

/** Weekday dates from a start, n of them. */
function weekdays(from: string, n: number) {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T12:00:00Z`); out.length < n; t += 86_400_000) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); }
  return out;
}
const days = weekdays("2021-01-04", 1100);
const path = (f: (i: number) => number): Bar[] => days.map((date, i) => ({ date, close: f(i) }));

describe("historical test of the concentration rule", () => {
  // A stock that triples and then gives most of it back; the index grows steadily.
  const h = new Map<string, Bar[]>([
    ["VOO", path((i) => 100 * 1.0003 ** i)], ["VXUS", path((i) => 50 * 1.0002 ** i)], ["AVUV", path((i) => 70 * 1.00025 ** i)],
    ["ZZZ", path((i) => (i < 550 ? 20 * 1.002 ** i : 20 * 1.002 ** 550 * 0.9985 ** (i - 550)))],
  ]);
  it("trims at the next close after a monthly check, with costs, and reports against no change, VOO and the mix", () => {
    const b = backtestCap("ZZZ", 20, h);
    if (!b.ok) throw new Error(b.why);
    expect(b.years).toBeGreaterThan(4);
    expect(b.trims).toBeGreaterThan(2);
    expect(b.costs).toBeGreaterThan(0);
    expect(b.rule.maxDrawdown).toBeGreaterThan(b.noChange.maxDrawdown); // a smaller drop (less negative)
    expect(b.windows).toBeGreaterThan(30);
    const e = summarizeEvidence([b, { symbol: "NEW", ok: false, why: "only 1.2 years of history (needs 3)" }], true);
    expect(e.summary).toMatch(/on 1 of your stocks, trimming back to the cap reduced the worst drop in 1/);
    expect(e.limits[0]).toMatch(/cannot be backtested/);
    expect(e.limits.join(" ")).toMatch(/Survivorship bias/);
  });
  it("refuses a short history instead of manufacturing a result", () => {
    const short = new Map([...h].map(([s, bars]) => [s, s === "ZZZ" ? bars.slice(-400) : bars]));
    expect(backtestCap("ZZZ", 5, short)).toMatchObject({ ok: false, why: expect.stringMatching(/years of history/) });
    expect(summarizeEvidence([], false).summary).toMatch(/no historical evidence/);
  });
});

describe("current assessment", () => {
  const p = { candidates: [{ symbol: "AAA", trigger: ["concentration" as const], research: { versionId: "v1", asOf: "2026-11-01", action: null, thesis: null, bull: null, base: null, bear: null, weighted: null, confidence: null } }] };
  const now = (o: Partial<Parameters<typeof assess>[1]> = {}) => ({ at: new Date("2026-11-20T12:00:00Z"), weightPct: () => 8, capPct: () => 5, research: () => ({ versionId: "v1", asOf: "2026-11-01", complete: true }), planAction: () => "Hold", ...o });
  it("comes from today's weights and research, never from the test's results", () => {
    expect(assess(p, now()).status).toBe("Still attractive");
    expect(assess(p, now({ weightPct: () => 5.2 })).status).toBe("No longer attractive");
    expect(assess(p, now({ research: () => ({ versionId: "v2", asOf: "2026-11-15", complete: true }) })).status).toBe("More research needed");
    expect(assess(p, now({ at: new Date("2027-06-01T12:00:00Z") })).reasons.join(" ")).toMatch(/over 120 days old/);
  });
});

describe("review and repeats", () => {
  it("accepts No change, rejects unreadable output", () => {
    expect(validateReview({ verdict: "No change", reason: "Risk is already modest.", confidence: "high" })).toMatchObject({ verdict: "No change", confidence: "high" });
    expect(validateReview({ verdict: "Buy everything", reason: "x" })).toBeNull();
    expect(validateReview(null)).toBeNull();
  });
  it("does not review the same candidates twice unless the research changed", () => {
    const a = [{ symbol: "AAA", sellPct: 37.5, research: null }];
    expect(sameCandidates(a, [{ symbol: "AAA", sellPct: 40, research: null }])).toBe(true);
    expect(sameCandidates(a, [{ symbol: "AAA", sellPct: 60, research: null }])).toBe(false);
  });
});
