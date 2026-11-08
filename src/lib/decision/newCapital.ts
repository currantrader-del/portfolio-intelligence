/**
 * The new-capital decision ("I have $1,250, where should it go?").
 *
 * Deterministic. It compares adding to researched holdings, buying diversified ETFs, starting researched new
 * positions, holding cash, and reviewing positions above their limits. It keeps two things apart:
 *
 * ANALYSIS (always given, even with incomplete information): what the evidence says about each option.
 *  - The research's own conclusion at today's price decides the action. A favourable modeled return never
 *    overrides a completed research conclusion of HOLD / NO ADD, and a conditional add ("only if ...") is not
 *    an add until its condition is confirmed.
 *  - The modeled return (research scenarios re-priced at today's price) is compared with VOO's published
 *    forecasts and a Treasury for the same horizon. Scenario probabilities are the research's subjective
 *    assumptions, not statistical confidence.
 *  - Portfolio limit: only a company limit you approved gives room for new money. The high-conviction range is
 *    used only when you approved it, its stated conditions are confirmed, and research and model both support it.
 *  - Research is current: nothing material happened since it was written (results, financing, material 8-K,
 *    zone change). Age alone never decides this.
 *
 * EXECUTION READINESS (needed before dollar amounts): holdings current, cash known, and no material open issue
 * for any name that would receive money. When readiness fails, the analysis and its leaning still show, but any
 * dollar split is marked illustrative.
 */
import type { PortfolioView } from "@/lib/portfolio/engine";
import { DEFAULT_ETF_FOR_BUCKET, type Bucket } from "@/lib/portfolio/classify";
import { companyLimit, type Policy } from "@/lib/policy/limits";
import type { ResearchRecord } from "@/lib/research/records";
import type { Quote } from "@/lib/market/quotes";
import type { FilingsResult } from "@/lib/market/sec";
import { ALTERNATIVES, assessVsAlternatives, conditionIn, refreshState, researchStance, riskFreeFor, type Alternative, type Assessment, type ResearchStance, type RiskFree } from "@/lib/policy/evidence";
import type { Yields } from "@/lib/workspace-core";

export const CODE_VERSION = "new-capital@5";

/** Holdings older than this are not reliable enough to size a purchase. */
export const HOLDINGS_FRESH_DAYS = 7;

export type OptionLabel = "Candidate" | "Valid option" | "Refresh required" | "Research needed" | "No limit set" | "At limit" | "Not ahead of VOO" | "Research says hold" | "Condition not met" | "Limit not approved" | "Trim review";

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
  /** What the completed research itself concludes at today's price. */
  stance?: ResearchStance | null;
  /** Whether the modeled return and the research conclusion point the same way. */
  agreement?: "agrees" | "model_more_positive" | "model_more_negative" | null;
  toVerify: string[];
};

export type Gate = { key: string; label: string; ok: boolean; detail: string };

