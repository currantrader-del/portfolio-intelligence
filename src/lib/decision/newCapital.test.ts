import { describe, expect, it } from "vitest";
import { buildPortfolio, type SnapshotInput } from "@/lib/portfolio/engine";
import { readPolicy } from "@/lib/policy/limits";
import { policyFromRules, type PolicyRuleRow } from "@/lib/policy/rules";
import { toResearchRecord } from "@/lib/research/records";
import { newCapital } from "./newCapital";

// Synthetic data only.
const now = new Date("2026-11-05T16:00:00Z");
const snap: SnapshotInput = {
  accountId: "a", accountName: "Broker", accountRole: "taxable_brokerage", asOf: "2026-11-04T21:00:00Z", totalValue: null, cashValue: 0,
  positions: [
    { symbol: "VOO", quantity: 10, price: 700, marketValue: 7000, costBasis: null },
    { symbol: "VXUS", quantity: 10, price: 80, marketValue: 800, costBasis: null },
    { symbol: "AAA", quantity: 20, price: 25, marketValue: 500, costBasis: null },
    { symbol: "BBB", quantity: 5, price: 280, marketValue: 1400, costBasis: null },
  ],
};
const savings: SnapshotInput = { accountId: "s", accountName: "Savings", accountRole: "cash", asOf: "2026-11-04T23:59:00Z", totalValue: 12000, cashValue: 12000, positions: [] };
const legacy = readPolicy("v2", {
  target_allocation_policies: { latest_approved_v2_revised: [
    { bucket: "U.S. broad-market equity", normal: "25-40%", hard_max: "50%" },
    { bucket: "International equity", normal: "12-20%", hard_max: "30%" },
  ] },
  single_company_frameworks: { latest_approved_v2_revised: { AAA: { normal: "~3-10%", conditional_hard_max: "~10%" } } },
});
const research = (refPrice: string, completeness = "complete", asOf = "2026-10-20") => toResearchRecord("AAA", "AAA", "held", [{
  id: "v1", research_as_of: asOf, completeness, origin: "chatgpt_original", is_current: true,
  conclusion: { review_state: "adopted", action: "HOLD / NO ADD", classification: "Growth", reference_price: refPrice, reference_date: asOf,
    valuation: { approx_holding_period_years: 4, bear_value: 20, base_value: 90, bull_value: 200, bear_probability: 0.3, base_probability: 0.5, bull_probability: 0.2 },
    price_framework: [{ price_zone: "< $35", action: "Add" }] },
}]);

const row = (over: Partial<PolicyRuleRow>): PolicyRuleRow => ({
  id: Math.random().toString(36).slice(2), scope: "company", subject: "AAA", normal_low: null, normal_high: null, high_conviction_low: null, high_conviction_high: null,
  hard_max: null, value: null, conditions: null, source_label: "Test", source_date: null, source_status: "latest_approved", approval: "approved",
  approved_at: over.approval && over.approval !== "approved" ? null : "2026-11-05T12:00:00Z", approval_note: null, created_at: "2026-11-05", ...over,
});
const approvedRules = [
  row({ subject: "AAA", normal_low: 0.03, normal_high: 0.10, hard_max: 0.10 }),
  row({ scope: "bucket", subject: "US broad-market equity", normal_low: 0.25, normal_high: 0.40, hard_max: 0.5 }),
  row({ scope: "bucket", subject: "International equity", normal_low: 0.12, normal_high: 0.20, hard_max: 0.3 }),
  row({ scope: "assumption", subject: "benchmark_return", normal_low: 0.048, normal_high: 0.075, value: 0.0665 }),
  row({ scope: "assumption", subject: "risk_margin_factor", value: 0.5 }),
  row({ scope: "portfolio", subject: "protected_reserve", value: 10000 }),
];
// SEC filings checked, nothing filed after the research date.
const quiet = new Map([["AAA", { cik: "1", company: "AAA", filings: [{ form: "10-Q", filed: "2026-08-01", reportDate: null, description: "Quarterly report", items: [], isEarnings: true, url: "u", category: "periodic" as const, note: "" }], lastEarnings: null, nextEarningsEstimate: null, source: "s", fetchedAt: "t" }]]);

