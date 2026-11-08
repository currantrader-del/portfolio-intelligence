import { describe, expect, it } from "vitest";
import { computeExposure } from "./engine";
import { checkLimits, PROPOSALS, proposalRows } from "./limits";
import { insights } from "./insights";
import { materialExposures, validateReview } from "./review";
import { REAL_CASH, REAL_HOLDINGS } from "./__fixtures__/portfolio-2026-11-07";

const NOW = new Date("2026-11-08T12:00:00Z");
const rep = computeExposure(REAL_HOLDINGS, REAL_CASH, NOW);
const asRules = (approval: "approved" | "proposed") => PROPOSALS.map((p) => ({ scope: "portfolio" as const, subject: p.subject, approval, normal_low: p.normal?.low ?? null, normal_high: p.normal?.high ?? null, value: p.review, hard_max: p.ceiling }));

describe("exposure limits", () => {
  it("every proposal states a basis for each number and cites a source", () => {
    for (const p of PROPOSALS) {
      expect(p.review).toBeLessThan(p.ceiling);
      if (p.normal) expect(p.normal.high).toBeLessThanOrEqual(p.review);
      expect(p.evidence.review && p.evidence.ceiling).toBeTruthy();
      expect(p.sources.length).toBeGreaterThan(0);
      expect(p.short.length).toBeLessThan(200);
    }
  });

  it("proposal rows are proposed, unapproved, one per subject, and skip subjects already on file", () => {
    const rows = proposalRows([{ scope: "portfolio", subject: PROPOSALS[0].subject, approval: "proposed" }]);
    expect(rows).toHaveLength(PROPOSALS.length - 1);
    for (const r of rows) {
      expect(r).toMatchObject({ scope: "portfolio", approval: "proposed", approved_at: null });
      expect(String(r.approval_note)).toMatch(/^Claude recommends: /);
      expect(String(r.subject)).toMatch(/^exposure:(industry|sector|theme|market):/);
    }
    // A rejected (superseded) proposal does not block sending a new one.
    expect(proposalRows([{ scope: "portfolio", subject: PROPOSALS[0].subject, approval: "superseded" }])).toHaveLength(PROPOSALS.length);
  });

  it("checks the real portfolio against the proposals, on investable capital", () => {
    const checks = checkLimits(rep, asRules("proposed"));
    const semis = checks.find((c) => c.subject.includes("Semiconductors"))!;
    expect(semis.status).toBe("proposed");
    expect(semis.value).toBeGreaterThan(0.2);
    expect(semis.value).toBeLessThan(0.25); // under the 25% review level on identified companies
    expect(semis.upper!).toBeGreaterThan(0.25); // but could be above it counting unassigned fund holdings
    expect(semis.message).toMatch(/up to/);
  });

  it("raises alerts only for approved limits", async () => {
    const { exposureAlerts } = await import("@/lib/workspace-core");
    const tight = asRules("approved").map((r) => ({ ...r, value: 0.01, hard_max: 0.02 }));
    expect(exposureAlerts(checkLimits(rep, tight)).length).toBe(PROPOSALS.length);
    expect(exposureAlerts(checkLimits(rep, tight.map((r) => ({ ...r, approval: "proposed" as const }))))).toHaveLength(0);
  });

  it("never turns room under a limit into a buy, and flags NVIDIA at its limit", () => {
    const list = insights(rep, checkLimits(rep, asRules("proposed")), [{ symbol: "NVDA", direct: 0.148, viaEtfs: 0.028, total: 0.176, max: 0.18, hasLimit: true, headroomDollars: 160 }]);
    expect(list.some((i) => /buy/i.test(i.action))).toBe(false);
    const nv = list.find((i) => i.id === "company-NVDA")!;
    expect(nv.action).toBe("maintain");
    expect(nv.title).toMatch(/don't add/);
    expect(list.find((i) => i.id === "under")?.detail).toMatch(/not a reason to buy/);
  });

  it("picks at most six material exposures for the market analysis", () => {
    const m = materialExposures(rep, checkLimits(rep, asRules("proposed")));
    expect(m.length).toBeGreaterThan(2);
    expect(m.length).toBeLessThanOrEqual(6);
    expect(m.map((x) => x.key)).toContain("Semiconductors & Semiconductor Equipment");
  });

  it("validates the analysis report and lists weaknesses instead of hiding them", () => {
    expect("error" in validateReview(null)).toBe(true);
    const v = validateReview({ headline: "x", exposures: [{ exposure: "Semis", condition: "great", recommendation: "buy", supporting: [], contradicting: [] }], sources: [] });
    if ("error" in v) throw new Error(v.error);
    expect(v.report.exposures[0].condition).toBe("unclear");
    expect(v.report.exposures[0].recommendation).toBe("research"); // "buy" is not an allowed recommendation
    expect(v.problems.join(" ")).toMatch(/no cited evidence/);
    expect(v.problems.join(" ")).toMatch(/No sources/);
  });
});
