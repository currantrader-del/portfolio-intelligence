import { describe, expect, it } from "vitest";
import { buildPlan, type Doc } from "./plan";

// Synthetic fixtures only. Real research never lives in the repo.
const doc = (key: string): Doc => ({ key, fileName: `${key}.json`, sha256: "a".repeat(64), byteSize: 1, origin: "chatgpt_export", description: key });
const phases = (n: number, text: (i: number) => string | undefined) =>
  Array.from({ length: n }, (_, i) => ({ phase_number: String(i + 1), checkpoint_text: text(i + 1) }));

describe("import plan", () => {
  it("marks a full original archive complete and current", () => {
    const plan = buildPlan({ docs: [doc("iren_archive")], irenArchive: { research_as_of_date: "2026-09-10", research_phases: phases(6, (i) => `p${i}`) } });
    const v = plan.versions[0];
    expect(v.completeness).toBe("complete");
    expect(v.is_current).toBe(true);
    expect(v.phases.every((p) => p.extraction === "verbatim")).toBe(true);
  });

  it("never marks an archive with a missing phase complete", () => {
    const plan = buildPlan({ docs: [doc("iren_archive")], irenArchive: { research_phases: phases(6, (i) => (i === 3 ? undefined : `p${i}`)) } });
    expect(plan.versions[0].completeness).toBe("partial");
    expect(plan.versions[0].is_current).toBe(false);
  });

  it("labels RDDT reconstructions and keeps it partial", () => {
    const plan = buildPlan({
      docs: [doc("rddt_a"), doc("rddt_b"), doc("rddt_p4"), doc("rddt_p5")],
      rddtArchiveA: { research_phases: phases(6, (i) => (i === 6 ? "restated" : undefined)) },
      rddtArchiveB: { research_phases: phases(6, (i) => `recon ${i}`) },
      rddtPhase4Md: "phase four", rddtPhase5Md: "phase five",
    });
    const v = plan.versions[0];
    expect(v.completeness).toBe("partial");
    const ex = Object.fromEntries(v.phases.map((p) => [p.phase_number, p.extraction]));
    expect(ex).toEqual({ 1: "reconstructed", 2: "reconstructed", 3: "reconstructed", 4: "verbatim", 5: "verbatim", 6: "reconstructed" });
  });

  it("imports GOOGL as history that is not current", () => {
    const plan = buildPlan({ docs: [doc("googl_md")], googlMasterMd: "# GOOGL" });
    expect(plan.versions[0].is_current).toBe(false);
  });

  it("refuses to plan a row without its source document", () => {
    expect(() => buildPlan({ docs: [], googlMasterMd: "# GOOGL" })).toThrow(/Missing source document/);
  });

  it("imports policy limits but not historical balances", () => {
    const plan = buildPlan({ docs: [doc("baseline")], baseline: { account_balances: { x: 1 }, target_allocation_policies: { a: 1 } } });
    expect(plan.policy?.rules).not.toHaveProperty("account_balances");
    expect(plan.policy?.rules.protected_savings_floor_usd).toBe(10000);
  });
});
