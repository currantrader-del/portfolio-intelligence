import { describe, expect, it } from "vitest";
import { computeValuation, type ScenarioSpec } from "../investigate/valuationCalc";
import type { ValidationReport } from "../validate";
import { makeRedactor } from "./redact";
import { buildShareReport, describeChanges, fmtInput, fmtValue, parseZones, reportTexts, splitPhaseBody, type ShareVersion } from "./report";
import { renderSharePdf } from "./pdf";

// A long, fictional investigation shaped like a real full investigation (six long phases with the
// generated key points / documents / findings / questions lists, many findings, skeptic stress tests).
const NB = " ";
const specs: ScenarioSpec[] = [
  { name: "bear", probability: 0.35, method: "ev_ebitda", inputs: { revenue: 110e9, multiple: 6, net_debt: -60e9, ebitda_margin: 0.38, diluted_shares: 1.07e9 }, sources: { revenue: "estimate: about 60% of consensus", multiple: "estimate: trough multiple", net_debt: "estimate: cash less buybacks", ebitda_margin: "estimate", diluted_shares: "estimate" }, rationale: "Supply wave arrives and prices fall." },
  { name: "base", probability: 0.45, method: "ev_ebitda", inputs: { revenue: 285e9, multiple: 3, net_debt: -100e9, ebitda_margin: 0.78, diluted_shares: 1.01e9 }, sources: { revenue: "estimate", multiple: "estimate", net_debt: "estimate", ebitda_margin: "estimate", diluted_shares: "estimate" }, rationale: "Prices plateau then ease." },
  { name: "bull", probability: 0.2, method: "ev_ebitda", inputs: { revenue: 330e9, multiple: 4, net_debt: -120e9, ebitda_margin: 0.82, diluted_shares: 1e9 }, sources: { revenue: "estimate", multiple: "estimate", net_debt: "estimate", ebitda_margin: "estimate", diluted_shares: "estimate" }, rationale: "Tightness lasts into 2029." },
];
const result = computeValuation({ scenarios: specs, horizon_date: "2028-11-07", price: 690, today: "2026-11-08" });
const para = (n: number) => `Revenue was $133.2B against $37.4B a year earlier (F${n}), and gross margin reached 87%; management guided the next quarter's EPS to $38.15 on 1.15B shares, which annualizes to about $150.`;
const findings = Array.from({ length: 50 }, (_, i) => ({ id: `F${i + 1}`, phase: (i % 6) + 1, claim: `Finding ${i + 1}: ${para(i).slice(0, 140)}`, value: String(100 + i), unit: i % 3 === 0 ? "USD billions" : i % 3 === 1 ? "% DRAM revenue share" : "USD per share", period: "FY2026", doc_id: `D${(i % 9) + 1}`, quote: "the transaction price allocated to our remaining performance obligations was approximately $ 134 billion", source: i % 4 === 0 ? "secondary" : "primary", key: i % 2 === 0, check: { status: i % 4 === 0 ? "secondary_unverifiable" : "verified", detail: "" } }));
const body = (n: number) => [
  ...Array.from({ length: 8 }, (_, k) => `**Part ${k + 1}.** ${para(n * 10 + k)} ${para(k)}`),
  "1. AI servers and HBM.\n2. Data-center SSDs.\n3. Edge and auto.",
  `- Q1: How long does peak margin last?${NB}It${NB}depends${NB}on${NB}supply${NB}from${NB}three${NB}makers${NB}and${NB}their${NB}new${NB}fabs${NB}arriving${NB}in${NB}2027${NB}and${NB}2028,${NB}which${NB}no${NB}one${NB}can${NB}date${NB}precisely${NB}today.`,
  "\n**Key points**\n- Revenue $133.2B in FY26 (3.6x)\n- Net cash $68.3B\n- Five debates raised",
  "\n**Documents for this phase**\n- D1 10-K filed 2026-10-09 (Annual report): fully reviewed",
  `\n**Findings**\n${findings.filter((f) => f.phase === n).map((f) => `- ${f.id} ${f.claim}: ${f.value} ${f.unit} (${f.period}) [${f.source}, verified]`).join("\n")}`,
  "\n**Questions**\n- Q1 (high) How long do peak margins last? -> resolved: the risk window is 2028-29.",
].join("\n\n");

