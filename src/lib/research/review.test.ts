import { describe, expect, it } from "vitest";
import { applyReview, inputRows, provisionalItems, withReviews } from "./review";
import { IREN_NOV8_REVIEW } from "./__fixtures__/irenNov8Review";
import { IREN_NOV8_SPECS } from "./__fixtures__/irenNov8";

const ACTION = "Trim to about 3.0% (sell about 10 shares, about $216) now; hold the remaining ~54 shares through the Jan-Feb 2027 ARR test; no add.";
const conclusion = () => ({
  action: ACTION,
  investment_summary: {
    action: ACTION,
    headline: "Trim the IREN position to the 3% floor (sell about 10 of 64 shares) and do not add. After the review, the weighted value is $18.38.",
    valuation: "Base: revenue $7.5B, 62% EBITDA margin, 7x, net debt $22.5B, 620M shares.",
    reasons: ["Net debt is a large share of enterprise value.", "Capex was cut because of funding conditions (F46), so the second $4B of ARR is uncontracted and financing-paced; only $1.84B is fixed."],
    risks: ["Microsoft concentration."],
  },
  evidence: { findings: [{ id: "F43", claim: "Roberts attributed the FY27 capex cut to financial markets", check: { status: "quote_not_found" } }, { id: "F46", claim: "Remaining FY27 capex of about $15B has been cut, which Roberts attributed to financial markets", check: { status: "verified" } }, { id: "F10", claim: "Net debt $4.43B" }] },
});

describe("reviewer corrections over a saved investigation", () => {
  it("keeps the trim conditional and the original action on file", () => {
    const c = applyReview(conclusion(), IREN_NOV8_REVIEW);
    expect(c.action).toMatch(/^Conditional, not a trade instruction/);
    expect((c.investment_summary as { action: string }).action).toBe(c.action);
    expect(c.review_original).toEqual({ action: ACTION });
    expect((c.investment_summary as { headline: string }).headline).toMatch(/^Conditional: a trim/);
  });

  it("replaces the unsupported capex reason and flags net debt in the valuation text", () => {
    const sm = applyReview(conclusion(), IREN_NOV8_REVIEW).investment_summary as { reasons: string[]; valuation: string };
    expect(sm.reasons[1]).not.toMatch(/because of funding conditions/);
    expect(sm.reasons[1]).toMatch(/not confirmed by a checked quote/);
    expect(sm.reasons[1]).toMatch(/only \$1\.84B is fixed/);
    expect(sm.valuation).toMatch(/net debt \$22\.5B \(material model estimate, not reconciled/);
  });

  it("withdraws F43 and restates F46, keeping the original claim", () => {
    const f = (applyReview(conclusion(), IREN_NOV8_REVIEW).evidence as { findings: Record<string, unknown>[] }).findings;
    expect(f[0].withdrawn).toMatchObject({ reason: expect.stringMatching(/not found in the earnings-call transcript/) });
    expect(f[1].claim).toMatch(/not confirmed by a checked quote/);
    expect(f[1].claim_original).toMatch(/attributed to financial markets/);
    expect(f[2].withdrawn).toBeUndefined();
  });

  it("does not change the stored conclusion object", () => {
    const orig = conclusion();
    const copy = JSON.parse(JSON.stringify(orig));
    applyReview(orig, IREN_NOV8_REVIEW);
    expect(orig).toEqual(copy);
  });

  it("applies only to the version it was written for", () => {
    const out = withReviews([{ id: "a", conclusion: conclusion() }, { id: "b", conclusion: conclusion() }], new Map([["a", IREN_NOV8_REVIEW]]));
    expect((out[0].conclusion as { action: string }).action).toMatch(/^Conditional/);
    expect((out[1].conclusion as { action: string }).action).toBe(ACTION);
  });

  it("marks every IREN valuation input as a model estimate and net debt as material in each scenario", () => {
    const rows = inputRows(IREN_NOV8_SPECS, IREN_NOV8_REVIEW);
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => r.kind === "estimate")).toBe(true);
    const nd = rows.filter((r) => r.input === "net_debt");
    expect(nd.map((r) => r.value)).toEqual([21e9, 22.5e9, 34e9]);
    expect(nd.every((r) => r.material?.includes("not reconciled"))).toBe(true);
    expect(rows.filter((r) => r.material).length).toBe(3);
    expect(rows.find((r) => r.input === "net_debt" && r.scenario === "bear")?.cites).toContain("F10");
  });

  it("tells a sourced input from an estimate", () => {
    const rows = inputRows([{ name: "base", probability: 1, method: "ev_ebitda", inputs: { revenue: 1, multiple: 2 }, sources: { revenue: "F5", multiple: "estimate: peers" } }]);
    expect(rows.map((r) => r.kind)).toEqual(["sourced", "estimate"]);
  });

  it("lists the reviewer caveats as open items for a provisional approval", () => {
    const items = provisionalItems({ checks: [{ status: "pass", label: "Arithmetic", detail: "exact" }, { status: "warn", label: "Net debt bridge", detail: "unbridged" }], annotations: IREN_NOV8_REVIEW });
    expect(items[0]).toMatch(/^Material input not reconciled: net_debt/);
    expect(items.some((x) => x.startsWith("Finding F43 withdrawn"))).toBe(true);
    expect(items).toContain("Net debt bridge: unbridged");
    expect(items.some((x) => x.startsWith("Arithmetic"))).toBe(false);
  });
});
