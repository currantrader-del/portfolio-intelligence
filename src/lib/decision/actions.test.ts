import { describe, expect, it } from "vitest";
import { buildPortfolio, type SnapshotInput } from "@/lib/portfolio/engine";
import { policyFromRules, type PolicyRuleRow } from "@/lib/policy/rules";
import { toResearchRecord } from "@/lib/research/records";
import type { Workspace } from "@/lib/workspace-core";
import { DEFAULT_PLAN, planStatus } from "@/lib/plan/target";
import { holdingAction, holdingActions } from "./actions";
import { reviewPosition } from "./review";

/*
 * 2026-11-18 audit: Plan said "trim about 7 shares", Stocks & funds said "trim about $1,794", and the research page said
 * "Trim" beside a "Hold" price band. These tests pin one answer per holding for one portfolio and research state.
 * Synthetic, NVDA-shaped data only.
 */
const now = new Date("2026-11-18T15:00:00Z");
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
const broker: SnapshotInput = {
  accountId: "s", accountName: "Broker", accountRole: "taxable_brokerage", asOf: "2026-11-18T14:00:00Z", totalValue: null, cashValue: 1200,
  positions: [
    { symbol: "NVDA", quantity: 20, price: 174, marketValue: 3480, costBasis: 3900 },
    { symbol: "VOO", quantity: 20, price: 625, marketValue: 12500, costBasis: 11000 },
    { symbol: "VXUS", quantity: 100, price: 70, marketValue: 7000, costBasis: 6500 },
    { symbol: "ZZZ", quantity: 10, price: 100, marketValue: 1000, costBasis: 1200 },
  ],
};
// A robo-advisor account (like Acorns): not where trades are placed, but part of the portfolio and its risk.
const robo: SnapshotInput = { accountId: "r", accountName: "Robo", accountRole: "taxable_brokerage", asOf: "2026-10-31T21:00:00Z", totalValue: null, cashValue: 0, positions: [{ symbol: "VOO", quantity: 4, price: 625, marketValue: 2500, costBasis: 2400 }] };
const research = (allocation: Record<string, unknown>) => [
  toResearchRecord("NVDA", "NVIDIA", "held", [{
    id: "nv", research_as_of: "2026-11-17", completeness: "complete", origin: "claude_full", is_current: true, created_at: "2026-11-17T17:00:00Z",
    conclusion: {
      research_type: "full_investigation", review_state: "adopted", reference_price: "$174", reference_date: "2026-11-17",
      action: "Hold, no add. Trim back to about 10% look-through.",
      valuation: { terminal_date: "2029-12-31", bear_value: 106, base_value: 180, bull_value: 260, bear_probability: 0.3, base_probability: 0.45, bull_probability: 0.25 },
      price_framework: [
        { price_zone: "Below $137", action: "Re-review an add" },
        { price_zone: "$137–$190", action: "Hold, no add" },
        { price_zone: "Above $190", action: "Trim back to 10%" },
      ],
      allocation,
    },
  }], undefined, null, now),
  toResearchRecord("ZZZ", "Zed", "held", [{
    id: "zz", research_as_of: "2026-11-10", completeness: "complete", origin: "claude_full", is_current: true, created_at: "2026-11-10T17:00:00Z",
    conclusion: { research_type: "full_investigation", review_state: "adopted", action: "Hold, no add.", reference_price: "$100", reference_date: "2026-11-10",
      price_framework: [{ price_zone: "$80–$130", action: "Hold" }], allocation: { target_pct: 4, max_pct: 4 } },
  }], undefined, null, now),
];
const wsOf = (outside?: number) => {
  const portfolio = buildPortfolio([broker, robo], new Map(), policy, {}, [], now, [], outside ? { amount: outside, setAt: "2026-11-16T12:00:00Z" } : undefined);
  return { now, portfolio, research: research({ target_pct: 10, max_pct: 10, note: "about 10% look-through" }), policy, alerts: [], yields: { y2: null, y10: null }, quotes: new Map(), benchmarks: [], ledger: [], transfers: [], capitalPreference: null, userId: null, marketOpen: true, exposure: null, exposureLimits: [] } as unknown as Workspace;
};
const noFilings = new Map();

