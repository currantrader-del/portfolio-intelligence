/**
 * Tools the assistant may call. Every number it can cite comes from one of these,
 * and each result carries its source and timestamp.
 */
import { ALTERNATIVES } from "@/lib/policy/evidence";
import { RETIRED_WHY } from "@/lib/policy/rules";
import { AGE_REMINDER_DAYS } from "@/lib/policy/limits";
import { loadDecisionFilings } from "@/lib/alerts/events";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace } from "@/lib/workspace-core";
import { getQuote } from "@/lib/market/quotes";
import { getFilings, getFundamentals } from "@/lib/market/sec";
import { getNews } from "@/lib/market/news";
import { screenCompany } from "@/lib/research/screen";
import { getHistories } from "@/lib/market/history";
import { buildRisk } from "@/lib/portfolio/risk";
import { loadEventAlerts } from "@/lib/alerts/events";
import { newCapital, parseSource, ruleRowsOf } from "@/lib/decision/newCapital";
import { expectedReturnAt, repriceCheck, scenarioReturnsAt, zoneFor } from "@/lib/research/valuation";
import { researchAgeDays } from "@/lib/research/records";
import { LOOKTHROUGH_AS_OF } from "@/lib/portfolio/classify";
import { getSecProfile } from "@/lib/market/sec";
import { computeExposure, describeSecurity, queryExposure, type DimensionKey } from "@/lib/exposure/engine";
import { checkLimits, NOT_PROPOSED, PROPOSALS } from "@/lib/exposure/limits";
import { BENCHMARK, THEMES } from "@/lib/exposure/reference";

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_exposure",
    description: "The portfolio's TRUE exposure with ETF look-through, split into direct (shares owned) and indirect (through funds), with each fund's dated source. Dimensions: asset (stocks/bonds/cash), sector (11 GICS sectors vs MSCI ACWI), industry (e.g. Semiconductors & Semiconductor Equipment, Software), theme (AI infrastructure, AI platforms and hyperscalers, Software and cloud, Digital advertising, Speculative / early-stage tech, Bitcoin mining; themes overlap and must not be added), country, market (US / Developed ex-US / Emerging), region (North America, Europe, Asia-Pacific...), size, style (growth/value), cycle (cyclical/sensitive/defensive), company. Industry and theme figures are lower bounds with an 'up to' upper bound. Optional filters combine dimensions (e.g. country 'United States' + sector 'Information Technology' = US technology; country 'Taiwan' + industry semis). Optional what_if adds a hypothetical purchase (any ticker the app has classified) and returns before/after against the exposure limits. Also returns fund overlaps, top-10 company concentration, interest-rate sensitivity, the exposure limits (approved or proposed) and data gaps. Use for any question about how much of the portfolio is in a sector, industry, theme, country or company.",
    input_schema: { type: "object", properties: {
      dimension: { type: "string", enum: ["all", "asset", "sector", "industry", "theme", "country", "market", "region", "size", "style", "cycle", "company"], description: "Which split to return in full; 'all' returns the top lines of every split." },
      country: { type: "string", description: "Filter, e.g. 'United States', 'Taiwan', 'China', 'Japan'; empty for none" },
      market: { type: "string", description: "Filter: 'US', 'Developed ex-US' or 'Emerging'; empty for none" },
      sector: { type: "string", description: "Filter: a GICS sector name; empty for none" },
      industry: { type: "string", description: "Filter: a GICS industry name; empty for none" },
      theme: { type: "string", description: "Filter: a theme label; empty for none" },
      company: { type: "string", description: "Filter: a ticker; empty for none" },
      what_if_symbol: { type: "string", description: "Ticker of a hypothetical purchase; empty for none" },
      what_if_dollars: { type: "number", description: "Dollars of the hypothetical purchase, paid from cash; 0 for none" },
    }, required: ["dimension", "country", "market", "sector", "industry", "theme", "company", "what_if_symbol", "what_if_dollars"], additionalProperties: false },
    strict: true,
  },
  {
    name: "classify_security",
    description: "How the app classifies any ticker for exposure: for a fund, its published sector, country and largest-holding weights with source dates; for a company, its GICS-style sector, industry, home market, size, style and themes. For a ticker the app has not classified, returns SEC EDGAR's SIC industry code and location; then use web_search for the fund's holdings or the company's business before drawing conclusions.",
    input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_portfolio",
    description: "Current holdings across all accounts with weights, today's move, contribution to the portfolio's move, cost basis, policy buckets and single-company exposure including ETF look-through. Use for any question about what is owned or how the portfolio is doing.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_research",
    description: "The stored research conclusion for one company: action, classification, confidence, thesis, scenarios, price bands, completeness, age, and the same valuation re-priced at today's price.",
    input_schema: { type: "object", properties: { symbol: { type: "string", description: "Ticker symbol" } }, required: ["symbol"], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_research_phase",
    description: "Full text of one research phase (1-6) for a company, for questions about the detailed reasoning. Text may be long; quote only what is relevant.",
    input_schema: { type: "object", properties: { symbol: { type: "string" }, phase: { type: "integer", description: "1 to 6" } }, required: ["symbol", "phase"], additionalProperties: false },
    strict: true,
  },
  {
    name: "simulate_new_capital",
    description: "Runs the deterministic new-capital engine for an amount in dollars. Compares researched holdings, diversified ETFs (VOO, VXUS, AVUV), researched new positions, keeping cash and trims, including each option's effect on total-portfolio exposure (NVIDIA look-through, technology, semiconductors, AI infrastructure, US share, emerging markets). Returns status ready (verified money, verified holdings and balances, no unresolved material development: the split can be executed) or conditional (the recommendation and split stand, but only as what to do once the open conditions are met; never present it as an order). Planned money that has not been deposited is always conditional; cash already held is capped at what is deployable after the protected reserve. Each stock carries the research conclusion as written and today's recommendation: when price, valuation, results, filings or financing changed since the research, it says reassess first. Few-year stock cases vs 10-15-year index forecasts are approximate context, not pass/fail.",
    input_schema: { type: "object", properties: { amount: { type: "number", description: "Dollars" }, source: { type: "string", enum: ["planned", "deposited", "existing"], description: "planned = new money not yet deposited (default when unsure); deposited = new money the user says has arrived; existing = cash already held" }, holdings_confirmed: { type: "boolean", description: "Only true if the user said in this conversation that they checked today that their holdings and balances match their broker accounts" } }, required: ["amount", "source"], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_policy",
    description: "The investment policy as versioned rules: for each company, bucket and assumption, the rule in use, its source and date, its approval status (approved, conflict, placeholder), competing candidates and superseded history. Use for any question about limits, ranges, reserves or assumptions.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_alerts",
    description: "Current monitoring alerts ranked by severity (price bands, big moves, limits, stale or conflicting research, stale holdings).",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_quote",
    description: "Latest delayed quote for any ticker, including ones not held.",
    input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_filings",
    description: "Recent SEC EDGAR filings for a US-listed company: 10-K, 10-Q, 8-K (with item descriptions; item 2.02 = earnings results), registrations, prospectuses and proxies, each with a category and a note on what the form alone does and does not show. Includes the last earnings filing and an ESTIMATED next report date (last + ~91 days, not a confirmed date). Not available for ETFs.",
    input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_fundamentals",
    description: "Reported financials from SEC XBRL data: revenue, operating income, net income, diluted EPS, operating cash flow, capital spending (latest quarter, same quarter last year, year-over-year change, latest fiscal year, trailing 12 months) plus cash, long-term debt and shares outstanding. Each figure has its period end and filing date.",
    input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_risk",
    description: "HYPOTHETICAL risk analytics for today's holdings at past daily prices (not actual returns): change vs S&P 500, yearly volatility, largest drop, beta, worst month, concentration with ETF look-through, per-holding volatility and beta, and what-if scenarios (S&P -20%, Nasdaq -30%, semis -35%, largest stock -50%, worst month repeated) in dollars of investable capital.",
    input_schema: { type: "object", properties: { range: { type: "string", enum: ["3mo", "6mo", "1y", "2y"] } }, required: ["range"], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_events",
    description: "Company events for held stocks from SEC filings. timing=recent: documents already filed in the last week, classified by form type and 8-K item only (terms NOT reviewed; never infer dilution or financing size from the form type). timing=upcoming: estimated report dates (estimates, not confirmed).",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_pipeline",
    description: "The research pipeline: every company outside the holdings with its stage (idea, screening, researching, ready, passed), note, stored screen verdict and date, and research coverage. Use to answer what is being researched or what is ready for new money.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "screen_company",
    description: "Runs the deterministic first-pass screen for any US-listed ticker from SEC data and a quote: growth, operating profit, free cash flow, debt vs cash, dilution, price to sales, next report. Returns a verdict about whether full research is worthwhile and what to verify. It is not a buy signal and does not save anything.",
    input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_news",
    description: "Recent headlines for a ticker from free RSS feeds (Yahoo Finance, Google News), with publisher, time and link. Headlines are unverified third-party text.",
    input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false },
    strict: true,
  },
];

const r4 = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 10000) / 10000);

