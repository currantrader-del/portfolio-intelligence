import { describe, expect, it } from "vitest";
import { accountCashUse, buildPortfolio, type SnapshotInput } from "./engine";
import { policyFromRules, type PolicyRuleRow } from "@/lib/policy/rules";
import { newCapital } from "@/lib/decision/newCapital";

// Account names and roles as stored for the real accounts; balances are the real Nov 7-8 cash figures.
const now = new Date("2026-11-08T23:00:00Z");
const schwab: SnapshotInput = { accountId: "schwab", accountName: "Schwab One (Thinkorswim)", accountRole: "taxable_brokerage", asOf: "2026-11-07T21:00:00Z", totalValue: null, cashValue: 82.2,
  positions: [{ symbol: "VOO", quantity: 10, price: 600, marketValue: 6000, costBasis: 6000 }] };
const acorns: SnapshotInput = { accountId: "acorns", accountName: "Acorns Invest", accountRole: "taxable_brokerage", asOf: "2026-11-03T21:00:00Z", totalValue: null, cashValue: 5,
  positions: [{ symbol: "VTI", quantity: 2, price: 300, marketValue: 600, costBasis: 600 }] };
const roth: SnapshotInput = { accountId: "roth", accountName: "Acorns Later (Roth IRA)", accountRole: "retirement", asOf: "2026-11-03T21:00:00Z", totalValue: null, cashValue: 3.97,
  positions: [{ symbol: "VOO", quantity: 1, price: 600, marketValue: 600, costBasis: 600 }] };
const usaa = (cash: number): SnapshotInput => ({ accountId: "usaa", accountName: "USAA Savings", accountRole: "cash", asOf: "2026-11-07T12:00:00Z", totalValue: cash, cashValue: cash, positions: [] });
const policy = policyFromRules([{
  id: "r", scope: "portfolio", subject: "protected_reserve", normal_low: null, normal_high: null, high_conviction_low: null, high_conviction_high: null, hard_max: null, value: 3000,
  conditions: null, source_label: "You", source_date: null, source_status: "latest_approved", approval: "approved", approved_at: "2026-11-07T00:00:00Z", approval_note: null, created_at: "2026-11-07",
} as PolicyRuleRow]);

