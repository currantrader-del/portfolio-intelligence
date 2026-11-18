import { describe, expect, it } from "vitest";
import { checkQuote, parseFilingIndex, partsOf, splitSections } from "./text";
import { computeValuation, type ScenarioSpec } from "./valuationCalc";
import { docStatus, finalGate, phaseGate } from "./gates";
import { buildFinancials } from "./financials";
import { usableVersion, toResearchRecord } from "../records";
import { emptyUsage, type Finding, type InvDoc, type RunState } from "./types";
import { nextId } from "./tools";
import { isStalled, repairIds } from "./run";

const filler = (n: number) => "lorem ipsum dolor sit amet ".repeat(n);

describe("splitSections", () => {
  it("takes the real item, not the table of contents, in a 10-K", () => {
    const toc = "PART I Item 1. Business 4 Item 1A. Risk Factors 12 Item 7. Management's Discussion 40 Item 8. Financial Statements 60 ";
    const body = `PART I Item 1. Business ${filler(200)} Item 1A. Risk Factors ${filler(300)} Item 7. Management's Discussion ${filler(250)} Item 7A. Quantitative ${filler(20)} Item 8. Financial Statements ${filler(400)} Item 9. Changes ${filler(5)}`;
    const secs = splitSections(toc + body, "10-K");
    const s1a = secs.find((s) => s.key === "1A")!;
    expect(s1a.end - s1a.start).toBeGreaterThan(300 * 20);
    expect(secs.find((s) => s.key === "8")!.material).toBe(true);
    expect(secs.find((s) => s.key === "9")!.material).toBe(false);
  });
  it("labels 10-Q items by part", () => {
    const t = `PART I Item 1. Financial Statements ${filler(300)} Item 2. Management's Discussion ${filler(200)} PART II Item 1. Legal Proceedings ${filler(10)} Item 1A. Risk Factors ${filler(50)} Item 6. Exhibits ${filler(3)}`;
    const keys = splitSections(t, "10-Q").map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["I-1", "I-2", "II-1", "II-1A", "II-6"]));
  });
  it("keeps a press release as one section", () => {
    expect(splitSections(filler(10), "8-K")).toEqual([{ key: "full", label: "Full document", start: 0, end: filler(10).length, material: true }]);
  });
  it("splits long sections into parts", () => {
    expect(partsOf(600_000).length).toBe(3);
    expect(partsOf(10).length).toBe(1);
  });
});

describe("parseFilingIndex", () => {
  it("reads documents and their types", () => {
    const html = `<table class="tableFile" summary="Document Format Files"><tr><th>Seq</th></tr>
      <tr><td>1</td><td>8-K</td><td><a href="/Archives/edgar/data/1045810/000104581026000073/nvda-20260826.htm">nvda-20260826.htm</a></td><td>8-K</td><td>30 KB</td></tr>
      <tr><td>2</td><td>PRESS RELEASE</td><td><a href="/Archives/edgar/data/1045810/000104581026000073/q2fy27pr.htm">q2fy27pr.htm</a></td><td>EX-99.1</td><td>200 KB</td></tr></table>`;
    const rows = parseFilingIndex(html, "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000073/0001045810-26-000073-index.htm");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ type: "EX-99.1", url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000073/q2fy27pr.htm" });
  });
});

describe("checkQuote", () => {
  const doc = "Revenue for the second quarter was $46,743 million, up 56% from a year ago. Data Center revenue was $41.1 billion.";
  it("verifies a quote and its figure", () => expect(checkQuote(doc, "Revenue for the second quarter was $46,743 million", "46,743").status).toBe("verified"));
  it("accepts a figure restated at another scale", () => expect(checkQuote(doc, "Data Center revenue was $41.1 billion", "41,100").status).toBe("verified"));
  it("tolerates curly quotes and spacing", () => expect(checkQuote(doc, "Revenue   for the second quarter was $ 46,743 million", "46743").status).toBe("verified"));
  it("rejects a figure the quote does not contain", () => expect(checkQuote(doc, "Revenue for the second quarter was $46,743 million", "48,000").status).toBe("quote_found_value_not_in_quote"));
  it("rejects a paraphrase", () => expect(checkQuote(doc, "Second-quarter revenue reached $46.7 billion", "46.7").status).toBe("quote_not_found"));
  it("accepts an ellipsis between exact pieces", () => expect(checkQuote(doc, "Revenue for the second quarter ... up 56% from a year ago", "56%").status).toBe("verified"));
});

