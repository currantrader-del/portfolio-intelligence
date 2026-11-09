import { describe, expect, it } from "vitest";
import { computeValuation, type ScenarioSpec } from "../investigate/valuationCalc";
import { applyReview, type ReviewAnnotations } from "../review";
import { makeRedactor } from "./redact";
import { buildShareReport, finishedInvestigations, pickVersion, reportTexts, shareOptions, stanceOf, type ShareVersion } from "./report";
import { renderSharePdf } from "./pdf";

// A synthetic investigation (fictional company, fictional owner numbers) shaped like the saved records.
const specs: ScenarioSpec[] = [
  { name: "bear", probability: 0.3, method: "ev_ebitda", inputs: { revenue: 4e9, multiple: 6, net_debt: 2e9, ebitda_margin: 0.3, diluted_shares: 500e6 }, sources: { revenue: "estimate: slower ramp", multiple: "estimate: trough multiple", net_debt: "F3", ebitda_margin: "estimate", diluted_shares: "F2" }, rationale: "Demand slows and pricing resets." },
  { name: "base", probability: 0.5, method: "ev_ebitda", inputs: { revenue: 6e9, multiple: 9, net_debt: 1.5e9, ebitda_margin: 0.35, diluted_shares: 480e6 }, sources: { revenue: "F1", multiple: "estimate: peer median", net_debt: "F3", ebitda_margin: "F4", diluted_shares: "F2" }, rationale: "Contracted backlog converts on schedule." },
  { name: "bull", probability: 0.2, method: "ev_ebitda", inputs: { revenue: 8e9, multiple: 12, net_debt: 1e9, ebitda_margin: 0.4, diluted_shares: 470e6 }, sources: { revenue: "estimate: new contracts", multiple: "estimate", net_debt: "F3", ebitda_margin: "estimate", diluted_shares: "F2" }, rationale: "New contracts at higher prices." },
];
const result = computeValuation({ scenarios: specs, horizon_date: "2028-12-31", price: 40, today: "2026-11-08" });

const review: ReviewAnnotations = {
  material_inputs: [{ scenario: "base", input: "net_debt", note: "Not reconciled to the 10-Q." }],
  withdrawn_findings: [{ id: "F5", reason: "Quote not found." }],
  corrections: [{ field: "risks", find: "minor", replace: "material" }],
  conditional_action: "Conditional: trim toward 2% (about 12 of 37 shares) only after the net debt is reconciled; do not add.",
  by: "reviewer", at: "2026-11-08T20:00:00Z",
};

