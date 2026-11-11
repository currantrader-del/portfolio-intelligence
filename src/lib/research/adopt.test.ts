import { describe, expect, it } from "vitest";
import { autoAdoptMode, openItemsFor } from "./adopt";
import { companyView, marketDayOf, monthYear, valueToday } from "./valueLabels";

const inv = (completeness: string, kind: string, state = "awaiting_approval") => ({ completeness, conclusion: { research_type: "full_investigation", review_state: state, completion: { kind, reasons: kind === "complete" ? [] : ["Key finding F34 is unresolved"] } } });
const quick = { completeness: "complete", conclusion: { action: "Hold" } };

describe("the most recent, complete, most in-depth research is used", () => {
  it("puts a complete investigation in use", () => {
    expect(autoAdoptMode(inv("complete", "complete"), quick)).toBe("full");
    expect(autoAdoptMode(inv("complete", "complete"), inv("complete", "complete", "adopted"))).toBe("full");
  });
  it("puts an investigation open only on an outside event in use over a quick note, with its open items", () => {
    expect(autoAdoptMode(inv("partial", "material_uncertainty"), quick)).toBe("provisional");
    expect(autoAdoptMode(inv("partial", "material_uncertainty"), null)).toBe("provisional");
  });
  it("never lets a partial push out a complete investigation, and never adopts unfinished work", () => {
    expect(autoAdoptMode(inv("partial", "material_uncertainty"), inv("complete", "complete", "adopted"))).toBeNull();
    expect(autoAdoptMode(inv("partial", "work_incomplete"), quick)).toBeNull();
    expect(autoAdoptMode(inv("complete", "complete", "running"), quick)).toBeNull();
  });
  it("lists the record's own open items plus failed checks when in use with open items", () => {
    const c = inv("partial", "material_uncertainty").conclusion;
    expect(openItemsFor(c, { checks: [{ status: "warn", label: "Sensitivity", detail: "straddles price" }, { status: "pass", label: "x", detail: "y" }] } as never, "provisional"))
      .toEqual(["Key finding F34 is unresolved", "Sensitivity: straddles price"]);
    expect(openItemsFor({}, null, "provisional")).toHaveLength(1);
    expect(openItemsFor(inv("complete", "complete").conclusion, null, "full")).toEqual([]);
  });
});

describe("valuation labels", () => {
  it("calls a weighted value a future price and discounts it to today", () => {
    expect(monthYear("2029-12-31")).toBe("Dec 2029");
    const now = new Date("2026-12-31T00:00:00Z");
    expect(valueToday(110.6, "2029-12-31", now, 0.075)).toBeCloseTo(110.6 / Math.pow(1.075, 3), 0);
    expect(valueToday(100, "2026-12-31", now, 0.075)).toBe(100);
  });
  it("puts a weekend research date on the last close before it", () => {
    expect(marketDayOf("2026-11-08")).toEqual({ date: "2026-11-06", moved: true });
    expect(marketDayOf("2026-11-07")).toEqual({ date: "2026-11-06", moved: true });
    expect(marketDayOf("2026-11-10")).toEqual({ date: "2026-11-10", moved: false });
  });
  it("answers the company question from the valuation judgment alone", () => {
    expect(companyView("favourable")).toBe("Attractive at this price");
    expect(companyView("mixed")).toBe("Fairly priced");
    expect(companyView("unfavourable")).toBe("Not attractive at this price");
    expect(companyView(null)).toBeNull();
  });
});
