/**
 * The skeptical review, the classification of unverified figures and the completion rules, tested on
 * the tools the models call: what is refused, what is accepted, and what keeps a record incomplete.
 */
import { describe, expect, it } from "vitest";
import { computeValuation } from "./valuationCalc";
import { finalGate, phaseGate } from "./gates";
import { makeExec } from "./tools";
import { emptyUsage, type Finding, type Objection, type RunState } from "./types";
import { NVDA_RUN, NVDA_SPECS } from "./__fixtures__/nvda-2026-11-08";

const f = (id: string, over: Partial<Finding> = {}): Finding => ({ id, phase: 2, claim: `claim ${id}`, value: "1", unit: "", period: "", doc_id: "D1", quote: "q", source: "primary", key: true, check: { status: "verified", detail: "" }, ...over });
const valuation = { specs: NVDA_SPECS, horizon_date: NVDA_RUN.horizon, result: computeValuation({ scenarios: NVDA_SPECS, horizon_date: NVDA_RUN.horizon, price: NVDA_RUN.price, today: NVDA_RUN.today }), revenue_basis: "FY29" };
const summary = {
  headline: "Hold, add nothing.", business_quality: { rating: "High", why: "" }, valuation: "Weighted value $268.55 per share.", expected_return: "About 18.5% a year.", risks: [], portfolio_fit: "", action: "Hold / no add",
  confidence: "Moderate" as const, would_change: [], reasons: ["r"], classification: "", thesis: "", price_framework: [], allocation: { target_pct: 15, max_pct: 18, note: "" }, changes_vs_prior: "",
};
const state = (over: Partial<RunState> = {}): RunState => ({
  version: "t", type: "full_investigation", symbol: "NVDA", name: null, cik: null, today: NVDA_RUN.today, requestId: "r", versionId: null, base: null, steps: [], next: 0, attemptsAtStep: 0, seq: 0, startedAt: "", status: "running",
  price: { value: NVDA_RUN.price, asOf: null, source: null }, financials: null, inventory: [], reviews: [], findings: Array.from({ length: 8 }, (_, i) => f(`F${i + 1}`)), questions: [], conflicts: [],
  phases: [1, 2, 3, 4, 5, 6].map((n) => ({ n, title: `P${n}`, status: "complete", attempts: 1, summary: "x", key_points: [], gate: [], usage: emptyUsage() })), valuation, objections: [], summary: null, completeness: null, usage: emptyUsage(), log: [], ...over,
});
const tools = (s: RunState, phase = 0) => { const done = { value: false }; return { done, exec: makeExec({ state: s, phase, db: null as never, ws: null, done }) }; };
const objection = (area: string, test_kind = "document") => ({ area, claim: "The base multiple of 17x", objection: "Not anchored", test_kind, test: "Compared with the five-year trailing range in D2", test_result: "The range was 25-60x; 17x is below it, so this is conservative", severity: "minor", finding_ids: ["F1"], evidence_to_check: "history" });

describe("the skeptical review", () => {
  it("refuses an objection without a real test, and a stress-test objection before any stress test", async () => {
    const s = state(); const { exec } = tools(s);
    expect(await exec("record_objection", { ...objection("thesis"), test: "thought", test_result: "seems weak" })).toMatchObject({ error: expect.stringMatching(/untested objection/) });
    expect(await exec("record_objection", objection("valuation_assumptions", "stress_test"))).toMatchObject({ error: "Run stress_test first" });
    expect(await exec("record_objection", { ...objection("thesis"), finding_ids: ["F99"] })).toMatchObject({ error: "Unknown finding ids: F99" });
    expect(s.objections).toHaveLength(0);
  });
  it("computes the skeptic's stress test with the app, not the model", async () => {
    const s = state(); const { exec } = tools(s);
    const r = await exec("stress_test", { label: "base multiple 14x", changes: [{ scenario: "base", input: "multiple", set: 14 }] }) as { weighted_value: number };
    expect(r.weighted_value).toBeCloseTo(268.55 - 0.5 * 290.33 * (3 / 17), 0);
    expect(s.stress![0].label).toBe("Skeptic: base multiple 14x");
  });
  it("will not finish until every area has a tested challenge, three are tested against documents or numbers, and one is a stress test", async () => {
    const s = state(); const { exec, done } = tools(s);
    await exec("record_objection", objection("thesis"));
    const r1 = await exec("finish_review", { thesis: "survives", valuation: "survives", recommendation: "survives", summary: "ok", required_changes: [] }) as { missing: string[] };
    expect(r1.missing.join(" ")).toMatch(/valuation assumptions/);
    expect(r1.missing.join(" ")).toMatch(/stress_test/);
    await exec("stress_test", { label: "multiples -20%", changes: [{ scenario: "all", input: "multiple", multiply: 0.8 }] });
    for (const a of ["valuation_assumptions", "probabilities"]) await exec("record_objection", objection(a, "stress_test"));
    for (const a of ["projections", "competition", "portfolio_recommendation"]) await exec("record_objection", objection(a, "record"));
    expect(await exec("finish_review", { thesis: "survives", valuation: "survives_with_changes", recommendation: "survives", summary: "Multiple compression is the main risk.", required_changes: ["State the 20% derating case"] })).toEqual({ accepted: true });
    expect(done.value).toBe(true);
    expect(s.review?.valuation).toBe("survives_with_changes");
  });
  it("requires evidence for answering a critical or major objection", async () => {
    const o: Objection = { id: "S1", severity: "critical", objection: "x", evidence_to_check: "" };
    const s = state({ objections: [o] }); const { exec } = tools(s, 6);
    expect(await exec("respond_objection", { id: "S1", response: "I disagree.", outcome: "rebutted" })).toMatchObject({ error: expect.stringMatching(/with evidence/) });
    await exec("respond_objection", { id: "S1", response: "F3 shows the backlog; D2 confirms it.", outcome: "rebutted" });
    expect(o.response_evidence).toEqual(["F3", "D2"]);
  });
  it("requires the conclusion to be revisited when the review requires changes", async () => {
    const s = state({ summary, summaryAt: "2026-11-08T10:00:00Z", review: { thesis: "survives", valuation: "survives_with_changes", recommendation: "survives", summary: "", required_changes: ["x"], at: "2026-11-08T11:00:00Z" },
      objections: [{ id: "S1", severity: "major", objection: "x", evidence_to_check: "", outcome: "accepted", response: "F1", response_evidence: ["F1"] }] });
    const { exec } = tools(s, 6);
    const account = "The thesis survived; the valuation was cut for multiple compression (S1). ".repeat(3);
    expect((await exec("finish_answers", { account }) as { missing: string[] }).missing.join(" ")).toMatch(/submit the summary again/);
    await exec("submit_summary", summary);
    expect(await exec("finish_answers", { account })).toEqual({ accepted: true });
  });
});

