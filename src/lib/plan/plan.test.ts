import { describe, expect, it } from "vitest";
import { PLAN_SYSTEM, validatePlan, type PlanFacts } from "./plan";

// Synthetic tickers and numbers only.
const facts: PlanFacts = {
  holdings: [{ symbol: "ACME", weight: 0.062 }, { symbol: "VTI", weight: 0.5 }],
  researched: [{ symbol: "ACME", asOf: "2026-11-07" }, { symbol: "BETA", asOf: "2026-11-01" }],
  maxFor: (s) => (s === "ACME" ? 0.07 : s === "VTI" ? null : 0.05),
  deployable: 1956,
};
const raw = () => ({
  summary: "Hold the core, add to BETA only below $40.",
  market: { stance: "Neutral", short_term: "Mixed breadth.", long_term: "Earnings growth intact." },
  positions: [
    { symbol: "ACME", status: "held", target_pct: 9, action: "Hold", priority: 2, reason: "Thesis intact." },
    { symbol: "VTI", status: "held", target_pct: 55, action: "Default home for cash", priority: 1, reason: "Core." },
    { symbol: "BETA", status: "idea", target_pct: 3, action: "Add below $40", priority: 3, reason: "Fair at today's price." },
    { symbol: "ZZZZ", status: "idea", target_pct: 2, action: "Buy", priority: 1, reason: "Invented." },
  ],
  cash: { now: "Put $1,000 in VTI.", wait_for: "BETA below $40." },
  stale: [{ symbol: "acme", why: "New 10-Q" }],
  next_actions: ["Upload fresh statements"],
});

describe("validatePlan", () => {
  it("uses the app's current weights, caps targets at the policy maximum and drops unknown symbols", () => {
    const p = validatePlan(raw(), facts);
    if ("error" in p) throw new Error(p.error);
    const acme = p.positions.find((x) => x.symbol === "ACME")!;
    expect(acme.currentPct).toBe(6.2);
    expect(acme.targetPct).toBe(7);
    expect(acme.maxPct).toBe(7);
    expect(acme.flags[0]).toMatch(/capped at the 7% policy maximum/);
    expect(p.positions.find((x) => x.symbol === "BETA")?.currentPct).toBe(0);
    expect(p.positions.some((x) => x.symbol === "ZZZZ")).toBe(false);
    expect(p.problems.some((x) => x.startsWith("ZZZZ"))).toBe(true);
    expect(p.stale[0].symbol).toBe("ACME");
    expect(p.positions[0].symbol).toBe("VTI"); // priority 1 first
    expect(p.cash.deployable).toBe(1956);
  });
  it("reports holdings the plan left out and targets over 100%", () => {
    const r = raw();
    r.positions = [{ symbol: "BETA", status: "idea", target_pct: 120, action: "Add", priority: 1, reason: "" }];
    const p = validatePlan(r, facts);
    if ("error" in p) throw new Error(p.error);
    expect(p.problems).toContain("ACME is held but the plan did not cover it");
    expect(p.positions[0].targetPct).toBeNull(); // 120% is out of range
  });
  it("rejects an unreadable reply", () => expect(validatePlan(null, facts)).toEqual({ error: "The planner did not return a readable plan." }));
});

describe("opportunities", () => {
  const f2: PlanFacts = { ...facts, researched: [...facts.researched, { symbol: "GAMMA", asOf: "2026-11-05", stage: "ready" }, { symbol: "DELTA", asOf: "2026-11-05", stage: "passed" }], deployable: 1000 };
  const r2 = () => ({ ...raw(), positions: [...raw().positions, { symbol: "DELTA", status: "idea", target_pct: 2, action: "Buy", priority: 1, reason: "x" }],
    opportunities: [
      { symbol: "GAMMA", verdict: "Buy now", buy_below: 50, amount_usd: 1500, expected_return: "12%/yr", vs_voo: "+5 pts", reason: "Cheap on cash flow." },
      { symbol: "BETA", verdict: "Buy now", amount_usd: 500, reason: "Not ready." },
      { symbol: "DELTA", verdict: "Buy now", amount_usd: 500, reason: "Passed." },
    ] });
  it("keeps only Ready companies, caps amounts at deployable cash, and drops passed ones everywhere", () => {
    const p = validatePlan(r2(), f2);
    if ("error" in p) throw new Error(p.error);
    expect(p.opportunities.map((o) => o.symbol)).toEqual(["GAMMA"]);
    expect(p.opportunities[0].amountUsd).toBe(1000);
    expect(p.positions.some((x) => x.symbol === "DELTA")).toBe(false);
    expect(p.problems.some((x) => x.startsWith("BETA was suggested"))).toBe(true);
    expect(p.problems.some((x) => x.startsWith("DELTA"))).toBe(false);
  });
});

describe("planner instructions follow the approved method", () => {
  it("treats ranges as guidelines and ceilings, applies no reserve, and never applies retired hurdles", () => {
    expect(PLAN_SYSTEM).toMatch(/guidelines and risk ceilings, never targets to fill/);
    expect(PLAN_SYSTEM).toMatch(/below 5% cash, is never by itself a reason to buy, sell, or delay investing/);
    expect(PLAN_SYSTEM).toMatch(/There is no protected savings reserve/);
    expect(PLAN_SYSTEM).toMatch(/holding cash is a valid decision/);
    expect(PLAN_SYSTEM).toMatch(/never mention or apply a hurdle/);
    expect(PLAN_SYSTEM).toMatch(/not like for like/);
    expect(PLAN_SYSTEM).not.toMatch(/buckets within their ranges/);
  });
});