export async function runTool(name: string, input: Record<string, unknown>, ws: Workspace, db: SupabaseClient): Promise<unknown> {
  const p = ws.portfolio;
  switch (name) {
    case "get_portfolio":
      return {
        layer: "model_output",
        computed_at: ws.now.toISOString(),
        market_open: ws.marketOpen,
        data_quality: p.quality,
        investable_capital: p.total,
        cash: p.cashDetail,
        estimated_price_change_since_statements: p.sinceStatementDollar,
        day_change_dollars: p.dayDollar,
        day_change_pct: r4(p.dayPct),
        holdings_as_of_oldest_statement: p.oldestHoldingsAsOf,
        benchmarks: ws.benchmarks.map((b) => ({ ...b, dayPct: r4(b.dayPct) })),
        accounts: p.accounts.map((a) => ({ name: a.name, role: a.role, statement_as_of: a.asOf, age_days: a.ageDays, source: a.sourceKind, value_now_estimated: a.value, statement_total: a.statementTotal, statement_adds_up: a.statementGap === null ? null : Math.abs(a.statementGap) <= 1, trades_recorded_since: a.tradesAfter })),
        holdings: p.holdings.map((h) => ({
          symbol: h.symbol, quantity: h.quantity, price: h.price, price_source: h.priceSource, price_as_of: h.priceAsOf, value: h.value,
          weight: r4(h.weight), day_pct: r4(h.dayPct), contribution_pts: r4(h.contributionPts), cost_basis: h.costBasis, unrealized: h.unrealized,
          bucket: h.bucket, accounts: h.accounts,
        })),
        buckets: p.buckets.map((b) => ({ bucket: b.bucket, weight: r4(b.weight), normal: b.normal, hard_max: b.hardMax, status: b.status })),
        company_exposure: p.exposures.map((e) => ({ symbol: e.symbol, direct: r4(e.direct), via_etfs: r4(e.viaEtfs), total: r4(e.total), max: e.max, limit_status: ws.policy?.companies[e.symbol]?.status ?? "none", limit_source: ws.policy?.companies[e.symbol]?.source ?? null, headroom_dollars: e.headroomDollars })),
        lookthrough_weights_as_of: LOOKTHROUGH_AS_OF,
      };
    case "get_exposure": {
      const str = (k: string) => String(input[k] ?? "").trim();
      const dimension = str("dimension") || "all";
      const filters = Object.fromEntries(["country", "market", "sector", "industry", "theme", "company"].map((k) => [k, str(k)]).filter(([, v]) => v));
      const holdings = p.holdings.map((h) => ({ symbol: h.symbol, value: h.value }));
      const onFile = ws.policy?.audit?.subjects.flatMap((s) => [...(s.approvedRow ? [s.approvedRow] : []), ...s.candidates]) ?? [];
      // Until the drafted limits are sent to Policy, test what-ifs against the drafts (reported as "proposed").
      const rules = onFile.some((r) => r.subject.startsWith("exposure:")) ? onFile : PROPOSALS.map((x) => ({ scope: "portfolio" as const, subject: x.subject, approval: "proposed" as const, normal_low: x.normal?.low ?? null, normal_high: x.normal?.high ?? null, value: x.review, hard_max: x.ceiling }));
      const rep = ws.exposure;
      const pick = (k: DimensionKey, n: number) => { const d = rep.dims[k]; return { label: d.label, base: d.base, base_value: d.baseValue, additive: d.additive, not_itemized_pct: r4(d.notItemizedPct), notes: d.notes, lines: d.lines.slice(0, n).map((l) => ({ key: l.key, pct: r4(l.pct), up_to_pct: l.upperPct !== undefined ? r4(l.upperPct) : undefined, direct: l.direct, through_funds: l.indirect, benchmark_pct: l.benchmarkPct ?? undefined, from: l.contributors.slice(0, 6) })) }; };
      const dims = dimension === "all" ? Object.fromEntries((Object.keys(rep.dims) as DimensionKey[]).map((k) => [k, pick(k, k === "company" ? 12 : 8)])) : { [dimension]: pick(dimension as DimensionKey, 40) };
      const wSym = str("what_if_symbol").toUpperCase(), wAmt = Number(input.what_if_dollars ?? 0);
      let whatIf: unknown = null;
      if (wSym && wAmt > 0) {
        const after = computeExposure([...holdings, { symbol: wSym, value: wAmt }], Math.max(0, p.cash - wAmt), ws.now);
        const known = describeSecurity(wSym);
        whatIf = {
          purchase: { symbol: wSym, dollars: wAmt, classified: !!known, note: known ? null : `${wSym} is not classified by the app, so it only shows up as 'not itemized'; use classify_security and web_search to judge its exposure.` },
          limits_after: checkLimits(after, rules).map((c) => ({ subject: c.subject, status: c.status, value: r4(c.value), up_to: c.upper !== null ? r4(c.upper) : null, state: c.state, message: c.message })),
          filter_after: Object.keys(filters).length ? queryExposure([...holdings, { symbol: wSym, value: wAmt }], Math.max(0, p.cash - wAmt), filters) : null,
        };
      }
      return {
        layer: "model_output", computed_at: rep.computedAt, holdings_quality: p.quality.status,
        method: "Direct holdings at their value; each fund split by its published sector, country and largest-holding weights. Each dimension adds to 100% of stocks with a 'not itemized' remainder, except themes, which overlap.",
        investable_capital: rep.investable, stocks: rep.equity, bonds: rep.bonds, cash: rep.cash,
        filter_result: Object.keys(filters).length ? { filters, ...queryExposure(holdings, p.cash, filters) } : null,
        what_if: whatIf,
        dimensions: dims,
        themes_defined: Object.values(THEMES),
        fund_overlaps: rep.overlaps,
        top10_companies: { pct_of_stocks: r4(rep.concentration.top10Pct), list: rep.concentration.top10.map((x) => ({ ...x, pct: r4(x.pct) })), msci_acwi_top10: BENCHMARK.top10 },
        interest_rates: rep.rates,
        limits: ws.exposureLimits.map((c) => ({ subject: c.subject, status: c.status, value_pct_of_investable: r4(c.value), up_to: c.upper !== null ? r4(c.upper) : null, normal: c.normal, review_above: c.review, ceiling: c.ceiling, state: c.state, message: c.message })),
        limits_proposed_in_app: ws.exposureLimits.length ? undefined : PROPOSALS.map((x) => ({ subject: x.subject, review: x.review, ceiling: x.ceiling, normal: x.normal, evidence: x.evidence, why: x.why, status: "drafted, not yet sent for approval" })),
        not_limited_and_why: NOT_PROPOSED,
        sources: rep.sources.map((s) => ({ fund: s.fund, what: s.what, source: s.source.label, url: s.source.url, as_of: s.source.asOf, age_days: s.ageDays, stale: s.stale })),
        gaps: rep.gaps,
      };
    }
    case "classify_security": {
      const sym = String(input.symbol ?? "").toUpperCase();
      const known = describeSecurity(sym);
      if (known) return { layer: "reference_data", ...known, note: known.kind === "fund" ? "Fund weights are as of the source dates shown; check them before relying on small differences." : "Classification is the app's GICS-style label." };
      const sec = await getSecProfile(sym);
      return { layer: "sec_edgar", symbol: sym, classified_by_app: false, sec, next_step: "Not in the app's reference data. For a fund, search the issuer's holdings page for sector and country weights and the largest holdings (with their date). For a company, confirm its business from its 10-K before assigning a sector or theme." };
    }
    case "get_research": {
      const sym = String(input.symbol ?? "").toUpperCase();
      const r = ws.research.find((x) => x.symbol === sym);
      if (!r) return { error: `No company record for ${sym}.` };
      const v = r.current ?? r.latest;
      const h = p.holdings.find((x) => x.symbol === sym);
      const q = h ? null : await getQuote(sym);
      const price = h?.price ?? q?.price ?? null;
      const check = v ? repriceCheck(v.parsed, price, researchAgeDays(r, ws.now), AGE_REMINDER_DAYS) : null;
      return {
        layer: "research_conclusion",
        symbol: sym,
        name: r.name,
        watchlist_status: r.watchlistStatus,
        conflict: r.conflict,
        versions: r.versions,
        is_current: !!r.current,
        research_as_of: v?.research_as_of ?? null,
        age_days: researchAgeDays(r, ws.now),
        completeness: v?.completeness ?? null,
        origin: v?.origin ?? null,
        conclusion: v ? { action: v.parsed.action, classification: v.parsed.classification, confidence: v.parsed.confidence, thesis: v.parsed.thesis, reference_price: v.parsed.referencePrice, reference_date: v.parsed.referenceDate, scenarios: v.parsed.scenarios, weighted_value: v.parsed.weightedValue, horizon: v.parsed.horizonDate, price_bands: v.parsed.zones.map((z) => ({ band: z.label, action: z.action })), allocation: v.parsed.allocation } : null,
        at_today_price: v && price ? {
          layer: "model_output",
          price, price_source: h?.priceSource ?? (q ? "quote" : null),
          repriced: !!check?.ok,
          not_repriced_reason: check?.reason ?? null,
          expected_annual_return: check?.ok ? r4(expectedReturnAt(v.parsed, price, ws.now)) : null,
          scenario_annual_returns: check?.ok ? scenarioReturnsAt(v.parsed, price, ws.now).map((s) => ({ name: s.name, probability: s.probability, annualized: r4(s.annualized) })) : [],
          band: zoneFor(v.parsed.zones, price)?.label ?? null,
        } : null,
      };
    }
    case "get_research_phase": {
      const sym = String(input.symbol ?? "").toUpperCase();
      const phase = Number(input.phase);
      const r = ws.research.find((x) => x.symbol === sym);
      const vid = (r?.current ?? r?.latest)?.id;
      if (!vid) return { error: `No research for ${sym}.` };
      const { data } = await db.from("research_phases").select("phase_number, title, extraction, body_markdown").eq("version_id", vid).eq("phase_number", phase).maybeSingle();
      if (!data) return { error: `Phase ${phase} not stored for ${sym}.` };
      const body = data.body_markdown ?? "";
      return { layer: "research_conclusion", symbol: sym, phase, title: data.title, extraction: data.extraction, text: body.length > 24000 ? body.slice(0, 24000) + "\n[truncated]" : body };
    }
    case "simulate_new_capital": {
      const amount = Number(input.amount);
      if (!(amount > 0)) return { error: "amount must be positive" };
      const source = parseSource(input.source);
      const filings = await loadDecisionFilings(ws);
      return { layer: "model_output", ...newCapital({ amount, source, holdingsConfirmed: input.holdings_confirmed === true, portfolio: p, research: ws.research, policy: ws.policy, now: ws.now, quotes: ws.quotes, filings, yields: ws.yields, rules: ruleRowsOf(ws.policy) }) };
    }
    case "get_policy": {
      const a = ws.policy?.audit;
      if (!a) return { error: "No versioned policy rules loaded." };
      const rule = (r: import("@/lib/policy/rules").PolicyRuleRow | null) => r && ({ source: r.source_label, source_date: r.source_date, source_status: r.source_status, approval: r.approval, normal: [r.normal_low, r.normal_high], high_conviction: [r.high_conviction_low, r.high_conviction_high], hard_max: r.hard_max, value: r.value, conditions: r.conditions, note: r.approval_note });
      return {
        layer: "policy",
        conflicts: a.conflicts.map((c) => ({ subject: c.subject, differences: c.differences, using_meanwhile: rule(c.used), candidates: c.candidates.map(rule) })),
        subjects: a.subjects.map((s) => ({ scope: s.scope, subject: s.subject, status: s.status, authority: s.authority, in_use: rule(s.used), superseded: s.history.map(rule) })),
        open_decisions: a.decisions.map((s) => s.subject),
        imported_not_confirmed: a.imported.map((s) => s.subject),
        alternatives: ALTERNATIVES.map((x) => ({ symbol: x.symbol, forecasts: x.forecasts.map((f) => ({ firm: f.firm, asset: f.asset, low: f.low, high: f.high, kind: f.kind, horizon_years: f.horizonYears, as_of: f.asOf, method: f.method })) })),
        retired: a.retired.map((r) => ({ subject: r.subject, why: RETIRED_WHY[r.subject] ?? null })),
        note: "authority 'you' = approved by the investor in the app; 'imported' = marked approved in the old archive only. Companies without their own limit get no new money.",
      };
    }
    case "get_alerts":
      return { layer: "model_output", computed_at: ws.now.toISOString(), alerts: ws.alerts };
    case "get_quote": {
      const sym = String(input.symbol ?? "").toUpperCase();
      const q = ws.quotes.get(sym) ?? (await getQuote(sym));
      return q ? { layer: "market_data", ...q } : { error: `No quote available for ${sym}.` };
    }
    case "get_filings": {
      const sym = String(input.symbol ?? "").toUpperCase();
      const r = await getFilings(sym, ws.now);
      return "error" in r ? r : { layer: "external_data", provider: "SEC EDGAR", note: "nextEarningsEstimate is an estimate, not a confirmed date", ...r };
    }
    case "get_fundamentals": {
      const sym = String(input.symbol ?? "").toUpperCase();
      const r = await getFundamentals(sym);
      if ("error" in r) return r;
      return {
        layer: "external_data",
        source: "SEC EDGAR XBRL (as reported)",
        company: r.company,
        fetched_at: r.fetchedAt,
        missing: r.missing,
        metrics: r.metrics.map((m) => ({ metric: m.label, unit: m.unit, latest_quarter: m.latestQuarter, year_ago_quarter: m.yearAgoQuarter, yoy_change: r4(m.yoy), latest_fiscal_year: m.latestAnnual, trailing_12m: m.ttm, latest: m.latest })),
      };
    }
    case "get_risk": {
      const range = (["3mo", "6mo", "1y", "2y"].includes(String(input.range)) ? input.range : "1y") as "3mo" | "6mo" | "1y" | "2y";
      const histories = await getHistories([...p.holdings.map((h) => h.symbol), "SPY", "QQQ", "SOXX"], range);
      const r = buildRisk({ positions: p.holdings.map((h) => ({ symbol: h.symbol, quantity: h.quantity, value: h.value })), cash: p.cash, investable: p.total, histories, exposures: p.exposures.map((e) => ({ symbol: e.symbol, total: e.total })) });
      return {
        layer: "model_output",
        label: "Hypothetical: today's holdings at past prices. Not the person's actual return.",
        range, start: r.start, as_of: r.asOf, stats: r.stats, concentration: r.concentration,
        holdings: r.holdings.map((h) => ({ ...h, weight: r4(h.weight), vol: r4(h.vol), beta: r4(h.beta), ret: r4(h.ret), maxDrawdown: r4(h.maxDrawdown) })),
        scenarios: r.scenarios.map((s) => ({ name: s.name, basis: s.basis, dollars: Math.round(s.dollars), pct: r4(s.pct), worst_lines: s.lines.slice(0, 5) })),
        missing_history: r.missing, partial_history: r.partial,
      };
    }
    case "get_events": {
      const { alerts } = await loadEventAlerts(p.holdings.map((h) => h.symbol), ws.now);
      return { layer: "external_data", provider: "SEC EDGAR", events: alerts.map((a) => ({ symbol: a.symbol, timing: a.timing, severity: a.severity, title: a.title, detail: a.detail, source: a.source })) };
    }
    case "get_pipeline": {
      const held = new Set(p.holdings.map((h) => h.symbol));
      return {
        layer: "research",
        companies: ws.research.filter((r) => !held.has(r.symbol)).map((r) => ({
          symbol: r.symbol, name: r.name, stage: r.pipeline.stage === "owned" ? "researching" : r.pipeline.stage, note: r.pipeline.note, stage_since: r.pipeline.stageUpdatedAt,
          screen: r.pipeline.screen ? { verdict: r.pipeline.screen.verdict, screened_at: r.pipeline.screenedAt, to_verify: r.pipeline.screen.toVerify } : null,
          research_as_of: (r.current ?? r.latest)?.research_as_of ?? null, research_completeness: (r.current ?? r.latest)?.completeness ?? null, conflict: r.conflict,
        })),
      };
    }
    case "screen_company": {
      const sym = String(input.symbol ?? "").toUpperCase();
      const [fundamentals, filings, q] = await Promise.all([getFundamentals(sym), getFilings(sym, ws.now), ws.quotes.get(sym) ? Promise.resolve(ws.quotes.get(sym)!) : getQuote(sym)]);
      return { layer: "model_output", note: "Screening defaults, not policy. Decides whether to research, never whether to buy.", ...screenCompany({ symbol: sym, fundamentals, filings: "error" in filings ? null : filings, price: q?.price ?? null, priceAsOf: q?.asOf ?? null, now: ws.now }) };
    }
    case "get_news": {
      const sym = String(input.symbol ?? "").toUpperCase();
      const name = ws.research.find((x) => x.symbol === sym)?.name ?? null;
      const r = await getNews(sym, name);
      return "error" in r ? r : { layer: "external_data", note: "Unverified headlines. Cite them as headlines with publisher and date; do not treat them as confirmed facts.", ...r };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}
