/**
 * Local design fixture: SYNTHETIC tickers and values only, for checking layouts with
 * `PI_FIXTURE=1 next dev` when Supabase and market data are out of reach.
 * It can never switch on in a production build (NODE_ENV is "production" there).
 */
import type { Quote } from "@/lib/market/quotes";
import type { History, Range } from "@/lib/market/history";
import type { FilingsResult, Fundamentals, Metric } from "@/lib/market/sec";
import { classifyFiling } from "@/lib/market/filingClass";
import type { NewsResult } from "@/lib/market/news";

export const FIXTURE = process.env.NODE_ENV !== "production" && process.env.PI_FIXTURE === "1";

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const ago = (days: number) => iso(new Date(Date.now() - days * DAY));

/* ------------------------------------------------------------------ prices */

// symbol: [price, previous close]
const PRICES: Record<string, [number, number]> = {
  VOO: [612.4, 609.3], VXUS: [71.2, 71.5], AVUV: [98.1, 97.6],
  ACME: [182.5, 179.1], BOLT: [38.6, 40.3], CRWN: [214.0, 215.9], DYNA: [96.3, 95.8],
  SPY: [668.2, 664.9], QQQ: [598.7, 594.6], SOXX: [281.4, 284.8],
  NEWCO: [44.0, 43.1],
  ACME270115C00175000: [11.9, 11.2],
};

export function fixtureQuote(symbol: string): Quote | null {
  const p = PRICES[symbol.toUpperCase()];
  if (!p) return null;
  return { symbol: symbol.toUpperCase(), price: p[0], prevClose: p[1], asOf: new Date(Date.now() - 16 * 60_000).toISOString(), provider: "yahoo", delayClass: "delayed" };
}

/** Deterministic random walk ending at today's price. */
export function fixtureHistory(symbol: string, range: Range): History | null {
  const p = PRICES[symbol.toUpperCase()];
  if (!p) return null;
  const days = { "3mo": 63, "6mo": 126, "1y": 252, "2y": 504, "5y": 1260 }[range];
  const vol = { BOLT: 0.045, ACME: 0.028, CRWN: 0.022, DYNA: 0.02, SOXX: 0.024, QQQ: 0.014 }[symbol.toUpperCase()] ?? 0.01;
  let seed = [...symbol].reduce((a, c) => a + c.charCodeAt(0), 7);
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280) - 0.5;
  const rets = Array.from({ length: days }, () => rnd() * vol * 2.2 + 0.0004);
  const closes: number[] = [p[0]];
  for (let i = rets.length - 1; i > 0; i--) closes.unshift(closes[0] / (1 + rets[i]));
  const bars: History["bars"] = [];
  let d = new Date();
  for (let i = closes.length - 1; i >= 0; i--) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() - DAY);
    bars.unshift({ date: iso(d), close: +closes[i].toFixed(2) });
    d = new Date(d.getTime() - DAY);
  }
  return { symbol: symbol.toUpperCase(), bars, provider: "yahoo", adjusted: true, fetchedAt: new Date().toISOString() };
}

/* ------------------------------------------------------------------ SEC and news */

export function fixtureFilings(symbol: string): FilingsResult | { error: string } {
  if (!["ACME", "BOLT", "CRWN", "DYNA", "NEWCO"].includes(symbol)) return { error: "no SEC filer for this symbol" };
  const f = (form: string, days: number, description: string, isEarnings = false, items: string[] = []) => ({ form, filed: ago(days), reportDate: null, description, items, isEarnings, url: "https://www.sec.gov/", ...classifyFiling(form, items) });
  const filings = symbol === "BOLT"
    ? [f("424B5", 1, "Prospectus supplement (share offering)"), f("8-K", 9, "Results of operations", true, ["2.02"]), f("10-Q", 9, "Quarterly report")]
    : [f("8-K", 70, "Results of operations", true, ["2.02"]), f("10-Q", 69, "Quarterly report"), f("4", 20, "Insider transaction")];
  const last = filings.find((x) => x.isEarnings) ?? null;
  return { cik: "0000000000", company: `${symbol} Sample Corp`, filings, lastEarnings: last, nextEarningsEstimate: symbol === "BOLT" ? ago(-82) : ago(-(91 - 70)), source: "SEC EDGAR (sample)", fetchedAt: new Date().toISOString() };
}

