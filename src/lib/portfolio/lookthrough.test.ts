import { describe, expect, it } from "vitest";
import { buildPortfolio, lookthroughUpperBound, type SnapshotInput } from "./engine";
import { policyFromRules, type PolicyRuleRow } from "@/lib/policy/rules";
import { FUNDS } from "@/lib/exposure/reference";

// Synthetic amounts; fund data is the app's dated reference snapshot.
const now = new Date("2026-11-08T16:00:00Z");
const broker: SnapshotInput = {
  accountId: "b", accountName: "Broker", accountRole: "taxable_brokerage", asOf: "2026-11-07T21:00:00Z", totalValue: null, cashValue: 221.24,
  positions: [
    { symbol: "VOO", quantity: 20, price: 600, marketValue: 12000, costBasis: 10000 },
    { symbol: "VXUS", quantity: 40, price: 75, marketValue: 3000, costBasis: 2800 },
    { symbol: "AGG", quantity: 10, price: 100, marketValue: 1000, costBasis: 1000 },
    { symbol: "NOW", quantity: 10, price: 100, marketValue: 1000, costBasis: 900 },
    { symbol: "NVDA", quantity: 10, price: 200, marketValue: 2000, costBasis: 1500 },
    { symbol: "IREN", quantity: 20, price: 50, marketValue: 1000, costBasis: 1200 },
  ],
};
const usaa: SnapshotInput = { accountId: "s", accountName: "USAA Savings", accountRole: "cash", asOf: "2026-11-07T13:03:00Z", totalValue: 3000, cashValue: 3000, positions: [] };
const rule = (subject: string, scope: PolicyRuleRow["scope"], over: Partial<PolicyRuleRow>): PolicyRuleRow => ({
  id: subject, scope, subject, normal_low: null, normal_high: null, high_conviction_low: null, high_conviction_high: null, hard_max: null, value: null, conditions: null,
  source_label: "Test", source_date: null, source_status: "user_entry", approval: "approved", approved_at: "2026-11-08T13:00:00Z", approval_note: null, created_at: "2026-11-08", ...over,
});
const policy = policyFromRules([
  rule("protected_reserve", "portfolio", { value: 3000 }),
  rule("NOW", "company", { normal_low: 0.03, normal_high: 0.05, hard_max: 0.07 }),
  rule("NVDA", "company", { hard_max: 0.18 }),
  rule("IREN", "company", { normal_low: 0.03, normal_high: 0.05, hard_max: 0.07 }),
]);
const p = buildPortfolio([broker, usaa], new Map(), policy, { NOW: "Quality/growth individual stocks", NVDA: "Quality/growth individual stocks", IREN: "Asymmetric/high-risk growth sleeve" }, [], now);

describe("investable capital and cash", () => {
  it("excludes the whole $3,000 reserve: savings of exactly $3,000 add nothing deployable", () => {
    expect(p.cashDetail).toMatchObject({ brokerage: 221.24, savings: 3000, protectedReserve: 3000, deployableSavings: 0, deployable: 221.24 });
    expect(p.total).toBe(20221.24); // positions 20,000 + brokerage cash 221.24
    expect(p.netWorthTracked).toBe(23221.24);
    expect(p.holdings.reduce((a, h) => a + h.weight, 0) + p.cash / p.total).toBeCloseTo(1, 10);
  });
});

describe("ETF look-through when fund holdings are incomplete", () => {
  it("counts NVIDIA from VOO's published holdings with no extra bound (it is itemized)", () => {
    const e = p.exposures.find((x) => x.symbol === "NVDA")!;
    expect(e.viaEtfs).toBeCloseTo((12000 * 0.0839) / p.total, 10);
    expect(e.totalMax).toBeCloseTo(e.total, 10);
    expect(e.lookthroughGaps).toEqual([]);
  });
  it("gives ServiceNow an upper bound: it is below VOO's top 25, so at most the smallest listed weight", () => {
    const e = p.exposures.find((x) => x.symbol === "NOW")!;
    const minVoo = Math.min(...FUNDS.VOO.top!.map((t) => t.weight));
    expect(e.viaEtfs).toBe(0);
    expect(e.viaEtfsMax).toBeCloseTo((12000 * minVoo) / p.total, 10);
    expect(e.lookthroughGaps.join(" ")).toMatch(/VOO: only its largest holdings are published/);
    // VXUS (outside the US) and AGG (bonds) cannot hold it, so they add nothing.
    expect(e.lookthroughGaps.join(" ")).not.toMatch(/VXUS|AGG/);
    // Room for new money is measured against the upper figure.
    expect(e.headroomDollars).toBeCloseTo(0.07 * p.total - (1000 + 12000 * minVoo), 1);
  });
  it("adds nothing for a fund whose mandate excludes the company", () => {
    expect(lookthroughUpperBound("IREN", [{ symbol: "VOO", value: 12000 }, { symbol: "VXUS", value: 3000 }, { symbol: "AGG", value: 1000 }])).toEqual({ extra: 0, funds: [], unknown: [] });
  });
  it("lists a held fund with no itemized holdings as unknown instead of assuming zero", () => {
    const saved = FUNDS.VHT.top;
    try {
      FUNDS.VHT.top = undefined;
      expect(lookthroughUpperBound("LLY", [{ symbol: "VHT", value: 1000 }]).unknown).toEqual(["VHT"]);
    } finally { FUNDS.VHT.top = saved; }
  });
});

describe("how a purchase changes weights", () => {
  it("$1,250 of new money into VOO raises VOO's weight and dilutes every other holding on the larger total", () => {
    const after = buildPortfolio([{ ...broker, positions: broker.positions.map((x) => x.symbol === "VOO" ? { ...x, quantity: 20 + 1250 / 600, marketValue: 12000 + 1250 } : x) }, usaa], new Map(), policy, {}, [], now);
    const w = (pv: typeof p, s: string) => pv.holdings.find((h) => h.symbol === s)!.weight;
    expect(after.total).toBeCloseTo(p.total + 1250, 6);
    expect(w(after, "VOO")).toBeCloseTo(13250 / (p.total + 1250), 10);
    expect(w(after, "NOW")).toBeCloseTo(1000 / (p.total + 1250), 10);
    // NVIDIA through VOO grows with it.
    expect(after.exposures.find((x) => x.symbol === "NVDA")!.viaEtfs).toBeCloseTo((13250 * 0.0839) / after.total, 10);
  });
});
