/**
 * The reviewer annotations saved for the Nov 8 IREN investigation (version 13eea72b), from the code-only
 * validation and the investor's review on Nov 8. Stored in model_runs research_validation (outputs.annotations);
 * kept here so the tests check exactly what is applied.
 */
import type { ReviewAnnotations } from "../review";

export const IREN_NOV8_REVIEW: ReviewAnnotations = {
  material_inputs: [{
    scenario: "all", input: "net_debt",
    note: "Projected June 2029 net debt ($22.5B base; $21B bear, $34B bull) is the model's own estimate, not reconciled to the filings: there is no cash-flow bridge from reported net debt (about $4.43B, F10) through capex, prepayments and new financing. A rough rebuild from the filings gives about $16-17B by mid-2027. This one input explains about $13.39 a share of the fall in base value since the Nov 7 screen, so the value and the trim rest on it.",
  }],
  withdrawn_findings: [{ id: "F43", reason: "Its quote (capex cut attributed to financial markets and cost of funding) was not found in the earnings-call transcript." }],
  finding_corrections: [{
    id: "F46", claim: "Remaining FY27 capex is about $15B. Why it was reduced is not confirmed by a checked quote.",
    reason: "the checked quote supports only the ~$15B remaining FY27 capex, not the funding-conditions explanation",
  }],
  corrections: [
    { field: "reasons", find: "Capex was cut because of funding conditions (F46), so the second $4B of ARR is uncontracted and financing-paced", replace: "Remaining FY27 capex is about $15B (F46); why it was reduced is not confirmed by a checked quote (F43 withdrawn). The second $4B of ARR is uncontracted and financing-paced" },
    { field: "headline", find: "Trim the IREN position to the 3% floor (sell about 10 of 64 shares) and do not add.", replace: "Conditional: a trim toward the 3% floor (about 10 of 64 shares) is suggested only once the net-debt assumption is reconciled; do not add." },
    { field: "valuation", find: "net debt $22.5B", replace: "net debt $22.5B (material model estimate, not reconciled to the filings)" },
  ],
  conditional_action: "Conditional, not a trade instruction: trim toward about 3% (about 10 of 64 shares) only after the $22.5B net-debt assumption is reconciled to the filings and you decide it on Decisions. Approving the research does not approve this trim. No add.",
  by: "review of saved records (code checks, no AI run)",
  at: "2026-11-08T23:30:00Z",
};
