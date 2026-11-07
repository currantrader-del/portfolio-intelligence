import { describe, expect, it } from "vitest";
import { evaluate, occSymbol, scoreboard, validateIdea, type Entry } from "./trades";

const today = "2026-11-09";
const base = {
  symbol: "acme", instrument: "stock", option: null, entry_price: 100, target_price: 125, stop_price: 92, end_date: "2027-01-15",
  confidence: "high", probability: 0.55, thesis: "Results on Dec 4 should show the new product line ramping faster than consensus assumes.", why_now: "Earnings on 2026-12-04",
  risks: ["Guidance could disappoint"], would_change: "A pre-announcement", size_usd: 1500,
  sources: [{ title: "8-K", url: "https://sec.gov/a" }, { title: "IR", url: "https://acme.com/ir" }],
};
const ok = (raw: unknown, price: number | null = 100) => {
  const r = validateIdea(raw, { today, price });
  if ("rejected" in r) throw new Error(r.rejected);
  return r.idea;
};
const why = (raw: unknown, price: number | null = 100) => { const r = validateIdea(raw, { today, price }); return "rejected" in r ? r.rejected : "accepted"; };

describe("validateIdea", () => {
  it("accepts a clear stock idea and computes its own numbers", () => {
    const i = ok(base);
    expect(i.symbol).toBe("ACME");
    expect(i.rewardRisk).toBeCloseTo(25 / 8);
    expect(i.expectedPct).toBeCloseTo(0.55 * 0.25 - 0.45 * 0.08);
  });
  it("rejects ideas that do not beat VOO plus margin", () => {
    expect(why({ ...base, target_price: 112, stop_price: 95, probability: 0.45 })).toMatch(/does not beat VOO/);
  });
  it("rejects poor reward for the risk, low confidence, and stale prices", () => {
    expect(why({ ...base, target_price: 110, stop_price: 92 })).toMatch(/reward is only/);
    expect(why({ ...base, confidence: "low" })).toMatch(/confidence/);
    expect(why(base, 110)).toMatch(/written for \$100/);
  });
  it("rejects day trades and very long holds", () => {
    expect(why({ ...base, end_date: "2026-11-11" })).toMatch(/holding period/);
    expect(why({ ...base, end_date: "2027-09-01" })).toMatch(/holding period/);
  });
  it("checks option legs and always states the total-loss risk", () => {
    const i = ok({ ...base, instrument: "option", option: { type: "call", strike: 105, expiry: "2027-01-15", est_premium: 6.2 } });
    expect(i.option?.contract).toBe("ACME270115C00105000");
    expect(i.risks.join(" ")).toMatch(/worthless/);
    expect(why({ ...base, instrument: "option", option: { type: "call", strike: 105, expiry: "2027-01-13" } })).toMatch(/Friday/);
    expect(why({ ...base, instrument: "option", option: { type: "call", strike: 105, expiry: "2026-12-18" } })).toMatch(/expires before/);
  });
  it("puts reverse target and stop", () => {
    const i = ok({ ...base, instrument: "option", option: { type: "put", strike: 95, expiry: "2027-01-15" }, target_price: 75, stop_price: 108 });
    expect(i.direction).toBe("down");
    expect(why({ ...base, instrument: "option", option: { type: "put", strike: 95, expiry: "2027-01-15" } })).toMatch(/wrong sides/);
  });
});

describe("evaluate", () => {
  const idea = ok(base);
  const entry: Entry = { at: "2026-11-09T15:00:00Z", underlying: 100, premium: null, premiumSource: null, voo: 600 };
  it("stays open between stop and target, scored against VOO", () => {
    const r = evaluate(idea, entry, { underlying: 110, premium: null, voo: 606, today: "2026-11-20" });
    expect(r.status).toBe("open");
    expect(r.returnPct).toBeCloseTo(0.1);
    expect(r.edgePct).toBeCloseTo(0.09);
  });
  it("closes at target, stop, or the end date", () => {
    expect(evaluate(idea, entry, { underlying: 126, premium: null, voo: 600, today: "2026-12-05" }).status).toBe("target");
    expect(evaluate(idea, entry, { underlying: 90, premium: null, voo: 600, today: "2026-12-05" }).status).toBe("stop");
    expect(evaluate(idea, entry, { underlying: 101, premium: null, voo: 600, today: "2027-01-16" }).status).toBe("ended");
  });
  it("prices options live, and at intrinsic value once expired", () => {
    const opt = ok({ ...base, instrument: "option", option: { type: "call", strike: 105, expiry: "2027-01-15" } });
    const e = { ...entry, premium: 5, premiumSource: "quote" as const };
    expect(evaluate(opt, e, { underlying: 112, premium: 9, voo: 600, today: "2026-12-01" }).returnPct).toBeCloseTo(0.8);
    const end = evaluate(opt, e, { underlying: 103, premium: null, voo: 600, today: "2027-01-15" });
    expect(end).toMatchObject({ returnPct: -1, priced: "intrinsic" });
  });
});

it("scoreboard compares against VOO in dollars", () => {
  const s = scoreboard([
    { sizeUsd: 1000, result: { status: "target", returnPct: 0.25, vooPct: 0.02, edgePct: 0.23, underlyingPct: 0.25, priced: "live" } },
    { sizeUsd: null, result: { status: "stop", returnPct: -0.08, vooPct: 0.01, edgePct: -0.09, underlyingPct: -0.08, priced: "live" } },
  ]);
  expect(s).toMatchObject({ closed: 2, beatVoo: 1, hitTarget: 1 });
  expect(s.edgeUsd).toBeCloseTo(140);
});

it("builds OCC symbols", () => expect(occSymbol("nvda", "2026-12-18", "put", 142.5)).toBe("NVDA261218P00142500"));

import { researched } from "./job";
it("only records a search that actually researched", () => {
  expect(researched([], 0)).toBe(false);
  expect(researched([{ tool: "get_quote" }, { tool: "get_technicals" }], 0)).toBe(false);
  expect(researched([{ tool: "get_quote" }, { tool: "get_technicals" }, { tool: "web_search" }], 1)).toBe(true);
});