describe("classifying unverified key figures", () => {
  it("needs a primary finding to call a figure verified, and an explanation of its effect", async () => {
    const s = state({ findings: [f("F1"), f("F2", { source: "secondary", check: { status: "secondary_unverifiable", detail: "" } })] }); const { exec } = tools(s, 6);
    expect(await exec("classify_finding", { id: "F2", cls: "verified_primary", explanation: "Found in the release", impact: "None at all here", replaced_by: "" })).toMatchObject({ error: expect.stringMatching(/replaced_by/) });
    expect(await exec("classify_finding", { id: "F2", cls: "labeled_estimate", explanation: "short", impact: "short", replaced_by: "" })).toMatchObject({ error: expect.any(String) });
    expect(await exec("classify_finding", { id: "F2", cls: "verified_primary", explanation: "The 8-K states the same date", impact: "Confirms the catalyst date", replaced_by: "F1" })).toMatchObject({ ok: true, still_to_classify: [] });
  });
});

describe("what a complete investigation needs", () => {
  const done = (over: Partial<RunState> = {}) => state({
    summary, summaryAt: "2026-11-08T12:00:00Z",
    review: { thesis: "survives", valuation: "survives", recommendation: "survives", summary: "", required_changes: [], at: "2026-11-08T11:00:00Z" },
    objections: [{ id: "S1", severity: "minor", objection: "x", evidence_to_check: "", outcome: "rebutted", response: "fine" }],
    consistency: { ok: true, issues: [], checks: [] }, ...over,
  });
  it("is complete when the work and evidence rules are met", () => {
    expect(finalGate(done())).toEqual({ complete: true, reasons: [], kind: "complete" });
  });
  it("is not complete just because every step ran: too little primary evidence", () => {
    const g = finalGate(done({ findings: [f("F1"), f("F2")] }));
    expect(g.kind).toBe("work_incomplete");
    expect(g.reasons.join(" ")).toMatch(/Only 2 key figures are verified/);
  });
  it("names an unclassified estimate, and separates a thesis-changing unknown as material uncertainty", () => {
    const sec = f("F9", { source: "secondary", check: { status: "secondary_unverifiable", detail: "" } });
    expect(finalGate(done({ findings: [...state().findings, sec] })).reasons.join(" ")).toMatch(/F9 is not verified .* not classified/);
    sec.classification = { cls: "unresolved_thesis_changing", explanation: "x", impact: "could reverse the thesis" };
    const g = finalGate(done({ findings: [...state().findings, sec] }));
    expect(g.kind).toBe("material_uncertainty");
    expect(g.reasons[0]).toMatch(/F9 is unresolved and could change the thesis/);
  });
  it("flags a required document nobody cites, and a major objection answered without evidence", () => {
    const d = { id: "D7", kind: "10-Q" as const, title: "10-Q", url: "u", required: true, phases: [2], why: "", origin: "sec" as const, status: "retrieved" as const, fetched: { chars: 1, sha256: "", at: "", contentType: "" }, sections: [{ key: "full", label: "", chars: 1, material: true, parts: 1, reviewedParts: [0] }] };
    const g = finalGate(done({ inventory: [d], objections: [{ id: "S1", severity: "major", objection: "x", evidence_to_check: "", outcome: "rebutted", response: "no" }] }));
    expect(g.reasons.join(" ")).toMatch(/D7 10-Q was read but nothing in the research cites it/);
    expect(g.reasons.join(" ")).toMatch(/S1 \(major\) was answered without evidence/);
  });
  it("is incomplete when the written conclusion contradicts the numbers", () => {
    expect(finalGate(done({ consistency: { ok: false, issues: ["Summary states the app's weighted value: no"], checks: [] } })).reasons.join(" ")).toMatch(/Consistency/);
  });
});

describe("a phase has to use what it read", () => {
  it("asks the analyst to cite a required document it read in full, and accepts a mention in the summary", () => {
    const d = { id: "D11", kind: "material_8k" as const, title: "8-K director change", url: "u", required: true, phases: [3], why: "", origin: "sec" as const, status: "retrieved" as const, fetched: { chars: 1, sha256: "", at: "", contentType: "" }, sections: [{ key: "full", label: "", chars: 1, material: true, parts: 1, reviewedParts: [0] }] };
    const s = state({ inventory: [d], findings: [] });
    expect(phaseGate(s, 3, "y".repeat(500)).join(" ")).toMatch(/D11 8-K director change was read but nothing cites it/);
    expect(phaseGate(s, 3, `${"y".repeat(500)} D11 is a routine director change with no effect.`).join(" ")).not.toMatch(/D11/);
  });
});
