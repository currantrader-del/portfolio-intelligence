import { describe, expect, it } from "vitest";
import { buildPortfolio, type SnapshotInput } from "@/lib/portfolio/engine";
import { policyFromRules, type PolicyRuleRow } from "@/lib/policy/rules";
import { newCapital } from "@/lib/decision/newCapital";
import { validatePlan } from "@/lib/plan/plan";
import { ideaAlerts } from "@/lib/watch/watch";
import { toResearchRecord, type VersionRow } from "./records";
import { authorityOf, isAuthoritative, researchStanding } from "./standing";
import { coverage } from "./status";

// Record shapes copied from the real IREN history (ids shortened); numbers synthetic where noted.
const now = new Date("2026-11-08T23:00:00Z");
const sept: VersionRow = { id: "52e6", research_as_of: "2026-09-10", created_at: "2026-11-05T22:00:35Z", completeness: "complete", origin: "chatgpt_original", is_current: false, conclusion: { action: "HOLD / NO ADD" } };
const nov6: VersionRow = { id: "910d", research_as_of: "2026-11-06", created_at: "2026-11-06T14:44:49Z", completeness: "in_progress", origin: "claude_targeted_update", is_current: false, conclusion: { action: "WAIT / REVIEW", refresh_level: "full_reassessment" } };
const nov7: VersionRow = { id: "f8d5", research_as_of: "2026-11-07", created_at: "2026-11-07T08:46:09Z", completeness: "complete", origin: "claude_full", is_current: true, conclusion: { action: "Hold / no add", generated_by: "ai-research@2" } };
const nov8: VersionRow = { id: "13ee", research_as_of: "2026-11-08", created_at: "2026-11-08T21:22:53Z", completeness: "complete", origin: "claude_full", is_current: false, conclusion: { action: "Trim to about 3.0%", research_type: "full_investigation", review_state: "awaiting_approval", generated_by: "investigation@3" } };
const stalled: VersionRow = { id: "dab4", research_as_of: "2026-11-08", created_at: "2026-11-08T17:57:37Z", completeness: "in_progress", origin: "claude_full", is_current: false, conclusion: { research_type: "full_investigation", review_state: "running" } };

describe("research authority: only research you approved is an investment model", () => {
  it("classifies every kind of record", () => {
    expect(authorityOf(sept, now)).toBe("historical");
    expect(authorityOf(nov6, now)).toBe("stopped");
    expect(authorityOf(nov7, now)).toBe("preliminary_screen");
    expect(authorityOf(nov8, now)).toBe("awaiting_approval");
    expect(authorityOf(stalled, now)).toBe("stopped"); // no progress for 5 hours
    expect(authorityOf({ ...stalled, created_at: "2026-11-08T22:30:00Z" }, now)).toBe("running");
    expect(authorityOf({ ...nov8, is_current: true, conclusion: { ...nov8.conclusion, review_state: "adopted" } }, now)).toBe("approved_full");
    expect(authorityOf({ ...nov8, completeness: "partial", is_current: true, conclusion: { ...nov8.conclusion, review_state: "adopted_provisional" } }, now)).toBe("approved_provisional");
    expect(authorityOf({ ...nov8, conclusion: { ...nov8.conclusion, review_state: "set_aside" } }, now)).toBe("historical");
    expect(isAuthoritative("preliminary_screen")).toBe(false);
    expect(isAuthoritative("historical")).toBe(false);
    expect(isAuthoritative("approved_provisional")).toBe(true);
  });

  it("IREN: the finished Nov 8 investigation is used automatically, ahead of the Nov 7 screen and the Sept archive", () => {
    const s = researchStanding([sept, nov6, nov7, nov8], now);
    expect(s.inUse?.v.id).toBe("13ee");
    expect(s.authoritative).toBe(true);
    expect(s.pending).toBeNull();
    expect(s.decisions).toBe("Decisions use the research in use.");
    const r = toResearchRecord("IREN", "IREN", "held", [sept, nov6, nov7, nov8], undefined, null, now);
    expect(r).toMatchObject({ authority: "approved_full", authoritative: true, pendingReview: null });
  });

  it("with only screens and archives, the record is preliminary", () => {
    const r = toResearchRecord("IREN", "IREN", "held", [sept, nov6, nov7], undefined, null, now);
    expect(r).toMatchObject({ authority: "preliminary_screen", authoritative: false });
    expect(r.current?.id).toBe("f8d5");
    expect(coverage(r, 21.64, now, 120)).toMatchObject({ key: "unapproved", label: "Preliminary" });
  });

  it("after approval, the investigation is the model and the screen becomes history", () => {
    const adopted = { ...nov8, is_current: true, conclusion: { ...nov8.conclusion, review_state: "adopted" } };
    const r = toResearchRecord("IREN", "IREN", "held", [sept, nov6, { ...nov7, is_current: false }, adopted], undefined, null, now);
    expect(r).toMatchObject({ authority: "approved_full", authoritative: true, pendingReview: null });
  });
});

