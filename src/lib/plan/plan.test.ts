import { describe, expect, it } from "vitest";
import { validatePlan, type PlanFacts } from "./plan";

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
