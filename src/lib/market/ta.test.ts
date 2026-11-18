import { describe, expect, it } from "vitest";
import type { Bar } from "./history";
import { analyze, atr, checkLevels, levels, rsi, sma } from "./ta";

// Synthetic prices only: a range between ~90 and ~110 with a 20-day cycle, ending at 100.
const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const range = (n = 160): Bar[] => Array.from({ length: n }, (_, i) => {
  const c = 100 + 10 * Math.sin((i / 20) * 2 * Math.PI);
  return { date: day(i), close: c, high: c + 1, low: c - 1, volume: 1_000_000 * (i % 20 < 10 ? 1.5 : 1) };
});

describe("indicators", () => {
  it("averages, RSI and ATR", () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(sma([1, 2], 3)).toBeNull();
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(rising)).toBe(100);
    const falling = rising.slice().reverse();
    expect(rsi(falling)).toBe(0);
    const flat: Bar[] = Array.from({ length: 30 }, (_, i) => ({ date: day(i), close: 50, high: 51, low: 49 }));
    expect(atr(flat)).toBeCloseTo(2);
    const closesOnly: Bar[] = Array.from({ length: 30 }, (_, i) => ({ date: day(i), close: 50 + (i % 2) }));
    expect(atr(closesOnly)).toBeCloseTo(1);
  });
});

describe("support and resistance", () => {
  it("finds the range floor and ceiling, with touches", () => {
    const bars = range();
    const { support, resistance } = levels(bars, 100, 2);
    expect(support[0].price).toBeGreaterThan(88);
    expect(support[0].price).toBeLessThan(91);
    expect(support[0].touches).toBeGreaterThan(3);
    expect(resistance[0].price).toBeGreaterThan(109);
    expect(resistance[0].price).toBeLessThan(112);
  });
  it("summarizes trend, RSI, volume and data coverage", () => {
    const ta = analyze(range())!;
    expect(["uptrend", "downtrend", "mixed"]).toContain(ta.trend);
    const up: Bar[] = Array.from({ length: 220 }, (_, i) => ({ date: day(i), close: 50 + i * 0.5 + Math.sin(i) }));
    expect(analyze(up)!.trend).toBe("uptrend");
    expect(analyze(up)!.hasVolume).toBe(false);
    expect(ta.hasRange && ta.hasVolume).toBe(true);
    expect(ta.volumeVs50d).not.toBeNull();
    expect(ta.atrPct).toBeGreaterThan(0);
    expect(analyze(range(20))).toBeNull();
  });
});

describe("checkLevels", () => {
  const ta = { support: [{ price: 90, touches: 4, lastTouched: day(150) }], resistance: [{ price: 110, touches: 4, lastTouched: day(140) }], atr14: 2 };
  it("accepts a stop beyond support", () => {
    const r = checkLevels(ta, { direction: "up", entry: 100, target: 108, stop: 88 });
    expect(r.problems).toEqual([]);
    expect(r.notes[0]).toMatch(/beyond support at \$90/);
  });
  it("rejects a stop above support, or inside normal noise", () => {
    expect(checkLevels(ta, { direction: "up", entry: 100, target: 108, stop: 92 }).problems[0]).toMatch(/sits above support at \$90/);
    expect(checkLevels(ta, { direction: "up", entry: 100, target: 108, stop: 98.5 }).problems.join(" ")).toMatch(/normal day's range/);
  });
  it("measures reward to resistance before the target, and rejects when it pays less than the risk", () => {
    const ok = checkLevels(ta, { direction: "up", entry: 100, target: 125, stop: 88 });
    expect(ok.realisticRewardRisk).toBeCloseTo(10 / 12);
    expect(ok.problems.join(" ")).toMatch(/resistance at \$110/);
    const fine = checkLevels({ ...ta, resistance: [{ price: 118, touches: 2, lastTouched: day(100) }] }, { direction: "up", entry: 100, target: 125, stop: 88 });
    expect(fine.problems).toEqual([]);
  });
  it("mirrors for puts", () => {
    expect(checkLevels(ta, { direction: "down", entry: 100, target: 92, stop: 112 }).problems).toEqual([]);
    expect(checkLevels(ta, { direction: "down", entry: 100, target: 92, stop: 106 }).problems[0]).toMatch(/below resistance at \$110/);
  });
});