const spec = (name: "bear" | "base" | "bull", p: number, margin: number, mult: number): ScenarioSpec => ({
  name, probability: p, method: "pe", inputs: { revenue: 700e9, operating_margin: margin, tax_rate: 0.17, diluted_shares: 24e9, multiple: mult },
  sources: { revenue: "estimate: x", operating_margin: "F1", tax_rate: "F2", diluted_shares: "F3", multiple: "estimate: y" }, rationale: "because",
});

describe("computeValuation", () => {
  it("recomputes the NVIDIA base case from its stated inputs", () => {
    const r = computeValuation({ scenarios: [spec("bear", 0.3, 0.4, 14), spec("base", 0.5, 0.62, 18), spec("bull", 0.2, 0.64, 22)], horizon_date: "2028-12-31", price: 186.64, today: "2026-11-07" });
    expect(r.ok).toBe(true);
    // 700B x 62% x (1 - 17%) / 24B = $15.01 EPS; x 18 = $270.2 (the old report stated $276).
    expect(r.scenarios.find((s) => s.name === "base")!.value_per_share).toBeCloseTo(270.2, 0);
    expect(r.weighted_value).toBeGreaterThan(0);
    expect(r.annualized_return).not.toBeNull();
  });
  it("rejects probabilities that do not sum to 1, wrong units and unsourced inputs", () => {
    const bad = spec("bull", 0.3, 0.64, 22);
    bad.sources = {};
    const r = computeValuation({ scenarios: [spec("bear", 0.3, 0.4, 14), { ...spec("base", 0.5, 0.62, 18), inputs: { ...spec("base", 0.5, 0.62, 18).inputs, diluted_shares: 24000 } }, bad], horizon_date: "2028-12-31", price: 100, today: "2026-11-07" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/add up to 1.100/);
    expect(r.errors.join(" ")).toMatch(/shares look wrong/);
    expect(r.errors.join(" ")).toMatch(/no source/);
  });
  it("applies an explicit floor and computes EV-based values", () => {
    const ev: ScenarioSpec = { name: "bear", probability: 0.35, method: "ev_ebitda", inputs: { revenue: 3e9, ebitda_margin: 0.5, multiple: 6, net_debt: 14e9, diluted_shares: 520e6 }, sources: { revenue: "e", ebitda_margin: "e", multiple: "e", net_debt: "e", diluted_shares: "e" }, rationale: "r", floor_value: 4 };
    const r = computeValuation({ scenarios: [ev, { ...ev, name: "base", probability: 0.45, floor_value: null, inputs: { ...ev.inputs, revenue: 7e9, ebitda_margin: 0.6, multiple: 8, net_debt: 15e9, diluted_shares: 560e6 } }, { ...ev, name: "bull", probability: 0.2, floor_value: null, inputs: { ...ev.inputs, revenue: 12e9, ebitda_margin: 0.65, multiple: 9, net_debt: 22e9, diluted_shares: 600e6 } }], horizon_date: "2030-06-30", price: 21.64, today: "2026-11-07" });
    const bear = r.scenarios.find((s) => s.name === "bear")!;
    expect(bear.computed_value).toBeLessThan(0);
    expect(bear.floored).toBe(true);
    expect(bear.value_per_share).toBe(4);
    expect(r.scenarios.find((s) => s.name === "base")!.value_per_share).toBeCloseTo(33.21, 1);
  });
});

const doc = (over: Partial<InvDoc>): InvDoc => ({ id: "D1", kind: "10-Q", title: "10-Q", url: "u", required: true, phases: [2], why: "", origin: "sec", status: "retrieved", fetched: { chars: 10, sha256: "x", at: "", contentType: "" }, sections: [{ key: "I-1", label: "Item 1", chars: 10, material: true, parts: 2, reviewedParts: [0] }, { key: "II-6", label: "Exhibits", chars: 2, material: false, parts: 1, reviewedParts: [] }], ...over });
const state = (over: Partial<RunState>): RunState => ({
  version: "t", type: "full_investigation", symbol: "X", name: null, cik: null, today: "2026-11-08", requestId: "r", versionId: null, base: null, steps: [], next: 0, attemptsAtStep: 0, seq: 0, startedAt: "", status: "running",
  price: { value: 10, asOf: null, source: null }, financials: null, inventory: [], reviews: [], findings: [], questions: [], conflicts: [],
  phases: [1, 2, 3, 4, 5, 6].map((n) => ({ n, title: `P${n}`, status: "complete", attempts: 1, summary: "x", key_points: [], gate: [], usage: emptyUsage() })), valuation: null, objections: [], summary: null, completeness: null, usage: emptyUsage(), log: [], ...over,
});

describe("completion rules", () => {
  it("counts a document as fully reviewed only when every part of every material section was read", () => {
    expect(docStatus(doc({}))).toBe("partially_reviewed");
    expect(docStatus(doc({ sections: [{ key: "I-1", label: "", chars: 1, material: true, parts: 2, reviewedParts: [0, 1] }] }))).toBe("fully_reviewed");
  });
  it("blocks a phase with an unread document, an open question or a failed source check", () => {
    const s = state({ inventory: [doc({})], questions: [{ id: "Q1", phase: 2, question: "?", materiality: "high", why: "", status: "open" }], findings: [{ id: "F1", phase: 2, claim: "c", value: "1", unit: "", period: "", doc_id: "D1", quote: "q", source: "primary", key: true, check: { status: "quote_not_found", detail: "" } }] });
    const g = phaseGate(s, 2, "y".repeat(500));
    expect(g.join(" | ")).toMatch(/partially reviewed/);
    expect(g.join(" | ")).toMatch(/Q1 is still open/);
    expect(g.join(" | ")).toMatch(/F1 failed the source check/);
  });
  it("does not accept 'unavailable' without attempts", () => {
    const s = state({ inventory: [doc({ kind: "transcript", status: "unavailable", unavailable_reason: "Not searched yet", attempts: [], fetched: null, sections: undefined, phases: [3] })] });
    expect(phaseGate(s, 3, "y".repeat(500)).join(" ")).toMatch(/without a search attempt/);
  });
  it("keeps the investigation incomplete when a material question is unresolvable", () => {
    const s = state({ questions: [{ id: "Q1", phase: 2, question: "Debt terms?", materiality: "high", why: "", status: "unresolvable", why_unresolvable: "not disclosed", could_change_conclusion: true, attempts: ["read 10-Q"] }] });
    const g = finalGate(s);
    expect(g.complete).toBe(false);
    expect(g.reasons.join(" ")).toMatch(/Material question Q1 could not be resolved/);
    expect(g.reasons.join(" ")).toMatch(/No skeptical review/);
  });
});

describe("buildFinancials", () => {
  const f = (start: string, end: string, val: number, form: string, filed: string) => ({ start, end, val, form, filed });
  const body = { entityName: "TEST CO", facts: { "us-gaap": {
    Revenues: { units: { USD: [f("2024-01-01", "2024-12-31", 100, "10-K", "2025-02-01"), f("2025-01-01", "2025-12-31", 150, "10-K", "2026-02-01"), f("2025-01-01", "2025-06-30", 70, "10-Q", "2025-08-01"), f("2026-01-01", "2026-06-30", 90, "10-Q", "2026-08-01"), f("2026-04-01", "2026-06-30", 50, "10-Q", "2026-08-01")] } },
    NetCashProvidedByUsedInOperatingActivities: { units: { USD: [f("2025-01-01", "2025-12-31", 60, "10-K", "2026-02-01"), f("2025-01-01", "2025-06-30", 25, "10-Q", "2025-08-01"), f("2026-01-01", "2026-06-30", 40, "10-Q", "2026-08-01")] } },
    PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [f("2025-01-01", "2025-12-31", 20, "10-K", "2026-02-01"), f("2025-01-01", "2025-06-30", 8, "10-Q", "2025-08-01"), f("2026-01-01", "2026-06-30", 12, "10-Q", "2026-08-01")] } },
  } } };
  it("computes trailing twelve months and free cash flow", () => {
    const r = buildFinancials(body);
    if ("error" in r) throw new Error(r.error);
    expect(r.annual.map((p) => p.end)).toEqual(["2025-12-31", "2024-12-31"]);
    expect(r.ttm?.values.revenue?.value).toBe(150 + 90 - 70);
    expect(r.latestQuarter?.values.revenue?.value).toBe(50);
    const fcf = r.derived.find((d) => d.label.startsWith("Free cash flow, Trailing"));
    expect(fcf?.value).toBe((60 + 40 - 25) - (20 + 12 - 8));
    expect(r.derived.find((d) => d.label.startsWith("Revenue growth"))?.value).toBe(0.5);
  });
});