// ---- Decisions: synthetic portfolio where approved research WOULD add to AAA ----
const snap: SnapshotInput = {
  accountId: "a", accountName: "Broker", accountRole: "taxable_brokerage", asOf: "2026-11-07T21:00:00Z", totalValue: null, cashValue: 400,
  positions: [
    { symbol: "VOO", quantity: 10, price: 700, marketValue: 7000, costBasis: 7000 },
    { symbol: "VXUS", quantity: 10, price: 80, marketValue: 800, costBasis: 800 },
    { symbol: "AAA", quantity: 20, price: 25, marketValue: 500, costBasis: 500 },
  ],
};
const savings: SnapshotInput = { accountId: "s", accountName: "Savings", accountRole: "cash", asOf: "2026-11-07T23:59:00Z", totalValue: 12000, cashValue: 12000, positions: [] };
const row = (over: Partial<PolicyRuleRow>): PolicyRuleRow => ({
  id: Math.random().toString(36).slice(2), scope: "company", subject: "AAA", normal_low: null, normal_high: null, high_conviction_low: null, high_conviction_high: null,
  hard_max: null, value: null, conditions: null, source_label: "Test", source_date: null, source_status: "latest_approved", approval: "approved",
  approved_at: "2026-11-05T12:00:00Z", approval_note: null, created_at: "2026-11-05", ...over,
});
const policy = policyFromRules([
  row({ subject: "AAA", normal_low: 0.03, normal_high: 0.10, hard_max: 0.10 }),
  row({ scope: "bucket", subject: "US broad-market equity", normal_low: 0.25, normal_high: 0.40, hard_max: 0.5 }),
  row({ scope: "bucket", subject: "International equity", normal_low: 0.12, normal_high: 0.20, hard_max: 0.3 }),
  row({ scope: "portfolio", subject: "protected_reserve", value: 10000 }),
]);
const quiet = new Map([["AAA", { cik: "1", company: "AAA", filings: [{ form: "10-Q", filed: "2026-08-01", reportDate: null, description: "Quarterly report", items: [], isEarnings: true, url: "u", category: "periodic" as const, note: "" }], lastEarnings: null, nextEarningsEstimate: null, source: "s", fetchedAt: "t" }]]);
const aaa = (extra: Record<string, unknown>, origin = "claude_full") => toResearchRecord("AAA", "AAA", "held", [{
  id: "v1", research_as_of: "2026-10-20", created_at: "2026-10-20T00:00:00Z", completeness: "complete", origin, is_current: true,
  conclusion: { action: "HOLD / NO ADD", classification: "Growth", reference_price: "$26", reference_date: "2026-10-20",
    valuation: { approx_holding_period_years: 4, bear_value: 20, base_value: 90, bull_value: 200, bear_probability: 0.3, base_probability: 0.5, bull_probability: 0.2 },
    price_framework: [{ price_zone: "< $35", action: "Add" }], ...extra },
}], undefined, null, now);

