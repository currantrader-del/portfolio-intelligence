# Policy review, 2026-11-08

## Source versions checked

| Subject | Source file (project handoff/originals) | What it says | Status in the app |
|---|---|---|---|
| GOOGL | `Pasted markdown(7) - GOOGL Master Record.md` ("Full research review completed: September 12, 2026") | normal 5–7%, high conviction 7–8.5%, max 10% total economic exposure | Matches the rule Brendan approved in the app on 2026-11-08 13:22Z. The old import labelled this source "partial, not current"; the Master Record itself says the full review was completed. |
| IREN | `IREN_FULL_RESEARCH_ARCHIVE_2026-09-10(1).json` (six phases complete) | normal 3–5%, high conviction 5–6% only after de-risking, company max 7% subject to portfolio-wide speculative limits | Matches the rule Brendan approved on 2026-11-08 13:23Z. A risk ceiling, not a buy recommendation. |
| RDDT | `RDDT_FULL_RESEARCH_ARCHIVE_2026-09-13` versions A and B | Both: normal 3–5%, high conviction 5–6.5%, hard max 7% (A: master_record.portfolio; B: portfolio_allocation_action_framework) | Version A is the better-documented copy (verbatim Phase 4, input hashes matching the pasted Phase 4/5 files); B is a structured re-export. They agree on every limit. The old import stored a "partial" RDDT record saying limits were "not preserved", which is why a provisional 6% ceiling from Baseline v2 (revised) controlled. Added as an open decision; 6% stays in control until Brendan approves or rejects. |
| Protected reserve | Brendan, project chat 2026-11-07 | $3,000 USAA savings | Approved 2026-11-07; the $10,000 row is kept as superseded. |

## Explicit approvals vs imported "approved"

- **Brendan's approvals** have `approved_at` set (made in the app or recorded from his message): GOOGL, IREN, the $3,000 reserve.
- **Imported** rows were marked "approved" in the old ChatGPT archive (Portfolio Baseline v2 revised, undated) but never approved by Brendan: all eight bucket ranges, NOW 12%, NVDA 18%, IONQ 5% (provisional), RDDT 6% (provisional) and the generic 18%. The app now labels these "Imported · not confirmed", and new-cash results stay on wait until he confirms them (one button) or replaces them.

## Decision engine changes

- **Unresearched companies:** no inherited maximum. Without its own limit a company gets no new money; the generic 18% is kept only as an absolute ceiling for any single company.
- **Return comparison:** the fixed 7% ETF return and 3-point hurdle are retired (kept in history). The index return is the range of published U.S. stock forecasts: Vanguard 4.8–6.8% (10 years, as of 2026-09-30) and J.P. Morgan 7.5% (10–15 years, 2027 LTCMA, 2026-10-19). A stock must beat the top of that range plus 0.5 x the spread of its own bear/base/bull outcomes. The 0.5 is a risk preference, shown for approval.
- **Research refresh:** the 120-day cutoff is retired as a gate. Research needs a refresh after new results (10-Q/10-K/20-F or 8-K 2.02), a financing (424B*, S-1/S-3/F-3, 8-K 2.03/3.02), another material 8-K, or a move into a different action zone of the research. If filings can't be checked the research is "unverified", never "current". Age only prompts a filings check.
- **Independent verdicts:** limit, valuation and research currency are evaluated and shown separately; all three must pass.

## Validation

- `src/lib/policy/evidence.test.ts` reproduces the RDDT research's own numbers at its $157.77 reference (13.2% probability-weighted return; scenario CAGRs −2.5%, 14.9%, 29.3%) and checks the margin, bar and event triggers.
- 265 tests pass (`npm test`), typecheck and lint clean.