describe("research in use", () => {
  const v = (id: string, conclusion: Record<string, unknown>, is_current = false, research_as_of = "2026-11-08") => ({ id, research_as_of, completeness: "complete", origin: "claude_full", is_current, conclusion });
  it("uses a finished investigation over older notes, never a running or set-aside one", () => {
    expect(usableVersion(v("a", { research_type: "full_investigation", review_state: "awaiting_approval" }))).toBe(true);
    expect(usableVersion(v("r", { research_type: "full_investigation", review_state: "running" }))).toBe(false);
    expect(usableVersion(v("s", { research_type: "full_investigation", review_state: "set_aside" }))).toBe(false);
    expect(usableVersion(v("c", { research_type: "full_investigation", review_state: "adopted" }, true))).toBe(true);
    const r = toResearchRecord("X", null, "held", [v("old", { action: "Hold" }, true, "2026-09-01"), v("new", { research_type: "full_investigation", review_state: "awaiting_approval", action: "Buy" })]);
    expect(r.current?.id).toBe("new");
    expect(r.latest?.id).toBe("new");
    expect(r.versions).toBe(2);
  });
});

describe("fixes from the first NVDA run", () => {
  const f = (id: string, over: Partial<Finding> = {}): Finding => ({ id, phase: 3, claim: "c", value: "1", unit: "", period: "", doc_id: "D1", quote: "q", source: "primary", key: true, check: { status: "verified", detail: "" }, ...over });

  it("gives parallel findings distinct ids and repairs duplicates saved before the fix", () => {
    expect(nextId("F", [f("F1"), f("F7"), f("F3")])).toBe("F8");
    const s = state({ findings: [f("F16"), f("F16"), f("F17"), f("F16")] });
    repairIds(s);
    expect(s.findings.map((x) => x.id)).toEqual(["F16", "F18", "F17", "F19"]);
  });

  it("lets a withdrawn finding stop blocking the phase", () => {
    const bad = f("F2", { check: { status: "quote_found_value_not_in_quote", detail: "x" } });
    expect(phaseGate(state({ findings: [bad] }), 3, "y".repeat(500)).join(" ")).toMatch(/F2 failed/);
    bad.withdrawn = { reason: "wrong figure", replaced_by: "F3" };
    expect(phaseGate(state({ findings: [bad, f("F3")] }), 3, "y".repeat(500)).join(" ")).not.toMatch(/F2 failed/);
  });

  it("matches a date written differently in the quote", () => {
    const doc = "NVIDIA will host a conference call on Tuesday, November 17, at 2 p.m. PT (5 p.m. ET)";
    expect(checkQuote(doc, "NVIDIA will host a conference call on Tuesday, November 17, at 2 p.m. PT", "Nov 17, 2026").status).toBe("verified");
    expect(checkQuote(doc, "NVIDIA will host a conference call on Tuesday, November 17, at 2 p.m. PT", "Nov 18, 2026").status).toBe("quote_found_value_not_in_quote");
    expect(checkQuote("The meeting is on November 17, 2025 in the hall", "The meeting is on November 17, 2025", "Nov 17, 2026").status).toBe("quote_found_value_not_in_quote");
  });

  it("tells a long step from a lost hand-off", () => {
    const t = Date.parse("2026-11-08T18:12:29Z");
    const base = { requestAt: "2026-11-08T17:57:00Z", running: true };
    // Checkpoint saved, no step started since: lost after 3 minutes.
    expect(isStalled({ ...base, checkpointAt: "2026-11-08T18:12:29Z", heartbeatAt: "2026-11-08T18:10:13Z" }, t + 2 * 60_000)).toBe(false);
    expect(isStalled({ ...base, checkpointAt: "2026-11-08T18:12:29Z", heartbeatAt: "2026-11-08T18:10:13Z" }, t + 4 * 60_000)).toBe(true);
    // A step in progress (heartbeat after the checkpoint) is allowed its full 15 minutes.
    expect(isStalled({ ...base, checkpointAt: "2026-11-08T18:12:29Z", heartbeatAt: "2026-11-08T18:12:30Z" }, t + 12 * 60_000)).toBe(false);
    expect(isStalled({ ...base, checkpointAt: "2026-11-08T18:12:29Z", heartbeatAt: "2026-11-08T18:12:30Z" }, t + 17 * 60_000)).toBe(true);
    expect(isStalled({ ...base, running: false, checkpointAt: "2026-11-08T18:12:29Z", heartbeatAt: null }, t + 60 * 60_000)).toBe(false);
  });
});