export function fixtureFundamentals(symbol: string): Fundamentals | { error: string } {
  if (!["ACME", "BOLT", "CRWN", "DYNA", "NEWCO"].includes(symbol)) return { error: "no SEC filer for this symbol" };
  const per = (end: number, value: number, start?: number) => ({ start: start === undefined ? null : ago(start), end: ago(end), value, form: "10-Q", filed: ago(end - 30) });
  const m = (key: string, label: string, unit: Metric["unit"], q: number, yoy: number | null, ttm: number | null, instant = false): Metric => ({
    key, label, unit, tag: key, latestQuarter: instant ? null : per(100, q, 191), yearAgoQuarter: null, yoy, latestAnnual: null, ttm, latest: per(100, q),
  });
  const big = symbol === "ACME" ? 1 : symbol === "BOLT" ? 0.02 : 0.3;
  return {
    cik: "0000000000", company: `${symbol} Sample Corp`, source: "SEC XBRL (sample)", fetchedAt: new Date().toISOString(), missing: [],
    metrics: [
      m("revenue", "Revenue", "USD", 41.2e9 * big, 0.48, 152e9 * big),
      m("operating_income", "Operating income", "USD", 24.9e9 * big, 0.52, 90e9 * big),
      m("net_income", "Net income", "USD", 21.1e9 * big, 0.5, 78e9 * big),
      m("eps", "Diluted EPS", "USD/share", 0.86, 0.49, 3.2),
      m("ocf", "Operating cash flow", "USD", 23e9 * big, 0.4, 80e9 * big),
      m("capex", "Capital spending", "USD", -1.9e9 * big, 0.3, -6e9 * big),
      m("cash", "Cash and equivalents", "USD", 38e9 * big, null, null, true),
      m("debt", "Long-term debt", "USD", 8.4e9 * big, null, null, true),
      m("shares", "Shares outstanding", "shares", 24.3e9 * big, symbol === "BOLT" ? 0.19 : -0.008, null, true),
    ],
  };
}

export function fixtureNews(symbol: string): NewsResult {
  return {
    symbol, feed: "Sample feed", fetchedAt: new Date().toISOString(),
    headlines: [
      { title: `${symbol} shares move as investors weigh sector rotation`, url: "https://example.com/1", publisher: "Sample Wire", publishedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), feed: "yahoo" },
      { title: `Analysts debate ${symbol}'s next quarter after a strong run`, url: "https://example.com/2", publisher: "Sample Markets", publishedAt: new Date(Date.now() - 26 * 3600_000).toISOString(), feed: "yahoo" },
    ],
  };
}

/* ------------------------------------------------------------------ database */

const conclusion = (o: { action: string; cls: string; conf: string; ref: number; refDate: string; bear: number; base: number; bull: number; zones: [string, string][]; thesis?: string }) => ({
  action: o.action, classification: o.cls, confidence: o.conf, reference_price: `$${o.ref}`, reference_date: o.refDate, thesis: o.thesis ?? null,
  valuation: { approx_holding_period_years: 3, bear_value: o.bear, base_value: o.base, bull_value: o.bull, bear_probability: 0.25, base_probability: 0.5, bull_probability: 0.25 },
  price_framework: o.zones.map(([price_zone, action]) => ({ price_zone, action })),
});

const phases = (n: number) => Array.from({ length: n }, (_, i) => ({ phase_number: i + 1, title: ["Business", "Moat", "Financials", "Valuation", "Risks", "Decision"][i], extraction: i < 3 ? "verbatim" : "reconstructed", body_markdown: "Sample research text for layout checks." }));

const version = (id: string, asOf: string, c: ReturnType<typeof conclusion>, completeness = "complete", is_current = true, n = 6) => ({
  id, research_as_of: asOf, completeness, origin: "chatgpt_original", is_current, conclusion: c, change_summary: null,
  source_documents: { file_name: `${id}.md`, sha256: "0".repeat(64) }, research_phases: phases(n),
});

