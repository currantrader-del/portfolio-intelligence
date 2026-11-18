import { describe, expect, it } from "vitest";
import { buildPortfolio, type SnapshotInput } from "@/lib/portfolio/engine";
import { toResearchRecord } from "@/lib/research/records";
import { policyFromRules, type PolicyRuleRow } from "@/lib/policy/rules";
import { DEFAULT_PLAN, buyLevelOf, planFrom, planStatus, noLongerGood, isBuyAction } from "./target";

// Synthetic data only.
const now = new Date("2026-11-17T16:00:00Z");
const broker: SnapshotInput = {
  accountId: "b", accountName: "Broker", accountRole: "taxable_brokerage", asOf: "2026-11-17T14:00:00Z", sourceKind: "schwab_api", totalValue: null, cashValue: 1000,
  positions: [
    { symbol: "VOO", quantity: 10, price: 600, marketValue: 6000, costBasis: 6000 },
    { symbol: "VXUS", quantity: 20, price: 100, marketValue: 2000, costBasis: 2000 },
    { symbol: "AAA", quantity: 10, price: 100, marketValue: 1000, costBasis: 1000 },
  ],
};
const robo: SnapshotInput = { accountId: "r", accountName: "Robo", accountRole: "taxable_brokerage", asOf: "2026-09-30T21:00:00Z", totalValue: null, cashValue: 0, positions: [{ symbol: "VOO", quantity: 5, price: 600, marketValue: 3000, costBasis: 3000 }] };
const p = buildPortfolio([broker, robo], new Map(), null, {}, [], now, [], { amount: 10000, setAt: "2026-11-16T12:00:00Z" });
const prow = (over: Partial<PolicyRuleRow>): PolicyRuleRow => ({
  id: Math.random().toString(36).slice(2), scope: "company", subject: "X", normal_low: null, normal_high: null, high_conviction_low: null, high_conviction_high: null,
  hard_max: null, value: null, conditions: null, source_label: "Test", source_date: null, source_status: "latest_approved", approval: "approved",
  approved_at: "2026-11-11T14:00:00Z", approval_note: null, created_at: "2026-11-06", ...over,
});
const rec = (symbol: string, action: string) => toResearchRecord(symbol, symbol, "watch", [{ id: symbol, research_as_of: "2026-11-10", completeness: "complete", origin: "claude_full", is_current: true, conclusion: { review_state: "adopted", action } }]);

describe("your plan", () => {
  it("reads buy levels from research actions", () => {
    expect(buyLevelOf("Watch. No new money now. Consider a small starter only below about $345 (about 10%)")).toBe(345);
    expect(buyLevelOf("Hold / no add (reconsider adding below ~$230; trim only above ~$330)")).toBe(230);
    expect(buyLevelOf("Hold / no add (consider a small add below $70 only after user trends stabilise)")).toBe(70);
    expect(buyLevelOf("Hold, no add. No trade before the results.")).toBeNull();
  });
  it("measures every account (Acorns-style accounts included) and keeps outside money out of every weight", () => {
    const st = planStatus(DEFAULT_PLAN, p, [], new Map(), null);
    expect(st.base).toBe(6000 + 2000 + 1000 + 1000 + 3000); // both accounts, outside money excluded
    expect(st.base).toBe(p.total);
    expect(st.outside).toBe(10000);
    expect(st.potential).toBe(st.base + 10000);
    const us = st.buckets.find((b) => b.bucket === "US broad-market equity")!;
    expect(us.value).toBe(9000); // the other account's VOO counts
    expect(us.weight).toBeCloseTo(9000 / 13000, 6);
    expect(st.accounts.map((a) => a.name)).toEqual(expect.arrayContaining(["Broker", "Robo"]));
    // The same portfolio without outside money has the same weights.
    const noOutside = buildPortfolio([broker, robo], new Map(), null, {}, [], now);
    expect(planStatus(DEFAULT_PLAN, noOutside, [], new Map(), null).buckets.map((b) => b.weight)).toEqual(st.buckets.map((b) => b.weight));
  });
  it("has no trades or dated transfers of its own", () => {
    const st = planStatus(DEFAULT_PLAN, p, [rec("ZZZ", "Watch; starter below about $90"), rec("YYY", "Watch; starter below about $50")], new Map([["ZZZ", 99], ["YYY", 100]]), null);
    expect(JSON.stringify({ ...DEFAULT_PLAN, adopted: "" })).not.toMatch(/\d{4}-\d\d-\d\d|\bshares?\b|\$\d|Dec 1|Jan 4|Feb 1/i);
    expect(Object.keys(DEFAULT_PLAN)).not.toContain("steps");
    expect(st.waiting.map((w) => w.symbol)).toEqual(["ZZZ", "YYY"]);
    expect(st.waiting[0].away).toBeCloseTo(0.1, 5);
  });
  it("warns only on maximums you approved, and never calls a warning a sale", () => {
    const heavy = buildPortfolio([{ ...broker, positions: [{ symbol: "AAA", quantity: 100, price: 100, marketValue: 10000, costBasis: 10000 }] }], new Map(), null, {}, [], now);
    expect(planStatus(DEFAULT_PLAN, heavy, [], new Map(), null).warnings).toEqual([]); // no approved policy: no limits invented
    const approved = policyFromRules([
      prow({ scope: "bucket", subject: "Quality/growth individual stocks", normal_low: 0.2, normal_high: 0.35, hard_max: 0.5 }),
      prow({ scope: "company", subject: "AAA", normal_low: 0.05, normal_high: 0.1, hard_max: 0.18 }),
    ]);
    const pv = buildPortfolio([{ ...broker, positions: [{ symbol: "AAA", quantity: 100, price: 100, marketValue: 10000, costBasis: 10000 }] }], new Map(), approved, {}, [], now);
    const w = planStatus(DEFAULT_PLAN, pv, [], new Map(), approved).warnings.join(" ");
    expect(w).toMatch(/AAA is 90\.9%.*approved 18% maximum/);
    expect(w).toMatch(/not an automatic sale/);
    const proposed = policyFromRules([prow({ scope: "company", subject: "AAA", hard_max: 0.12, approval: "proposed", approved_at: null })]);
    const pp = buildPortfolio([{ ...broker, positions: [{ symbol: "AAA", quantity: 100, price: 100, marketValue: 10000, costBasis: 10000 }] }], new Map(), proposed, {}, [], now);
    expect(planStatus(DEFAULT_PLAN, pp, [], new Map(), proposed).warnings.join(" ")).not.toMatch(/12%/);
  });
  it("labels unrealized gains as securities only", () => {
    const st = planStatus(DEFAULT_PLAN, p, [], new Map(), null);
    expect(st.unrealized).toEqual({ amount: 0, known: 3, unknown: 0 });
  });
  it("falls back to the agreed plan when a saved one is malformed", () => {
    expect(planFrom(null)).toBe(DEFAULT_PLAN);
    // An older saved plan's targets, caps and dated steps are ignored.
    const old = planFrom({ sleeves: [{ key: "us", label: "x", buy: "VOO", target: 0.45 }], steps: [{ date: "2026-12-01", text: "Move $3,000" }], stocksMax: 0.3, singleMax: 0.12 });
    expect(old).toEqual(DEFAULT_PLAN);
  });
});