describe("new capital: evidence gates", () => {
  it("is conditional when the cash is not known, and still lists every open check", () => {
    const p = buildPortfolio([snap], new Map(), legacy, {}, [], now);
    const r = newCapital({ amount: 1250, portfolio: p, research: [research("$26")], policy: legacy, now });
    expect(r.status).toBe("conditional");
    expect(r.lean).toMatch(/^Lean: /);
    expect(r.recommendation.illustrative).toBe(true);
    const open = r.gates.filter((g) => !g.ok).map((g) => g.key);
    expect(open).toEqual(expect.arrayContaining(["funds", "research"]));
    expect(r.gates.map((g) => g.key)).not.toContain("assumptions");
    expect(r.toVerify.join(" ")).toMatch(/BBB: full research/);
    expect(r.options.find((o) => o.kind === "cash")!.label).toBe("Valid option");
  });

  it("needs verified holdings: a stale statement, or trades recorded since one, is not a reconciliation", () => {
    const policy = policyFromRules(approvedRules);
    // The $400 deposit shows in the account's cash, so only the holdings check is open.
    const stale = { ...snap, cashValue: 400, asOf: "2026-10-15T21:00:00Z", positions: snap.positions.filter((x) => x.symbol !== "BBB") };
    const p = buildPortfolio([stale, savings], new Map(), policy, {}, [], now);
    const r = newCapital({ amount: 400, source: "deposited", portfolio: p, research: [research("$26")], policy, now, filings: quiet });
    expect(r.gates.find((g) => g.key === "holdings")).toMatchObject({ ok: false, detail: expect.stringMatching(/Broker: statement 2026-10-15 \(20 days\)/) });
    expect(r.status).toBe("conditional");
    expect(r.recommendation.illustrative).toBe(true);
    // Room is measured on the invested portfolio (savings excluded): 10% of $8,700 minus $500 held = $370.
    expect(r.recommendation.headline).toBe("$370 AAA + $30 VXUS, once your balances are verified");
    expect(r.lean).toMatch(/^Lean: add to AAA/);
    // Trades recorded since the statement show what probably happened; they do not verify the account.
    const ledger = [{ accountId: "a", tradeDate: "2026-11-03", kind: "deposit" as const, symbol: null, quantity: null, price: null, amount: 100 }];
    const p2 = buildPortfolio([stale, savings], new Map(), policy, {}, ledger, now);
    const r2 = newCapital({ amount: 400, source: "deposited", portfolio: p2, research: [research("$26")], policy, now, filings: quiet });
    expect(r2.gates.find((g) => g.key === "holdings")).toMatchObject({ ok: false, detail: expect.stringMatching(/1 recorded transactions through 2026-11-03\. Recorded transactions are not a reconciliation/) });
    // Your own check today verifies them; bookkeeping gaps are noted, not blocking.
    const r3 = newCapital({ amount: 400, source: "deposited", holdingsConfirmed: true, portfolio: p2, research: [research("$26")], policy, now, filings: quiet });
    expect(r3.gates.find((g) => g.key === "holdings")).toMatchObject({ ok: true, detail: expect.stringMatching(/You confirmed today.*not blocking: .*Cost basis missing/) });
    expect(r3.status).toBe("ready");
  });

  it("is ready to execute only when the money, the holdings and the research are verified", () => {
    const policy = policyFromRules(approvedRules);
    const withBasis = { ...snap, cashValue: 400, positions: snap.positions.filter((x) => x.symbol !== "BBB").map((x) => ({ ...x, costBasis: x.marketValue })) };
    const ledger = [{ accountId: "a", tradeDate: "2026-10-01", kind: "deposit" as const, symbol: null, quantity: null, price: null, amount: 500 }];
    const p = buildPortfolio([withBasis, savings], new Map(), policy, {}, ledger, now);
    expect(p.quality.reconciliation).toMatchObject({ complete: true, label: "Reconciled" });
    const r = newCapital({ amount: 400, source: "deposited", portfolio: p, research: [research("$26")], policy, now, filings: quiet });
    expect(r.gates.every((g) => g.ok)).toBe(true);
    expect(r.status).toBe("ready");
    expect(r.recommendation.illustrative).toBe(false);
    expect(r.recommendation.allocations[0]).toEqual({ symbol: "AAA", amount: 370 });
    expect(r.options.find((o) => o.symbol === "AAA")!.assessment!.judgment).toBe("favourable");
  });
});

