# Test report

Commit `0fadd58` plus this report, run 2026-11-06 with `npx vitest run`. Reproduce with `npm ci && npx vitest run`. Type check (`npx tsc --noEmit`), lint (`npm run lint`) and `next build` also pass.

**135 passed, 0 failed, 135 total** in 20 files.

Real-data fixtures (public SEC data only):
- `src/lib/market/__fixtures__/iren-submissions-2026-11-06.json`, trimmed from https://data.sec.gov/submissions/CIK0001878848.json.
- `src/lib/market/__fixtures__/iren-10q-2026-09-30-subset.xml`, a **transcribed subset** of IREN's Q1 FY27 10-Q (accession 0001878848-26-000066), written in XBRL instance form. Its header says so. The live app reads the original instance from SEC instead.

All other inputs are synthetic.

## Database migration staging test

`supabase/tests/run-staging.sh` builds a scratch PostgreSQL 16 database with every earlier migration and runs `supabase/tests/research_append_only.test.sql`. Result: **ALL STAGING CHECKS PASSED** (log in the project files, `reliability/staging-run.log`). See `docs/migration-safety-research-append-only.md`.

## Coverage by area

| Area | Tests | Passed |
| --- | --- | --- |
| Auth | 5 | 5 |
| Filing classification and events | 10 | 10 |
| Fixture safety | 2 | 2 |
| Freshness | 12 | 12 |
| Import | 10 | 10 |
| Monitoring rules | 2 | 2 |
| Policy conflicts and provisional limits | 8 | 8 |
| Policy parsing | 2 | 2 |
| Portfolio arithmetic | 8 | 8 |
| Quotes and stale data | 10 | 10 |
| Recommendation safeguards | 8 | 8 |
| Research coverage | 6 | 6 |
| Research refresh rules | 7 | 7 |
| Risk arithmetic and history | 10 | 10 |
| SEC filing check (acceptance) | 14 | 14 |
| SEC/RSS parsing | 7 | 7 |
| Scenario models | 5 | 5 |
| Screening | 4 | 4 |
| XBRL parsing | 5 | 5 |

## Not covered by automated tests

- Live provider calls (Yahoo, Stooq, SEC) from the deployed app: the build sandbox has no outbound access. The SEC filing check is verified live by pressing "Check latest SEC filing" on the preview and comparing the stored `model_runs` row with the 10-Q.
- Page rendering with real account data (checked manually with synthetic fixture mode only).
- The append-only research migration on production (staging only; not applied until approved).

## Every test