describe("decisions follow research authority", () => {
  const p = buildPortfolio([snap, savings], new Map(), policy, {}, [], now);
  const run = (r: ReturnType<typeof aaa>) => newCapital({ amount: 400, source: "deposited", holdingsConfirmed: true, portfolio: p, research: [r], policy, now, filings: quiet });

  it("approved research can receive new money", () => {
    const r = run(aaa({ research_type: "full_investigation", review_state: "adopted" }));
    expect(r.recommendation.allocations[0]).toMatchObject({ symbol: "AAA" });
  });

  it("a preliminary screen never does, says why, and does not block a diversified purchase", () => {
    const r = run(aaa({ generated_by: "ai-research@2" }));
    const o = r.options.find((x) => x.symbol === "AAA")!;
    expect(o.label).toBe("Preliminary research");
    expect(o.eligible).toBe(false);
    expect(o.highConviction).toBe(false);
    expect(o.verdicts!.research.detail).toMatch(/Preliminary research only: the record on file is a preliminary screen, enough for Hold or No Add, not for new money/);
    expect(o.reassessment).toMatchObject({ status: "not_approved" });
    expect(o.reassessment!.current).toMatch(/^Preliminary research only\. .*Until a targeted investigation is done: hold, no new money\./);
    expect(r.recommendation.allocations.some((a) => a.symbol === "AAA")).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/Only preliminary research for AAA/);
    expect(r.gates.find((g) => g.key === "research")!.ok).toBe(true);
  });

  it("imported (historical) research is context only too", () => {
    const o = run(aaa({}, "chatgpt_original")).options.find((x) => x.symbol === "AAA")!;
    expect(o.label).toBe("Preliminary research");
    expect(o.verdicts!.research.detail).toMatch(/older research, enough for Hold or No Add/);
  });

  it("no buy-zone alerts from unapproved bands", () => {
    const quotes = new Map([["AAA", { symbol: "AAA", price: 30, prevClose: 30.2, provider: "test", at: "t" }]]) as unknown as Parameters<typeof ideaAlerts>[2];
    const withRef = (r: ReturnType<typeof aaa>) => ({ ...r, current: { ...r.current!, parsed: { ...r.current!.parsed, referencePrice: 40, zones: [{ low: 0, high: 35, label: "Below $35", action: "Add" }, { low: 35, high: Infinity, label: "Above $35", action: "Hold" }] } } });
    expect(ideaAlerts([withRef(aaa({ generated_by: "ai-research@2" }))], new Set(), quotes)).toHaveLength(0);
    expect(ideaAlerts([withRef(aaa({ research_type: "full_investigation", review_state: "adopted" }))], new Set(), quotes).map((a) => a.kind)).toEqual(["price_zone"]);
  });
});

describe("the plan cannot turn an unapproved thesis into a target or an opportunity", () => {
  it("holds targets at today's weight and drops opportunities without approved research", () => {
    const plan = validatePlan({
      summary: "s", market: {}, cash: {}, stale: [], next_actions: [],
      positions: [{ symbol: "ACME", target_pct: 9, action: "Add", priority: 1, reason: "r" }, { symbol: "OKAY", target_pct: 5, action: "Add", priority: 1, reason: "r" }],
      opportunities: [{ symbol: "BETA", verdict: "Buy now", amount_usd: 500 }, { symbol: "GOOD", verdict: "Buy now", amount_usd: 500 }],
    }, {
      holdings: [{ symbol: "ACME", weight: 0.03 }, { symbol: "OKAY", weight: 0.03 }],
      researched: [{ symbol: "ACME", asOf: "2026-11-07", approved: false }, { symbol: "OKAY", asOf: "2026-11-08", approved: true }, { symbol: "BETA", asOf: "2026-11-07", stage: "ready", approved: false }, { symbol: "GOOD", asOf: "2026-11-08", stage: "ready", approved: true }],
      maxFor: () => 0.1, deployable: 2000,
    });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.positions.find((x) => x.symbol === "ACME")).toMatchObject({ targetPct: 3, flags: [expect.stringMatching(/not used: the research is not in use yet/)] });
    expect(plan.positions.find((x) => x.symbol === "OKAY")!.targetPct).toBe(5);
    expect(plan.opportunities.map((o) => o.symbol)).toEqual(["GOOD"]);
    expect(plan.problems.join(" ")).toMatch(/BETA was suggested as an opportunity but its research is not in use yet/);
  });
});