describe("new capital: a drop is not a buy signal", () => {
  it("does not re-price research after a large decline", () => {
    const policy = policyFromRules(approvedRules);
    const p = buildPortfolio([snap, savings], new Map(), policy, {}, [], now);
    const r = newCapital({ amount: 1000, portfolio: p, research: [research("$40")], policy, now }); // $25 is 37% below $40
    const aaa = r.options.find((o) => o.symbol === "AAA")!;
    expect(aaa.label).toBe("Refresh required");
    expect(aaa.expectedReturn).toBeNull();
    expect(aaa.verdicts!.research.detail).toMatch(/38% below the \$40 research reference/);
    expect(r.recommendation.allocations.find((x) => x.symbol === "AAA")).toBeUndefined();
    expect(r.status).toBe("conditional");
  });

  it("treats partial research as needing completion, not as a smaller buy", () => {
    const policy = policyFromRules(approvedRules);
    const p = buildPortfolio([snap, savings], new Map(), policy, {}, [], now);
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26", "partial")], policy, now });
    expect(r.options.find((o) => o.symbol === "AAA")!.label).toBe("Refresh required");
  });
});

describe("new capital: completed investigations with open questions", () => {
  const policy = policyFromRules(approvedRules);
  const withBasis = { ...snap, cashValue: 400, positions: snap.positions.filter((x) => x.symbol !== "BBB").map((x) => ({ ...x, costBasis: x.marketValue })) };
  const ledger = [{ accountId: "a", tradeDate: "2026-10-01", kind: "deposit" as const, symbol: null, quantity: null, price: null, amount: 500 }];
  const p = buildPortfolio([withBasis, savings], new Map(), policy, {}, ledger, now);
  const base = research("$26").current!;
  const inv = { id: "v2", research_as_of: "2026-11-04", created_at: "2026-11-04T12:00:00Z", completeness: "partial", origin: "claude_full", is_current: false, conclusion: { ...base.conclusion, research_type: "full_investigation", review_state: "awaiting_approval", completion: { complete: false, reasons: ["Q1"] } } };
  it("uses a newer finished investigation automatically, and adds nothing while its material questions are open", () => {
    const r = newCapital({ amount: 400, source: "deposited", portfolio: p, research: [toResearchRecord("AAA", "AAA", "held", [{ ...base, created_at: "2026-10-20T00:00:00Z" }, inv])], policy, now, filings: quiet });
    const aaa = r.options.find((o) => o.symbol === "AAA")!;
    expect(r.recommendation.allocations.find((a) => a.symbol === "AAA")).toBeUndefined();
    expect(JSON.stringify(aaa)).toMatch(/material questions open/);
  });
  it("adds nothing on provisionally approved research, however attractive its modeled return", () => {
    const adopted = { ...inv, is_current: true, conclusion: { ...inv.conclusion, review_state: "adopted_provisional" } };
    const r = newCapital({ amount: 400, source: "deposited", portfolio: p, research: [toResearchRecord("AAA", "AAA", "held", [{ ...base, is_current: false }, adopted])], policy, now, filings: quiet });
    expect(r.recommendation.allocations.find((a) => a.symbol === "AAA")).toBeUndefined();
    expect(JSON.stringify(r.options.find((o) => o.symbol === "AAA"))).toMatch(/material questions open/);
  });
});

