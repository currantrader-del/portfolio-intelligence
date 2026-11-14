import { describe, expect, it } from "vitest";
import type { Bar } from "@/lib/market/history";
import type { TA } from "@/lib/market/ta";
import { findSetup, rankSetups, setupsText, type Setup } from "./scan";

// Synthetic numbers only.
const bars = (high = 130, volume = 1_000_000): Bar[] => Array.from({ length: 260 }, (_, i) => ({ date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`, close: 100, high: i === 100 ? high : 101, low: 99, volume }));
const ta = (o: Partial<TA> = {}): TA => ({
  last: 100, asOf: "2026-11-06", trend: "uptrend", sma50: 98, sma200: 90, rsi14: 40, rsiLabel: "neutral", atr14: 2, atrPct: 0.02,
  support: [{ price: 98, touches: 3, lastTouched: "2026-10-01" }], resistance: [{ price: 115, touches: 2, lastTouched: "2026-08-01" }],
  volumeVs50d: 1, upDownVolume20d: 1.2, hasRange: true, hasVolume: true, ...o,
});

describe("findSetup", () => {
  it("finds a pullback to support in an uptrend, with a stop beyond support", () => {
    const s = findSetup("AAA", "Tech", bars(), ta())!;
    expect(s.kind).toBe("pullback");
    expect(s.stop).toBe(97); // support 98 minus half an ATR
    expect(s.target).toBe(115);
    expect(s.rewardRisk).toBe(5);
  });
  it("skips setups with too little reward, cheap or illiquid stocks, and no setup at all", () => {
    expect(findSetup("AAA", "Tech", bars(), ta({ resistance: [{ price: 104, touches: 2, lastTouched: "x" }] }))).toBeNull();
    expect(findSetup("AAA", "Tech", bars(), ta({ last: 8 }))).toBeNull();
    expect(findSetup("AAA", "Tech", bars(130, 1000), ta())).toBeNull();
    expect(findSetup("AAA", "Tech", bars(), ta({ rsi14: 60 }))).toBeNull();
  });
  it("finds put setups: a rally into resistance in a downtrend", () => {
    const s = findSetup("BBB", "Energy", bars(), ta({ trend: "downtrend", rsi14: 60, support: [{ price: 85, touches: 2, lastTouched: "x" }], resistance: [{ price: 101, touches: 4, lastTouched: "x" }] }))!;
    expect(s).toMatchObject({ kind: "rally_into_resistance", direction: "down", stop: 102, target: 85 });
  });
  it("finds breakouts at the yearly high on volume", () => {
    const s = findSetup("CCC", "Tech", bars(101), ta({ rsi14: 66, volumeVs50d: 1.8, support: [], resistance: [] }))!;
    expect(s.kind).toBe("breakout");
  });
});

it("ranks by score and keeps sectors varied", () => {
  const mk = (symbol: string, sector: string, score: number) => ({ symbol, sector, score, rewardRisk: score } as Setup);
  const r = rankSetups([mk("A", "Tech", 5), mk("B", "Tech", 4.9), mk("C", "Tech", 4.8), mk("D", "Tech", 4.7), mk("E", "Energy", 3)], 10, 3);
  expect(r.map((s) => s.symbol)).toEqual(["A", "B", "C", "E"]);
  expect(setupsText([], 503)).toMatch(/screened 503 stocks and found no chart setup/);
});
