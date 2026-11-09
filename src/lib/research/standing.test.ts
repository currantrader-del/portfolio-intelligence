import { describe, expect, it } from "vitest";
import { researchStanding } from "./standing";
import { toResearchRecord, type VersionRow } from "./records";

// The NVDA records on file on 2026-11-08 (ids shortened).
const nov7: VersionRow = { id: "c00b7fe1", research_as_of: "2026-11-07", created_at: "2026-11-07T08:43:07Z", completeness: "complete", origin: "claude_full", is_current: true, conclusion: { action: "Hold / no add (trim above ~$260)", not_verified: ["a", "b", "c", "d", "e", "f", "g"] } };
const stalled: VersionRow = { id: "dab42de6", research_as_of: "2026-11-08", created_at: "2026-11-08T17:57:37Z", completeness: "in_progress", origin: "claude_full", is_current: false, conclusion: { research_type: "full_investigation", review_state: "running" } };
const inv: VersionRow = { id: "14856bc6", research_as_of: "2026-11-08", created_at: "2026-11-08T19:42:57Z", completeness: "partial", origin: "claude_full", is_current: false, conclusion: { research_type: "full_investigation", review_state: "awaiting_approval", completion: { complete: false, reasons: ["Q1 unresolvable", "Q2 unresolvable", "No skeptical review"] } } };

describe("research standing (the NVDA page): the deepest completed record is used automatically", () => {
  const s = researchStanding([nov7, stalled, inv]);
  it("uses the finished Nov 8 investigation, not the newer-looking but shallower Nov 7 screen", () => {
    expect(s.inUse?.v.id).toBe("14856bc6");
    expect(s.inUse?.label).toBe("Full investigation, incomplete, open questions remain");
    expect(s.inUse?.authority).toBe("approved_provisional");
    expect(s.authoritative).toBe(true);
    expect(s.inUse?.open).toHaveLength(3);
  });
  it("keeps the screen and the stalled run as history, with nothing pending", () => {
    expect(s.pending).toBeNull();
    expect(s.history.map((v) => v.id).sort()).toEqual(["c00b7fe1", "dab42de6"]);
    expect(s.decisions).toMatch(/has 3 open questions; it supports Hold, No Add and Trim, but no new money until a targeted update resolves them/);
  });
  it("feeds decisions with the investigation and its open questions", () => {
    const r = toResearchRecord("NVDA", "NVIDIA", "watch", [nov7, stalled, inv]);
    expect(r.current?.id).toBe("14856bc6");
    expect(r.approval).toBe("provisional");
    expect(r.authoritative).toBe(true);
    expect(r.pendingReview).toBeNull();
  });
  it("a newer preliminary screen never overrides a completed investigation", () => {
    const laterScreen = { ...nov7, id: "later", research_as_of: "2026-11-09", created_at: "2026-11-09T10:00:00Z" };
    expect(researchStanding([inv, laterScreen]).inUse?.v.id).toBe("14856bc6");
  });
  it("with only the screen, it is preliminary: Hold or No Add, no new money", () => {
    const s2 = researchStanding([nov7, stalled]);
    expect(s2.inUse?.v.id).toBe("c00b7fe1");
    expect(s2.authoritative).toBe(false);
    expect(s2.decisions).toMatch(/^Preliminary research only .* no buy range or new money until a targeted investigation is done/);
  });
  it("an investigation the investor set aside is never used", () => {
    const aside = { ...inv, conclusion: { ...inv.conclusion, review_state: "set_aside" } };
    const r = toResearchRecord("NVDA", null, "watch", [nov7, aside]);
    expect(r.current?.id).toBe("c00b7fe1");
    expect(r.pendingReview).toBeNull();
  });
});

describe("provisional approval turned into full approval", () => {
  const items = ["Material input not reconciled: net_debt. Not bridged to the filings."];
  const base = { id: "13eea72b", research_as_of: "2026-11-08", created_at: "2026-11-08T20:00:00Z", completeness: "complete", origin: "claude_full", is_current: true } as const;
  const provisional: VersionRow = { ...base, conclusion: { research_type: "full_investigation", review_state: "adopted_provisional", adoption: { mode: "provisional", open_items: items } } };
  const full: VersionRow = { ...base, conclusion: { research_type: "full_investigation", review_state: "adopted", adoption: { mode: "full", open_items: [], accepted_open_items: items, promoted_from_provisional: true } } };
  it("is provisional with its open items before", () => {
    const s = researchStanding([provisional]);
    expect(s.inUse?.approval).toBe("provisional");
    expect(s.inUse?.open).toEqual(items);
  });
  it("is approved in full with no open items after, and no longer blocks decisions as provisional", () => {
    const s = researchStanding([full]);
    expect(s.inUse?.approval).toBe("approved");
    expect(s.inUse?.authority).toBe("approved_full");
    expect(s.inUse?.open).toEqual([]);
    expect(toResearchRecord("IREN", "IREN", "held", [full]).approval).toBe("approved");
  });
});
