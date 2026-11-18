/**
 * Reproduces the NVIDIA investigation's numbers with code, from the real inputs (see the fixture):
 * the scenario values, the weighted value and the annual return (two independent calculations),
 * the per-share earnings behind each scenario, the sensitivity to each assumption, and the portfolio
 * exposure with ETF look-through. Also checks the written conclusion against those numbers.
 */
import { describe, expect, it } from "vitest";
import { computeValuation } from "./valuationCalc";
import { actionAdds, consistencyCheck, crossCheckValuation, portfolioCheckFrom, stressTests } from "./challenge";
import { buildPortfolio } from "@/lib/portfolio/engine";
import { LOOKTHROUGH } from "@/lib/portfolio/classify";
import { policyFromRules, type PolicyRuleRow } from "@/lib/policy/rules";
import { LEDGER, NVDA_RUN, NVDA_SPECS, SNAPSHOTS } from "./__fixtures__/nvda-2026-11-08";
import type { RunState } from "./types";

const result = computeValuation({ scenarios: NVDA_SPECS, horizon_date: NVDA_RUN.horizon, price: NVDA_RUN.price, today: NVDA_RUN.today });
const valuation = { specs: NVDA_SPECS, horizon_date: NVDA_RUN.horizon, result, revenue_basis: "FY ending Jan 2029" };
const state = { valuation, price: { value: NVDA_RUN.price, asOf: null, source: "test" }, today: NVDA_RUN.today } as unknown as RunState;

describe("NVIDIA valuation, reproduced", () => {
  it("matches the stored scenario values, weighted value and annual return", () => {
    const v = (n: string) => result.scenarios.find((x) => x.name === n)!.value_per_share;
    expect(v("bear")).toBeCloseTo(NVDA_RUN.bear, 2);
    expect(v("base")).toBeCloseTo(NVDA_RUN.base, 2);
    expect(v("bull")).toBeCloseTo(NVDA_RUN.bull, 2);
    expect(result.weighted_value).toBeCloseTo(NVDA_RUN.weighted, 2);
    expect(result.annualized_return!).toBeCloseTo(NVDA_RUN.annualized, 3);
  });
  it("agrees with a separate plain-arithmetic recomputation", () => {
    expect(crossCheckValuation(valuation, NVDA_RUN.price, NVDA_RUN.today)).toEqual([]);
  });
  it("recomputes by hand: EPS = (revenue x margin + other income) x (1 - tax) / shares", () => {
    const eps = (r: number, m: number, o: number, sh: number) => ((r * m + o) * 0.83) / sh;
    expect(eps(460e9, 0.55, 3e9, 24e9) * 13).toBeCloseTo(115.09, 1); // EPS $8.85
    expect(eps(760e9, 0.635, 3e9, 23.6e9)).toBeCloseTo(17.08, 2); // the summary's "17x on $17.08"
    expect(eps(903e9, 0.655, 5e9, 23.4e9) * 21).toBeCloseTo(444.29, 1);
    const w = 0.3 * 115.0935 + 0.5 * 290.3256 + 0.2 * 444.2866;
    expect(w).toBeCloseTo(268.55, 1);
    const years = (Date.parse("2028-12-31") - Date.parse("2026-11-08")) / (365.25 * 864e5);
    expect(years).toBeCloseTo(2.15, 2);
    expect(Math.pow(w / 186.64, 1 / years) - 1).toBeCloseTo(0.1847, 3);
  });
  it("shows how much the conclusion depends on each assumption", () => {
    const rows = stressTests(state);
    const get = (l: string) => rows.find((r) => r.label.startsWith(l))!;
    expect(get("As modeled").annualized_return!).toBeCloseTo(0.1847, 3);
    // Recorded from the real inputs: a 20% lower multiple alone takes the expected return below VOO's
    // 7.5% forecast; margins, revenue and probability shifts keep it above.
    expect(get("All multiples 20% lower").weighted_value).toBeCloseTo(214.84, 2);
    expect(get("All multiples 20% lower").annualized_return!).toBeLessThan(0.075);
    expect(get("All margins 5 points lower").annualized_return!).toBeCloseTo(0.1402, 3);
    expect(get("All revenue 15% lower").annualized_return!).toBeCloseTo(0.099, 3);
    expect(get("Bear probability +15").annualized_return!).toBeCloseTo(0.1292, 3);
    const be = get("Bear probability at which the expected return falls to VOO");
    expect(be.note).toMatch(/^Bear 59% \(base 21%\)/);
    expect(get("Bear probability at which the expected return falls to a 0%").note).toMatch(/^Bear 77%/);
  });
});