describe("one action per holding on every page", () => {
  const ws = wsOf();
  const plan = holdingActions(ws, noFilings);
  const nv = plan.find((a) => a.symbol === "NVDA")!;

  it("Plan, Stocks & funds, the research page and Decisions give the same NVDA action", () => {
    expect(nv.now.verb).toBe("Trim");
    expect(holdingAction(ws, "NVDA", noFilings)!.now).toEqual(nv.now); // Stocks & funds and Portfolio
    expect(reviewPosition(ws, "NVDA", null)!.now).toEqual(nv.now); // research page (held) when SEC can't be read
    const rv = reviewPosition(ws, "NVDA", null)!;
    const trim = rv.options.find((o) => o.key === "trim")!;
    expect(rv.suggestion.key).toBe("trim"); // Decisions review
    expect(nv.now.headline).toContain(`$${trim.dollars.toLocaleString("en-US")}`); // same dollars as Decisions
    expect(trim.weightAfter).toBeCloseTo(0.1, 3);
  });
  it("gives the trim in shares too, says it is about size not price, and keeps the approved maximum apart", () => {
    const rv = reviewPosition(ws, "NVDA", null)!;
    const shares = Math.round(rv.options.find((o) => o.key === "trim")!.dollars / 174);
    expect(nv.now.headline).toContain(`about ${shares} shares`);
    expect(nv.now.headline).toMatch(/size, not price: \$137–\$190 is the research's hold range/);
    expect(nv.now.headline).toMatch(/approved 18% maximum does not require it/);
    expect(nv.weight).toBeLessThan(0.18);
  });
  it("the plan carries no trade text of its own", () => {
    const st = planStatus(DEFAULT_PLAN, ws.portfolio, ws.research, new Map(), ws.policy);
    expect(JSON.stringify(st)).not.toMatch(/\btrim\b|\bshares?\b/i);
  });
  it("a stock inside its levels holds on every page", () => {
    const z = plan.find((a) => a.symbol === "ZZZ")!;
    expect(z.now.verb).toBe("Hold");
    expect(reviewPosition(ws, "ZZZ", null)!.now).toEqual(z.now);
  });
  it("lists only individual stocks, never funds", () => {
    expect(plan.map((a) => a.symbol).sort()).toEqual(["NVDA", "ZZZ"]);
  });
});

describe("denominators", () => {
  it("weights include every account, robo accounts too", () => {
    const ws = wsOf();
    expect(ws.portfolio.total).toBeCloseTo(3480 + 12500 + 7000 + 1000 + 1200 + 2500, 6);
    const e = ws.portfolio.exposures.find((x) => x.symbol === "NVDA")!;
    expect(e.direct).toBeCloseTo(3480 / ws.portfolio.total, 4);
    expect(e.viaEtfs).toBeGreaterThan(0); // through VOO, in both accounts
    expect(holdingAction(ws, "NVDA", noFilings)!.weight).toBeCloseTo(e.total, 10);
  });
  it("outside money changes no weight, no limit room and no action until it is transferred", () => {
    const a = wsOf(), b = wsOf(10_000);
    expect(b.portfolio.total).toBe(a.portfolio.total);
    expect(b.portfolio.exposures).toEqual(a.portfolio.exposures);
    expect(holdingActions(b, noFilings)).toEqual(holdingActions(a, noFilings));
    expect(b.portfolio.investableCapital).toBeCloseTo(a.portfolio.total + 10_000, 6);
  });
});

describe("no sale from size or price alone", () => {
  it("above the normal range but with no research trim level: hold, not trim", () => {
    const ws = { ...wsOf(), research: research({}) } as Workspace;
    const n = holdingAction(ws, "NVDA", noFilings)!;
    expect(n.weight).toBeGreaterThan(0.1); // above the 6–10% normal range
    expect(n.now.verb).toBe("Hold");
  });
});