const conclusion = applyReview({
  research_type: "full_investigation", review_state: "adopted_provisional", adopted_at: "2026-11-08T21:00:00Z",
  adoption: { mode: "provisional", open_items: ["Material input not reconciled: net_debt (base). Not reconciled to the 10-Q.", "Deployable cash is $187, below its floor."] },
  reference_price: 40, reference_date: "2026-11-08", reference_price_source: "yahoo (delayed)", confidence: "Low", classification: "Cyclical growth",
  action: "Trim the ACME position to the 2% floor (sell about 12 of 37 shares) and do not add.",
  completion: { complete: true, reasons: [], kind: "complete" },
  allocation: { target_pct: 2, max_pct: 4, note: "Approved ACME band 2-4%." },
  investment_summary: {
    headline: "Acme earns real cash but the price already reflects the base case, so no new money.",
    business_quality: { rating: "Good", why: "Revenue grew 40% (F1) with 35% EBITDA margin (F4)." },
    valuation: "Weighted value about $41 against $40.",
    expected_return: "About 1% a year, below VOO.",
    risks: ["Customer concentration is a minor risk: top three are 60% of revenue (F6).", "Funding: $2B of capex unfunded (F3)."],
    portfolio_fit: "ACME is 37 shares, $1,480, 2.8% of investable capital, inside the approved 2-4% band. Deployable cash is $187 and the $2,500 reserve is untouched.",
    action: "Trim the ACME position to the 2% floor (sell about 12 of 37 shares) and do not add.",
    confidence: "Low",
    would_change: ["Upgrade if Q4 backlog converts above 80% and the price is below $30 with an approved limit.", "Exit if the largest customer cuts its contract."],
    reasons: ["Weighted value is close to the price (app).", "Portfolio and policy: the position is above the 2% floor; deployable cash is $187."],
    classification: "Cyclical growth",
    thesis: "Acme sells power capacity under multi-year contracts; returns depend on delivering the backlog without heavy dilution.",
    price_framework: [{ price_zone: "< $30", action: "Starter eligible (about 1-2% if an ACME limit is approved and deployable cash is rebuilt)." }, { price_zone: "$30-$50", action: "Hold; no add." }, { price_zone: "> $50", action: "Trim back to 4% or below." }],
    allocation: { target_pct: 2, max_pct: 4, note: "Approved ACME band 2-4%." },
    changes_vs_prior: "Weighted value fell from $48 to $41 after the review.",
  },
  evidence: {
    valuation: { specs, result, revenue_basis: "FY2028" },
    findings: [
      { id: "F1", phase: 2, claim: "Revenue grew 40% in FY26", value: "40", unit: "%", period: "FY26", doc_id: "D1", quote: "Revenue increased 40% year over year.", source: "primary", key: true, check: { status: "verified", detail: "" } },
      { id: "F2", phase: 2, claim: "Diluted shares 480M", value: "480", unit: "M", period: "Q3", doc_id: "D2", quote: "", source: "xbrl", key: true, check: { status: "xbrl", detail: "" } },
      { id: "F5", phase: 3, claim: "Capex cut due to funding", value: "", unit: "", period: "", doc_id: "D3", quote: "x", source: "primary", key: false, check: { status: "quote_not_found", detail: "" } },
      { id: "F9", phase: 6, claim: "The owner's position is 37 shares with a cost basis of $1,740", value: "37", unit: "shares", period: "now", doc_id: null, quote: "", source: "calculation", key: false, check: { status: "calculation", detail: "" } },
    ],
    questions: [{ id: "Q1", phase: 1, question: "Can the $2B gap be funded without heavy dilution?", materiality: "high", why: "", status: "unresolvable", why_unresolvable: "Terms not disclosed.", could_change_conclusion: true }],
    conflicts: [{ id: "C1", phase: 4, description: "Management says funded; filings show a gap.", finding_ids: ["F3"], resolution: "Treated as unfunded.", status: "resolved" }],
    objections: [
      { id: "S1", objection: "The base multiple is generous.", severity: "major", evidence_to_check: "Peer multiples", area: "valuation_assumptions", test: "Base at 7x", test_kind: "stress_test", test_result: "Weighted $36", response: "Cut base multiple to 9x.", outcome: "partly_accepted" },
      { id: "S2", objection: "Hold was asserted, not compared with harvesting the $828 tax loss in the taxable account.", severity: "major", evidence_to_check: "", area: "portfolio_recommendation", response: "Trim to the 2% floor (sell about 12 shares).", outcome: "accepted" },
    ],
    review: { thesis: "survives", valuation: "survives_with_changes", recommendation: "survives_with_changes", summary: "The thesis holds; the valuation was too generous.", required_changes: ["Cut base multiple."], at: "2026-11-08T19:00:00Z" },
    stress: [{ label: "Base at 7x", weighted_value: 36, annualized_return: -0.05, note: "One change" }],
    consistency: { ok: true, issues: [], checks: [{ label: "Summary states the app's weighted value", ok: true, detail: "Matches." }, { label: "Action respects the position limits", ok: true, detail: "ACME 2.8% inside the 2-4% band." }] },
    portfolio_check: { weight: 0.028, direct: 0.028, normalHigh: 0.04, max: 0.05, limitAuthority: "approved", headroomDollars: 600 },
  },
}, review);

const phaseBody = (n: number) => n === 6
  ? "**Conclusion: Trim, Low confidence.** The weighted value is $41 against $40.\n\n**Portfolio fit.** ACME is 37 shares, $1,480. Deployable cash is $187.\n\n**Action and bands.** Below $30, consider a starter only if the investor approves an ACME limit. Above $50, trim.\n\n- Thesis breakers: backlog slips past Q2 2027."
  : `**Phase ${n} heading.** Substantive research text for phase ${n} with figures like $6.0B revenue and 480M shares.\n\n| Metric | Value |\n|---|---|\n| Revenue | $4.2B |`;

const version: ShareVersion = {
  id: "v-acme-2", research_as_of: "2026-11-08", created_at: "2026-11-08T18:00:00Z", completeness: "complete", origin: "claude_full", is_current: true, conclusion,
  research_phases: [1, 2, 3, 4, 5, 6].map((n) => ({ phase_number: n, title: ["Business and thesis", "Financials and filings", "Competition, management and capital allocation", "Risks and catalysts", "Valuation: bear, base and bull", "Conclusion and what would change it"][n - 1], body_markdown: phaseBody(n), details: { status: "complete", at: "2026-11-08T18:30:00Z" } })),
  research_sources: [
    { title: "Acme 10-K FY2026", url: "https://www.sec.gov/Archives/acme-10k.htm", document_date: "2026-08-30", details: { doc_id: "D1", review_status: "fully_reviewed", required: true, chars: 400000 } },
    { title: "Industry news", url: "https://example.com/news", document_date: "2026-11-01", details: { review_status: "search_result_only" } },
  ],
};
const older: ShareVersion = { ...version, id: "v-acme-1", is_current: false, created_at: "2026-11-07T10:00:00Z", research_as_of: "2026-11-07", conclusion: { ...conclusion, review_state: "set_aside" } };
const running: ShareVersion = { ...version, id: "v-acme-3", is_current: false, created_at: "2026-11-09T10:00:00Z", research_as_of: "2026-11-09", conclusion: { research_type: "full_investigation", review_state: "running" } };

