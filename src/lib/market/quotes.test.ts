import { describe, expect, it } from "vitest";
import { dayChangePct, parseStooqCsv, parseYahooChart, zonedToUtc } from "./quotes";
import { isMarketOpen } from "./hours";

describe("quote parsing", () => {
  it("reads Yahoo chart meta", () => {
    const q = parseYahooChart("AAA", { chart: { result: [{ meta: { regularMarketPrice: 33.8, chartPreviousClose: 37.23, regularMarketTime: 1793977200 } }] } });
    expect(q?.price).toBe(33.8);
    expect(q?.provider).toBe("yahoo");
    expect(dayChangePct(q)).toBeCloseTo(-0.0921, 3);
  });
  it("rejects empty Yahoo responses", () => {
    expect(parseYahooChart("X", { chart: { result: null } })).toBeNull();
    expect(parseYahooChart("X", { chart: { result: [{ meta: { regularMarketPrice: 0 } }] } })).toBeNull();
  });
  it("reads Stooq CSV", () => {
    const q = parseStooqCsv("VOO", "Symbol,Date,Time,Open,High,Low,Close,Volume,Prev\nVOO.US,2026-11-05,22:00:10,690,700,689,694.81,100,700.1\n");
    expect(q?.price).toBe(694.81);
    expect(q?.prevClose).toBe(700.1);
  });
  it("rejects a Yahoo price with no market time instead of stamping it as current", () => {
    expect(parseYahooChart("AAA", { chart: { result: [{ meta: { regularMarketPrice: 33.8 } }] } })).toBeNull();
    expect(parseYahooChart("AAA", { chart: { result: [{ meta: { regularMarketPrice: 33.8, regularMarketTime: 0 } }] } })).toBeNull();
  });
  it("keeps the provider's time, not the fetch time", () => {
    const q = parseYahooChart("AAA", { chart: { result: [{ meta: { regularMarketPrice: 33.8, regularMarketTime: 1793977200 } }] } });
    expect(q?.asOf).toBe(new Date(1793977200 * 1000).toISOString());
  });
  it("converts Stooq Warsaw times with daylight saving", () => {
    // Summer (CEST, UTC+2) and winter (CET, UTC+1)
    expect(parseStooqCsv("VOO", "Symbol,Date,Time,Open,High,Low,Close,Volume,Prev\nVOO.US,2026-07-15,22:00:10,1,1,1,1,1,1\n")?.asOf).toBe("2026-07-15T20:00:10.000Z");
    expect(parseStooqCsv("VOO", "Symbol,Date,Time,Open,High,Low,Close,Volume,Prev\nVOO.US,2026-11-05,22:00:10,1,1,1,1,1,1\n")?.asOf).toBe("2026-11-05T21:00:10.000Z");
    expect(zonedToUtc("2026-03-29", "03:30:00", "Europe/Warsaw").toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });
  it("rejects Stooq rows without a date", () => {
    expect(parseStooqCsv("VOO", "Symbol,Date,Time,Open,High,Low,Close,Volume,Prev\nVOO.US,,,1,1,1,5,1,1\n")).toBeNull();
  });
  it("rejects Stooq N/D rows", () => {
    expect(parseStooqCsv("ZZZ", "Symbol,Date,Time,Open,High,Low,Close,Volume,Prev\nZZZ.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D,N/D\n")).toBeNull();
  });
});

describe("market hours", () => {
  it("is open on a weekday at 11 AM New York", () => {
    expect(isMarketOpen(new Date("2026-11-05T16:00:00Z"))).toBe(true); // 11:00 EST
  });
  it("is closed before the open, after the close and at weekends", () => {
    expect(isMarketOpen(new Date("2026-11-05T14:00:00Z"))).toBe(false); // 9:00
    expect(isMarketOpen(new Date("2026-11-05T21:30:00Z"))).toBe(false); // 16:30
    expect(isMarketOpen(new Date("2026-11-07T16:00:00Z"))).toBe(false); // Saturday
  });
});
