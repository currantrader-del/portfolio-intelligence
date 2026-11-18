import { expect, it } from "vitest";
import { parseStooqHistory, parseYahooHistory } from "./history";

it("reads Yahoo open/high/low/volume and scales them like the adjusted close", () => {
  const body = { chart: { result: [{ timestamp: [1767276000, 1767362400], meta: { exchangeTimezoneName: "America/New_York" }, indicators: {
    quote: [{ open: [99, 101], high: [102, 104], low: [98, 100], close: [100, 102], volume: [5000, 7000] }],
    adjclose: [{ adjclose: [50, 51] }],
  } }] } };
  const h = parseYahooHistory("AAA", body)!;
  expect(h.bars[0]).toEqual({ date: "2026-01-01", close: 50, raw: 100, open: 49.5, high: 51, low: 49, volume: 5000 });
  expect(h.bars[1].high).toBeCloseTo(52);
});

it("reads Stooq OHLCV and still works with closes only", () => {
  const h = parseStooqHistory("AAA", "Date,Open,High,Low,Close,Volume\n2026-01-02,10,11,9,10.5,1200\n")!;
  expect(h.bars[0]).toEqual({ date: "2026-01-02", close: 10.5, open: 10, high: 11, low: 9, volume: 1200 });
  expect(parseStooqHistory("AAA", "Date,Close\n2026-01-02,10.5\n")!.bars[0]).toEqual({ date: "2026-01-02", close: 10.5 });
});
