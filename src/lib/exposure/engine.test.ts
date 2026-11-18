import { describe, expect, it } from "vitest";
import { computeExposure, queryExposure, STALE_DAYS } from "./engine";
import { FUNDS } from "./reference";
import { REAL_CASH, REAL_HOLDINGS } from "./__fixtures__/portfolio-2026-11-07";

const NOW = new Date("2026-11-08T12:00:00Z");
const sumDim = (r: ReturnType<typeof computeExposure>, k: keyof ReturnType<typeof computeExposure>["dims"]) => r.dims[k].lines.reduce((a, l) => a + l.value, 0) + r.dims[k].notItemized;

describe("exposure look-through", () => {
  it("never counts a fund beside its own holdings: every additive dimension adds up to its base", () => {
    const r = computeExposure(REAL_HOLDINGS, REAL_CASH, NOW);
    for (const k of ["sector", "industry", "country", "market", "region", "size", "style", "cycle", "company"] as const) {
      expect(sumDim(r, k)).toBeCloseTo(r.equity, 0);
    }
    expect(sumDim(r, "asset")).toBeCloseTo(r.investable, 0);
    // A fund symbol never appears as a company.
    expect(r.dims.company.lines.some((l) => FUNDS[l.key])).toBe(false);
  });

  it("splits one S&P 500 fund by its published weights", () => {
    const r = computeExposure([{ symbol: "VOO", value: 1000 }], 0, NOW);
    expect(r.dims.sector.lines.find((l) => l.key === "Information Technology")!.value).toBeCloseTo(396.6, 0); // 39.7%, scaled for the fact sheet's 100.1% total
    expect(r.dims.company.lines.find((l) => l.key === "NVDA")!.value).toBeCloseTo(83.9, 1);
    expect(r.dims.company.lines.find((l) => l.key === "GOOGL")!.value).toBeCloseTo(55.2, 1); // both share classes
    expect(r.dims.country.lines[0]).toMatchObject({ key: "United States", value: 1000 });
    expect(r.dims.company.notItemized).toBeGreaterThan(300); // ~36% of VOO is outside its 25 largest holdings
  });

  it("adds direct and fund exposure for a company held both ways (real portfolio: NVIDIA)", () => {
    const r = computeExposure(REAL_HOLDINGS, REAL_CASH, NOW);
    const nvda = r.dims.company.lines.find((l) => l.key === "NVDA")!;
    const voo = REAL_HOLDINGS.find((h) => h.symbol === "VOO")!.value;
    expect(nvda.direct).toBeCloseTo(5946, 0);
    expect(nvda.indirect).toBeCloseTo(0.0839 * voo, 0);
    expect(nvda.contributors.map((c) => c.via)).toEqual(["NVDA", "VOO"]);
  });

  it("real portfolio: semiconductors, AI infrastructure, US technology and Asia", () => {
    const r = computeExposure(REAL_HOLDINGS, REAL_CASH, NOW);
    const semis = r.dims.industry.lines.find((l) => l.key === "Semiconductors & Semiconductor Equipment")!;
    expect(semis.pct).toBeGreaterThan(0.22);
    expect(semis.pct).toBeLessThan(0.25);
    expect(semis.upperPct!).toBeGreaterThan(semis.pct); // unassigned tech dollars could add to it
    const ai = r.dims.theme.lines.find((l) => l.key === "AI infrastructure")!;
    expect(ai.direct).toBeCloseTo(5946 + 1532.8, 0); // NVDA + IREN held directly
    expect(r.dims.theme.additive).toBe(false);
    const usTech = queryExposure(REAL_HOLDINGS, REAL_CASH, { country: "United States", sector: "Information Technology" });
    expect(usTech.approximate).toBe(false); // US funds are single-country, so no independence assumption is needed
    expect(usTech.contributors.map((c) => c.via)).toContain("VOO");
    expect(usTech.contributors.map((c) => c.via)).not.toContain("VXUS");
    const tw = queryExposure(REAL_HOLDINGS, REAL_CASH, { country: "Taiwan" });
    expect(tw.value).toBeCloseTo(r.dims.country.lines.find((l) => l.key === "Taiwan")!.value, 0);
  });

  it("uses a sector fund's published industry split instead of its top holdings", () => {
    const r = computeExposure([{ symbol: "VHT", value: 1000 }], 0, NOW);
    expect(sumDim(r, "industry")).toBeCloseTo(1000, 0);
    expect(r.dims.industry.lines.find((l) => l.key === "Pharmaceuticals")!.value).toBeCloseTo(332, 0);
  });

  it("gives a country range that never adds a fund's remainder to a country it already lists", () => {
    const r = computeExposure([{ symbol: "VXUS", value: 1000 }], 0, NOW);
    const japan = r.dims.country.lines.find((l) => l.key === "Japan")!;
    expect(japan.upper).toBeUndefined(); // Japan is itemized in VXUS
    const em = r.dims.market.lines.find((l) => l.key === "Emerging")!;
    expect(em.upperPct!).toBeGreaterThan(em.pct);
  });

  it("merges share classes and counts an unknown stock as not itemized, not as zero", () => {
    const r = computeExposure([{ symbol: "GOOG", value: 100 }, { symbol: "GOOGL", value: 100 }, { symbol: "ZZZZ", value: 50 }], 0, NOW);
    expect(r.dims.company.lines.find((l) => l.key === "GOOGL")!.value).toBe(200);
    expect(r.unclassified).toEqual(["ZZZZ"]);
    expect(r.dims.sector.notItemized).toBe(50);
  });

  it("flags fund data older than the staleness limit", () => {
    const later = new Date(new Date("2026-09-30T00:00:00Z").getTime() + (STALE_DAYS + 5) * 86_400_000);
    const r = computeExposure([{ symbol: "VOO", value: 1000 }], 0, later);
    expect(r.sources.some((s) => s.stale)).toBe(true);
    expect(r.gaps.join(" ")).toMatch(/Older than/);
    expect(computeExposure([{ symbol: "VOO", value: 1000 }], 0, NOW).sources.every((s) => !s.stale)).toBe(true);
  });

  it("names the two international funds that hold the same market", () => {
    const r = computeExposure(REAL_HOLDINGS, REAL_CASH, NOW);
    const o = r.overlaps.find((x) => [x.a, x.b].sort().join() === "IXUS,VXUS")!;
    expect(o.note).toMatch(/no diversification/);
    expect(r.overlaps.some((x) => x.a === "VOO" && x.b === "IJH")).toBe(false); // US funds are not "overlapping" just by being US
  });

  it("estimates bond rate sensitivity from published durations", () => {
    const r = computeExposure([{ symbol: "AGG", value: 1000 }], 0, NOW);
    expect(r.rates.per1pt).toBeCloseTo(57.3, 1);
    expect(r.equity).toBe(0);
  });
});
