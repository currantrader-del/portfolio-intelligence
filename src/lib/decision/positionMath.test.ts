import { describe, expect, it } from "vitest";
import { buildPortfolio, type SnapshotInput } from "@/lib/portfolio/engine";
import { policyFromRules, type PolicyRuleRow } from "@/lib/policy/rules";
import { toResearchRecord } from "@/lib/research/records";
import type { Workspace } from "@/lib/workspace-core";
import { capsFor, factsFrom } from "@/lib/shadow/proposals";
import { findCandidates } from "@/lib/shadow/improve";
import { combinedWeight, levelState, levelsFor, roomTo, sellToReach, weightAfterTrade, type PositionSnapshot } from "./positionMath";
import { reviewPosition } from "./review";

// The audit's own figures (2026-11-11): $5,048 direct + $1,138 through funds, $40,602 invested portfolio.
const AUDIT: PositionSnapshot = { symbol: "NVDA", direct: 5048, viaFunds: 1138, invested: 40602 };

describe("position math keeps fund exposure (audit finding 1)", () => {
  it("reproduces the 15.2% combined exposure", () => {
    expect(combinedWeight(AUDIT)).toBeCloseTo(0.1524, 4);
  });
  it("a $2,612 trim leaves about 8.8%, not 6%, with proceeds kept as brokerage cash", () => {
    expect(weightAfterTrade(AUDIT, -2612)).toBeCloseTo(0.0880, 3);
  });
  it("selling every direct share leaves the fund exposure, about 2.8%, not 0%", () => {
    expect(weightAfterTrade(AUDIT, -AUDIT.direct)).toBeCloseTo(0.0280, 3);
    expect(weightAfterTrade(AUDIT, -99_999)).toBeCloseTo(0.0280, 3); // a sale is capped at the shares held
  });
  it("trimming back to the research's 15% is about $96", () => {
    const t = sellToReach(AUDIT, 0.15);
    expect(t.dollars).toBeGreaterThan(90);
    expect(t.dollars).toBeLessThan(100);
    expect(t.weightAfter).toBeCloseTo(0.15, 6);
    expect(t.reachable).toBe(true);
  });
  it("says when funds alone are above a target", () => {
    const t = sellToReach(AUDIT, 0.02);
    expect(t.reachable).toBe(false);
    expect(t.dollars).toBe(5048);
  });
  it("models where the money goes: cash kept, new money in, proceeds withdrawn", () => {
    expect(weightAfterTrade(AUDIT, 500, "brokerage_cash")).toBeCloseTo((5548 + 1138) / 40602, 6);
    expect(weightAfterTrade(AUDIT, 500, "new_money")).toBeCloseTo((5548 + 1138) / 41102, 6);
    expect(weightAfterTrade(AUDIT, -1000, "withdrawn")).toBeCloseTo((4048 + 1138) / 39602, 6);
    // Room to 18% with existing cash vs with new money (the denominator grows with new money).
    expect(roomTo(AUDIT, 0.18)).toBeCloseTo(0.18 * 40602 - 6186, 1);
    const r = roomTo(AUDIT, 0.18, "new_money");
    expect(weightAfterTrade(AUDIT, r, "new_money")).toBeCloseTo(0.18, 6);
  });
  it("keeps the normal range, the research level and the maximum apart", () => {
    const l = { normal: { low: 0.06, high: 0.1 }, highConviction: { low: 0.1, high: 0.15 }, researchReview: { value: 0.15, source: "research 2026-11-10" }, hardMax: 0.18, hasOwnLimit: true };
    expect(levelState(0.152, l).key).toBe("over_review");
    expect(levelState(0.19, l).key).toBe("over_max");
    expect(levelState(0.12, l).key).toBe("above_normal");
    expect(levelState(0.08, l).key).toBe("within");
  });
});

/* ------------------------------------------------------- one snapshot, every page (synthetic, NVDA-shaped) */

