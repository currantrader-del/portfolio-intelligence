import { describe, expect, it } from "vitest";
import { toResearchRecord, type FilingCheckInfo } from "./records";
import { coverage, researchDepth, unresolvedFiling } from "./status";

// Synthetic data, shaped like the real records: Claude's Nov 7 research is "complete" with 6-9 open questions each.
const now = new Date("2026-11-08T16:00:00Z");
const conclusion = (notVerified: string[] = []) => ({
  action: "Hold / no add", confidence: "Low", reference_price: 100, reference_date: "2026-11-07", not_verified: notVerified,
  valuation: { terminal_date: "2028-12-31", bear_value: 60, base_value: 130, bull_value: 200, bear_probability: 0.3, base_probability: 0.5, bull_probability: 0.2 },
});
const rec = (o: { origin?: string; completeness?: string; notVerified?: string[]; fc?: FilingCheckInfo | null } = {}) =>
  toResearchRecord("AAA", "AAA Corp", "held", [{ id: "v1", research_as_of: "2026-11-07", completeness: o.completeness ?? "complete", origin: o.origin ?? "claude_full", is_current: true, conclusion: conclusion(o.notVerified) }], undefined, o.fc ?? null);
const fc = (o: Partial<FilingCheckInfo> = {}): FilingCheckInfo => ({ at: "2026-11-08T12:00:00Z", status: "CURRENT", reason: "No material change found in the items checked.", document: { form: "10-Q", filed: "2026-08-01" }, material: [], ...o });

describe("research depth: six AI sections are not verified research", () => {
  it("labels automated research preliminary, with its open questions, even when stored as complete", () => {
    const c = coverage(rec({ notVerified: ["Q4 guidance", "share count after the convert"] }), 101, now, 120);
    expect(c.key).toBe("current"); // still usable for comparison
    expect(c.label).toBe("Preliminary · 2 open");
    expect(c.tone).toBe("warn");
    expect(c.detail).toMatch(/Automated research \(preliminary\): usable for comparison, not verified\. 2 questions it could not verify, e\.g\. Q4 guidance/);
    expect(c.detail).toMatch(/has not checked SEC filings since this research/);
  });
  it("keeps non-automated research with open questions preliminary too", () => {
    expect(researchDepth(rec({ origin: "chatgpt_original", notVerified: ["margin"] }).current!, null).level).toBe("preliminary");
  });
  it("calls research 'filings checked' only when the app's filing check after it found nothing unresolved", () => {
    const d = researchDepth(rec({ origin: "manual", fc: fc() }).current!, fc());
    expect(d.level).toBe("filings_checked");
    expect(coverage(rec({ origin: "manual", fc: fc() }), 100, now, 120).label).toBe("Current");
    expect(researchDepth(rec({ origin: "manual" }).current!, null).level).toBe("company_research");
  });
  it("never claims documents were fully reviewed (nothing records that yet)", () => {
    expect(researchDepth(rec({ origin: "manual", fc: fc() }).current!, fc()).level).not.toBe("documents_reviewed");
  });
});

describe("material filings after the research", () => {
  const newQ = fc({ status: "WAIT / REVIEW", reason: "1 material change since the research period.", document: { form: "10-Q", filed: "2026-11-10" }, material: ["Shares outstanding 300m to 330m: +10.0%"] });
  it("is not current while a material new filing is unresolved", () => {
    const c = coverage(rec({ origin: "manual", fc: newQ }), 100, now, 120);
    expect(c.key).toBe("refresh");
    expect(c.detail).toMatch(/Unresolved new filing: 10-Q filed 2026-11-10, after the research: 1 material change \(Shares outstanding/);
  });
  it("ignores a flagged filing that the research already covered", () => {
    expect(unresolvedFiling("2026-11-12", newQ)).toBeNull();
  });
  it("does not treat a check that only had data gaps on an older filing as a new filing", () => {
    expect(unresolvedFiling("2026-11-07", fc({ status: "WAIT / REVIEW", reason: "Some inputs could not be checked." }))).toBeNull();
  });
});

describe("missing research", () => {
  it("is 'Not researched', never current", () => {
    expect(coverage(toResearchRecord("ZZZ", null, "idea", []), 50, now, 120)).toMatchObject({ key: "none", label: "Not researched" });
  });
});