function tables(): Record<string, Record<string, unknown>[]> {
  const stmt = ago(7);
  const old = ago(38);
  const pipe = (stage: string, note: string | null = null) => ({ pipeline_stage: stage, pipeline_note: note, stage_updated_at: ago(5), stage_history: [], screen: null, screened_at: null });
  return {
    accounts: [
      { id: "acc-1", name: "Sample Brokerage", account_role: "taxable_brokerage" },
      { id: "acc-2", name: "Sample Round-ups", account_role: "taxable_brokerage" },
      { id: "acc-3", name: "Sample Roth IRA", account_role: "retirement" },
      { id: "acc-4", name: "Sample Savings", account_role: "cash" },
    ],
    holding_snapshots: [
      { id: "s1", account_id: "acc-1", as_of: stmt + "T21:00:00Z", source_kind: "statement", total_value: null, cash_value: 1904, positions: [
        { symbol: "VOO", quantity: 15.2, price: 600, market_value: 9120, cost_basis: 7800 },
        { symbol: "ACME", quantity: 22.5, price: 176, market_value: 3960, cost_basis: 2100 },
        { symbol: "CRWN", quantity: 15.1, price: 210, market_value: 3171, cost_basis: 2900 },
        { symbol: "BOLT", quantity: 74, price: 37, market_value: 2738, cost_basis: 1500 },
        { symbol: "DYNA", quantity: 19, price: 99, market_value: 1881, cost_basis: 2200 },
      ] },
      { id: "s2", account_id: "acc-2", as_of: old + "T21:00:00Z", source_kind: "statement", total_value: null, cash_value: 12, positions: [
        { symbol: "VOO", quantity: 4.1, price: 590, market_value: 2419, cost_basis: null },
        { symbol: "VXUS", quantity: 22, price: 70, market_value: 1540, cost_basis: null },
      ] },
      { id: "s3", account_id: "acc-3", as_of: old + "T21:00:00Z", source_kind: "statement", total_value: null, cash_value: 40, positions: [
        { symbol: "AVUV", quantity: 26, price: 96, market_value: 2496, cost_basis: null },
      ] },
      { id: "s4", account_id: "acc-4", as_of: ago(2) + "T23:59:00Z", source_kind: "manual", total_value: 15000, cash_value: 15000, positions: [] },
    ],
    companies: [
      { symbol: "ACME", name: "Acme Systems", watchlist_status: "held", ...pipe("owned"), research_versions: [version("acme-1", ago(19), conclusion({ action: "HOLD", cls: "Quality growth", conf: "High", ref: 175, refDate: ago(19), bear: 120, base: 250, bull: 340, zones: [["< $150", "Add research trigger"], ["$150–$230", "Hold"], ["> $230", "Trim review"]], thesis: "Leader in its niche with expanding margins." }))] },
      { symbol: "BOLT", name: "Bolt Compute", watchlist_status: "held", ...pipe("owned"), research_versions: [version("bolt-1", ago(57), conclusion({ action: "HOLD", cls: "Asymmetric / speculative growth", conf: "Moderate", ref: 29, refDate: ago(57), bear: 12, base: 55, bull: 110, zones: [["< $25", "Add research trigger"], ["$25–$50", "Hold"], ["> $50", "Trim review"]] }))] },
      { symbol: "CRWN", name: "Crown Media", watchlist_status: "held", ...pipe("owned"), research_versions: [version("crwn-1", ago(55), conclusion({ action: "HOLD", cls: "Quality growth", conf: "Moderate", ref: 228, refDate: ago(55), bear: 160, base: 300, bull: 380, zones: [["< $190", "Add research trigger"], ["$190–$290", "Hold"], ["> $290", "Trim review"]] })), version("crwn-0", ago(41), conclusion({ action: "ADD", cls: "Quality growth", conf: "Moderate", ref: 205, refDate: ago(41), bear: 150, base: 290, bull: 360, zones: [] }), "complete", false)].map((v, i) => ({ ...v, is_current: false, research_as_of: ago(i ? 41 : 55) })) },
      { symbol: "DYNA", name: "Dyna Social", watchlist_status: "held", ...pipe("owned"), research_versions: [version("dyna-1", ago(54), conclusion({ action: "HOLD, SMALL", cls: "Quality growth", conf: "Low", ref: 118, refDate: ago(54), bear: 70, base: 160, bull: 230, zones: [] }), "partial", true, 4)] },
      { symbol: "NEWCO", name: "Newco Robotics", watchlist_status: "watch", ...pipe("researching", "Automation supplier with improving margins"), research_versions: [] },
      ...["ALFA", "BRAVO", "CHAR", "DELT", "ECHO", "FOXT"].map((s, i) => ({ symbol: s, name: `${s[0]}${s.slice(1).toLowerCase()} Holdings`, watchlist_status: "watch", ...pipe(i < 1 ? "screening" : "idea", i % 2 ? "From a sector scan" : null), research_versions: [] })),
    ],
    policies: [{ version: "Sample policy v2", is_current: true, rules: {
      target_allocation_policies: { latest_approved_v2_revised: [] },
      single_company_frameworks: { latest_approved_v2_revised: { ACME: { role: "Quality growth core" }, BOLT: { role: "Asymmetric speculative sleeve" } } },
      protected_savings_floor_usd: 10000,
    } }],
    policy_rules: policyRules(),
    transactions: [],
    decisions: [
      { id: "d1", kind: "historical", symbol: "ACME", decided_at: ago(60) + "T15:00:00Z", recommendation: { action: "HOLD / NO ADD", summary: "Hold; add only below the research band.", prices_at_decision: { ACME: 150, SPY: 640 } }, user_action: null, user_note: null, status: null, research_as_of: ago(60), imported_at: ago(2) + "T10:00:00Z", execution: null },
      { id: "d2", kind: "new_capital", symbol: null, decided_at: ago(9) + "T15:00:00Z", recommendation: { action: "WAIT / REVIEW", summary: "Two checks open; kept in cash.", prices_at_decision: { VOO: 600, SPY: 655 }, to_verify: ["Enter savings balance"] }, user_action: "deferred", user_note: "Waiting for savings figure", status: "wait_review", research_as_of: null, imported_at: null, execution: null },
    ],
    model_runs: [
      { id: "ms-1", kind: "market_snapshot", computed_at: ago(0) + "T13:30:00Z", inputs: {}, outputs: { macro: [{ id: "DGS2", value: 4.46, date: ago(1) }, { id: "DGS10", value: 4.84, date: ago(1) }] } },
      { id: "ts-1", kind: "trade_scan", computed_at: ago(0) + "T14:20:00Z", inputs: { request_id: "tr-1", trigger: "manual" }, outputs: { ok: true, trigger: "manual", focus: null, ideaIds: [], rejected: [{ symbol: "BOLT", why: "expected 2.1% does not beat VOO plus margin (4.0%) over 52 days" }], noneReason: "Nothing clears the bar today: BOLT's setup depends on a contract award with no date, and ACME already trades near your add band's top.", costUsd: 0.27, ms: 140000, searches: 5, model: "sample" } },
      { id: "ti-1", kind: "trade_idea", computed_at: ago(12) + "T15:00:00Z", inputs: {}, outputs: { entry: { at: ago(12) + "T15:00:00Z", underlying: 170.2, premium: 7.4, premiumSource: "quote", voo: 604.1 }, idea: { symbol: "ACME", instrument: "option", option: { type: "call", strike: 175, expiry: "2027-01-15", contract: "ACME270115C00175000", estPremium: 7.2 }, direction: "up", entryRef: 170.2, target: 205, stop: 158, endDate: "2027-01-08", confidence: "medium", probability: 0.5, thesis: "Data-center orders in the last two 8-Ks run well ahead of the consensus revenue for next quarter; results on Dec 10 should force estimates up.", whyNow: "Results on 2026-12-10; estimates have not moved since the orders were filed.", risks: ["Guidance could offset a strong quarter", "The option can expire worthless: the whole premium can be lost."], wouldChange: "A pre-announcement or a cut to capex by its two largest customers.", sizeUsd: 750, sources: [{ title: "Q3 8-K", url: "https://www.sec.gov/" }, { title: "Company IR", url: "https://example.com/ir" }], expectedPct: 0.066, hurdlePct: 0.039, rewardRisk: 2.9 } } },
      { id: "ti-0", kind: "trade_idea", computed_at: ago(70) + "T15:00:00Z", inputs: {}, outputs: { entry: { at: ago(70) + "T15:00:00Z", underlying: 199.0, premium: null, premiumSource: null, voo: 590.0 }, idea: { symbol: "CRWN", instrument: "stock", option: null, direction: "up", entryRef: 199, target: 228, stop: 186, endDate: ago(10), confidence: "high", probability: 0.6, thesis: "Price fell on a one-off charge the 10-Q shows is non-cash; buybacks resume next quarter.", whyNow: "Buyback window reopens after the 10-Q.", risks: ["Charge could recur"], wouldChange: "A second charge.", sizeUsd: 1500, sources: [{ title: "Q3 8-K", url: "https://www.sec.gov/" }, { title: "Company IR", url: "https://example.com/ir" }], expectedPct: 0.035, hurdlePct: 0.03, rewardRisk: 2.2 } } },
      { id: "tc-0", kind: "trade_close", computed_at: ago(20) + "T18:00:00Z", inputs: { idea_id: "ti-0" }, outputs: { mark: { underlying: 229.1, premium: null, voo: 601.0, today: ago(20) }, result: { status: "target", returnPct: 0.151, vooPct: 0.0186, edgePct: 0.1326, underlyingPct: 0.151, priced: "live" } } },
      { id: "cp-1", kind: "capital_preference", computed_at: ago(1) + "T12:00:00Z", inputs: {}, outputs: { max_transfer: 10000 } },
      { id: "ws-1", kind: "watch_settings", computed_at: ago(2) + "T15:00:00Z", inputs: {}, outputs: { topic: "pi-sample7k2mfq9xw3hnd8r", enabled: true } },
      { id: "wr-2", kind: "watch_run", computed_at: ago(0) + "T15:30:00Z", inputs: {}, outputs: { version: "watch@1", at: ago(0) + "T15:30:00Z", trigger: "schedule", checked: 6, sent: [], summary: null, pushed: false, error: null, costUsd: 0 } },
      { id: "wr-1", kind: "watch_run", computed_at: ago(1) + "T17:00:00Z", inputs: {}, outputs: { version: "watch@1", at: ago(1) + "T17:00:00Z", trigger: "schedule", checked: 7, pushed: true, error: null, costUsd: 0.0006,
        summary: "BOLT fell with no filing; your thesis rests on contract wins, so check news before reading anything into it.",
        sent: [{ key: "x|move:BOLT", alert: { id: "move:BOLT", severity: "medium", symbol: "BOLT", kind: "big_move", title: "BOLT -6.4% today", detail: "-5.9% versus the S&P 500. A drop is not a buy signal by itself; check filings and news first.", href: "/decisions/review/BOLT" } }] } },
      { id: "plan-1", kind: "portfolio_plan", computed_at: ago(1) + "T14:05:00Z", inputs: { request_id: "pr-1", trigger: "research" }, outputs: { ok: true, trigger: "research", costUsd: 0.31, ms: 70000, searches: 0, model: "sample", plan: {
        summary: "Keep the index core and hold the stocks you own. CRWN is above its limit, so let new cash go to the index until it drifts back. ACME is the one idea worth adding, but only below $40.",
        market: { stance: "Neutral", shortTerm: "Breadth is mixed and volatility is low; no strong signal.", longTerm: "Earnings growth is intact; valuations are full." },
        positions: [
          { symbol: "CRWN", status: "held", currentPct: 10.8, targetPct: 10, maxPct: 12, action: "Hold, no add", priority: 1, reason: "Near its limit after a strong run; research is 41 days old.", researchAsOf: ago(41), flags: [] },
          { symbol: "VOO", status: "held", currentPct: 52.3, targetPct: 55, maxPct: null, action: "Default home for new cash", priority: 1, reason: "Core holding; no company research needed.", researchAsOf: null, flags: [] },
          { symbol: "ACME", status: "idea", currentPct: 0, targetPct: 3, maxPct: 5, action: "Add below $40", priority: 2, reason: "Good business, fairly priced today.", researchAsOf: ago(3), flags: [] },
          { symbol: "BOLT", status: "held", currentPct: 4.1, targetPct: null, maxPct: 7, action: "Refresh research first", priority: 2, reason: "Price is 22% below the research reference.", researchAsOf: ago(70), flags: [] },
        ],
        opportunities: [{ symbol: "ACME", verdict: "Wait for price", buyBelow: 40, amountUsd: 750, expectedReturn: "about 11% a year", vsVoo: "+4 pts if bought below $40; even at today's price", reason: "Good business, fairly priced today; the research only beats VOO with a margin below $40." }],
        cash: { deployable: 1956, now: "Put $1,000 into VOO; keep the rest for ACME below $40.", waitFor: "ACME below $40, or BOLT research refreshed." },
        stale: [{ symbol: "BOLT", why: "Price moved 22% from its research reference" }],
        nextActions: ["Refresh BOLT research", "Move $1,000 of cash into VOO", "Set a watch for ACME at $40"],
        problems: [],
      } } },
    ],
    portfolio_daily: [
      { as_of: ago(2), investable: 31800, invested: 29900, cash: 1956, net_worth_tracked: 41800, spy_close: 660, quality: "estimated", holdings_as_of: old },
      { as_of: ago(1), investable: 32050, invested: 30100, cash: 1956, net_worth_tracked: 42050, spy_close: 664.9, quality: "estimated", holdings_as_of: old },
    ],
  };
}

