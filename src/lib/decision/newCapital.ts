/**
 * The new-capital decision ("I have $1,250, where should it go?").
 *
 * Deterministic. It compares: adding to researched holdings, buying diversified ETFs, starting researched
 * new positions, holding cash, and reviewing positions that are above their limits. It always gives its
 * best recommendation on the evidence it has, with the checks still open listed beside it.
 *
 * Three assessments are kept separate, and a stock receives money only when all three support it:
 *  1. Portfolio limit: the company has its own limit. New cash fills to the top of the normal range, or to the
 *     top of the high-conviction range when you approved that range and the case is favourable and current.
 *     A company without its own limit gets no new money; it never inherits the generic maximum.
 *  2. Valuation: the research's own price zone allows adding, AND the comparison with the alternatives
 *     (VOO's published forecasts, a Treasury for the same horizon) is favourable. See assessVsAlternatives.
 *  3. Research is current: nothing has happened since it was written (results, financing, material filings,
 *     a move into another action zone). Age alone never decides this.
 *
 * Status: "recommend" when every check passes, "recommend_with_checks" when it is the best answer on the
 * evidence but something should be confirmed first, "wait" only when the cash itself is not known or not there.
 */
import type { PortfolioView } from "@/lib/portfolio/engine";
import { DEFAULT_ETF_FOR_BUCKET, type Bucket } from "@/lib/portfolio/classify";
import { companyLimit, type Policy } from "@/lib/policy/limits";
import type { ResearchRecord } from "@/lib/research/records";
import { zoneFor } from "@/lib/research/valuation";
import type { Quote } from "@/lib/market/quotes";
import type { FilingsResult } from "@/lib/market/sec";
import { ALTERNATIVES, assessVsAlternatives, refreshState, riskFreeFor, zoneKind, type Alternative, type Assessment, type RiskFree } from "@/lib/policy/evidence";
import type { Yields } from "@/lib/workspace-core";

export const CODE_VERSION = "new-capital@4";

/** Holdings older than this are not reliable enough to size a purchase. */
export const HOLDINGS_FRESH_DAYS = 7;

export type OptionLabel = "Candidate" | "Valid option" | "Refresh required" | "Research needed" | "No limit set" | "At limit" | "Not ahead of VOO" | "Research says wait" | "Trim review";

export type Verdict = { ok: boolean; detail: string };

export type Option = {
  kind: "stock" | "new_stock" | "etf" | "cash" | "trim";
  symbol: string;
  label: OptionLabel;
  price: number | null;
  priceSource: "quote" | "statement" | null;
  expectedReturn: number | null; // only when the research is current enough to re-price
  assessment?: Assessment | null;
  /** Published forecast span for an ETF alternative (never averaged). */
  forecast?: Alternative | null;
  /** True when new cash may fill to the top of an approved high-conviction range. */
  highConviction?: boolean;
  headroomDollars: number | null;
  weightNow: number | null;
  maxWeight: number | null;
  limitStatus: string | null;
  eligible: boolean;
  notes: string[];
  researchAction: string | null;
  zoneAction: string | null;
  refreshFirst?: boolean;
  /** The three independent checks, so a pass on one never hides a fail on another. */
  verdicts?: { limit: Verdict; valuation: Verdict; research: Verdict };
  toVerify: string[];
};

export type Gate = { key: string; label: string; ok: boolean; detail: string };

export type NewCapitalResult = {
  amount: number;
  source: "new" | "existing";
  asOf: string;
  status: "recommend" | "recommend_with_checks" | "wait";
  gates: Gate[];
  toVerify: string[];
  options: Option[];
  recommendation: {
    allocations: { symbol: string; amount: number }[];
    illustrative: boolean; // true only when status is wait: the cash is not known or not there
    confidence: number;
    headline: string;
    rationale: string[];
    wouldChange: string[];
  };
  assumptions: { alternatives: Alternative[]; riskFree10y: RiskFree };
  warnings: string[];
};