| Area | File | Test | Result |
| --- | --- | --- | --- |
| Auth | `src/lib/auth-gate.test.ts` | auth gate > allows a password session when no authenticator is enrolled | passed |
| Auth | `src/lib/auth-gate.test.ts` | auth gate > lets signed-out users see login | passed |
| Auth | `src/lib/auth-gate.test.ts` | auth gate > moves fully signed-in users off login | passed |
| Auth | `src/lib/auth-gate.test.ts` | auth gate > requires the code once an authenticator is enrolled | passed |
| Auth | `src/lib/auth-gate.test.ts` | auth gate > sends signed-out users to login | passed |
| Filing classification and events | `src/lib/alerts/events.test.ts` | classifyFiling > never treats a form type as proof of dilution | passed |
| Filing classification and events | `src/lib/alerts/events.test.ts` | classifyFiling > reads an 8-K by its item codes, not as an offering | passed |
| Filing classification and events | `src/lib/alerts/events.test.ts` | classifyFiling > separates a shelf registration, a prospectus supplement and a resale | passed |
| Filing classification and events | `src/lib/alerts/events.test.ts` | eventAlerts > caps form-type alerts at medium severity and says the terms are not reviewed | passed |
| Filing classification and events | `src/lib/alerts/events.test.ts` | eventAlerts > ignores filings dated after now | passed |
| Filing classification and events | `src/lib/alerts/events.test.ts` | eventAlerts > lists already-filed documents as recent, never as upcoming | passed |
| Filing classification and events | `src/lib/alerts/events.test.ts` | eventAlerts > shows an estimated report only when close, labelled as an estimate, and ignores old filings | passed |
| Filing classification and events | `src/lib/alerts/events.test.ts` | real IREN submissions (SEC, retrieved 2026-11-06) > leaves out 13G, Form 4 and proxy add-ons | passed |
| Filing classification and events | `src/lib/alerts/events.test.ts` | real IREN submissions (SEC, retrieved 2026-11-06) > on 2026-11-06 reports nothing as recently filed, and no past filing as coming up | passed |
| Filing classification and events | `src/lib/alerts/events.test.ts` | real IREN submissions (SEC, retrieved 2026-11-06) > parses the company and classifies each 2026 filing by form and items | passed |
| Fixture safety | `src/lib/dev/fixture.test.ts` | design fixture switch > can never turn on in a production build | passed |
| Fixture safety | `src/lib/dev/fixture.test.ts` | design fixture switch > is off unless asked for | passed |
| Freshness | `src/lib/freshness/freshness.test.ts` | helpers > counts weekdays only | passed |
| Freshness | `src/lib/freshness/freshness.test.ts` | helpers > labels age | passed |
| Freshness | `src/lib/freshness/freshness.test.ts` | holdings freshness > Friday's sync is live on Monday | passed |
| Freshness | `src/lib/freshness/freshness.test.ts` | holdings freshness > Sep 21 holdings are stale on Nov 5 | passed |
| Freshness | `src/lib/freshness/freshness.test.ts` | holdings freshness > yesterday's sync is still live | passed |
| Freshness | `src/lib/freshness/freshness.test.ts` | quote freshness > is delayed up to 15 minutes | passed |
| Freshness | `src/lib/freshness/freshness.test.ts` | quote freshness > is live within 2 minutes in market hours | passed |
| Freshness | `src/lib/freshness/freshness.test.ts` | quote freshness > is missing with no timestamp | passed |
| Freshness | `src/lib/freshness/freshness.test.ts` | quote freshness > is stale after 15 minutes | passed |
| Freshness | `src/lib/freshness/freshness.test.ts` | quote freshness > treats the last close as current when the market is shut | passed |
| Freshness | `src/lib/freshness/freshness.test.ts` | research freshness > AAA Sep 10 research is live within 120 days | passed |
| Freshness | `src/lib/freshness/freshness.test.ts` | research freshness > is stale after 120 days | passed |
| Import | `src/lib/import/files.test.ts` | file classification > ignores files it does not know | passed |
| Import | `src/lib/import/files.test.ts` | file classification > recognises pasted markdown by its upload name | passed |
| Import | `src/lib/import/files.test.ts` | file classification > skips byte-identical duplicates | passed |
| Import | `src/lib/import/files.test.ts` | file classification > tells the two same-named RDDT archives apart by size | passed |
| Import | `src/lib/import/plan.test.ts` | import plan > imports GOOGL as history that is not current | passed |
| Import | `src/lib/import/plan.test.ts` | import plan > imports policy limits but not historical balances | passed |
| Import | `src/lib/import/plan.test.ts` | import plan > labels RDDT reconstructions and keeps it partial | passed |
| Import | `src/lib/import/plan.test.ts` | import plan > marks a full original archive complete and current | passed |
| Import | `src/lib/import/plan.test.ts` | import plan > never marks an archive with a missing phase complete | passed |
| Import | `src/lib/import/plan.test.ts` | import plan > refuses to plan a row without its source document | passed |
| Monitoring rules | `src/lib/alerts/rules.test.ts` | alerts > merges a big move, a band change and a limit breach on one company into one review | passed |
| Monitoring rules | `src/lib/alerts/rules.test.ts` | alerts > treats a move in line with the market as low priority | passed |
| Policy conflicts and provisional limits | `src/lib/policy/rules.test.ts` | policy conflicts > marks a lone proposed value as proposed, and assumptions without approval as not approved | passed |
| Policy conflicts and provisional limits | `src/lib/policy/rules.test.ts` | policy conflicts > never labels a disputed maximum approved, and uses the stricter one | passed |
| Policy conflicts and provisional limits | `src/lib/policy/rules.test.ts` | policy conflicts > never uses a superseded rule | passed |
| Policy conflicts and provisional limits | `src/lib/policy/rules.test.ts` | policy conflicts > treats two approved rows that disagree as a conflict | passed |
| Policy conflicts and provisional limits | `src/lib/policy/rules.test.ts` | policy conflicts > uses an approved rule over open candidates | passed |
| Policy conflicts and provisional limits | `src/lib/policy/rules.test.ts` | provisional limit > follows the provisional row even when it is not the stricter one | passed |
| Policy conflicts and provisional limits | `src/lib/policy/rules.test.ts` | provisional limit > is not provisional once a row is approved | passed |
| Policy conflicts and provisional limits | `src/lib/policy/rules.test.ts` | provisional limit > uses the owner's provisional choice while the conflict stays open and unapproved | passed |
| Policy parsing | `src/lib/policy/limits.test.ts` | policy parsing > parses ranges and percents in the policy's own wording | passed |
| Policy parsing | `src/lib/policy/limits.test.ts` | policy parsing > reads bucket and company limits from the revised policy | passed |
| Portfolio arithmetic | `src/lib/portfolio/engine.test.ts` | portfolio engine > adds ETF look-through to company exposure | passed |
| Portfolio arithmetic | `src/lib/portfolio/engine.test.ts` | portfolio engine > combines accounts and leaves cost basis unknown when any lot lacks it | passed |
| Portfolio arithmetic | `src/lib/portfolio/engine.test.ts` | portfolio engine > day contributions add up to the portfolio's day change | passed |
| Portfolio arithmetic | `src/lib/portfolio/engine.test.ts` | portfolio engine > falls back to statement prices when there are no quotes | passed |
| Portfolio arithmetic | `src/lib/portfolio/engine.test.ts` | portfolio engine > flags missing savings and statements that do not add up | passed |
| Portfolio arithmetic | `src/lib/portfolio/engine.test.ts` | portfolio engine > reprices with quotes and attributes the day's move | passed |
| Portfolio arithmetic | `src/lib/portfolio/engine.test.ts` | portfolio engine > rolls holdings forward with recorded trades and keeps the estimate label | passed |
| Portfolio arithmetic | `src/lib/portfolio/engine.test.ts` | portfolio engine > separates brokerage cash, deployable savings and the protected reserve | passed |
| Quotes and stale data | `src/lib/market/quotes.test.ts` | market hours > is closed before the open, after the close and at weekends | passed |
| Quotes and stale data | `src/lib/market/quotes.test.ts` | market hours > is open on a weekday at 11 AM New York | passed |
| Quotes and stale data | `src/lib/market/quotes.test.ts` | quote parsing > converts Stooq Warsaw times with daylight saving | passed |
| Quotes and stale data | `src/lib/market/quotes.test.ts` | quote parsing > keeps the provider's time, not the fetch time | passed |
| Quotes and stale data | `src/lib/market/quotes.test.ts` | quote parsing > reads Stooq CSV | passed |
| Quotes and stale data | `src/lib/market/quotes.test.ts` | quote parsing > reads Yahoo chart meta | passed |
| Quotes and stale data | `src/lib/market/quotes.test.ts` | quote parsing > rejects Stooq N/D rows | passed |
| Quotes and stale data | `src/lib/market/quotes.test.ts` | quote parsing > rejects Stooq rows without a date | passed |
| Quotes and stale data | `src/lib/market/quotes.test.ts` | quote parsing > rejects a Yahoo price with no market time instead of stamping it as current | passed |
| Quotes and stale data | `src/lib/market/quotes.test.ts` | quote parsing > rejects empty Yahoo responses | passed |
| Recommendation safeguards | `src/lib/decision/newCapital.test.ts` | new capital: a drop is not a buy signal > does not re-price research after a large decline | passed |
| Recommendation safeguards | `src/lib/decision/newCapital.test.ts` | new capital: a drop is not a buy signal > treats partial research as needing completion, not as a smaller buy | passed |
| Recommendation safeguards | `src/lib/decision/newCapital.test.ts` | new capital: ceilings and money source > does not grow the portfolio when the money is cash already held | passed |
| Recommendation safeguards | `src/lib/decision/newCapital.test.ts` | new capital: ceilings and money source > fills a stock only to the top of its normal range | passed |
| Recommendation safeguards | `src/lib/decision/newCapital.test.ts` | new capital: evidence gates > becomes actionable only when every gate passes | passed |
| Recommendation safeguards | `src/lib/decision/newCapital.test.ts` | new capital: evidence gates > is WAIT / REVIEW with placeholders, unknown savings and an unresearched holding | passed |
| Recommendation safeguards | `src/lib/decision/newCapital.test.ts` | new capital: evidence gates > stays on wait while the portfolio is not reconciled | passed |
| Recommendation safeguards | `src/lib/decision/newCapital.test.ts` | new capital: policy conflicts > uses the stricter limit and blocks actionability until you choose | passed |
| Research coverage | `src/lib/research/status.test.ts` | research coverage label > asks for a refresh when research is past the freshness window | passed |
| Research coverage | `src/lib/research/status.test.ts` | research coverage label > asks for a refresh when the price has moved far from the reference, up or down | passed |
| Research coverage | `src/lib/research/status.test.ts` | research coverage label > flags conflicting records with no current version | passed |
| Research coverage | `src/lib/research/status.test.ts` | research coverage label > is current for complete, fresh research near its reference price | passed |
| Research coverage | `src/lib/research/status.test.ts` | research coverage label > marks partial research incomplete, never current | passed |
| Research coverage | `src/lib/research/status.test.ts` | research coverage label > reports no research when nothing is on file | passed |
| Research refresh rules | `src/lib/research/refresh.test.ts` | decideRefresh > asks for a targeted refresh after a new quarterly report | passed |
| Research refresh rules | `src/lib/research/refresh.test.ts` | decideRefresh > flags a price outside the bear-to-bull range | passed |
| Research refresh rules | `src/lib/research/refresh.test.ts` | decideRefresh > ignores filings dated before the research or already reviewed by it | passed |
| Research refresh rules | `src/lib/research/refresh.test.ts` | decideRefresh > is current when nothing changed | passed |
| Research refresh rules | `src/lib/research/refresh.test.ts` | decideRefresh > on the real IREN filing list (as of 2026-11-06) finds no new report or financing after 2026-09-10 | passed |
| Research refresh rules | `src/lib/research/refresh.test.ts` | decideRefresh > records what it could not check instead of passing it | passed |
| Research refresh rules | `src/lib/research/refresh.test.ts` | decideRefresh > requires a full reassessment after a very large drop, without treating it as a buy | passed |
| Risk arithmetic and history | `src/lib/portfolio/risk.test.ts` | history parsing > reads Stooq CSV | passed |
| Risk arithmetic and history | `src/lib/portfolio/risk.test.ts` | history parsing > reads Yahoo daily bars, preferring adjusted closes and skipping gaps | passed |
| Risk arithmetic and history | `src/lib/portfolio/risk.test.ts` | period moves > measures a week of change for symbols and for today's holdings | passed |
| Risk arithmetic and history | `src/lib/portfolio/risk.test.ts` | risk math > aligns and carries forward, using the first close before a late start | passed |
| Risk arithmetic and history | `src/lib/portfolio/risk.test.ts` | risk math > builds a hypothetical series and beta-driven scenarios, leaving cash alone | passed |
| Risk arithmetic and history | `src/lib/portfolio/risk.test.ts` | risk math > computes drawdown, worst window and beta | passed |
| Risk arithmetic and history | `src/lib/portfolio/risk.test.ts` | risk math > does not shock a holding with an assumed beta when its beta cannot be measured | passed |
| Risk arithmetic and history | `src/lib/portfolio/risk.test.ts` | risk math > flags a mix of total-return and price-only histories | passed |
| Risk arithmetic and history | `src/lib/portfolio/risk.test.ts` | risk math > lists holdings with no history instead of inventing it | passed |
| Risk arithmetic and history | `src/lib/portfolio/risk.test.ts` | risk math > matches hand-computed beta and annualised volatility | passed |
| SEC filing check (acceptance) | `src/lib/research/filingCheck.test.ts` | buildFilingCheck on IREN's Q1 FY27 10-Q > cites every source it used | passed |
| SEC filing check (acceptance) | `src/lib/research/filingCheck.test.ts` | buildFilingCheck on IREN's Q1 FY27 10-Q > compares the quarter-end balance sheet with the one the research could have known | passed |
| SEC filing check (acceptance) | `src/lib/research/filingCheck.test.ts` | buildFilingCheck on IREN's Q1 FY27 10-Q > concludes WAIT / REVIEW, citing the refresh rules that fired | passed |
| SEC filing check (acceptance) | `src/lib/research/filingCheck.test.ts` | buildFilingCheck on IREN's Q1 FY27 10-Q > flags dilution and the share count increase as material, with the numbers shown | passed |
| SEC filing check (acceptance) | `src/lib/research/filingCheck.test.ts` | buildFilingCheck on IREN's Q1 FY27 10-Q > lists what it could not find instead of filling it in | passed |
| SEC filing check (acceptance) | `src/lib/research/filingCheck.test.ts` | buildFilingCheck on IREN's Q1 FY27 10-Q > never produces a buy, a target or a valuation | passed |
| SEC filing check (acceptance) | `src/lib/research/filingCheck.test.ts` | buildFilingCheck on IREN's Q1 FY27 10-Q > reconciles net debt exactly to the 10-Q figures ($216m to $4,430m) | passed |
| SEC filing check (acceptance) | `src/lib/research/filingCheck.test.ts` | buildFilingCheck on IREN's Q1 FY27 10-Q > reports revenue and loss as reported facts, not as conclusions | passed |
| SEC filing check (acceptance) | `src/lib/research/filingCheck.test.ts` | buildFilingCheck when inputs are missing > reports a missing tag as a gap and does not compute net debt from partial data | passed |
| SEC filing check (acceptance) | `src/lib/research/filingCheck.test.ts` | buildFilingCheck when inputs are missing > says CURRENT when nothing fired, nothing is material and nothing is missing | passed |
| SEC filing check (acceptance) | `src/lib/research/filingCheck.test.ts` | buildFilingCheck when inputs are missing > stays WAIT / REVIEW and says why when SEC could not be reached | passed |
| SEC filing check (acceptance) | `src/lib/research/filingCheck.test.ts` | buildFilingCheck with no new report > does not invent a gap when the research already covers the newest report | passed |
| SEC filing check (acceptance) | `src/lib/research/filingCheck.test.ts` | chooseReport and instanceFromIndex > finds the extracted XBRL instance in an EDGAR index.json, ignoring linkbases | passed |
| SEC filing check (acceptance) | `src/lib/research/filingCheck.test.ts` | chooseReport and instanceFromIndex > picks the 10-Q filed after the research, not the 10-K the research already covered | passed |
| SEC/RSS parsing | `src/lib/market/feeds.test.ts` | RSS parsing > decodes entities, CDATA and strips tags | passed |
| SEC/RSS parsing | `src/lib/market/feeds.test.ts` | RSS parsing > parses items, splits Google publishers, drops unsafe links and duplicates | passed |
| SEC/RSS parsing | `src/lib/market/feeds.test.ts` | SEC parsing > estimates the next report about a quarter after the last one | passed |
| SEC/RSS parsing | `src/lib/market/feeds.test.ts` | SEC parsing > finds a CIK by ticker | passed |
| SEC/RSS parsing | `src/lib/market/feeds.test.ts` | SEC parsing > lists relevant filings and flags earnings 8-Ks | passed |
| SEC/RSS parsing | `src/lib/market/feeds.test.ts` | SEC parsing > reads the latest balance-sheet value and any unit | passed |
| SEC/RSS parsing | `src/lib/market/feeds.test.ts` | SEC parsing > summarises quarterly, annual, year-over-year and trailing figures | passed |
| Scenario models | `src/lib/research/valuation.test.ts` | research valuation > computes the annualized return at the reference price and date | passed |
| Scenario models | `src/lib/research/valuation.test.ts` | research valuation > finds the price zone | passed |
| Scenario models | `src/lib/research/valuation.test.ts` | research valuation > re-prices at a lower price | passed |
| Scenario models | `src/lib/research/valuation.test.ts` | research valuation > returns nulls for conclusions without a valuation | passed |
| Scenario models | `src/lib/research/valuation.test.ts` | research valuation > uses an explicit terminal date when present | passed |
| Screening | `src/lib/research/screen.test.ts` | screenCompany > flags a cash-burning, diluting company as weak and lists what to verify | passed |
| Screening | `src/lib/research/screen.test.ts` | screenCompany > passes a healthy company to research, without any buy signal | passed |
| Screening | `src/lib/research/screen.test.ts` | screenCompany > says there is not enough data instead of guessing | passed |
| Screening | `src/lib/research/screen.test.ts` | screenCompany > treats a recent prospectus as a filing to read, without claiming dilution | passed |
| XBRL parsing | `src/lib/market/xbrl.test.ts` | parseXbrlInstance > accepts repeated identical facts but refuses conflicting ones | passed |
| XBRL parsing | `src/lib/market/xbrl.test.ts` | parseXbrlInstance > never returns a segment value as the company total | passed |
| XBRL parsing | `src/lib/market/xbrl.test.ts` | parseXbrlInstance > reads numeric facts with their period and unit, skipping text and nil facts | passed |
| XBRL parsing | `src/lib/market/xbrl.test.ts` | parseXbrlInstance > reads the document period | passed |
| XBRL parsing | `src/lib/market/xbrl.test.ts` | parseXbrlInstance > respects the duration window (a quarter is not a year-to-date or annual figure) | passed |
