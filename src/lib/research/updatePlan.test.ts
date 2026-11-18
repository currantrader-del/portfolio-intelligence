import { describe, expect, it } from "vitest";
import { measuredRange, planUpdate, updateAllowed, type Foundation } from "./updatePlan";
import { updateFoundation } from "./standing";
import type { Filing } from "@/lib/market/sec";

const now = new Date("2026-11-20T15:00:00Z");
const iren: Foundation = {
  versionId: "13ee", asOf: "2026-11-08", label: "Nov 8, awaiting your approval", complete: true, isInvestigation: true, referencePrice: 21.64, terminalDate: "2029-06-30",
  scenarios: { bear: 2, base: 16.21, bull: 57.5, pBear: 0.37, pBase: 0.45, pBull: 0.18 }, reviewedAccessions: [],
};
const filing = (over: Partial<Filing>): Filing => ({ form: "8-K", filed: "2026-11-15", reportDate: null, description: "Current report", items: [], isEarnings: false, url: "u", category: "material_event", note: "", ...over });

describe("Update research: pay only to read what is new", () => {
  it("a price move alone needs no AI: the saved scenarios are re-priced for free", () => {
    const p = planUpdate({ foundation: iren, filings: [filing({ filed: "2026-11-05", form: "10-Q", category: "periodic" })], price: 25, now });
    expect(p.recommend).toBe("nothing_new");
    expect(p.summary).toMatch(/No AI is needed/);
    expect(p.reprice).toMatchObject({ weighted: 18.38, outsideRange: false });
    expect(p.reprice!.annualizedNow!).toBeLessThan(p.reprice!.annualizedThen!);
  });

  it("new filings since the research suggest a targeted update with a cost estimate", () => {
    const p = planUpdate({ foundation: iren, filings: [filing({}), filing({ form: "424B5", category: "financing", description: "Prospectus" }), filing({ form: "4", category: "insider" as Filing["category"] })], price: 21, now });
    expect(p.recommend).toBe("update");
    expect(p.newEvidence.map((e) => e.label)).toEqual(["8-K Current report", "424B5 Prospectus"]);
    expect(p.summary).toMatch(/^2 new filings since 2026-11-08\. An update reads only these.*about \$1\.00–\$2\.50/);
  });

  it("a full investigation is recommended only when the foundation is unreliable", () => {
    expect(planUpdate({ foundation: null, filings: [], price: 21, now }).fullReasons[0]).toMatch(/no finished investigation/);
    expect(planUpdate({ foundation: iren, filings: [], price: 70, now }).fullReasons[0]).toMatch(/outside the research's bear-to-bull range \(\$2–\$57\.5\)/);
    expect(planUpdate({ foundation: { ...iren, asOf: "2025-09-01" }, filings: [], price: 21, now }).fullReasons[0]).toMatch(/14 months old/);
    expect(planUpdate({ foundation: { ...iren, complete: false }, filings: [], price: 21, now }).recommend).toBe("full");
  });

  it("estimates come from measured runs once there are some", () => {
    expect(measuredRange([4.96, 3.4, 5.1, 0], { low: 3, high: 6, basis: "estimate" })).toMatchObject({ low: 3.4, high: 5.1, basis: "measured from 3 past runs" });
    expect(measuredRange([4.96], { low: 3, high: 6, basis: "estimate" }).basis).toBe("estimate");
  });
});

describe("what an update builds on", () => {
  const screen = { id: "s", research_as_of: "2026-11-07", created_at: "2026-11-07T08:00:00Z", completeness: "complete", origin: "claude_full", is_current: true, conclusion: { generated_by: "ai-research@2" } };
  const inv = { id: "i", research_as_of: "2026-11-08", created_at: "2026-11-08T21:22:53Z", completeness: "complete", origin: "claude_full", is_current: false, conclusion: { research_type: "full_investigation", review_state: "awaiting_approval" } };
  it("never a quick screen; always the newest finished investigation", () => {
    expect(updateFoundation([screen], now)).toBeNull();
    expect(updateFoundation([screen, inv], now)?.v.id).toBe("i");
    const approved = { ...inv, id: "a", is_current: true, conclusion: { research_type: "full_investigation", review_state: "adopted" } };
    const newer = { ...inv, id: "n", created_at: "2026-11-19T00:00:00Z" };
    expect(updateFoundation([{ ...screen, is_current: false }, approved, newer], now)?.v.id).toBe("n");
  });
});

describe("the server refuses a paid update with nothing new to read", () => {
  it("a price move alone, or filings the research already covers, starts nothing", () => {
    const p = planUpdate({ foundation: iren, filings: [filing({ filed: "2026-11-05", form: "10-Q", category: "periodic" })], price: 25, now });
    expect(updateAllowed(p, true)).toMatchObject({ ok: false, message: expect.stringMatching(/Nothing material has been filed since 2026-11-08.*No paid run was started/) });
  });
  it("filings that could not be checked start nothing", () => {
    const p = planUpdate({ foundation: iren, filings: null, price: 25, now });
    expect(updateAllowed(p, false)).toMatchObject({ ok: false, message: expect.stringMatching(/could not be checked/) });
  });
  it("no foundation starts nothing", () => {
    expect(updateAllowed(planUpdate({ foundation: null, filings: [filing({})], price: 25, now }), true).ok).toBe(false);
  });
  it("a new material filing allows the update", () => {
    expect(updateAllowed(planUpdate({ foundation: iren, filings: [filing({})], price: 21, now }), true)).toEqual({ ok: true });
  });
});