const version: ShareVersion = {
  id: "v-long", research_as_of: "2026-11-08", created_at: "2026-11-08T18:00:00Z", completeness: "complete", origin: "claude_full", is_current: true,
  conclusion: {
    research_type: "full_investigation", review_state: "adopted", adopted_at: "2026-11-09T10:00:00Z", reference_price: 690, reference_date: "2026-11-08", confidence: "Low", classification: "Cyclical, at or near peak earnings",
    investment_summary: {
      headline: "Earnings are real, but at $690 the expected return is about zero, so the action stays Watch with no new money.",
      action: "Watch. No new money now.", confidence: "Low", classification: "Cyclical, at or near peak earnings",
      business_quality: { rating: "Good", why: para(1) }, valuation: para(2), expected_return: "About -0.5% a year.", thesis: para(3), reasons: [para(4), para(5)], risks: [para(6), para(7), para(8)], would_change: [para(9), para(10)],
      price_framework: [{ price_zone: "< $520", action: "Starter eligible (small)." }, { price_zone: "$520-$600", action: "Watch." }, { price_zone: "> $600", action: "No new money." }],
    },
    evidence: {
      valuation: { specs, result, revenue_basis: "FY ending Aug 2028" },
      findings,
      questions: [{ id: "Q1", phase: 1, question: "How long do peak margins last?", materiality: "high", why: "", status: "resolved", answer: para(11).repeat(3) }],
      objections: Array.from({ length: 6 }, (_, i) => ({ id: `S${i + 1}`, objection: para(20 + i), severity: "major", evidence_to_check: "TrendForce prints", area: "valuation_assumptions", test: "Base at 3x", test_kind: "stress_test", test_result: "Weighted $846", response: para(30 + i), outcome: "accepted" })),
      stress: [
        { label: "Lower demand only", weighted_value: 820.47, annualized_return: 0.09, note: "Lower demand only" },
        ...Array.from({ length: 14 }, (_, i) => ({ label: `Skeptic: test ${i + 1} with a deeper bear`, weighted_value: 700 + i, annualized_return: 0.01 * i, note: JSON.stringify([{ scenario: "bear", input: "revenue", set: 90e9 }, { scenario: "bear", input: "ebitda_margin", set: 0.35 }, { scenario: "all", input: "", probabilities: { bear: 0.4, base: 0.4, bull: 0.2 } }]).slice(0, 400) })),
      ],
    },
  },
  research_phases: [1, 2, 3, 4, 5, 6].map((n) => ({ phase_number: n, title: `Phase title ${n}`, body_markdown: body(n), details: { status: "complete", at: "2026-11-09T00:00:00Z" } })),
  research_sources: Array.from({ length: 20 }, (_, i) => ({ title: `Document ${i + 1}`, url: `https://www.sec.gov/Archives/edgar/data/723125/000072312526000041/mu-20260903-document-${i}.htm`, document_date: "2026-10-09", details: { doc_id: `D${i + 1}`, review_status: "fully_reviewed" } })),
};
const validation = { version: "validate@1", symbol: "MU", at: "2026-11-09T00:00:00Z", verdict: "passes_with_caveats", headline: "Passes with caveats.", checks: [{ key: "a", label: "Arithmetic", status: "pass", detail: "OK" }], inputs: [], bridges: [], notes: [],
  sensitivity: [{ label: "Base multiple 1 turn lower", weighted: 584.79, delta: -99.04, annualized: -0.079 }, { label: "Base multiple 1 turn higher", weighted: 782.88, delta: 99.05, annualized: 0.065 }, { label: "Base revenue 10% lower", weighted: 654.12, delta: -29.71, annualized: -0.026 }] } as ValidationReport;

describe("readable layout of a long investigation", () => {
  const r = buildShareReport({ symbol: "MU", name: "Example Memory Co", version, choice: "approved", approved: version, latest: version, validation, redactor: makeRedactor({ amounts: [], terms: [] }), now: new Date("2026-11-09T12:00:00Z") });
  const all = reportTexts(r).join("\n");

  it("formats figures in their own units", () => {
    expect(fmtInput("ebitda_margin", 0.38)).toBe("38%");
    expect(fmtInput("multiple", 6)).toBe("6x");
    expect(fmtInput("diluted_shares", 1.07e9)).toBe("1.07B shares");
    expect(fmtInput("net_debt", -60e9)).toBe("-$60.0B (net cash)");
    expect(fmtValue("134", "USD billions")).toBe("$134B");
    expect(fmtValue("10%", "% DRAM revenue share")).toBe("10% DRAM revenue share");
    expect(describeChanges('[{"scenario":"bear","input":"revenue","set":90000000000},{"scenario":"all","input":"","probabilities":{"bear":0.4,"base":0.4,"bull":0.2}}]')).toBe("Changed: probabilities 40/40/20 (bear/base/bull); bear revenue $90.0B");
    expect(parseZones([{ label: "< $520", action: "Starter eligible" }, { label: "$520-$600", action: "Watch" }, { label: "> $600", action: "No new money" }])?.map((z) => [z.lo, z.hi, z.tone])).toEqual([[null, 520, "good"], [520, 600, "wait"], [600, null, "bad"]]);
  });

  it("does not repeat the phase findings, documents and questions lists", () => {
    const { body: b, keyPoints } = splitPhaseBody(body(1));
    expect(keyPoints).toEqual(["Revenue $133.2B in FY26 (3.6x)", "Net cash $68.3B", "Five debates raised"]);
    expect(b).not.toMatch(/\*\*(Findings|Documents for this phase|Questions|Key points)\*\*/);
    expect(b).toContain("**Part 8.**");
    expect(all).not.toMatch(/\$-\d/); // no "$-60.00B"
    expect(all).not.toMatch(/"scenario":/); // stress-test changes in words, not JSON
    expect(r.summary?.charts.map((c) => c.kind)).toEqual(["scenarios", "zones"]);
  });

  it("renders quickly", async () => {
    const t = Date.now();
    const pdf = await renderSharePdf(r);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(Date.now() - t).toBeLessThan(20_000);
    if (process.env.SHARE_PDF_LONG_OUT) (await import("node:fs")).writeFileSync(process.env.SHARE_PDF_LONG_OUT, pdf);
  }, 60_000);
});