const ETF_BUCKETS: Bucket[] = ["US broad-market equity", "International equity", "Small/mid-cap"];

export function newCapital(args: {
  amount: number;
  portfolio: PortfolioView;
  research: ResearchRecord[];
  policy: Policy | null;
  now: Date;
  source?: "new" | "existing";
  quotes?: Map<string, Quote>;
  /** SEC filings per symbol. A symbol missing here could not be checked, so its research is "unverified". */
  filings?: Map<string, FilingsResult>;
  /** Treasury yields for the risk-free alternative. */
  yields?: Yields | null;
}): NewCapitalResult {
  const { amount, portfolio, research, policy, now } = args;
  const source = args.source ?? "new";
  const audit = policy?.audit;
  const yields = args.yields ?? { y2: null, y10: null };
  // Money already counted as deployable cash only moves within the portfolio; new money grows it.
  const postTotal = source === "new" ? portfolio.total + amount : portfolio.total;
  const warnings: string[] = [];
  if (portfolio.quality.status === "estimated") warnings.push(portfolio.quality.headline + ". " + portfolio.quality.reasons[0]);
  if (portfolio.pricedLive < portfolio.holdings.length) warnings.push("Some prices are from statements, not live quotes.");

  const stockOption = (symbol: string, held: boolean): Option => {
    const h = portfolio.holdings.find((x) => x.symbol === symbol);
    const e = portfolio.exposures.find((x) => x.symbol === symbol);
    const q = args.quotes?.get(symbol);
    const price = h?.price ?? q?.price ?? null;
    const r = research.find((x) => x.symbol === symbol);
    const v = r?.current;
    const notes: string[] = [];
    const toVerify: string[] = [];
    let er: number | null = null;
    let assessment: Assessment | null = null;
    let zoneAction: string | null = null;
    let refreshFirst = false;
    const lim = policy?.companies[symbol];
    const cl = companyLimit(policy, symbol);

    // ---- 3. Research current? (event-driven) ----
    let fresh: Verdict;
    if (!r || (!v && !r.conflict)) { fresh = { ok: false, detail: "No current research on file" }; toVerify.push(`${symbol}: full research before it can be compared`); }
    else if (r.conflict) { fresh = { ok: false, detail: "Research records conflict and none is marked current" }; toVerify.push(`${symbol}: resolve which research record is current`); }
    else if (v!.completeness !== "complete") { fresh = { ok: false, detail: `Research is ${v!.completeness}` }; toVerify.push(`${symbol}: complete the missing research phases`); }
    else {
      const st = refreshState({ asOf: v!.research_as_of, pc: v!.parsed, price, filings: args.filings?.get(symbol) ?? null });
      refreshFirst = st.status === "refresh";
      fresh = st.status === "current"
        ? { ok: true, detail: `Nothing material filed since ${v!.research_as_of}, and the price is still in the research's own zone` }
        : { ok: false, detail: st.triggers.map((t) => t.detail).join("; ") };
      if (st.status !== "current") toVerify.push(`${symbol}: ${st.status === "refresh" ? "refresh the research for what changed" : "check SEC filings since the research"} (${st.triggers.map((t) => t.kind.replace(/_/g, " ")).join(", ")})`);
    }

    // ---- 2. Valuation: the research's own zone, and the comparison with the alternatives ----
    const normalHigh = lim?.normal?.high ?? null;
    const hcHigh = lim?.highConviction?.high ?? null;
    let valuation: Verdict = { ok: false, detail: "No valuation to compare" };
    if (v && price) {
      const zone = zoneFor(v.parsed.zones, price);
      zoneAction = zone?.action ?? null;
      const years = v.parsed.horizonDate ? Math.max(0.25, (new Date(v.parsed.horizonDate).getTime() - now.getTime()) / (365.25 * 864e5)) : 10;
      assessment = assessVsAlternatives(v.parsed, price, now, {
        riskFree: riskFreeFor(years, yields), weightNow: e?.total ?? 0,
        limit: cl.hasLimit ? { normalHigh, hcHigh, max: cl.newMoneyMax } : null, completeness: v.completeness, confidence: v.parsed.confidence,
      });
      er = fresh.ok ? assessment?.expected ?? null : null;
      if (!assessment) valuation = { ok: false, detail: "Research has no complete bear/base/bull scenarios to compare with the alternatives" };
      else if (zone && zoneKind(zone.action) !== "buy") valuation = { ok: false, detail: `Research zone at $${price.toFixed(2)}: ${zone.action}. ${assessment.summary}` };
      else valuation = { ok: assessment.judgment === "favourable", detail: assessment.summary };
    } else if (v) valuation = { ok: false, detail: "No price to compare" };

    // ---- 1. Portfolio limit: own limit only. Normal range by default; the high-conviction range only when you
    //      approved it and the case is favourable and current. ----
    const lowConfidence = /low/i.test(v?.parsed.confidence ?? "");
    const highConviction = !!(cl.hasLimit && lim?.authority === "you" && hcHigh !== null && normalHigh !== null && hcHigh > normalHigh && valuation.ok && fresh.ok && !lowConfidence);
    const target = highConviction ? hcHigh! : normalHigh ?? cl.newMoneyMax;
    const ceiling = cl.hasLimit ? Math.min(cl.newMoneyMax, target) : 0;
    const current = (e?.total ?? 0) * portfolio.total;
    const headroom = cl.hasLimit ? Math.max(0, Math.round((ceiling * postTotal - current) * 100) / 100) : 0;
    const rangeName = highConviction ? "high-conviction range" : "normal range";
    let limit: Verdict;
    if (!cl.hasLimit) {
      limit = { ok: false, detail: `No limit of its own. It does not inherit the generic ${policy?.portfolioCeiling ? `${pct(policy.portfolioCeiling, 0)} ` : ""}maximum, so it gets no new money until research sets a limit and you approve it` };
      toVerify.push(`${symbol}: approve a company limit from its research`);
    } else if (headroom <= 0) limit = { ok: false, detail: ceiling < cl.newMoneyMax ? `At the top of its ${rangeName} (${pct(ceiling)})` : `At or above its ${pct(cl.newMoneyMax)} maximum, including ETF look-through` };
    else limit = { ok: true, detail: `Room of $${Math.floor(headroom).toLocaleString()} to the top of its ${rangeName} (${pct(ceiling)})` };
    if (highConviction) {
      notes.push(`High-conviction range applies: you approved up to ${pct(hcHigh!)}, the comparison is favourable and the research is current`);
      if (lim?.conditions) toVerify.push(`${symbol}: confirm the high-conviction condition in its research: ${lim.conditions}`);
    } else if (cl.hasLimit && hcHigh !== null && normalHigh !== null && hcHigh > normalHigh) {
      notes.push(`High-conviction range (to ${pct(hcHigh)}) not used: ${lim?.authority !== "you" ? "you have not approved it" : !valuation.ok ? "the comparison is not favourable" : !fresh.ok ? "the research needs a refresh" : "research confidence is low"}`);
    }
    if (lim?.status === "conflict") {
      notes.push(`Your sources disagree on its limit; the app uses ${lim.provisional ? "your provisional" : "the stricter"} ${pct(lim.hardMax ?? 0)} as a temporary safety limit until you decide on the Policy page`);
      toVerify.push(`${symbol}: decide which allocation limit controls`);
    } else if (lim && lim.authority === "imported") notes.push(`Its ${pct(lim.hardMax ?? 0)} maximum is imported from the old archive and not yet confirmed by you`);

    let label: OptionLabel = "Candidate";
    if (!fresh.ok) label = !v || r?.conflict ? "Research needed" : "Refresh required";
    else if (!cl.hasLimit) label = "No limit set";
    else if (!limit.ok) label = "At limit";
    else if (!valuation.ok) label = assessment && zoneAction && zoneKind(zoneAction) !== "buy" ? "Research says wait" : "Not ahead of VOO";
    notes.unshift(`Limit: ${limit.detail}`, `Valuation: ${valuation.detail}`, `Research: ${fresh.detail}`);
    if (v?.parsed.action) notes.push(`Research action at its reference price: ${v.parsed.action}`);

    return {
      kind: held ? "stock" : "new_stock", symbol, label, price, priceSource: h?.priceSource ?? (q ? "quote" : null), expectedReturn: er, assessment, highConviction,
      headroomDollars: headroom, weightNow: e?.total ?? 0, maxWeight: cl.hasLimit ? ceiling : null, limitStatus: lim?.authority === "you" ? "approved" : lim?.authority === "imported" ? "imported" : lim?.status ?? "none",
      eligible: label === "Candidate", notes, researchAction: v?.parsed.action ?? null, zoneAction, refreshFirst, verdicts: { limit, valuation, research: fresh }, toVerify,
    };
  };

  const stockOptions = portfolio.exposures.map((e) => stockOption(e.symbol, true));
  const heldSet = new Set(portfolio.holdings.map((h) => h.symbol));
  const newOptions = research.filter((r) => !heldSet.has(r.symbol) && r.current && r.pipeline?.stage !== "passed").map((r) => stockOption(r.symbol, false));

  // ETFs: every core bucket, labelled by how far it sits from its range. Underweight is a reason to look, not to buy.
  const etfOptions: Option[] = portfolio.buckets
    .filter((b) => ETF_BUCKETS.includes(b.bucket))
    .map((b) => ({ b, gap: (b.normal ? (b.normal.low + b.normal.high) / 2 : 0) - b.weight }))
    .sort((x, y) => y.gap - x.gap)
    .map(({ b, gap }, i) => {
      const symbol = DEFAULT_ETF_FOR_BUCKET[b.bucket] ?? "VOO";
      const h = portfolio.holdings.find((x) => x.symbol === symbol);
      const alt = ALTERNATIVES.find((x) => x.symbol === symbol) ?? null;
      const notes = [`${b.bucket} is ${pct(b.weight)}${b.normal ? `, normal range ${pct(b.normal.low)}–${pct(b.normal.high)}` : ""}`,
        alt ? `Published forecasts: ${alt.forecasts.map((f) => `${f.firm} ${f.asset} ${f.kind === "range" ? `${pct(f.low)}–${pct(f.high)}` : pct(f.low)} (${f.horizonYears[0] === f.horizonYears[1] ? f.horizonYears[0] : f.horizonYears.join("–")} years, as of ${f.asOf})`).join("; ")}. Forecasts, not promises` : "No published forecast on file for this bucket, so it is not ranked on return"];
      if (b.status === "over_max" || b.status === "above") notes.push("Already above its normal range");
      return {
        kind: "etf" as const, symbol, label: (i === 0 && gap > 0 ? "Candidate" : "Valid option") as OptionLabel, price: h?.price ?? args.quotes?.get(symbol)?.price ?? null,
        priceSource: h?.priceSource ?? null, expectedReturn: null, forecast: alt, headroomDollars: null, weightNow: b.weight, maxWeight: b.hardMax,
        limitStatus: b.status === "no_limit" ? "none" : policy?.buckets.find((x) => x.bucket === b.bucket)?.status ?? "none", eligible: b.status !== "over_max", notes, researchAction: null, zoneAction: null, toVerify: [],
      };
    });

  const trimOptions: Option[] = portfolio.exposures.filter((e) => e.total > e.max).map((e) => ({
    kind: "trim", symbol: e.symbol, label: "Trim review", price: portfolio.holdings.find((h) => h.symbol === e.symbol)?.price ?? null, priceSource: null,
    expectedReturn: null, headroomDollars: null, weightNow: e.total, maxWeight: e.max, limitStatus: policy?.companies[e.symbol]?.status ?? null, eligible: false,
    notes: [`${pct(e.total)} including ETFs, above its ${pct(e.max)} maximum. Policy: review, not an automatic sale`, "Selling in a taxable account can realize gains; check the cost basis first"],
    researchAction: null, zoneAction: null, toVerify: [],
  }));

  const cash: Option = {
    kind: "cash", symbol: "CASH", label: "Valid option", price: null, priceSource: null, expectedReturn: null, headroomDollars: null,
    weightNow: portfolio.total ? portfolio.cash / portfolio.total : 0, maxWeight: null, limitStatus: null, eligible: true,
    notes: ["Policy: new cash does not have to be invested immediately", `The $${portfolio.cashDetail.protectedReserve.toLocaleString()} protected reserve is excluded from sizing`,
      yields.y2 ? `Risk-free alternative: 2-year Treasury ${yields.y2.value.toFixed(2)}% (FRED, ${yields.y2.date}); your savings yield is not entered` : "Treasury yields not loaded; your savings yield is not entered"],
    researchAction: null, zoneAction: null, toVerify: [],
  };

  // ---- Illustrative split: best eligible stocks to their ceilings, the rest to the most underweight ETF ----
  const eligible = [...stockOptions, ...newOptions].filter((o) => o.eligible).sort((x, y) => (y.expectedReturn ?? 0) - (x.expectedReturn ?? 0));
  const allocations: { symbol: string; amount: number }[] = [];
  const rationale: string[] = [];
  const wouldChange: string[] = [];
  let remaining = amount;
  let confidence = 6;
  for (const c of eligible) {
    if (remaining < 1) break;
    const toStock = Math.floor(Math.min(c.headroomDollars ?? 0, remaining));
    if (toStock <= 0) continue;
    allocations.push({ symbol: c.symbol, amount: toStock });
    remaining -= toStock;
    rationale.push(`${c.symbol}: ${c.assessment?.summary ?? ""}${c.highConviction ? " Sized to its approved high-conviction range." : ""}`);
    if (/specul|asymmetric/i.test(research.find((r) => r.symbol === c.symbol)?.current?.parsed.classification ?? "")) confidence -= 1;
    wouldChange.push(`${c.symbol} rising until its expected return is no longer above every published VOO forecast, a filing that changes its scenarios, or new evidence against its thesis.`);
  }
  const etf = etfOptions.find((o) => o.eligible) ?? etfOptions[0];
  if (remaining > 0 && etf) {
    allocations.push({ symbol: etf.symbol, amount: Math.round(remaining * 100) / 100 });
    rationale.push(eligible.length
      ? `The rest to ${etf.symbol}, the most underweight core bucket.`
      : `No stock can be ranked on current evidence, so the diversified option is ${etf.symbol} (${etf.notes[0]}). Being underweight is a reason to consider it, not proof it is the best use of the money.`);
  }
  rationale.push("Account: assumes the money goes to your taxable brokerage account. Retirement contributions have annual limits, and selling in a taxable account can realize gains.");

  // ---- Gates ----
  const brokerAccounts = portfolio.accounts.filter((a) => a.role !== "cash" && a.role !== "protected_savings");
  const oldest = brokerAccounts.reduce((m, a) => Math.max(m, a.ageDays), 0);
  const gaps = brokerAccounts.filter((a) => a.statementGap !== null && Math.abs(a.statementGap) > 1);
  const refresh = [...stockOptions].filter((o) => o.label === "Refresh required" || o.label === "Research needed");
  const receiving = allocations.map((x) => x.symbol);
  const notYours = [...stockOptions, ...newOptions].filter((o) => receiving.includes(o.symbol) && o.limitStatus !== "approved").map((o) => o.symbol);
  const conflicts = (audit?.conflicts ?? []).filter((c) => receiving.includes(c.subject)).map((c) => c.subject);
  const gates: Gate[] = [
    { key: "holdings", label: "Holdings are current", ok: oldest <= HOLDINGS_FRESH_DAYS && !gaps.length && portfolio.quality.reconciliation.complete,
      detail: oldest > HOLDINGS_FRESH_DAYS ? `Oldest statement is ${oldest} days old. Confirm holdings or record trades since then`
        : gaps.length ? `Statement totals do not add up for ${gaps.map((a) => a.name).join(", ")}`
        : !portfolio.quality.reconciliation.complete ? `Not reconciled: ${portfolio.quality.reconciliation.gaps.join("; ")}`
        : "All accounts updated within a week and reconciled" },
    { key: "cash", label: "Cash and savings are known", ok: portfolio.cashDetail.savings !== null && (source === "new" || amount <= portfolio.cashDetail.deployable),
      detail: portfolio.cashDetail.savings === null ? "Enter your savings balance so the protected reserve and deployable cash are known"
        : source === "existing" && amount > portfolio.cashDetail.deployable ? `Only $${portfolio.cashDetail.deployable.toLocaleString()} is deployable after the protected reserve` : `Deployable cash $${portfolio.cashDetail.deployable.toLocaleString()}` },
    { key: "limits", label: "Limits used are ones you approved", ok: !notYours.length && !conflicts.length,
      detail: conflicts.length ? `Open policy decision for ${conflicts.join(", ")}` : notYours.length ? `Imported, not confirmed by you: ${notYours.join(", ")}` : receiving.some((x) => x !== "VOO" && x !== "VXUS") ? "Every company limit used is one you approved" : "Only diversified ETFs receive money" },
    { key: "research", label: "Research is current (event check)", ok: !refresh.length,
      detail: refresh.length ? `${refresh.map((o) => o.symbol).join(", ")}: something changed since the research, or filings could not be checked. Those stocks get no new money until it is checked` : "No new results, financings or zone changes since each held stock's research" },
  ];
  const cashOk = gates.find((g) => g.key === "cash")!.ok;
  const status: NewCapitalResult["status"] = !cashOk ? "wait" : gates.every((g) => g.ok) ? "recommend" : "recommend_with_checks";
  const toVerify = [
    ...gates.filter((g) => !g.ok && g.key !== "research").map((g) => g.detail),
    ...[...stockOptions, ...newOptions].filter((o) => receiving.includes(o.symbol)).flatMap((o) => o.toVerify),
    ...refresh.flatMap((o) => o.toVerify),
  ].filter((x, i, a) => a.indexOf(x) === i);

  if (refresh.length) wouldChange.unshift(`Refreshed research on ${refresh.map((o) => o.symbol).join(", ")} that sets expected returns at today's prices.`);
  confidence -= gates.filter((g) => !g.ok).length;

  const split = allocations.map((x) => `$${x.amount.toLocaleString()} ${x.symbol}`).join(" + ");
  return {
    amount,
    source,
    asOf: now.toISOString(),
    status,
    gates,
    toVerify,
    options: [
      ...stockOptions.sort((x, y) => rankLabel(x.label) - rankLabel(y.label) || (y.expectedReturn ?? -1) - (x.expectedReturn ?? -1)),
      ...newOptions,
      ...etfOptions,
      cash,
      ...trimOptions,
    ],
    recommendation: {
      allocations,
      illustrative: status === "wait",
      confidence: Math.max(1, Math.min(10, confidence)),
      headline: status === "wait" ? "Wait: confirm your cash first" : split || "Hold cash",
      rationale,
      wouldChange,
    },
    assumptions: { alternatives: ALTERNATIVES, riskFree10y: riskFreeFor(10, yields) },
    warnings,
  };
}

const LABEL_ORDER: OptionLabel[] = ["Candidate", "Refresh required", "Not ahead of VOO", "Research says wait", "At limit", "No limit set", "Research needed", "Valid option", "Trim review"];
const rankLabel = (l: OptionLabel) => LABEL_ORDER.indexOf(l);

export function pct(n: number, digits = 1) {
  return `${(n * 100).toFixed(digits)}%`;
}