const now = new Date("2026-11-11T18:00:00Z");
const row = (over: Partial<PolicyRuleRow>): PolicyRuleRow => ({
  id: Math.random().toString(36).slice(2), scope: "company", subject: "NVDA", normal_low: null, normal_high: null, high_conviction_low: null, high_conviction_high: null,
  hard_max: null, value: null, conditions: null, source_label: "Test", source_date: null, source_status: "latest_approved", approval: "approved",
  approved_at: "2026-11-11T14:00:00Z", approval_note: null, created_at: "2026-11-06", ...over,
});
const policy = policyFromRules([
  row({ subject: "NVDA", normal_low: 0.06, normal_high: 0.1, high_conviction_low: 0.1, high_conviction_high: 0.15, hard_max: 0.18 }),
  row({ subject: "ZZZ", normal_low: 0.02, normal_high: 0.04, hard_max: 0.06 }),
  row({ scope: "generic_company", subject: "*", hard_max: 0.18 }),
]);
// VOO holds NVDA, so part of the exposure comes through the fund.
const snap: SnapshotInput = {
  accountId: "a", accountName: "Broker", accountRole: "taxable_brokerage", asOf: "2026-11-11T21:00:00Z", totalValue: null, cashValue: 1221,
  positions: [
    { symbol: "NVDA", quantity: 32, price: 174, marketValue: 5568, costBasis: 3000 },
    { symbol: "VOO", quantity: 24, price: 625, marketValue: 15000, costBasis: 12000 },
    { symbol: "VXUS", quantity: 200, price: 65, marketValue: 13000, costBasis: 12000 },
    { symbol: "BND", quantity: 70, price: 72, marketValue: 5040, costBasis: 5000 },
    { symbol: "ZZZ", quantity: 10, price: 100, marketValue: 1000, costBasis: 1200 },
  ],
};
const portfolio = buildPortfolio([snap], new Map(), policy, {}, [], now);
const inv = (symbol: string, id: string, asOf: string, allocation: Record<string, unknown>, extra: Record<string, unknown> = {}) => toResearchRecord(symbol, symbol, "held", [{
  id, research_as_of: asOf, completeness: "partial", origin: "claude_full", is_current: true, created_at: `${asOf}T17:00:00Z`,
  conclusion: { research_type: "full_investigation", review_state: "awaiting_approval", action: "Hold, no add. Keep look-through at or below 15%; trim back to 15% if above.", reference_price: "$174", reference_date: asOf,
    valuation: { terminal_date: "2029-12-31", bear_value: 100, base_value: 180, bull_value: 260, bear_probability: 0.25, base_probability: 0.5, bull_probability: 0.25 },
    allocation, completion: { kind: "incomplete", reasons: ["One question about a customer's financing is open"] }, ...extra },
}], undefined, null, now);
const nvda = inv("NVDA", "nv-3", "2026-11-10", { target_pct: 15, max_pct: 15, note: "15% look-through" });
// An unrelated stock whose research has an open question.
const zzz = inv("ZZZ", "zz-1", "2026-11-01", { target_pct: 3, max_pct: 4, note: "" });
const ws = { now, portfolio, research: [nvda, zzz], policy, alerts: [], yields: { y2: null, y10: null }, quotes: new Map(), benchmarks: [], ledger: [], transfers: [], capitalPreference: null, userId: null, marketOpen: true, exposure: null, exposureLimits: [] } as unknown as Workspace;

describe("NVDA from one snapshot: Portfolio, Risk, Decisions and Plan agree", () => {
  const e = portfolio.exposures.find((x) => x.symbol === "NVDA")!;
  const rv = reviewPosition(ws, "NVDA")!;
  it("uses the same combined weight everywhere", () => {
    expect(e.viaEtfs).toBeGreaterThan(0);
    expect(e.total).toBeGreaterThan(0.15); // above the research level, under the maximum, like the audit case
    expect(e.total).toBeLessThan(0.18);
    expect(rv.weight).toBeCloseTo(e.total, 10); // Decisions review = Portfolio/Risk exposure row
    const facts = factsFrom(ws, null);
    expect(facts.holdings.find((h) => h.symbol === "NVDA")!.weight).toBeCloseTo(e.total, 10); // Plan's improvement check
    expect(rv.snapshot.invested).toBe(portfolio.total);
  });
  it("shows the levels apart: normal 6–10%, research 15%, maximum 18%", () => {
    expect(rv.levels).toMatchObject({ normal: { low: 0.06, high: 0.1 }, researchReview: { value: 0.15 }, hardMax: 0.18 });
    expect(levelsFor(policy, "NVDA", { allocation: nvda.current!.parsed.allocation, asOf: "2026-11-10" }).researchReview?.value).toBe(0.15);
  });
  it("keeps fund exposure after a trim or an exit", () => {
    const exit = rv.options.find((o) => o.key === "exit")!;
    expect(exit.weightAfter).toBeCloseTo(e.viaEtfs, 10);
    expect(exit.weightAfter).toBeGreaterThan(0);
    for (const o of rv.options.filter((x) => x.key !== "hold" && x.key !== "add")) expect(o.weightAfter).toBeCloseTo((e.total * portfolio.total - o.dollars) / portfolio.total, 3);
  });
  it("puts the research-backed size first and labels the others", () => {
    const trim = rv.options.find((o) => o.key === "trim");
    if (e.total > 0.15) {
      expect(trim).toMatchObject({ basis: "research" });
      expect(trim!.weightAfter).toBeCloseTo(0.15, 3);
      expect(rv.suggestion, JSON.stringify([rv.weight, rv.suggestion])).toMatchObject({ key: "trim" });
    }
    expect(rv.options.find((o) => o.key === "exit")!.basis).toBe("hypothetical");
    expect(rv.options.find((o) => o.key === "trim_normal")?.basis ?? "hypothetical").toBe("hypothetical");
  });
  it("never offers an add just because the maximum has room", () => {
    const add = rv.options.find((o) => o.key === "add")!;
    expect(add.available).toBe(false);
    expect(add.basis).toBe("blocked");
  });
  it("Plan's proposal uses the research's 15% line on combined weight, not 10% of the direct holding", () => {
    const c = findCandidates({ ...factsFrom(ws, null), total: portfolio.total, capFor: capsFor(ws) });
    const n = c.find((x) => x.symbol === "NVDA");
    if (n) { expect(n.capPct).toBe(15); expect(n.targetPct).toBe(15); }
    expect(c.find((x) => x.symbol === "NVDA" && x.targetPct === 10)).toBeUndefined();
  });
  it("an unrelated stock's open research question does not block NVDA's decision", () => {
    const alone = reviewPosition({ ...ws, research: [nvda] } as Workspace, "NVDA")!;
    expect(alone.suggestion).toEqual(rv.suggestion);
    expect(alone.options).toEqual(rv.options);
  });
});
