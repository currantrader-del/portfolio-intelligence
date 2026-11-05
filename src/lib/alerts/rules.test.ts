import { describe, expect, it } from "vitest";
import { buildPortfolio } from "@/lib/portfolio/engine";
import { toResearchRecord } from "@/lib/research/records";
import { evaluateAlerts } from "./rules";

const now = new Date("2026-11-05T16:00:00Z");
const quotes = new Map([["AAA", { symbol: "AAA", price: 33.8, prevClose: 37.23, asOf: now.toISOString(), provider: "yahoo" as const, delayClass: "delayed" as const }]]);
const portfolio = buildPortfolio(
  [{
    accountId: "a", accountName: "B", accountRole: "taxable_brokerage", asOf: "2026-10-31T21:00:00Z", totalValue: null, cashValue: 0,
    positions: [
      { symbol: "AAA", quantity: 10, price: 40, marketValue: 400, costBasis: null },
      { symbol: "NOW", quantity: 1, price: 100, marketValue: 100, costBasis: null },
    ],
  }],
  quotes,
  null,
);
const research = [toResearchRecord("AAA", null, "held", [{
  id: "v", research_as_of: "2026-09-10", completeness: "complete", origin: "chatgpt_original", is_current: true,
  conclusion: { reference_price: "$50", reference_date: "2026-09-10", price_framework: [{ price_zone: "< $35", action: "Strong Add research trigger" }, { price_zone: "$40–$55", action: "Hold" }] },
}])];

describe("alerts", () => {
  it("raises a high alert for a big move and for entering a strong-add band", () => {
    const a = evaluateAlerts({ portfolio, research, marketDayPct: -0.008, now });
    expect(a[0].severity).toBe("high");
    expect(a.map((x) => x.kind)).toEqual(expect.arrayContaining(["big_move", "price_zone", "research_missing", "holdings_stale"]));
    expect(a.find((x) => x.kind === "big_move")!.title).toBe("AAA −9.2% today");
  });

  it("flags concentration above the maximum as a review", () => {
    const a = evaluateAlerts({ portfolio, research, marketDayPct: null, now });
    expect(a.find((x) => x.kind === "over_limit" && x.symbol === "AAA")?.detail).toMatch(/not an automatic sale/);
  });
});
