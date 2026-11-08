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

describe("cash belongs to its account", () => {
  it("knows what each account's cash can do", () => {
    expect(accountCashUse("Schwab One (Thinkorswim)", "taxable_brokerage")).toBe("self_directed");
    expect(accountCashUse("Acorns Invest", "taxable_brokerage")).toBe("managed");
    expect(accountCashUse("Acorns Later (Roth IRA)", "retirement")).toBe("retirement_managed");
    expect(accountCashUse("USAA Savings", "cash")).toBe("savings");
  });

  it("only the Schwab cash can buy today; Acorns, the Roth and the reserve never pay", () => {
    const p = buildPortfolio([schwab, acorns, roth, usaa(3000)], new Map(), policy, {}, [], now);
    const cd = p.cashDetail;
    expect(cd.investingAccount).toEqual({ id: "schwab", name: "Schwab One (Thinkorswim)", cash: 82.2 });
    expect(cd.spendableNow).toBe(82.2);
    expect(cd.accounts.map((a) => [a.name, a.cash, a.canBuyChosen])).toEqual([
      ["Schwab One (Thinkorswim)", 82.2, true], ["Acorns Invest", 5, false], ["Acorns Later (Roth IRA)", 3.97, false], ["USAA Savings", 3000, false],
    ]);
    expect(cd.deployableSavings).toBe(0); // all $3,000 of savings is the protected reserve

    const r = newCapital({ amount: 1250, source: "existing", portfolio: p, research: [], policy, now });
    expect(r.funds).toMatchObject({ requested: 1250, used: 82.2, verified: true });
    expect(r.funds.detail).toMatch(/Schwab One \(Thinkorswim\) holds \$82\.2 of cash that can buy a stock or ETF/);
    expect(r.funds.detail).toMatch(/The \$3,000 savings reserve is never used\./);
    expect(r.funds.detail).toMatch(/Cash in Acorns Invest \(\$5\) and Acorns Later \(Roth IRA\) \(\$3\.97\) stays in those accounts and is not counted\./);
    expect(r.recommendation.allocations.reduce((a, x) => a + x.amount, 0)).toBeCloseTo(82.2, 2);
  });

  it("savings above the reserve are used only through a planned transfer, and stay conditional until they arrive", () => {
    const p = buildPortfolio([schwab, acorns, roth, usaa(4500)], new Map(), policy, {}, [], now);
    const noPlan = newCapital({ amount: 1000, source: "existing", portfolio: p, research: [], policy, now });
    expect(noPlan.funds.used).toBe(82.2);
    expect(noPlan.funds.detail).toMatch(/Savings hold \$1,500 above the reserve; that can be used only after you plan a transfer to Schwab One/);
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
