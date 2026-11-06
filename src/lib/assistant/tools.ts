/**
 * Tools the assistant may call. Every number it can cite comes from one of these,
 * and each result carries its source and timestamp.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace } from "@/lib/workspace";
import { getQuote } from "@/lib/market/quotes";
import { getFilings, getFundamentals } from "@/lib/market/sec";
import { getNews } from "@/lib/market/news";
import { screenCompany } from "@/lib/research/screen";
import { newCapital } from "@/lib/decision/newCapital";
import { expectedReturnAt, repriceCheck, scenarioReturnsAt, zoneFor } from "@/lib/research/valuation";
import { researchAgeDays } from "@/lib/research/records";
import { LOOKTHROUGH_AS_OF } from "@/lib/portfolio/classify";

export const TOOLS: Anthropic.Beta.BetaTool[] = [
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
    description: "Runs the deterministic new-capital engine for an amount in dollars. Compares researched holdings, ETFs, researched new positions, holding cash and trims; checks evidence gates (current holdings, known cash, approved limits, chosen assumptions, current research). Returns status actionable or wait_review, the gates, what to verify, labelled alternatives, and a split that is illustrative when status is wait_review.",
    input_schema: { type: "object", properties: { amount: { type: "number", description: "Dollars" }, source: { type: "string", enum: ["new", "existing"], description: "new = money coming in; existing = cash already held" } }, required: ["amount", "source"], additionalProperties: false },
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
    description: "Recent SEC EDGAR filings for a US-listed company: 10-K, 10-Q, 8-K (with item descriptions; item 2.02 = earnings results), offerings and proxies. Includes the last earnings filing and an ESTIMATED next report date (last + ~91 days, not a confirmed date). Not available for ETFs.",
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
    case "get_research": {
      const sym = String(input.symbol ?? "").toUpperCase();
      const r = ws.research.find((x) => x.symbol === sym);
      if (!r) return { error: `No company record for ${sym}.` };
      const v = r.current ?? r.latest;
      const h = p.holdings.find((x) => x.symbol === sym);
      const q = h ? null : await getQuote(sym);
      const price = h?.price ?? q?.price ?? null;
      const check = v ? repriceCheck(v.parsed, price, researchAgeDays(r, ws.now), ws.policy?.researchFreshnessDays ?? 120) : null;
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
      const source = input.source === "existing" ? "existing" : "new";
      return { layer: "model_output", ...newCapital({ amount, source, portfolio: p, research: ws.research, policy: ws.policy, now: ws.now, quotes: ws.quotes }) };
    }
    case "get_policy": {
      const a = ws.policy?.audit;
      if (!a) return { error: "No versioned policy rules loaded." };
      const rule = (r: import("@/lib/policy/rules").PolicyRuleRow | null) => r && ({ source: r.source_label, source_date: r.source_date, source_status: r.source_status, approval: r.approval, normal: [r.normal_low, r.normal_high], high_conviction: [r.high_conviction_low, r.high_conviction_high], hard_max: r.hard_max, value: r.value, conditions: r.conditions, note: r.approval_note });
      return {
        layer: "policy",
        conflicts: a.conflicts.map((c) => ({ subject: c.subject, differences: c.differences, using_meanwhile: rule(c.used), candidates: c.candidates.map(rule) })),
        subjects: a.subjects.map((s) => ({ scope: s.scope, subject: s.subject, status: s.status, in_use: rule(s.used), superseded: s.history.map(rule) })),
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
