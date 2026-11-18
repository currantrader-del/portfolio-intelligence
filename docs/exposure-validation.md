# Exposure look-through: validation on the real portfolio (2026-11-08)

Holdings: latest statements plus recorded trades, read from the app database on 2026-11-08 (Acorns Invest and Acorns Later at 2026-09-30 plus the ledger to 2026-11-03; Schwab at 2026-10-31 plus the 2026-11-05 VXUS/AVUV buys), valued at statement or trade prices. USAA savings is the protected reserve and is excluded. Investable capital $40,179; stocks $39,110. Fixture: `src/lib/exposure/__fixtures__/portfolio-2026-11-07.ts`. Tests: `src/lib/exposure/*.test.ts` (20 tests).

Percentages below are of investable capital unless marked "of stocks".

| Question | Answer | How it is made up |
|---|---|---|
| Semiconductors | 22.7%, up to 33.3% | NVDA $5,946 direct; VOO $2,217 (NVDA, AVGO, MU, AMD, INTC, LRCX, AMAT); VWO $473, VXUS $307, IXUS $169 (TSMC, SK hynix, ASML, MediaTek...). The range adds fund technology holdings not itemized by the sources. |
| AI infrastructure (theme) | 26.4%, up to 37% | NVDA and IREN direct; VOO's chip makers; TSMC, SK hynix, Samsung, ASML, Delta, Foxconn through the international funds |
| US technology | 38.2% | NVDA $5,946, VOO $5,358, NOW $2,102, IREN $1,533, IONQ $300, IJH $76, IJR $39 |
| China / Taiwan / Japan | 2.5% / 3.4% / 2.3% | All through VWO, VXUS and IXUS; none owned directly |
| NVIDIA (company) | 17.6% vs your 18% max | $5,946 direct + $1,132 through VOO (8.39% of VOO). The old look-through table used 7.5%, which understated it. |
| Alphabet (company) | 6.7% vs 10% max | $1,960 direct + $745 through VOO (Class A + C, 5.52%) |
| Technology sector | 44.2% of stocks vs 31.2% for MSCI ACWI | Direct 25.3% of stocks, funds 19.0% |
| US / developed / emerging | 78.9% / 7.4% / 9.8% of stocks | 3.9% of stocks sits in fund countries the sources don't itemize |

Checks the tests enforce: every split (sector, industry, country, market, region, size, style, cycle, company) adds up to 100% of stocks with an explicit "not itemized" remainder; no fund is ever counted next to its own holdings; themes are marked non-additive; share classes merge (GOOG + GOOGL); a sector fund's published industry split replaces its top holdings; a country already listed by a fund never receives that fund's unlisted remainder; fund data older than 75 days is flagged; alerts fire only for approved limits.

Known gaps: AVUV publishes no sector split (only its 15 largest holdings are classified); VXUS, VWO and IXUS list only their largest countries; VOO's industries beyond its 25 largest holdings are known only by sector, hence the ranges. Fund data refresh is manual (issuer fact sheets, monthly).
