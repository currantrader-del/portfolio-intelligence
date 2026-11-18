import { describe, expect, it, vi } from "vitest";
import { planUpdate, type Foundation } from "./updatePlan";
import { researchVerdict } from "./verdict";
import type { Filing } from "@/lib/market/sec";

vi.mock("@/lib/market/sec", () => ({ getFilings: vi.fn() }));

const now = new Date("2026-11-12T15:00:00Z");
// A full investigation that finished all its phases with one material question open (the NVDA shape of Nov 10).
const nvda: Foundation = {
  versionId: "1f7c", asOf: "2026-11-10", label: "Nov 10, in use", complete: true, isInvestigation: true, referencePrice: 166.8, terminalDate: "2029-06-30",
  scenarios: { bear: 86.32, base: 193.59, bull: 289.55, pBear: 0.3, pBase: 0.5, pBull: 0.2 }, reviewedAccessions: [],
};
const inUse = { asOf: "2026-11-10", isInvestigation: true, open: ["CEO probe unresolved", "a", "b"], label: "Full investigation, finished" };
const k8 = (over: Partial<Filing> = {}): Filing => ({ form: "8-K", filed: "2026-11-12", reportDate: null, description: "Current report", items: ["5.02"], isEarnings: false, url: "u", category: "material_event", note: "", ...over });

describe("Research page: one answer, one next step", () => {
  it("researched with open questions + a new filing after a fall -> reassess with a targeted update, never 'full because not completed'", () => {
    const plan = planUpdate({ foundation: nvda, filings: [k8()], price: 148, now });
    expect(plan.recommend).toBe("update");
    expect(plan.fullReasons).toEqual([]);
    const v = researchVerdict({ inUse, plan, zoneChange: null });
    expect(v.researched).toBe(true);
    expect(v.headline).toBe("Researched: full investigation of Nov 10, all phases finished, 3 questions left open");
    expect(v.next.kind).toBe("update");
    expect(v.next.text).toMatch(/^Reassess: 8-K Current report filed Nov 12\. A targeted update reads only what is new and works on the open questions/);
    expect(v.next.text).not.toMatch(/not completed|never completed|full investigation/i);
  });

  it("open questions alone do not call for a full rerun; nothing new filed -> no AI", () => {
    const plan = planUpdate({ foundation: nvda, filings: [], price: 148, now });
    const v = researchVerdict({ inUse, plan, zoneChange: null });
    expect(v.next.kind).toBe("none");
    expect(v.next.text).toMatch(/No reassessment needed/);
  });

  it("a run that stopped part-way is the only completeness reason for a full rerun", () => {
    const plan = planUpdate({ foundation: { ...nvda, complete: false }, filings: [k8()], price: 148, now });
    const v = researchVerdict({ inUse, plan, zoneChange: null });
    expect(v.next.kind).toBe("full");
    expect(v.next.text).toMatch(/stopped before finishing its phases/);
  });

  it("filings that could not be checked never start a paid run", () => {
    const plan = planUpdate({ foundation: nvda, filings: null, price: 148, now });
    expect(researchVerdict({ inUse, plan, zoneChange: null }).next.kind).toBe("unknown");
  });
});