describe("NVIDIA exposure, reproduced from the holdings on file", () => {
  // The real NVDA rows on file: the revised baseline (6-10% normal, 10-15% high conviction, 18% max),
  // marked approved in the archived chat but never approved in this app, so it counts as imported.
  const row = (over: Partial<PolicyRuleRow>): PolicyRuleRow => ({
    id: "x", scope: "company", subject: "NVDA", normal_low: null, normal_high: null, high_conviction_low: null, high_conviction_high: null, hard_max: null, value: null, conditions: null,
    source_label: "", source_date: null, source_status: "latest_approved", approval: "approved", approved_at: null, approval_note: null, created_at: "2026-11-06", ...over,
  } as PolicyRuleRow);
  const policy = policyFromRules([
    row({ id: "a400b93a", normal_low: 0.06, normal_high: 0.1, high_conviction_low: 0.1, high_conviction_high: 0.15, hard_max: 0.18, source_label: "Portfolio Baseline v2 (revised)" }),
    row({ id: "8edad59e", normal_low: 0.07, normal_high: 0.1, hard_max: 0.12, source_status: "superseded", approval: "superseded", source_label: "Portfolio Baseline v2 (original)" }),
    row({ id: "1b72c489", scope: "portfolio", subject: "protected_reserve", value: 3000, source_status: "user_entry", approved_at: "2026-11-07T13:04:16Z" }),
  ]);
  const quotes = new Map([["NVDA", { symbol: "NVDA", price: 186.64, prevClose: null, asOf: "2026-11-06T21:00:00Z", provider: "yahoo" as const, delayClass: "eod" as const }]]);
  const p = buildPortfolio(SNAPSHOTS, quotes, policy, { NVDA: "Quality/growth individual stocks" }, LEDGER, new Date("2026-11-08T16:00:00Z"));
  const e = p.exposures.find((x) => x.symbol === "NVDA")!;

  it("values the NVIDIA shares at the run's price: 29.0559 x $186.64 = $5,423", () => {
    expect(p.holdings.find((h) => h.symbol === "NVDA")!.value).toBeCloseTo(5423.0, 0);
  });
  it("matches a hand computation of direct and look-through weight", () => {
    const etf = p.holdings.reduce((a, h) => a + (LOOKTHROUGH[h.symbol]?.NVDA ?? 0) * h.value, 0);
    expect(e.direct).toBeCloseTo(5423.0 / p.total, 4);
    expect(e.total).toBeCloseTo((5423.0 + etf) / p.total, 6);
    // Headroom is measured to the 18% maximum against the upper bound of exposure.
    expect(e.headroomDollars).toBeCloseTo(Math.max(0, 0.18 * p.total - e.totalMax * p.total), 1);
  });
  it("feeds the conclusion check: the position is above its normal range and the limit was never approved in this app", () => {
    const pc = portfolioCheckFrom({ portfolio: p, policy: policy as never }, "NVDA");
    expect(pc.weight).toBeGreaterThan(0.15);
    expect(pc.normalHigh).toBe(0.1);
    expect(pc.max).toBe(0.18);
    expect(pc.limitAuthority).toBe("imported");
  });
});

describe("the written NVIDIA conclusion versus the numbers", () => {
  const summary = {
    action: "Hold / no add. Trim back toward about 15% total exposure if the price rises above about $260, or if the combined weight exceeds 18%.",
    headline: "NVIDIA is an excellent business with an attractive expected return, but at 16.7–17.2% of the portfolio it is already at its limit, so hold it and add nothing.",
    valuation: "Probability-weighted value is $268.55 per share at end-2028, against $186.64 now (app figures).",
    expected_return: "The weighted case is about +44% total, or about 18.5% a year, before risk adjustment.",
    allocation: { target_pct: 15, max_pct: 18, note: "" },
  };
  const s = { ...state, summary, objections: [], portfolioCheck: { weight: 0.1674, direct: 0.139, normalHigh: 0.1, max: 0.18, limitAuthority: "imported", headroomDollars: 473.43 }, completeness: { complete: false, reasons: ["x"] } } as unknown as RunState;
  it("reads the action as not adding, despite the attractive modeled return", () => {
    expect(actionAdds(summary.action)).toBe(false);
  });
  it("states the app's weighted value and return, respects the limits, and flags the imported limit", () => {
    const c = consistencyCheck(s);
    expect(c.ok).toBe(true);
    expect(c.checks.find((x) => x.label === "Limit used is one you approved")!.ok).toBe(false);
  });
  it("would fail if the same numbers had led to 'Add below $200'", () => {
    const c = consistencyCheck({ ...s, summary: { ...summary, action: "Add below $200" } } as RunState);
    expect(c.ok).toBe(false);
    expect(c.issues.join(" ")).toMatch(/position limits|complete research/);
  });
  it("would fail if the summary misstated the weighted value", () => {
    const c = consistencyCheck({ ...s, summary: { ...summary, valuation: "Weighted value is about $290 per share." } } as RunState);
    expect(c.issues.join(" ")).toMatch(/weighted value of \$268\.55/);
  });
});
