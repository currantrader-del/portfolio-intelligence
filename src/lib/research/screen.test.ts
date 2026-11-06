import { describe, expect, it } from "vitest";
import { screenCompany } from "./screen";
import type { Fundamentals, Metric, FilingsResult } from "@/lib/market/sec";

const P = (end: string, value: number, start: string | null = null) => ({ start, end, value, form: null, filed: null });
function metric(key: string, o: Partial<Metric>): Metric {
  return { key, label: key, unit: "USD", tag: "t", latestQuarter: null, yearAgoQuarter: null, yoy: null, latestAnnual: null, ttm: null, latest: null, ...o };
}
const fund = (metrics: Metric[]): Fundamentals => ({ cik: "1", company: "Alpha", metrics, missing: [], source: "", fetchedAt: "" });

const healthy = fund([
  metric("revenue", { latestQuarter: P("2026-09-30", 300, "2026-07-01"), yoy: 0.25, ttm: 1100, latest: P("2026-09-30", 300, "2026-07-01") }),
  metric("operating_income", { ttm: 200 }),
  metric("operating_cash_flow", { ttm: 250 }),
  metric("capex", { ttm: 50 }),
  metric("cash", { latest: P("2026-09-30", 500) }),
  metric("long_term_debt", { latest: P("2026-09-30", 100) }),
  metric("shares_outstanding", { unit: "shares", latest: P("2026-10-20", 100), yoy: 0.01 }),
]);

describe("screenCompany", () => {
  const now = new Date("2026-11-06T00:00:00Z");

  it("passes a healthy company to research, without any buy signal", () => {
    const r = screenCompany({ symbol: "AAA", fundamentals: healthy, filings: null, price: 50, now });
    expect(r.verdict).toBe("Worth researching");
    expect(r.checks.find((c) => c.key === "valuation")).toMatchObject({ status: "pass", value: "4.5×" });
    expect(r.toVerify).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/buy|allocat|expected return/i);
  });

  it("flags a cash-burning, diluting company as weak and lists what to verify", () => {
    const weak = fund([
      metric("revenue", { yoy: -0.05, latestQuarter: P("2026-09-30", 10, "2026-07-01"), ttm: 40 }),
      metric("operating_income", { ttm: -30 }),
      metric("operating_cash_flow", { ttm: -20 }),
      metric("cash", { latest: P("2026-09-30", 10) }),
      metric("long_term_debt", { latest: P("2026-09-30", 50) }),
      metric("shares_outstanding", { latest: P("2026-10-20", 100), yoy: 0.2 }),
    ]);
    const r = screenCompany({ symbol: "BBB", fundamentals: weak, filings: null, price: 20, now });
    expect(r.verdict).toBe("Weak on screen");
    expect(r.checks.filter((c) => c.status === "fail").map((c) => c.key)).toEqual(expect.arrayContaining(["growth", "profit", "fcf", "balance", "dilution", "valuation"]));
    expect(r.toVerify.length).toBeGreaterThanOrEqual(5);
  });

  it("says there is not enough data instead of guessing", () => {
    const r = screenCompany({ symbol: "EEE", fundamentals: { error: "SEC EDGAR could not be reached." }, filings: null, price: null, now });
    expect(r.verdict).toBe("Not enough data");
    expect(r.toVerify[0]).toMatch(/could not be loaded/);
  });

  it("treats a recent share offering as a dilution watch item", () => {
    const filings: FilingsResult = { cik: "1", company: "Alpha", lastEarnings: null, nextEarningsEstimate: "2026-11-12", source: "", fetchedAt: "",
      filings: [{ form: "424B5", filed: "2026-10-01", reportDate: null, description: "", items: [], isEarnings: false, url: "" }] };
    const r = screenCompany({ symbol: "AAA", fundamentals: healthy, filings, price: 50, now });
    expect(r.checks.find((c) => c.key === "dilution")?.status).toBe("watch");
    expect(r.checks.find((c) => c.key === "earnings")).toMatchObject({ status: "info" });
    expect(r.verdict).toBe("Worth researching"); // one watch item only
  });
});