describe("down from their high", () => {
  it("flags plan funds at 10%, other funds at 15%, researched stocks at 25%", async () => {
    const { lowsFrom } = await import("./target");
    const highs = new Map([
      ["VOO", { price: 89, high: 100 }], ["AVUV", { price: 95, high: 100 }],
      ["QQQ", { price: 84, high: 100 }], ["VTI", { price: 90, high: 100 }],
      ["ZZZ", { price: 70, high: 100 }], ["YYY", { price: 60, high: 100 }],
    ]);
    const lows = lowsFrom(DEFAULT_PLAN, highs, ["ZZZ"]);
    expect(lows.map((l) => [l.symbol, l.kind])).toEqual([["ZZZ", "stock"], ["QQQ", "fund"], ["VOO", "plan_fund"]]);
    expect(lows.find((l) => l.symbol === "VOO")!.note).toMatch(/11% below its high: worth a look in Decisions if you have new money/);
  });
});

describe("no longer good", () => {
  it("lists research that went from buy to hold, and ideas you passed on, newest first", () => {
    const v = new Map([
      ["AMAT", [{ asOf: "2026-11-16", action: "Watch, no new money; small starter only below ~$345." }, { asOf: "2026-11-01", action: "Hold." }]],
      ["IREN", [{ asOf: "2026-11-08", action: "Trim to ~3%. The debt is larger than thought." }, { asOf: "2026-09-01", action: "Add below $40." }]],
      ["NOW", [{ asOf: "2026-11-08", action: "Hold, no add." }, { asOf: "2026-10-01", action: "Hold." }]],
      ["OLD", [{ asOf: "2026-05-01", action: "Hold." }, { asOf: "2026-04-01", action: "Buy below $10." }]],
    ]);
    const out = noLongerGood(v, [{ symbol: "XYZ", note: "Too much debt. Revisit next year.", at: "2026-11-10" }], "2026-07-20");
    expect(out.map((d) => d.symbol)).toEqual(["XYZ", "IREN"]);
    expect(out[1]).toMatchObject({ was: "Add below $40.", now: "Trim to ~3%.", kind: "research" });
    expect(out[0]).toMatchObject({ now: "Too much debt.", kind: "passed" });
  });
  it("a watch with a starter level is not a buy, so Watch to Watch is never 'no longer good' (CBRS, 2026-11-18)", () => {
    expect(isBuyAction("Watch, no new money; small starter only below ~$345.")).toBe(false);
    expect(isBuyAction("Buy a starter below $85.")).toBe(true);
    const out = noLongerGood(new Map([["CBRS", [{ asOf: "2026-11-18", action: "Watch. Below about $85, re-check for a starter." }, { asOf: "2026-11-10", action: "Watch; consider a starter below ~$80." }]]]), [], "2026-07-20");
    expect(out).toEqual([]);
    expect(isBuyAction("Hold, no add.")).toBe(false);
  });
});

