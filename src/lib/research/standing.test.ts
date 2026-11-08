import { describe, expect, it } from "vitest";
import { researchStanding } from "./standing";
import { toResearchRecord, type VersionRow } from "./records";

// The NVDA records on file on 2026-11-08 (ids shortened).
const nov7: VersionRow = { id: "c00b7fe1", research_as_of: "2026-11-07", created_at: "2026-11-07T08:43:07Z", completeness: "complete", origin: "claude_full", is_current: true, conclusion: { action: "Hold / no add (trim above ~$260)", not_verified: ["a", "b", "c", "d", "e", "f", "g"] } };
const stalled: VersionRow = { id: "dab42de6", research_as_of: "2026-11-08", created_at: "2026-11-08T17:57:37Z", completeness: "in_progress", origin: "claude_full", is_current: false, conclusion: { research_type: "full_investigation", review_state: "running" } };
const inv: VersionRow = { id: "14856bc6", research_as_of: "2026-11-08", created_at: "2026-11-08T19:42:57Z", completeness: "partial", origin: "claude_full", is_current: false, conclusion: { research_type: "full_investigation", review_state: "awaiting_approval", completion: { complete: false, reasons: ["Q1 unresolvable", "Q2 unresolvable", "No skeptical review"] } } };

describe("research standing (the NVDA page)", () => {
  const s = researchStanding([nov7, stalled, inv]);
  it("says the Nov 7 record is in use but preliminary and never approved, not 'current and complete'", () => {
    expect(s.inUse?.v.id).toBe("c00b7fe1");
    expect(s.inUse?.label).toBe("Preliminary (automated AI research), set automatically, not approved by you");
    expect(s.inUse?.open).toHaveLength(7);
  });
  it("shows the newest investigation as waiting for a decision, with its open items, and the stalled run as history", () => {
    expect(s.pending).toMatchObject({ state: "awaiting_approval", complete: false });
    expect(s.pending?.v.id).toBe("14856bc6");
    expect(s.pending?.open).toHaveLength(3);
    expect(s.history.map((v) => v.id)).toEqual(["dab42de6"]);
    expect(s.decisions).toMatch(/waiting for your decision/);
  });
  it("feeds decisions: the record in use is flagged and the pending investigation blocks new money", () => {
    const r = toResearchRecord("NVDA", "NVIDIA", "watch", [nov7, stalled, inv]);
    expect(r.current?.id).toBe("c00b7fe1");
    expect(r.approval).toBe("automatic");
    expect(r.pendingReview).toEqual({ id: "14856bc6", research_as_of: "2026-11-08", complete: false });
  });
  it("after a provisional approval: the investigation is in use, provisional, with its open items; Nov 7 becomes history", () => {
    const adopted = { ...inv, is_current: true, conclusion: { ...inv.conclusion, review_state: "adopted_provisional" } };
    const s2 = researchStanding([{ ...nov7, is_current: false }, stalled, adopted]);
    expect(s2.inUse?.label).toBe("Full investigation, incomplete, approved provisionally by you");
    expect(s2.pending).toBeNull();
    expect(s2.decisions).toMatch(/approved provisionally with 3 open items; no new money/);
    expect(toResearchRecord("NVDA", null, "watch", [{ ...nov7, is_current: false }, adopted]).approval).toBe("provisional");
  });
  it("after setting it aside: nothing is pending and the record stays out of decisions", () => {
    const aside = { ...inv, conclusion: { ...inv.conclusion, review_state: "set_aside" } };
    const r = toResearchRecord("NVDA", null, "watch", [nov7, aside]);
    expect(r.pendingReview).toBeNull();
    expect(r.latest?.id).toBe("c00b7fe1");
  });
});