describe("new capital: ceilings and money source", () => {
  it("fills a stock only to the top of its normal range", () => {
    const tight = policyFromRules([...approvedRules.filter((x) => x.subject !== "AAA"), row({ subject: "AAA", normal_low: 0.03, normal_high: 0.06, hard_max: 0.10 })]);
    const p = buildPortfolio([{ ...snap, positions: snap.positions.filter((x) => x.symbol !== "BBB") }, savings], new Map(), tight, {}, [], now);
    const r = newCapital({ amount: 1250, portfolio: p, research: [research("$26")], policy: tight, now, filings: quiet });
    // invested portfolio = 8300 (savings are not part of it); new money -> 9550; 6% = 573; minus 500 held = 73
    expect(r.recommendation.allocations[0]).toEqual({ symbol: "AAA", amount: 73 });
    expect(r.options.find((o) => o.symbol === "AAA")!.maxWeight).toBe(0.06);
  });

  it("treats a bucket maximum as a ceiling on the stocks in that bucket, not only on funds", () => {
    const capped = policyFromRules([...approvedRules, row({ scope: "bucket", subject: "Quality/growth individual stocks", normal_low: 0.02, normal_high: 0.04, hard_max: 0.06 })]);
    const p = buildPortfolio([{ ...snap, positions: snap.positions.filter((x) => x.symbol !== "BBB") }, savings], new Map(), capped, {}, [], now);
    const r = newCapital({ amount: 1250, portfolio: p, research: [research("$26")], policy: capped, now, filings: quiet });
    // AAA's own limit allows up to 10%, but its bucket's 6% maximum leaves only $73 (same arithmetic as above).
    expect(r.recommendation.allocations[0]).toEqual({ symbol: "AAA", amount: 73 });
  });

  it("does not grow the portfolio when the money is cash already held", () => {
    const policy = policyFromRules(approvedRules);
    const p = buildPortfolio([{ ...snap, cashValue: 1500 }, savings], new Map(), policy, {}, [], now);
    const fromNew = newCapital({ amount: 1000, source: "new", portfolio: p, research: [research("$26")], policy, now });
    const fromCash = newCapital({ amount: 1000, source: "existing", portfolio: p, research: [research("$26")], policy, now });
    const room = (x: typeof fromNew) => x.options.find((o) => o.symbol === "AAA")!.headroomDollars!;
    expect(room(fromNew) - room(fromCash)).toBeCloseTo(100, 1); // 10% of the extra 1000
    // Cash already held is only what the brokerage account itself holds: savings need a planned transfer first.
    const tooMuch = newCapital({ amount: 5000, source: "existing", portfolio: p, research: [], policy, now });
    expect(tooMuch.funds).toMatchObject({ requested: 5000, used: 1500, verified: true });
    expect(tooMuch.funds.detail).toMatch(/Broker holds \$1,500 of cash that can buy a stock or ETF, so this is sized on \$1,500\. Savings hold \$12,000; that can be used only after you plan a transfer to Broker\./);
    expect(tooMuch.funds.detail).not.toMatch(/reserve/);
    expect(tooMuch.recommendation.allocations.reduce((a, x) => a + x.amount, 0)).toBe(1500);
    // With a planned $2,000 transfer it can be used, but only as conditional money until it arrives.
    const transfers = [{ id: "t1", fromAccountId: "s", toAccountId: "a", amount: 2000, date: "2026-11-06", note: null, createdAt: "2026-11-05T15:00:00Z" }];
    const withTransfer = newCapital({ amount: 5000, source: "existing", portfolio: p, research: [], policy, now, transfers });
    expect(withTransfer.funds).toMatchObject({ used: 3500, verified: false });
    expect(withTransfer.funds.detail).toMatch(/^\$3,500: \$1,500 already in Broker plus \$2,000 from the transfer you planned, which has not arrived yet\./);
    expect(withTransfer.gates.find((g) => g.key === "funds")!.ok).toBe(false);
    expect(withTransfer.recommendation.rationale.join(" ")).toMatch(/Account: bought in Broker, after the planned \$2,000 transfer arrives/);
  });
});

describe("new capital: policy conflicts", () => {
  it("uses the stricter limit as a temporary safety limit and gives no new money until you decide", () => {
    const rules = [...approvedRules.filter((x) => x.subject !== "AAA"),
      row({ subject: "AAA", normal_low: 0.03, normal_high: 0.05, hard_max: 0.10, approval: "unresolved", source_label: "Baseline" }),
      row({ subject: "AAA", normal_low: 0.03, normal_high: 0.05, hard_max: 0.07, approval: "unresolved", source_label: "Company research", source_date: "2026-09-10" })];
    const policy = policyFromRules(rules);
    expect(policy.companies.AAA.hardMax).toBe(0.07);
    expect(policy.companies.AAA.status).toBe("conflict");
    expect(policy.audit.conflicts[0].differences[0]).toMatch(/Maximum: 10% \(Baseline, undated\) vs 7% \(Company research, 2026-09-10\)/);
    const p = buildPortfolio([snap, savings], new Map(), policy, {}, [], now);
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26")], policy, now, filings: quiet });
    expect(policy.companies.AAA.authority).toBe("safety");
    const aaa = r.options.find((o) => o.symbol === "AAA")!;
    expect(aaa.label).toBe("Limit not approved");
    expect(r.toVerify.join(" ")).toMatch(/AAA: decide which allocation limit controls/);
  });
});