function policyRules() {
  let n = 0;
  const row = (o: Record<string, unknown>) => ({
    id: `r${n++}`, scope: "company", subject: "", normal_low: null, normal_high: null, high_conviction_low: null, high_conviction_high: null, hard_max: null, value: null,
    conditions: null, source_label: "Sample policy v2", source_date: ago(90), source_status: "latest_approved", approval: "approved", approved_at: ago(90), approval_note: null, created_at: ago(3), ...o,
  });
  return [
    row({ scope: "bucket", subject: "US broad-market equity", normal_low: 0.35, normal_high: 0.5, hard_max: 0.6 }),
    row({ scope: "bucket", subject: "International equity", normal_low: 0.08, normal_high: 0.2, hard_max: 0.3 }),
    row({ scope: "bucket", subject: "Small/mid-cap", normal_low: 0.05, normal_high: 0.12, hard_max: 0.15 }),
    row({ scope: "bucket", subject: "Quality/growth individual stocks", normal_low: 0.2, normal_high: 0.35, hard_max: 0.4 }),
    row({ scope: "bucket", subject: "Asymmetric/high-risk growth sleeve", normal_low: 0, normal_high: 0.1, hard_max: 0.12 }),
    row({ subject: "ACME", normal_low: 0.05, normal_high: 0.12, hard_max: 0.18 }),
    row({ subject: "BOLT", hard_max: 0.1, approval: "unresolved", source_label: "Sample policy v2 (undated)", source_date: null }),
    row({ subject: "BOLT", normal_low: 0.03, normal_high: 0.05, hard_max: 0.08, approval: "unresolved", source_label: "BOLT research", source_date: ago(57), approval_note: "Claude recommends: the completed company research sets this range; the older figure was provisional.", conditions: "Research archive, final allocation section" }),
    row({ subject: "CRWN", hard_max: 0.12 }),
    row({ scope: "generic_company", subject: "generic", hard_max: 0.08, approval: "proposed", source_label: "App default" }),
    row({ scope: "assumption", subject: "etf_expected_return", value: 0.07, approval: "proposed", source_label: "App placeholder" }),
    row({ scope: "assumption", subject: "hurdle_over_etf", value: 0.03, approval: "proposed", source_label: "App placeholder" }),
    row({ scope: "assumption", subject: "benchmark_return", normal_low: 0.048, normal_high: 0.075, value: 0.0665, approval: "proposed", approved_at: null, source_label: "Published forecasts", source_date: ago(10), approval_note: "Claude recommends: use the range of published forecasts instead of a fixed 7%." }),
    row({ scope: "bucket", subject: "Bonds", normal_low: 0, normal_high: 0.05, hard_max: 0.15, approved_at: null, source_label: "Sample policy v2 (imported)" }),
    row({ scope: "portfolio", subject: "protected_reserve", value: 10000 }),
  ];
}

