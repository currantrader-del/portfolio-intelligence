import { describe, expect, it } from "vitest";
import { centred, logReturns, recoveryOdds, rng } from "./sim";
import { calibrate } from "./calibrate";

/** A random walk with fat-ish tails and volatility spells, like a real stock. */
function walk(seed: number, days: number, vol = 0.02) {
  const r = rng(seed);
  const out = [100];
  let v = vol;
  for (let i = 1; i < days; i++) {
    if (i % 60 === 0) v = vol * (0.6 + r() * 0.9);
    const z = (r() + r() + r() + r() - 2) * Math.sqrt(3);
    out.push(out[i - 1] * Math.exp(z * v + 0.0002));
  }
  return out;
}

describe("recovery odds", () => {
  const closes = walk(7, 800);
  const returns = centred(logReturns(closes));

  it("removes the stock's own past trend and adds a market-like drift", () => {
    const raw = logReturns(closes);
    const m0 = raw.reduce((a, b) => a + b, 0) / raw.length;
    const variance = raw.reduce((a, b) => a + (b - m0) ** 2, 0) / raw.length;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    expect(mean).toBeCloseTo(Math.log(1.06) / 252 - variance / 2, 8);
    // An expected 6% a year in price terms, whatever the stock did before.
    expect(Math.exp((mean + variance / 2) * 252) - 1).toBeCloseTo(0.06, 6);
  });
  it("touching is at least as likely as closing above, and farther or sooner is less likely", () => {
    const o = recoveryOdds({ price: 100, returns, targets: [110, 150], paths: 2000 });
    for (const x of o) expect(x.touch).toBeGreaterThanOrEqual(x.closeAbove);
    const at = (t: number, h: string) => o.find((x) => x.target === t && x.horizon === h)!;
    expect(at(150, "1y").touch).toBeLessThan(at(110, "1y").touch);
    expect(at(110, "2m").touch).toBeLessThan(at(110, "2y").touch);
  });
  it("is reproducible for the same inputs", () => {
    const a = recoveryOdds({ price: 100, returns, targets: [120], paths: 500, seed: 3 });
    const b = recoveryOdds({ price: 100, returns, targets: [120], paths: 500, seed: 3 });
    expect(a).toEqual(b);
  });
  it("handles falls too: odds of dropping to a lower price", () => {
    const o = recoveryOdds({ price: 100, returns, targets: [80], paths: 1000 });
    expect(o.find((x) => x.horizon === "1y")!.touch).toBeGreaterThan(0.05);
  });
  it("refuses to guess without enough history", () => {
    expect(recoveryOdds({ price: 100, returns: returns.slice(0, 10), targets: [120] })).toEqual([]);
  });
});

describe("calibration check", () => {
  it("passes on prices that really behave like the model, and reports its limits", () => {
    const series = Array.from({ length: 12 }, (_, i) => ({ symbol: `S${i}`, closes: walk(100 + i, 1260, 0.012 + (i % 4) * 0.004) }));
    const c = calibrate(series, new Date("2026-11-11T00:00:00Z"), 200);
    expect(c.cases).toBeGreaterThan(500);
    expect(c.byKind.touch.meanGap).toBeLessThan(0.06);
    expect(c.limits.length).toBeGreaterThan(2);
    // Each period is judged on its own, and the list of periods to show matches those verdicts.
    expect(c.horizonsPassed!.length).toBeGreaterThan(0);
    for (const [k, h] of Object.entries(c.byHorizon)) expect(c.horizonsPassed!.includes(k as never)).toBe(!!h.passed);
  }, 60_000);
  it("fails when the future is nothing like the past", () => {
    // Calm for years, then a steady crash: past volatility says nothing about the move that came.
    const crash = (seed: number) => { const base = walk(seed, 900, 0.004); const last = base[base.length - 1]; return [...base, ...Array.from({ length: 360 }, (_, i) => last * Math.exp(-0.004 * (i + 1)))]; };
    const c = calibrate(Array.from({ length: 12 }, (_, i) => ({ symbol: `C${i}`, closes: crash(300 + i) })), new Date(), 150);
    expect(c.passed).toBe(false);
    expect(c.horizonsPassed!.length).toBeLessThan(4);
  }, 60_000);
});