describe("new capital: event-driven refresh and independent verdicts", () => {
  const policy = policyFromRules(approvedRules);
  const withBasis = { ...snap, positions: snap.positions.filter((x) => x.symbol !== "BBB").map((x) => ({ ...x, costBasis: x.marketValue })) };
  const ledger = [{ accountId: "a", tradeDate: "2026-10-01", kind: "deposit" as const, symbol: null, quantity: null, price: null, amount: 500 }];
  const p = buildPortfolio([withBasis, savings], new Map(), policy, {}, ledger, now);

  it("asks for a refresh after new results, even when the research is only weeks old", () => {
    const filed = new Map([["AAA", { ...quiet.get("AAA")!, filings: [{ ...quiet.get("AAA")!.filings[0], form: "10-Q", filed: "2026-11-03" }] }]]);
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26")], policy, now, filings: filed });
    const aaa = r.options.find((o) => o.symbol === "AAA")!;
    expect(aaa.label).toBe("Refresh required");
    expect(aaa.verdicts!.research.detail).toMatch(/New results since the research: 10-Q filed 2026-11-03/);
    expect(r.status).toBe("conditional");
    expect(aaa.reassessment).toMatchObject({ status: "needed", conclusion: { action: "HOLD / NO ADD", asOf: "2026-10-20" } });
    expect(aaa.reassessment!.current).toMatch(/^Reassess first\. The 2026-10-20 conclusion .* is not today's recommendation/);
    expect(r.recommendation.allocations.find((x) => x.symbol === "AAA")).toBeUndefined();
  });
  it("does not call research current when filings could not be checked", () => {
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26")], policy, now });
    expect(r.options.find((o) => o.symbol === "AAA")!.verdicts!.research.ok).toBe(false);
    expect(r.gates.find((g) => g.key === "research")!.ok).toBe(false);
  });
  it("does not let an old but event-free research block the decision", () => {
    const early = new Map([["AAA", { ...quiet.get("AAA")!, filings: [{ ...quiet.get("AAA")!.filings[0], filed: "2026-04-20" }] }]]);
    const r = newCapital({ amount: 400, portfolio: p, research: [research("$26", "complete", "2026-05-01")], policy, now, filings: early });
    expect(r.options.find((o) => o.symbol === "AAA")!.verdicts!.research.ok).toBe(true);
  });
  it("keeps the research's own 'hold' zone even when the return comparison clears", () => {
    const holdZone = toResearchRecord("AAA", "AAA", "held", [{ id: "v2", research_as_of: "2026-10-20", completeness: "complete", origin: "x", is_current: true,
      conclusion: { review_state: "adopted", action: "HOLD", reference_price: "$26", reference_date: "2026-10-20",
        valuation: { approx_holding_period_years: 4, bear_value: 20, base_value: 90, bull_value: 200, bear_probability: 0.3, base_probability: 0.5, bull_probability: 0.2 },
        price_framework: [{ price_zone: "< $20", action: "Add" }, { price_zone: "$20–$40", action: "Hold / no add" }] } }]);
    const aaa = newCapital({ amount: 400, portfolio: p, research: [holdZone], policy, now, filings: quiet }).options.find((o) => o.symbol === "AAA")!;
    expect(aaa.label).toBe("Research says hold");
    expect(aaa.assessment!.judgment).toBe("favourable");
    expect(aaa.agreement).toBe("model_more_positive");
    expect(aaa.verdicts!.valuation.detail).toMatch(/HOLD conclusion stands/);
    expect(aaa.verdicts!.limit.ok).toBe(true);
    expect(aaa.verdicts!.valuation.ok).toBe(false);
    expect(aaa.eligible).toBe(false);
  });
  it("gives no new money to a researched company without its own limit", () => {
    const noLimit = policyFromRules([...approvedRules.filter((x) => x.subject !== "AAA"), row({ scope: "generic_company", subject: "generic", hard_max: 0.18 })]);
    const p2 = buildPortfolio([withBasis, savings], new Map(), noLimit, {}, ledger, now);
    const aaa = newCapital({ amount: 400, portfolio: p2, research: [research("$26")], policy: noLimit, now, filings: quiet }).options.find((o) => o.symbol === "AAA")!;
    expect(aaa.label).toBe("No limit set");
    expect(aaa.headroomDollars).toBe(0);
    expect(aaa.verdicts!.limit.detail).toMatch(/does not inherit the generic 18% maximum/);
  });
  it("gives no new money under a limit you have not approved: a missing approval is not just a warning", () => {
    const importedOnly = policyFromRules(approvedRules.map((x) => (x.scope === "assumption" ? x : { ...x, approved_at: null })));
    const p3 = buildPortfolio([withBasis, savings], new Map(), importedOnly, {}, ledger, now);
    const r = newCapital({ amount: 400, portfolio: p3, research: [research("$26")], policy: importedOnly, now, filings: quiet });
    const aaa = r.options.find((o) => o.symbol === "AAA")!;
    expect(aaa.label).toBe("Limit not approved");
    expect(aaa.eligible).toBe(false);
    expect(r.recommendation.allocations.find((x) => x.symbol === "AAA")).toBeUndefined();
    expect(r.toVerify.join(" ")).toMatch(/AAA: confirm or revise its imported limit/);
    // With no stock qualifying, a diversified ETF gets the money. Here VOO would push the US bucket above its guide
    // range, so VXUS is used; being below its own range is not what decides it.
    expect(r.recommendation.allocations).toEqual([{ symbol: "VXUS", amount: 400 }]);
    expect(r.options.find((o) => o.symbol === "VXUS")!.notes[0]).toMatch(/^Chosen because VOO is not preferred here \(US broad-market equity would go to .*, above its 40\.0% normal top\), and it keeps International equity under the top of its guide range/);
  });
  it("treats a conditional add in the research as no add until the condition is confirmed", () => {
    const cond = toResearchRecord("AAA", "AAA", "held", [{ id: "v3", research_as_of: "2026-10-20", completeness: "complete", origin: "x", is_current: true,
      conclusion: { review_state: "adopted", action: "Hold / no add", reference_price: "$26", reference_date: "2026-10-20",
        valuation: { approx_holding_period_years: 4, bear_value: 20, base_value: 90, bull_value: 200, bear_probability: 0.3, base_probability: 0.5, bull_probability: 0.2 },
        price_framework: [{ price_zone: "< $35", action: "Consider a small add only if Q4 results confirm the turnaround." }] } }]);
    const r = newCapital({ amount: 400, portfolio: p, research: [cond], policy, now, filings: quiet });
    const aaa = r.options.find((o) => o.symbol === "AAA")!;
    expect(aaa.stance).toMatchObject({ kind: "conditional", condition: "only if Q4 results confirm the turnaround" });
    expect(aaa.label).toBe("Condition not met");
    expect(aaa.eligible).toBe(false);
    expect(r.toVerify.join(" ")).toMatch(/condition for adding must be confirmed first: only if Q4 results/);
  });
  it("sizes to the high-conviction range only when you approved it, its condition is met, and research and model support adding", () => {
    const hc = (approved_at: string | null, conditions: string | null) => policyFromRules([...approvedRules.filter((x) => x.subject !== "AAA"),
      row({ subject: "AAA", normal_low: 0.03, normal_high: 0.05, high_conviction_low: 0.05, high_conviction_high: 0.08, hard_max: 0.1, approved_at, conditions })]);
    const run = (pol: ReturnType<typeof hc>, filings?: typeof quiet) => newCapital({ amount: 400, portfolio: buildPortfolio([withBasis, savings], new Map(), pol, {}, ledger, now), research: [research("$26")], policy: pol, now, filings }).options.find((o) => o.symbol === "AAA")!;
    const yours = run(hc("2026-11-08T13:00:00Z", "A ceiling, not a reason to add."), quiet);
    expect(yours.highConviction).toBe(true);
    expect(yours.maxWeight).toBe(0.08);
    const conditional = run(hc("2026-11-08T13:00:00Z", "High conviction only after meaningful de-risking"), quiet);
    expect(conditional.highConviction).toBe(false);
    expect(conditional.maxWeight).toBe(0.05);
    expect(conditional.notes.join(" ")).toMatch(/not available: its condition is not confirmed \(only after meaningful de-risking\)/);
    const imported = run(hc(null, null), quiet);
    expect(imported.highConviction).toBe(false);
    expect(imported.notes.join(" ")).toMatch(/not available: you have not approved it/);
    expect(run(hc("2026-11-08T13:00:00Z", null)).highConviction).toBe(false); // filings unchecked
  });
});

describe("new capital: hypothetical vs verified money", () => {
  const policy = policyFromRules(approvedRules);
  const withBasis = { ...snap, positions: snap.positions.filter((x) => x.symbol !== "BBB").map((x) => ({ ...x, costBasis: x.marketValue })) };
  const p = buildPortfolio([withBasis, savings], new Map(), policy, {}, [], now);
  it("never labels planned money that has not arrived as executable", () => {
    const planned = newCapital({ amount: 1250, source: "planned", portfolio: p, research: [research("$26")], policy, now, filings: quiet });
    expect(planned.status).toBe("conditional");
    expect(planned.funds.verified).toBe(false);
    expect(planned.gates.find((g) => g.key === "funds")).toMatchObject({ ok: false, detail: expect.stringMatching(/planned new money for Broker, not yet deposited\. This is what to do once it arrives, not an order/) });
    expect(planned.recommendation.headline).toMatch(/, once the money arrives$/);
    const legacyNew = newCapital({ amount: 1250, source: "new", portfolio: p, research: [research("$26")], policy, now, filings: quiet });
    expect(legacyNew.source).toBe("planned"); // "new" from older callers is treated as unverified
    // Once the deposit shows in the brokerage cash it is executable, and it is not counted twice.
    const pDep = buildPortfolio([{ ...withBasis, cashValue: 1250 }, savings], new Map(), policy, {}, [], now);
    const deposited = newCapital({ amount: 1250, source: "deposited", portfolio: pDep, research: [research("$26")], policy, now, filings: quiet });
    expect(deposited.status).toBe("ready");
    expect(deposited.recommendation.allocations).toEqual(planned.recommendation.allocations);
  });

  it("does not call $1,250 'deposited' money ready when the app shows only $221 of brokerage cash", () => {
    const p221 = buildPortfolio([{ ...withBasis, cashValue: 221.24 }, { ...savings, cashValue: 10000, totalValue: 10000 }], new Map(), policy, {}, [], now);
    const r = newCapital({ amount: 1250, source: "deposited", holdingsConfirmed: true, portfolio: p221, research: [research("$26")], policy, now, filings: quiet });
    expect(r.status).toBe("conditional");
    expect(r.funds.verified).toBe(false);
    expect(r.gates.find((g) => g.key === "funds")).toMatchObject({ ok: false, detail: expect.stringMatching(/but Broker shows only \$221\.24 of cash\. Record the deposit/) });
    expect(r.recommendation.headline).toMatch(/once the deposit shows in your recorded cash$/);
  });

  it("does not add a recorded deposit to the portfolio a second time", () => {
    const ledger = [{ accountId: "a", tradeDate: "2026-11-05", kind: "deposit" as const, symbol: null, quantity: null, price: null, amount: 1250 }];
    const pRec = buildPortfolio([withBasis, savings], new Map(), policy, {}, ledger, now);
    expect(pRec.cashDetail.brokerage).toBe(1250);
    const dep = newCapital({ amount: 1250, source: "deposited", portfolio: pRec, research: [research("$26")], policy, now, filings: quiet });
    const planned = newCapital({ amount: 1250, source: "planned", portfolio: p, research: [research("$26")], policy, now, filings: quiet });
    // A recorded deposit is arithmetic, not a balance: it stays unconfirmed until you check the broker's app.
    expect(dep.funds.verified).toBe(false);
    expect(dep.funds.detail).toMatch(/cash is not confirmed: .*plus \$1,250\.00 from 1 recorded transaction through 2026-11-05/);
    const checked = newCapital({ amount: 1250, source: "deposited", holdingsConfirmed: true, portfolio: pRec, research: [research("$26")], policy, now, filings: quiet });
    expect(checked.funds.verified).toBe(true);
    // Same money, same resulting portfolio: the recorded deposit is already in the total.
    expect(dep.recommendation.allocations).toEqual(planned.recommendation.allocations);
  });
});

describe("new capital: research guides, but is reassessed when the evidence changes", () => {
  const policy = policyFromRules(approvedRules);
  const withBasis = { ...snap, positions: snap.positions.filter((x) => x.symbol !== "BBB").map((x) => ({ ...x, costBasis: x.marketValue })) };
  const p = buildPortfolio([withBasis, savings], new Map(), policy, {}, [], now);
  it("keeps the conclusion as today's recommendation when nothing material changed", () => {
    const aaa = newCapital({ amount: 400, portfolio: p, research: [research("$26")], policy, now, filings: quiet }).options.find((o) => o.symbol === "AAA")!;
    expect(aaa.reassessment).toMatchObject({ status: "current", changes: [expect.stringMatching(/Price down 3\.8% since the research \(\$26 → \$25\.00\)/)] });
    expect(aaa.reassessment!.current).toMatch(/still applies.*Add\.$/);
  });
  it("separates the old conclusion from today's recommendation when the re-priced valuation changed", () => {
    // Written at $60, where its own scenarios did not beat VOO; at $25 they do, inside the same hold zone.
    const hold = toResearchRecord("AAA", "AAA", "held", [{ id: "v4", research_as_of: "2026-10-20", completeness: "complete", origin: "x", is_current: true,
      conclusion: { review_state: "adopted", action: "Hold / no add", reference_price: "$60", reference_date: "2026-10-20",
        valuation: { approx_holding_period_years: 10, bear_value: 30, base_value: 80, bull_value: 140, bear_probability: 0.3, base_probability: 0.5, bull_probability: 0.2 },
        price_framework: [{ price_zone: "$10–$80", action: "Hold / no add" }] } }]);
    const aaa = newCapital({ amount: 400, portfolio: p, research: [hold], policy, now, filings: quiet }).options.find((o) => o.symbol === "AAA")!;
    expect(aaa.label).toBe("Refresh required");
    expect(aaa.reassessment!.status).toBe("needed");
    expect(aaa.reassessment!.changes.join(" ")).toMatch(/Valuation changed since the research: at its \$60 reference .*unfavourable|mixed/);
    expect(aaa.reassessment!.current).toMatch(/Reassess first.*Until it is reassessed: hold what you own, no new money/);
    expect(aaa.eligible).toBe(false);
  });
  it("treats a few-year case against 10-15-year forecasts as context, not a pass/fail", () => {
    const aaa = newCapital({ amount: 400, portfolio: p, research: [research("$26")], policy, now, filings: quiet }).options.find((o) => o.symbol === "AAA")!;
    expect(aaa.assessment!.comparison).toBe("approximate");
    expect(aaa.assessment!.summary).toMatch(/over the research's 4\.0 years: .* in total .* vs .* for VOO if its 10-15-year forecasts held .* context, not a pass\/fail/);
    expect(aaa.assessment!.factors.find((f) => f.label === "Expected return vs VOO")!.leans).toBe("neutral");
    expect(aaa.verdicts!.valuation.ok).toBe(true); // the research says add and its own scenarios do not contradict it
  });
});

describe("new capital: diversified option chosen on whole-portfolio exposure", () => {
  const policy = policyFromRules(approvedRules);
  const balanced = { ...snap, cashValue: 2000, positions: [
    { symbol: "VOO", quantity: 10, price: 700, marketValue: 7000, costBasis: 7000 },
    { symbol: "VXUS", quantity: 30, price: 80, marketValue: 2400, costBasis: 2400 },
    { symbol: "NVDA", quantity: 10, price: 180, marketValue: 1800, costBasis: 1800 },
  ] };
  const p = buildPortfolio([balanced], new Map(), policy, {}, [], now);
  it("compares VOO with the other core ETFs and cash on NVIDIA, chips, AI, technology and geography", () => {
    const r = newCapital({ amount: 1250, source: "planned", portfolio: p, research: [], policy, now });
    const syms = r.exposure.impacts.map((x) => x.symbol);
    expect(syms).toEqual(expect.arrayContaining(["VOO", "VXUS", "CASH"]));
    const voo = r.exposure.impacts.find((x) => x.symbol === "VOO")!;
    expect(voo.rows.map((x) => x.key)).toEqual(["nvda", "tech", "semis", "ai", "us", "em"]);
    const nv = voo.rows.find((x) => x.key === "nvda")!;
    expect(nv.after).toBeLessThan(nv.before); // VOO holds less NVIDIA than this portfolio does
    expect(r.exposure.reasons.find((x) => x.startsWith("Keep cash"))).toMatch(/no stock risk/);
    expect(r.exposure.choice).toBe("VOO");
  });
  it("does not pick an ETF whose bucket would end above its normal range", () => {
    const r = newCapital({ amount: 1250, source: "planned", portfolio: p, research: [], policy, now });
    // International is 21.6% of investable, above its 12-20% range.
    expect(r.exposure.reasons.find((x) => x.startsWith("VXUS"))).toMatch(/above its 20\.0% normal top/);
    expect(r.recommendation.allocations).toEqual([{ symbol: "VOO", amount: 1250 }]);
  });
});
