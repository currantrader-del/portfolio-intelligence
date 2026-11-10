import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_PREFS, formatMovePush, moveClassOf, prefsFrom, priceMoveAlerts, type MoveItem } from "./priceMoves";

const now = new Date("2026-11-10T16:00:00Z"); // 11:00 ET
const item = (symbol: string, dayPct: number, bucket: MoveItem["bucket"] = "Quality/growth individual stocks", o: Partial<MoveItem> = {}): MoveItem =>
  ({ symbol, dayPct, price: 100, quoteAt: "2026-11-10T15:50:00Z", held: true, bucket, ...o });
const run = (items: MoveItem[], sent = new Map<string, number>(), prefs = DEFAULT_ALERT_PREFS) => priceMoveAlerts({ items, prefs, marketDayPct: 0.005, sentToday: sent, now });

describe("price-movement alerts", () => {
  it("uses 3% for broad ETFs, 5% for established stocks, 8% for speculative ones", () => {
    expect(moveClassOf("VOO", "US broad-market equity")).toBe("broad_etf");
    expect(moveClassOf("GOOGL", "Quality/growth individual stocks")).toBe("stock");
    expect(moveClassOf("IONQ", "Asymmetric/high-risk growth sleeve")).toBe("speculative");
    expect(moveClassOf("NVDA", "Quality/growth individual stocks", { NVDA: "speculative" })).toBe("speculative");
    const a = run([item("VOO", -0.031, "US broad-market equity"), item("GOOGL", 0.049), item("RDDT", 0.056), item("IONQ", 0.066, "Asymmetric/high-risk growth sleeve")]);
    expect(a.map((x) => [x.symbol, x.thresholdPct])).toEqual([["RDDT", 5], ["VOO", 3]]);
    expect(a[0].body).toMatch(/^Price move only, not a buy or sell signal\. Your holding moved past 5%/);
    expect(a[0].title).toBe("RDDT +5.6% today (+5.1% vs the market)");
  });
  it("alerts once per crossing, escalates at 2x and 3x, and resets each session", () => {
    const first = run([item("RDDT", 0.056)]);
    expect(first).toHaveLength(1);
    const sent = new Map([["RDDT|up", 1]]);
    expect(run([item("RDDT", 0.08)], sent)).toEqual([]);
    const esc = run([item("RDDT", 0.104)], sent);
    expect(esc[0]).toMatchObject({ level: 2, priority: "high" });
    expect(esc[0].body).toMatch(/2x your 5% level\. Next alert at 15%/);
    // A fall the same day is its own direction.
    expect(run([item("RDDT", -0.051)], sent)).toHaveLength(1);
    expect(esc[0].id).toBe("move:2026-11-10:RDDT:up:2");
  });
  it("never alerts on a stale or missing quote, and watchlist moves only when turned on", () => {
    expect(run([item("RDDT", 0.09, undefined, { quoteAt: "2026-11-10T14:00:00Z" })])).toEqual([]);
    expect(run([item("RDDT", 0.09, undefined, { quoteAt: null })])).toEqual([]);
    const w = item("MU", 0.07, "Quality/growth individual stocks", { held: false });
    expect(run([w])).toEqual([]);
    expect(run([w], new Map(), { ...DEFAULT_ALERT_PREFS, watchlistMoves: true })[0].body).toMatch(/Watchlist stock moved past 5%/);
  });
  it("one notification for several moves; settings are validated", () => {
    const m = formatMovePush(run([item("RDDT", 0.056), item("VOO", -0.031, "US broad-market equity")]));
    expect(m.title).toBe("Price moves: RDDT +5.6%, VOO −3.1%");
    expect(m.body).toMatch(/Price moves only, not buy or sell signals\.$/);
    expect(prefsFrom({ thresholds: { stock: 4, speculative: -1 }, classOverrides: { nvda: "speculative", x: "bogus" }, priceDelivery: "daily" }))
      .toMatchObject({ thresholds: { broad_etf: 3, stock: 4, speculative: 8 }, classOverrides: { NVDA: "speculative" }, priceDelivery: "daily", intelligenceDelivery: "immediate", priceMoves: true });
  });
});

describe("the closing check", () => {
  it("runs at 4:02 PM ET on weekdays only", async () => {
    const { isClosingCheck } = await import("./job");
    expect(isClosingCheck(new Date("2026-11-10T21:02:00Z"))).toBe(true); // Tue 4:02 PM EST
    expect(isClosingCheck(new Date("2026-11-10T21:12:00Z"))).toBe(false);
    expect(isClosingCheck(new Date("2026-11-08T21:02:00Z"))).toBe(false); // Sunday
  });
});