describe("a cash figure is checked, not assumed", () => {
  // The real Schwab records: Oct 31 statement cash $82.20, then the Nov 5 deposit and three buys recorded from Thinkorswim.
  const ledger = [
    { accountId: "schwab", tradeDate: "2026-11-05", kind: "deposit" as const, symbol: null, quantity: null, price: null, amount: 1250 },
    { accountId: "schwab", tradeDate: "2026-11-05", kind: "buy" as const, symbol: "VXUS", quantity: 8, price: 82.06, amount: -656.48 },
    { accountId: "schwab", tradeDate: "2026-11-05", kind: "buy" as const, symbol: "AVUV", quantity: 3, price: 124.13, amount: -372.39 },
    { accountId: "schwab", tradeDate: "2026-11-05", kind: "buy" as const, symbol: "VXUS", quantity: 1, price: 82.085, amount: -82.09 },
  ];
  const oct = { ...schwab, asOf: "2026-10-31T21:00:00Z", totalValue: 6082.2 };
  it("statement cash plus recorded trades is shown as worked out, not confirmed", () => {
    const p = buildPortfolio([oct, acorns, roth, usaa(3000)], new Map(), policy, {}, ledger, now);
    const s = p.cashDetail.accounts.find((a) => a.id === "schwab")!;
    expect(s.cash).toBe(221.24);
    expect(s.basis).toMatchObject({ status: "derived", confirmed: false, statementCash: 82.2, ledgerNet: 139.04, ledgerRows: 4, lastActivity: "2026-11-05" });
    expect(s.basis!.detail).toMatch(/^\$82\.20 on the 2026-10-31 statement plus \$139\.04 from 4 recorded transactions through 2026-11-05 = \$221\.24\. Worked out, not confirmed/);
    expect(s.basis!.checks.join(" ")).toMatch(/statement is 8 days old/);
    const r = newCapital({ amount: 200, source: "existing", portfolio: p, research: [], policy, now });
    expect(r.funds.verified).toBe(false);
    expect(r.funds.detail).toMatch(/Check the cash and buying power in the broker's app/);
  });
  it("your confirmation of the worked-out figure makes it confirmed; a different figure is flagged", () => {
    const ok = buildPortfolio([oct, usaa(3000)], new Map(), policy, {}, ledger, now, [{ accountId: "schwab", cash: 221.24, at: now.toISOString() }]);
    const s = ok.cashDetail.accounts.find((a) => a.id === "schwab")!;
    expect(s.basis).toMatchObject({ confirmed: true, checks: [] });
    expect(s.basis!.detail).toMatch(/confirmed by you on/);
    const off = buildPortfolio([oct, usaa(3000)], new Map(), policy, {}, ledger, now, [{ accountId: "schwab", cash: 250, at: now.toISOString() }]);
    expect(off.cashDetail.accounts.find((a) => a.id === "schwab")!.basis).toMatchObject({ confirmed: false });
    expect(off.cashDetail.accounts.find((a) => a.id === "schwab")!.basis!.checks.join(" ")).toMatch(/You confirmed \$250\.00 .* records give \$221\.24/);
  });
  it("counts savings as investable only up to your transfer limit", () => {
    const p = buildPortfolio([oct, usaa(13000)], new Map(), policy, {}, ledger, now, [], 10000);
    expect(p.cashDetail.deployableSavings).toBe(10000);
    expect(p.investableCapital).toBe(Math.round((p.total + 10000) * 100) / 100);
    expect(buildPortfolio([oct, usaa(6000)], new Map(), policy, {}, ledger, now, [], 10000).cashDetail.deployableSavings).toBe(6000);
  });
  it("flags records that spend more cash than the statement had", () => {
    const p = buildPortfolio([oct, usaa(3000)], new Map(), policy, {}, ledger.filter((t) => t.kind !== "deposit"), now);
    expect(p.cashDetail.accounts[0].basis!.checks[0]).toMatch(/spend \$1,028\.76 more than the cash on the 2026-10-31 statement: a deposit or trade is missing/);
  });
  it("a recent statement or your own entry with no later activity is confirmed", () => {
    const p = buildPortfolio([schwab, { ...usaa(3000), sourceKind: "manual" }], new Map(), policy, {}, [], now);
    expect(p.cashDetail.accounts.map((a) => [a.name, a.basis!.status, a.basis!.confirmed])).toEqual([["Schwab One (Thinkorswim)", "statement", true], ["USAA Savings", "manual", true]]);
  });
});

describe("cash belongs to its account", () => {
  it("knows what each account's cash can do", () => {
    expect(accountCashUse("Schwab One (Thinkorswim)", "taxable_brokerage")).toBe("self_directed");
    expect(accountCashUse("Acorns Invest", "taxable_brokerage")).toBe("managed");
    expect(accountCashUse("Acorns Later (Roth IRA)", "retirement")).toBe("retirement_managed");
    expect(accountCashUse("USAA Savings", "cash")).toBe("savings");
  });

  it("only the Schwab cash can buy today; Acorns, the Roth and savings never pay without a transfer", () => {
    const p = buildPortfolio([schwab, acorns, roth, usaa(3000)], new Map(), policy, {}, [], now);
    const cd = p.cashDetail;
    expect(cd.investingAccount).toMatchObject({ id: "schwab", name: "Schwab One (Thinkorswim)", cash: 82.2, confirmed: true });
    expect(cd.spendableNow).toBe(82.2);
    expect(cd.accounts.map((a) => [a.name, a.cash, a.canBuyChosen])).toEqual([
      ["Schwab One (Thinkorswim)", 82.2, true], ["Acorns Invest", 5, false], ["Acorns Later (Roth IRA)", 3.97, false], ["USAA Savings", 3000, false],
    ]);
    expect(cd.deployableSavings).toBe(3000); // no protected reserve: all savings could be transferred

    const r = newCapital({ amount: 1250, source: "existing", portfolio: p, research: [], policy, now });
    expect(r.funds).toMatchObject({ requested: 1250, used: 82.2, verified: true });
    expect(r.funds.detail).toMatch(/Schwab One \(Thinkorswim\) holds \$82\.2 of cash that can buy a stock or ETF/);
    expect(r.funds.detail).not.toMatch(/reserve/);
    expect(r.funds.detail).toMatch(/Cash in Acorns Invest \(\$5\) and Acorns Later \(Roth IRA\) \(\$3\.97\) stays in those accounts and is not counted\./);
    expect(r.recommendation.allocations.reduce((a, x) => a + x.amount, 0)).toBeCloseTo(82.2, 2);
  });

  it("savings are used only through a planned transfer, and stay conditional until they arrive", () => {
    const p = buildPortfolio([schwab, acorns, roth, usaa(4500)], new Map(), policy, {}, [], now);
    const noPlan = newCapital({ amount: 1000, source: "existing", portfolio: p, research: [], policy, now });
    expect(noPlan.funds.used).toBe(82.2);
    expect(noPlan.funds.detail).toMatch(/Savings hold \$4,500; that can be used only after you plan a transfer to Schwab One/);
    const transfers = [{ id: "t", fromAccountId: "usaa", toAccountId: "schwab", amount: 1000, date: "2026-11-10", note: null, createdAt: "2026-11-08T22:00:00Z" }];
    const planned = newCapital({ amount: 1000, source: "existing", portfolio: p, research: [], policy, now, transfers });
    expect(planned.funds).toMatchObject({ used: 1000, verified: false });
    expect(planned.status).toBe("conditional");
    // Once a newer Schwab statement shows the money, the transfer is no longer counted on top of it.
    const arrived = buildPortfolio([{ ...schwab, asOf: "2026-11-11T21:00:00Z", cashValue: 1082.2 }, acorns, roth, usaa(3500)], new Map(), policy, {}, [], now);
    const after = newCapital({ amount: 1000, source: "existing", portfolio: arrived, research: [], policy, now, transfers });
    expect(after.funds).toMatchObject({ used: 1000, verified: true });
  });

  it("new money is checked against the Schwab cash, not the pooled total", () => {
    const p = buildPortfolio([schwab, acorns, roth, usaa(3000)], new Map(), policy, {}, [], now);
    const r = newCapital({ amount: 85, source: "deposited", portfolio: p, research: [], policy, now });
    // Schwab $82.20 + Acorns $5 + Roth $3.97 would cover $85 if pooled; Schwab alone does not.
    expect(r.funds.verified).toBe(false);
    expect(r.funds.detail).toMatch(/Schwab One \(Thinkorswim\) shows only \$82\.2 of cash/);
  });
});