export type NewCapitalResult = {
  amount: number;
  source: "new" | "existing";
  asOf: string;
  /** actionable: dollar amounts can be acted on. analysis_only: the opinion stands, but dollar amounts wait for the readiness checks. */
  status: "actionable" | "analysis_only";
  /** One plain sentence: the leaning on current evidence, given even when dollar amounts cannot be. */
  lean: string;
  gates: Gate[];
  toVerify: string[];
  options: Option[];
  recommendation: {
    allocations: { symbol: string; amount: number }[];
    illustrative: boolean; // true unless status is actionable
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
  /** Extra tickers to assess even without research (e.g. a stock you asked about). They get no money without research and a limit. */
  consider?: string[];
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
    const price = q?.price ?? h?.price ?? null; // today's quote first; a statement price only when no quote
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

    // ---- 2. Valuation: the research's own conclusion first, then the modeled return vs the alternatives ----
    const normalHigh = lim?.normal?.high ?? null;
    const hcHigh = lim?.highConviction?.high ?? null;
    let valuation: Verdict = { ok: false, detail: "No valuation to compare" };
    let stance: ResearchStance | null = null;
    let agreement: Option["agreement"] = null;
    if (v && price) {
      stance = researchStance(v.parsed, price);
      zoneAction = stance?.from === "zone" ? stance.text : null;
      const years = v.parsed.horizonDate ? Math.max(0.25, (new Date(v.parsed.horizonDate).getTime() - now.getTime()) / (365.25 * 864e5)) : 10;
      assessment = assessVsAlternatives(v.parsed, price, now, {
        riskFree: riskFreeFor(years, yields), weightNow: e?.total ?? 0,
        limit: cl.hasLimit ? { normalHigh, hcHigh, max: cl.newMoneyMax } : null, completeness: v.completeness, confidence: v.parsed.confidence,
      });
      er = fresh.ok ? assessment?.expected ?? null : null;
      const supports = stance?.kind === "add";
      const modelFav = assessment?.judgment === "favourable";
      agreement = !assessment || !stance ? null : supports === modelFav ? "agrees" : modelFav ? "model_more_positive" : "model_more_negative";
      const said = stance ? `Research at $${price.toFixed(2)} (${stance.from === "zone" ? "its price zone" : "its conclusion"}): ${stance.text.replace(/\.\s*$/, "")}` : "The research states no action";
      if (!assessment) valuation = { ok: false, detail: `${said}. It has no complete bear/base/bull scenarios to model a return` };
      else if (stance?.kind === "conditional") {
        valuation = { ok: false, detail: `${said}. Not an add until the condition is confirmed: ${stance.condition}. ${assessment.summary}` };
        toVerify.push(`${symbol}: the research's condition for adding must be confirmed first: ${stance.condition}`);
      } else if (!supports) valuation = { ok: false, detail: `${said}. ${assessment.summary}${modelFav ? " The research's HOLD conclusion stands: it weighs uncertainty, downside and conditions the model does not capture." : ""}` };
      else valuation = { ok: modelFav, detail: `${said}. ${assessment.summary}${modelFav ? "" : " The research would add, but the modeled return does not clearly beat VOO, so no new money on return grounds."}` };
    } else if (v) valuation = { ok: false, detail: "No price to compare" };

    // ---- 1. Portfolio limit: own limit only, approved by you. Normal range by default; the high-conviction range
    //      only when you approved it, its stated conditions are confirmed, and research and model both support it. ----
    const hcCondition = conditionIn(lim?.conditions) ?? conditionIn(String((v?.parsed.allocation as Record<string, unknown> | null)?.high_conviction_condition ?? ""));
    const lowConfidence = /low/i.test(v?.parsed.confidence ?? "");
    const hcExists = cl.hasLimit && hcHigh !== null && normalHigh !== null && hcHigh > normalHigh;
    const hcBlocker = !hcExists ? null : lim?.authority !== "you" ? "you have not approved it" : hcCondition ? `its condition is not confirmed (${hcCondition})` : !valuation.ok ? "the research and the modeled return do not both support adding" : !fresh.ok ? "the research needs a refresh" : lowConfidence ? "research confidence is low" : null;
    const highConviction = hcExists && hcBlocker === null;
    const target = highConviction ? hcHigh! : normalHigh ?? cl.newMoneyMax;
    const ceiling = cl.hasLimit ? Math.min(cl.newMoneyMax, target) : 0;
    const current = (e?.total ?? 0) * portfolio.total;
    const headroom = cl.hasLimit ? Math.max(0, Math.round((ceiling * postTotal - current) * 100) / 100) : 0;
    const rangeName = highConviction ? "high-conviction range" : "normal range";
    const approvedByYou = lim?.authority === "you";
    let limit: Verdict;
    if (!cl.hasLimit) {
      limit = { ok: false, detail: `No limit of its own. It does not inherit the generic ${policy?.portfolioCeiling ? `${pct(policy.portfolioCeiling, 0)} ` : ""}maximum, so it gets no new money until research sets a limit and you approve it` };
      toVerify.push(`${symbol}: approve a company limit from its research`);
    } else if (headroom <= 0) limit = { ok: false, detail: ceiling < cl.newMoneyMax ? `At the top of its ${rangeName} (${pct(ceiling)})` : `At or above its ${pct(cl.newMoneyMax)} maximum, including ETF look-through` };
    else if (!approvedByYou) limit = { ok: false, detail: `Room of $${Math.floor(headroom).toLocaleString()} under ${lim?.status === "conflict" ? "a disputed" : "an imported"} limit you have not approved. No new money until you approve a limit` };
    else limit = { ok: true, detail: `Room of $${Math.floor(headroom).toLocaleString()} to the top of its ${rangeName} (${pct(ceiling)})` };
    if (highConviction) notes.push(`High-conviction range applies: you approved up to ${pct(hcHigh!)}, it has no unmet condition, and research and model both support adding`);
    else if (hcExists) notes.push(`High-conviction range (to ${pct(hcHigh!)}) not available: ${hcBlocker}`);
    if (lim?.status === "conflict") {
      notes.push(`Your sources disagree on its limit; the app uses ${lim.provisional ? "your provisional" : "the stricter"} ${pct(lim.hardMax ?? 0)} as a temporary safety limit until you decide on the Policy page`);
      toVerify.push(`${symbol}: decide which allocation limit controls`);
    } else if (lim && lim.authority === "imported") {
      notes.push(`Its ${pct(lim.hardMax ?? 0)} maximum is imported from the old archive and not yet confirmed by you`);
      toVerify.push(`${symbol}: confirm or revise its imported limit on the Policy page`);
    }

    let label: OptionLabel = "Candidate";
    if (!fresh.ok) label = !v || r?.conflict ? "Research needed" : "Refresh required";
    else if (!cl.hasLimit) label = "No limit set";
    else if (headroom <= 0) label = "At limit";
    else if (stance?.kind === "conditional") label = "Condition not met";
    else if (stance && stance.kind !== "add") label = "Research says hold";
    else if (!valuation.ok) label = "Not ahead of VOO";
    else if (!approvedByYou) label = "Limit not approved";
    notes.unshift(`Research: ${valuation.detail}`, `Limit: ${limit.detail}`, `Current: ${fresh.detail}`);
    if (agreement === "model_more_positive") notes.push("The modeled return looks better than the research's conclusion. The app follows the research, which weighs uncertainty, downside and conditions the model leaves out.");
    if (v?.parsed.action && stance?.from === "zone") notes.push(`Research conclusion at its reference price: ${v.parsed.action}`);

    return {
      kind: held ? "stock" : "new_stock", symbol, label, price, priceSource: h?.priceSource ?? (q ? "quote" : null), expectedReturn: er, assessment, highConviction,
      headroomDollars: headroom, weightNow: e?.total ?? 0, maxWeight: cl.hasLimit ? ceiling : null, limitStatus: lim?.authority === "you" ? "approved" : lim?.authority === "imported" ? "imported" : lim?.status ?? "none",
      eligible: label === "Candidate", notes, researchAction: v?.parsed.action ?? null, zoneAction, refreshFirst, verdicts: { limit, valuation, research: fresh }, stance, agreement, toVerify,
    };
  };

  const stockOptions = portfolio.exposures.map((e) => stockOption(e.symbol, true));
  const heldSet = new Set(portfolio.holdings.map((h) => h.symbol));
  const newSymbols = [...research.filter((r) => !heldSet.has(r.symbol) && r.current && r.pipeline?.stage !== "passed").map((r) => r.symbol),
    ...(args.consider ?? []).map((x) => x.toUpperCase()).filter((x) => !heldSet.has(x))].filter((x, i, a) => a.indexOf(x) === i);
  const newOptions = newSymbols.map((symbol) => stockOption(symbol, false));

  // ETFs: every core bucket. VOO is the default home for money that nothing else beats; another core ETF leads only
  // when its bucket is below the bottom of its normal range (most below first). Underweight is a reason to look, not proof.
  const etfOptions: Option[] = portfolio.buckets
    .filter((b) => ETF_BUCKETS.includes(b.bucket))
    .map((b) => ({ b, gap: b.normal && b.weight < b.normal.low ? b.normal.low - b.weight : b.bucket === "US broad-market equity" ? 0 : -1 }))
    .sort((x, y) => y.gap - x.gap)
    .map(({ b, gap }, i) => {
      const symbol = DEFAULT_ETF_FOR_BUCKET[b.bucket] ?? "VOO";
      const h = portfolio.holdings.find((x) => x.symbol === symbol);
      const alt = ALTERNATIVES.find((x) => x.symbol === symbol) ?? null;
      const notes = [`${b.bucket} is ${pct(b.weight)}${b.normal ? `, normal range ${pct(b.normal.low)}–${pct(b.normal.high)}` : ""}`,
        alt ? `Published forecasts: ${alt.forecasts.map((f) => `${f.firm} ${f.asset} ${f.kind === "range" ? `${pct(f.low)}–${pct(f.high)}` : pct(f.low)} (${f.horizonYears[0] === f.horizonYears[1] ? f.horizonYears[0] : f.horizonYears.join("–")} years, as of ${f.asOf})`).join("; ")}. Forecasts, not promises` : "No published forecast on file for this bucket, so it is not ranked on return"];
      if (b.status === "over_max" || b.status === "above") notes.push("Already above its normal range");
      if (i === 0) notes.unshift(gap > 0 ? `Below the bottom of its normal range, so it leads the diversified options` : "The default alternative: where money goes when nothing beats owning the index");
      return {
        kind: "etf" as const, symbol, label: (i === 0 ? "Candidate" : "Valid option") as OptionLabel, price: h?.price ?? args.quotes?.get(symbol)?.price ?? null,
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
    rationale.push(`${c.symbol}: the research supports adding at today's price ("${c.stance?.text ?? ""}") and the modeled return agrees. ${c.assessment?.summary ?? ""}${c.highConviction ? " Sized to its approved high-conviction range." : ""}`);
    if (/specul|asymmetric/i.test(research.find((r) => r.symbol === c.symbol)?.current?.parsed.classification ?? "")) confidence -= 1;
    wouldChange.push(`${c.symbol}: a price move out of the research's add zone, a filing that changes its scenarios, or new evidence against its thesis.`);
  }
  const etf = etfOptions.find((o) => o.eligible) ?? etfOptions[0];
  if (remaining > 0 && etf) {
    allocations.push({ symbol: etf.symbol, amount: Math.round(remaining * 100) / 100 });
    rationale.push(eligible.length
      ? `The rest to ${etf.symbol}: ${etf.notes[0].toLowerCase()}.`
      : `No stock qualifies for new money on current evidence, so the money goes to ${etf.symbol}: ${etf.notes[0].toLowerCase()}. Holding cash is equally valid if you expect to need it.`);
  }
  rationale.push("Account: assumes the money goes to your taxable brokerage account. Retirement contributions have annual limits, and selling in a taxable account can realize gains.");

  // ---- Gates ----
  const brokerAccounts = portfolio.accounts.filter((a) => a.role !== "cash" && a.role !== "protected_savings");
  // Holdings are known through the later of each statement and the trades recorded since it (confirmations).
  const oldest = brokerAccounts.reduce((m, a) => Math.max(m, a.knownAgeDays ?? a.ageDays), 0);
  const stalest = brokerAccounts.find((a) => (a.knownAgeDays ?? a.ageDays) === oldest);
  const gaps = brokerAccounts.filter((a) => a.statementGap !== null && Math.abs(a.statementGap) > 1);
  const refresh = [...stockOptions].filter((o) => o.label === "Refresh required" || o.label === "Research needed");
  const receiving = allocations.map((x) => x.symbol);
  const gates: Gate[] = [
    { key: "holdings", label: "Holdings are current", ok: oldest <= HOLDINGS_FRESH_DAYS && !gaps.length,
      detail: oldest > HOLDINGS_FRESH_DAYS ? `${stalest?.name ?? "An account"} is only known through ${stalest?.knownThrough ?? "its statement"} (${oldest} days). Confirm holdings or record trades since then`
        : gaps.length ? `Statement totals do not add up for ${gaps.map((a) => a.name).join(", ")}`
        : `Every account known through a statement or recorded trades within ${HOLDINGS_FRESH_DAYS} days${portfolio.quality.reconciliation.complete ? "" : ` (not blocking: ${portfolio.quality.reconciliation.gaps.join("; ")})`}` },
    { key: "cash", label: "Available cash is known", ok: portfolio.cashDetail.savings !== null && (source === "new" || amount <= portfolio.cashDetail.deployable),
      detail: portfolio.cashDetail.savings === null ? "Enter your savings balance so the protected reserve and deployable cash are known"
        : source === "existing" && amount > portfolio.cashDetail.deployable ? `Only $${portfolio.cashDetail.deployable.toLocaleString()} is deployable after the protected reserve` : `Deployable cash $${portfolio.cashDetail.deployable.toLocaleString()}` },
    { key: "research", label: "No unresolved material events", ok: !refresh.length,
      detail: refresh.length ? `${refresh.map((o) => o.symbol).join(", ")}: something material changed since the research, or filings could not be checked. Until that is resolved the best use of the money may change` : "No new results, financings or zone changes since each held stock's research" },
  ];
  // Dollar amounts only when every readiness check passes. The analysis and its leaning are given either way.
  const status: NewCapitalResult["status"] = gates.every((g) => g.ok) ? "actionable" : "analysis_only";
  const toVerify = [
    ...gates.filter((g) => !g.ok && g.key !== "research").map((g) => g.detail),
    ...refresh.flatMap((o) => o.toVerify),
    ...[...stockOptions, ...newOptions].filter((o) => o.label === "Condition not met" || o.label === "Limit not approved").flatMap((o) => o.toVerify),
  ].filter((x, i, a) => a.indexOf(x) === i);

  if (refresh.length) wouldChange.unshift(`Refreshed research on ${refresh.map((o) => o.symbol).join(", ")} that sets expected returns at today's prices.`);
  for (const o of [...stockOptions, ...newOptions].filter((x) => x.label === "Condition not met")) wouldChange.push(`${o.symbol}: confirmation of the research's condition (${o.stance?.condition}).`);
  confidence -= gates.filter((g) => !g.ok).length;

  const researched = [...stockOptions, ...newOptions].filter((o) => o.stance);
  const why = researched.slice(0, 5).map((o) => `${o.symbol}: ${o.label === "Research says hold" ? "research says hold" : o.label === "Condition not met" ? "add only on a condition not yet met" : o.label.toLowerCase()}`).join("; ");
  const lean = eligible.length
    ? `Lean: add to ${eligible.slice(0, 2).map((o) => o.symbol).join(" and ")}, where the research and the modeled return both support it and you approved the limit${etf && allocations.some((x) => x.symbol === etf.symbol) ? `; the rest to ${etf.symbol}` : ""}.`
    : `Lean: ${etf?.symbol ?? "VOO"} or hold cash. ${etf ? `${etf.symbol}: ${etf.notes[0].charAt(0).toLowerCase()}${etf.notes[0].slice(1)}. ` : ""}No stock qualifies for new money right now${why ? ` (${why})` : ""}.`;
  const leanShort = eligible.length ? `Leaning: add to ${eligible.slice(0, 2).map((o) => o.symbol).join(" and ")}` : `Leaning: ${etf?.symbol ?? "VOO"} or hold cash`;
  const split = allocations.map((x) => `$${x.amount.toLocaleString()} ${x.symbol}`).join(" + ");
  return {
    amount,
    source,
    asOf: now.toISOString(),
    status,
    lean,
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
      illustrative: status !== "actionable",
      confidence: Math.max(1, Math.min(10, confidence)),
      headline: status === "actionable" ? split || "Hold cash" : leanShort,
      rationale,
      wouldChange,
    },
    assumptions: { alternatives: ALTERNATIVES, riskFree10y: riskFreeFor(10, yields) },
    warnings,
  };
}

const LABEL_ORDER: OptionLabel[] = ["Candidate", "Limit not approved", "Condition not met", "Refresh required", "Research says hold", "Not ahead of VOO", "At limit", "No limit set", "Research needed", "Valid option", "Trim review"];
const rankLabel = (l: OptionLabel) => LABEL_ORDER.indexOf(l);

export function pct(n: number, digits = 1) {
  return `${(n * 100).toFixed(digits)}%`;
}
