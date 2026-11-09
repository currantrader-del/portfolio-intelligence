import { describe, expect, it } from "vitest";
import { buildPortfolio } from "@/lib/portfolio/engine";
import { toResearchRecord } from "@/lib/research/records";
import { evaluateAlerts, moveCaveat } from "./rules";

// Synthetic data only.
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
  {}, [], now,
);
const research = [toResearchRecord("AAA", null, "held", [{
  id: "v", research_as_of: "2026-09-10", completeness: "complete", origin: "chatgpt_original", is_current: true,
  conclusion: { reference_price: "$50", reference_date: "2026-09-10", price_framework: [{ price_zone: "< $35", action: "Strong Add research trigger" }, { price_zone: "$40–$55", action: "Hold" }] },
}])];

describe("alerts", () => {
  it("words the big-move caveat for the move's direction", () => {
    expect(moveCaveat(-0.07)).toMatch(/^A drop is not a buy signal/);
    expect(moveCaveat(0.087)).toMatch(/^A jump is not a reason to buy or sell/);
    expect(moveCaveat(0.087)).not.toMatch(/drop/);
  });

  it("merges a big move, a band change and a limit breach on one company into one review", () => {
    const a = evaluateAlerts({ portfolio, research, marketDayPct: -0.008, now });
    expect(a[0].severity).toBe("high");
    const aaa = a.filter((x) => x.symbol === "AAA" && x.kind !== "research_missing");
    expect(aaa).toHaveLength(1);
    expect(aaa[0].kind).toBe("review");
    expect(aaa[0].title).toMatch(/^Review AAA: −9\.2% today/);
    expect(aaa[0].detail).toMatch(/not a buy signal by itself/);
    expect(aaa[0].detail).toMatch(/not an automatic sale/);
    expect(a.map((x) => x.kind)).toEqual(expect.arrayContaining(["research_missing", "holdings_stale", "data_missing"]));
  });

  it("treats a move in line with the market as low priority", () => {
    const a = evaluateAlerts({ portfolio, research: [], marketDayPct: -0.08, now });
    const move = a.find((x) => x.symbol === "AAA");
    expect(move?.severity).not.toBe("high");
  });
});