type Row = Record<string, unknown>;

/** A tiny stand-in for the Supabase query builder: filters, sorts and limits in memory. */
class FakeQuery implements PromiseLike<{ data: unknown; error: null; count?: number }> {
  private filters: ((r: Row) => boolean)[] = [];
  private sort: { k: string; asc: boolean } | null = null;
  private max: number | null = null;
  private one = false;
  private write = false;
  constructor(private rows: Row[]) {}
  select() { return this; }
  eq(k: string, v: unknown) { this.filters.push((r) => r[k] === v); return this; }
  neq(k: string, v: unknown) { this.filters.push((r) => r[k] !== v); return this; }
  in(k: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[k])); return this; }
  gte(k: string, v: string) { this.filters.push((r) => String(r[k]) >= v); return this; }
  lte(k: string, v: string) { this.filters.push((r) => String(r[k]) <= v); return this; }
  is() { return this; }
  not() { return this; }
  or() { return this; }
  order(k: string, o?: { ascending?: boolean }) { this.sort = { k, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }
  insert() { this.write = true; return this; }
  upsert() { this.write = true; return this; }
  update() { this.write = true; return this; }
  delete() { this.write = true; return this; }
  then<A, B>(ok?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.sort) { const { k, asc } = this.sort; out = [...out].sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : 1) * (asc ? 1 : -1)); }
    if (this.max !== null) out = out.slice(0, this.max);
    const data = this.write ? null : this.one ? out[0] ?? null : out;
    return Promise.resolve({ data, error: null }).then(ok, bad);
  }
}

export function fixtureDb() {
  const t = tables();
  const user = { id: "00000000-0000-0000-0000-000000000000", email: "sample@example.com", factors: [] };
  return {
    from: (name: string) => new FakeQuery(t[name] ?? []),
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getUser: async () => ({ data: { user }, error: null }),
      getClaims: async () => ({ data: { claims: { sub: user.id } }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }) },
    },
  };
}