const fp = { amounts: [1480.1, 1740.5, -260.4, 41230, 2500, 9000], terms: ["Brokerage One"] };

describe("choosing the version", () => {
  it("skips running investigations and defaults to the newest finished one", () => {
    expect(finishedInvestigations([older, running, version]).map((v) => v.id)).toEqual(["v-acme-2", "v-acme-1"]);
    expect(pickVersion([older, running, version], "latest")?.id).toBe("v-acme-2");
    expect(pickVersion([older, running, version], "approved")?.id).toBe("v-acme-2");
    expect(pickVersion([older], "approved")).toBeNull();
    expect(shareOptions([older, running, version])).toEqual({ latest: { id: "v-acme-2", research_as_of: "2026-11-08" }, approved: { id: "v-acme-2", research_as_of: "2026-11-08" } });
  });
  it("names the research's stance in general words", () => {
    expect(stanceOf("Trim the ACME position to the 2% floor (sell about 12 of 37 shares) and do not add.")).toBe("Trim (reduce exposure); no new money");
    expect(stanceOf("Watch. No new money now.")).toBe("Watch; no new money");
    expect(stanceOf("Conditional: trim toward 2%")).toBe("Trim (reduce exposure)");
    expect(stanceOf("Consider a starter")).toBeNull();
  });
});

describe("the shared report", () => {
  const r = buildShareReport({ symbol: "ACME", name: "Acme Power", version, choice: "latest", approved: version, latest: version, validation: null, redactor: makeRedactor(fp), now: new Date("2026-11-09T05:00:00Z") });
  const all = reportTexts(r).join("\n");

  it("includes every phase and the full analysis", () => {
    const ids = r.sections.map((s) => s.id);
    for (const id of ["about", "status", "conclusion", "strategy", "valuation", "phase-1", "phase-2", "phase-3", "phase-4", "phase-5", "phase-6", "skeptic", "evidence", "sources", "redactions"]) expect(ids).toContain(id);
    expect(all).toContain("Substantive research text for phase 3");
    expect(all).toContain("Acme sells power capacity under multi-year contracts");
    expect(all).toContain("Can the $2B gap be funded without heavy dilution?");
    expect(all).toContain("The base multiple is generous.");
    expect(all).toContain("https://www.sec.gov/Archives/acme-10k.htm");
    expect(all).toContain("Not reconciled to the 10-Q.");
    expect(all).toContain("Customer concentration is a material risk"); // reviewer correction applied
    expect(all).toContain("Above $50, trim.");
    expect(all).toContain("Exit if the largest customer cuts its contract.");
  });

  it("states date, price, approval and provisional status", () => {
    expect(r.facts).toContainEqual(["Reference price", "$40.00 on Nov 8, 2026 (yahoo (delayed))"]);
    expect(r.facts.find((f) => f[0] === "Approval")?.[1]).toMatch(/^Approved provisionally by the owner on Nov 8, 2026/);
    expect(r.notices.join(" ")).toMatch(/Provisional/);
  });

  it("removes the owner's private information everywhere", () => {
    expect(all).not.toMatch(/37 shares|\$1,480|\$1,740|\$187|\$2,500|\$828|investable|cost basis of|deployable cash is|2\.8%|tax loss|headroom/i);
    expect(all).toContain("[Section removed: “Portfolio fit”");
    expect(all).toContain("Research stance");
    expect(all).toContain("Trim (reduce exposure); no new money");
    expect(r.redactions.length).toBeGreaterThan(0);
  });

  it("labels a latest-but-unapproved export", () => {
    const pending: ShareVersion = { ...version, id: "v-acme-4", is_current: false, created_at: "2026-11-09T12:00:00Z", conclusion: { ...conclusion, review_state: "awaiting_approval" }, completeness: "partial" };
    const r2 = buildShareReport({ symbol: "ACME", name: "Acme Power", version: pending, choice: "latest", approved: version, latest: pending, validation: null, redactor: makeRedactor(fp) });
    expect(r2.notices.join(" ")).toMatch(/not the one the owner approved/);
    expect(r2.notices.join(" ")).toMatch(/Not approved/);
    expect(r2.notices.join(" ")).toMatch(/Incomplete/);
  });

  it("renders a PDF", async () => {
    const pdf = await renderSharePdf(r);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(10_000);
    if (process.env.SHARE_PDF_OUT) (await import("node:fs")).writeFileSync(process.env.SHARE_PDF_OUT, pdf);
  }, 30_000);
});

