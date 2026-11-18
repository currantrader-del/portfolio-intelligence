import { describe, expect, it } from "vitest";
import { companyMax, parsePct, parseRange, readPolicy } from "./limits";

describe("policy parsing", () => {
  it("parses ranges and percents in the policy's own wording", () => {
    expect(parseRange("25-40%")).toEqual({ low: 0.25, high: 0.4 });
    expect(parseRange("~3-5%")).toEqual({ low: 0.03, high: 0.05 });
    expect(parseRange("TBD")).toBeNull();
    expect(parsePct("~18%")).toBe(0.18);
    expect(parsePct("50% aggregate")).toBe(0.5);
    expect(parsePct("No artificial maximum")).toBeNull();
  });

  it("reads bucket and company limits from the revised policy", () => {
    const p = readPolicy("v2", {
      target_allocation_policies: { latest_approved_v2_revised: [{ bucket: "U.S. broad-market equity", normal: "25-40%", hard_max: "50%" }] },
      single_company_frameworks: { latest_approved_v2_revised: {
        generic_established_quality_growth_ladder: { hard_boundary: "~18%" },
        AAA: { normal: "~3-5%", conditional_hard_max: "~10%", action: "Hold" },
        EEE: { normal: "TBD", provisional_research_ceiling: "~6% before full profile" },
      } },
      protected_savings_floor_usd: 10000,
    });
    expect(p.buckets[0]).toEqual({ bucket: "US broad-market equity", normal: { low: 0.25, high: 0.4 }, hardMax: 0.5 });
    expect(companyMax(p, "AAA")).toBe(0.1);
    expect(companyMax(p, "EEE")).toBe(0.06);
    expect(companyMax(p, "ZZZ")).toBe(0.18);
    expect(p.protectedSavingsFloor).toBe(10000);
  });
});
