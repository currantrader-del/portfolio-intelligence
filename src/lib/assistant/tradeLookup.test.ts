import { describe, expect, it } from "vitest";
import { buildPortfolio, type LedgerEntry, type SnapshotInput } from "@/lib/portfolio/engine";
import { dedupeSynced } from "@/lib/workspace-core";
import { isTradeRecordQuestion, tradeRecordAnswer } from "./tradeLookup";

// Synthetic, shaped like 2026-11-18: two buys synced from Schwab at 3:02 PM ET.
const now = new Date("2026-11-18T22:00:00Z");
const snap: SnapshotInput = {
  accountId: "s", accountName: "Broker", accountRole: "taxable_brokerage", asOf: "2026-11-18T20:02:00Z", sourceKind: "schwab_api", totalValue: null, cashValue: 72,
  positions: [{ symbol: "VOO", quantity: 11, price: 671, marketValue: 7381, costBasis: 7000 }, { symbol: "AVUV", quantity: 24, price: 119.5, marketValue: 2868, costBasis: 2944 }],
};
const p = buildPortfolio([snap], new Map(), null, {}, [], now);
const ledger: LedgerEntry[] = [
  { accountId: "s", tradeDate: "2026-11-18", kind: "buy", symbol: "VOO", quantity: 1, price: 670.99, amount: -670.99, source: "schwab_api" },
  { accountId: "s", tradeDate: "2026-11-18", kind: "buy", symbol: "AVUV", quantity: 4, price: 119.52, amount: -478.08, source: "schwab_api" },
  { accountId: "s", tradeDate: "2026-11-05", kind: "buy", symbol: "VXUS", quantity: 8, price: 82.06, amount: -656.48, source: "csv_import" },
];

describe("was my trade recorded?", () => {
  it("recognises the lookup, and leaves real questions to the assistant", () => {
    expect(isTradeRecordQuestion("I bought more VOO and AVUV today - was that recorded ?")).toBe(true);
    expect(isTradeRecordQuestion("Did my NVDA sale sync?")).toBe(true);
    expect(isTradeRecordQuestion("Should I buy more VOO?")).toBe(false);
    expect(isTradeRecordQuestion("Why did NVDA drop today?")).toBe(false);
  });
  it("finds Schwab-synced buys and says they are in the holdings", () => {
    const a = tradeRecordAnswer("I bought more VOO and AVUV today - was that recorded ?", ledger, p, now);
    expect(a).toMatch(/^Yes\. Recorded today:/);
    expect(a).toContain("Bought 1 share of VOO at $670.99");
    expect(a).toContain("Bought 4 shares of AVUV at $119.52");
    expect(a).toContain("synced from Schwab");
    expect(a).not.toContain("VXUS");
    expect(a).toMatch(/no AI used, no charge/);
  });
  it("says plainly when a trade is not there, with the last sync time", () => {
    const a = tradeRecordAnswer("Was my NVDA buy recorded today?", ledger.filter((l) => l.symbol !== "VOO"), { ...p, holdings: [...p.holdings, { ...p.holdings[0], symbol: "NVDA" }] }, now);
    expect(a).toMatch(/I don't see NVDA today, but these trades are recorded/);
    expect(a).toMatch(/Broker last synced Nov 18, 3:02 PM ET/);
  });
});

describe("a Schwab activity counts once", () => {
  it("drops a second row for the same Schwab id and keeps everything else", () => {
    const rows = [
      { id: 1, source_kind: "schwab_api", note: "Deposit from Schwab (schwab activity 135881620574)" },
      { id: 2, source_kind: "schwab_api", note: "Deposit from Schwab (schwab activity 135881620574)" },
      { id: 3, source_kind: "manual", note: null },
      { id: 4, source_kind: "manual", note: null },
      { id: 5, source_kind: "schwab_api", note: "From Schwab (schwab activity 9)" },
    ];
    expect(dedupeSynced(rows).map((r) => r.id)).toEqual([1, 3, 4, 5]);
  });
});
