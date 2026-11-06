/**
 * The new-capital decision ("I have $1,250, where should it go?").
 *
 * Deterministic. It compares: adding to researched holdings, buying diversified ETFs, starting researched
 * new positions, holding cash, and reviewing positions that are above their limits.
 *
 * It only calls a result ACTIONABLE when the evidence behind it passes every gate: recent holdings, known
 * cash, limits you approved, return assumptions you chose, and research current enough to rank the
 * alternatives. Otherwise the status is WAIT / REVIEW, with a list of what to verify, and any split it
 * computes is shown as illustrative only.
 *
 * A price drop never makes a stock more attractive by itself: once the price is far from the research
 * reference (either direction) the research must be refreshed before it can size anything.
 */
import type { PortfolioView } from "@/lib/portfolio/engine";
import { DEFAULT_ETF_FOR_BUCKET, type Bucket } from "@/lib/portfolio/classify";
import type { Policy } from "@/lib/policy/limits";
import type { ResearchRecord } from "@/lib/research/records";
import { researchAgeDays } from "@/lib/research/records";
import { expectedReturnAt, REPRICE_LIMIT, zoneFor } from "@/lib/research/valuation";
import type { Quote } from "@/lib/market/quotes";

export const CODE_VERSION = "new-capital@2";

/** Placeholders until you set your own on the Policy page. Shown on screen whenever they are used. */
export const DEFAULT_ASSUMPTIONS = {
  etfExpectedReturn: 0.07, // long-run broad-equity estimate, nominal, before tax
  hurdlePoints: 0.03, // a stock must beat the ETF by this much to be preferred
};

/** Price this far from the research reference (up or down) means the scenarios must be refreshed before use. */
export const BIG_MOVE = REPRICE_LIMIT;
/** Holdings older than this are not reliable enough to size a purchase. */
export const HOLDINGS_FRESH_DAYS = 7;

export type OptionLabel = "Candidate" | "Valid option" | "Refresh required" | "Research needed" | "At limit" | "Below hurdle" | "Trim review";

export type Option = {
  kind: "stock" | "new_stock" | "etf" | "cash" | "trim";
  symbol: string;
  label: OptionLabel;
  price: number | null;
  priceSource: "quote" | "statement" | null;
  expectedReturn: number | null; // only when the research is current enough to re-price
  headroomDollars: number | null;
  weightNow: number | null;
  maxWeight: number | null;
  limitStatus: string | null;
  eligible: boolean;
  notes: string[];
  researchAction: string | null;
  zoneAction: string | null;
  refreshFirst?: boolean;
  toVerify: string[];
};

export type Gate = { key: string; label: string; ok: boolean; detail: string };

export type NewCapitalResult = {
  amount: number;
  source: "new" | "existing";
  asOf: string;
  status: "actionable" | "wait_review";
  gates: Gate[];
  toVerify: string[];
  options: Option[];
  recommendation: {
    allocations: { symbol: string; amount: number }[];
    illustrative: boolean; // true when status is wait_review: not a recommendation to act on
    confidence: number;
    headline: string;
    rationale: string[];
    wouldChange: string[];
  };
  assumptions: { etfExpectedReturn: number; hurdlePoints: number; etfSource: string; hurdleSource: string; approved: boolean };
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
  assumptions?: Partial<typeof DEFAULT_ASSUMPTIONS>;
}): NewCapitalResult {
  const { amount, portfolio, research, policy, now } = args;
  const source = args.source ?? "new";
  const audit = policy?.audit;
  const etfReturn = args.assumptions?.etfExpectedReturn ?? audit?.assumptions.etfExpectedReturn.value ?? DEFAULT_ASSUMPTIONS.etfExpectedReturn;
  const hurdle = args.assumptions?.hurdlePoints ?? policy?.hurdleOverEtfPoints ?? audit?.assumptions.hurdle.value ?? DEFAULT_ASSUMPTIONS.hurdlePoints;
  const assumptionsApproved = !!audit && audit.assumptions.etfExpectedReturn.status === "approved" && audit.assumptions.hurdle.status === "approved";
  const freshDays = policy?.researchFreshnessDays ?? 120;
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
    let label: OptionLabel = "Candidate";
    let er: number | null = null;
    let zoneAction: string | null = null;
    let refreshFirst = false;
    const lim = policy?.companies[symbol];
    const max = e?.max ?? lim?.hardMax ?? policy?.genericCompanyHardMax ?? 0.1;

    if (!r || (!v && !r.conflict)) { label = "Research needed"; notes.push("No current research on file"); toVerify.push(`${symbol}: full research before it can be compared`); }
    else if (r.conflict) { label = "Research needed"; notes.push("Research records conflict and none is marked current"); toVerify.push(`${symbol}: resolve which research record is current`); }
    else if (v) {
      const age = researchAgeDays(r, now);
      const ref = v.parsed.referencePrice;
      const drift = ref && price ? price / ref - 1 : null;
      zoneAction = price ? zoneFor(v.parsed.zones, price)?.action ?? null : null;
      if (v.completeness !== "complete") { label = "Refresh required"; notes.push(`Research is ${v.completeness}`); toVerify.push(`${symbol}: complete the missing research phases`); }
      if (age !== null && age > freshDays) { label = "Refresh required"; notes.push(`Research is ${age} days old (limit ${freshDays})`); toVerify.push(`${symbol}: refresh research older than ${freshDays} days`); }
      if (drift !== null && Math.abs(drift) > BIG_MOVE) {
        label = "Refresh required";
        refreshFirst = true;
        notes.push(`Price is ${Math.round(Math.abs(drift) * 100)}% ${drift < 0 ? "below" : "above"} the $${ref} research reference (${v.parsed.referenceDate}). Not re-priced: a move this large can change the scenario probabilities, financing, dilution and cash-flow assumptions`);
        toVerify.push(`${symbol}: re-underwrite the scenarios at today's price (${drift < 0 ? "a lower price is not a buy signal by itself" : "check the valuation still holds"})`);
      }
      if (label === "Candidate" && price) {
        er = expectedReturnAt(v.parsed, price, now);
        if (er === null) { label = "Research needed"; notes.push("Research has no scenario valuation to compare"); }
        else if (er < etfReturn + hurdle) { label = "Below hurdle"; notes.push(`Expected return ${pct(er)} does not clear the ETF + ${pct(hurdle)} hurdle`); }
      }
      if (v.parsed.action) notes.push(`Research action at the reference price: ${v.parsed.action}`);
    }

    // New cash fills a position only to the top of its normal range; higher needs an explicit high-conviction decision.
    const normalHigh = lim?.normal?.high ?? null;
    const ceiling = Math.min(max, normalHigh ?? max);
    const current = (e?.total ?? 0) * portfolio.total;
    const headroom = Math.max(0, Math.round((ceiling * postTotal - current) * 100) / 100);
    if (headroom <= 0) {
      if (label === "Candidate") label = "At limit";
      notes.push(ceiling < max ? `At the top of its normal range (${pct(ceiling)})` : `At or above its ${pct(max)} maximum, including ETF look-through`);
    }
    if (lim?.status === "conflict") {
      notes.push(`Your sources disagree on its limit; using the stricter ${pct(max)} until you choose on the Policy page`);
      toVerify.push(`${symbol}: choose which allocation limit is authoritative`);
    } else if (!lim || lim.status === "none") notes.push(`No company-specific limit; the generic ${pct(max)} maximum applies`);

    return {
      kind: held ? "stock" : "new_stock", symbol, label, price, priceSource: h?.priceSource ?? (q ? "quote" : null), expectedReturn: er,
      headroomDollars: headroom, weightNow: e?.total ?? 0, maxWeight: ceiling, limitStatus: lim?.status ?? null,
      eligible: label === "Candidate", notes, researchAction: v?.parsed.action ?? null, zoneAction, refreshFirst, toVerify,
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
      const notes = [`${b.bucket} is ${pct(b.weight)}${b.normal ? `, normal range ${pct(b.normal.low)}–${pct(b.normal.high)}` : ""}`, `Expected return is an assumption (${pct(etfReturn)}), not a forecast`];
      if (b.status === "over_max" || b.status === "above") notes.push("Already above its normal range");
      return {
        kind: "etf" as const, symbol, label: (i === 0 && gap > 0 ? "Candidate" : "Valid option") as OptionLabel, price: h?.price ?? args.quotes?.get(symbol)?.price ?? null,
        priceSource: h?.priceSource ?? null, expectedReturn: etfReturn, headroomDollars: null, weightNow: b.weight, maxWeight: b.hardMax,
        limitStatus: b.status === "no_limit" ? "none" : "approved", eligible: b.status !== "over_max", notes, researchAction: null, zoneAction: null, toVerify: [],
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
    notes: ["Policy: new cash does not have to be invested immediately", `The $${portfolio.cashDetail.protectedReserve.toLocaleString()} protected reserve is excluded from sizing`, "Cash yield not entered, so it is not compared on return"],
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
    rationale.push(`${c.symbol}: about ${pct(c.expectedReturn!)} a year expected at today's price from current research, against ${pct(etfReturn)} assumed for an ETF.`);
    if (/specul|asymmetric/i.test(research.find((r) => r.symbol === c.symbol)?.current?.parsed.classification ?? "")) confidence -= 1;
    wouldChange.push(`${c.symbol} rising until its expected return is below ${pct(etfReturn + hurdle)}, or new evidence against its thesis.`);
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
  const limitIssues = stockOptions.filter((o) => receiving.includes(o.symbol) && o.limitStatus !== "approved").map((o) => o.symbol);
  const conflicts = audit?.conflicts.map((c) => c.subject) ?? [];
  const gates: Gate[] = [
    { key: "holdings", label: "Holdings are current", ok: oldest <= HOLDINGS_FRESH_DAYS && !gaps.length,
      detail: oldest <= HOLDINGS_FRESH_DAYS ? (gaps.length ? `Statement totals do not add up for ${gaps.map((a) => a.name).join(", ")}` : "All accounts updated within a week") : `Oldest statement is ${oldest} days old. Confirm holdings or record trades since then` },
    { key: "cash", label: "Cash and savings are known", ok: portfolio.cashDetail.savings !== null && (source === "new" || amount <= portfolio.cashDetail.deployable),
      detail: portfolio.cashDetail.savings === null ? "Enter your savings balance so the protected reserve and deployable cash are known"
        : source === "existing" && amount > portfolio.cashDetail.deployable ? `Only $${portfolio.cashDetail.deployable.toLocaleString()} is deployable after the protected reserve` : `Deployable cash $${portfolio.cashDetail.deployable.toLocaleString()}` },
    { key: "limits", label: "Limits you approved", ok: !limitIssues.length && !conflicts.length,
      detail: conflicts.length ? `Your sources disagree on limits for ${conflicts.join(", ")}` : limitIssues.length ? `No approved limit for ${limitIssues.join(", ")}` : "Every limit used is approved" },
    { key: "assumptions", label: "Return assumptions you chose", ok: assumptionsApproved,
      detail: assumptionsApproved ? `ETF ${pct(etfReturn)}, hurdle ${pct(hurdle)}` : `ETF return ${pct(etfReturn)} and hurdle ${pct(hurdle)} are app placeholders, not your numbers` },
    { key: "research", label: "Research can rank the alternatives", ok: !refresh.length,
      detail: refresh.length ? `${refresh.map((o) => o.symbol).join(", ")} cannot be compared on current evidence` : "Every held stock has current research" },
  ];
  const status: NewCapitalResult["status"] = gates.every((g) => g.ok) ? "actionable" : "wait_review";
  const toVerify = [
    ...gates.filter((g) => !g.ok && g.key !== "research").map((g) => g.detail),
    ...refresh.flatMap((o) => o.toVerify),
  ].filter((x, i, a) => a.indexOf(x) === i);

  if (refresh.length) wouldChange.unshift(`Refreshed research on ${refresh.map((o) => o.symbol).join(", ")} that sets expected returns at today's prices.`);
  if (!assumptionsApproved) wouldChange.push("Your own ETF return and hurdle assumptions.");
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
      illustrative: status !== "actionable",
      confidence: Math.max(1, Math.min(10, confidence)),
      headline: status === "actionable" ? split : "WAIT / REVIEW",
      rationale,
      wouldChange,
    },
    assumptions: {
      etfExpectedReturn: etfReturn, hurdlePoints: hurdle, approved: assumptionsApproved,
      etfSource: audit?.assumptions.etfExpectedReturn.source ?? "App default", hurdleSource: audit?.assumptions.hurdle.source ?? "App default",
    },
    warnings,
  };
}

const LABEL_ORDER: OptionLabel[] = ["Candidate", "Refresh required", "Below hurdle", "At limit", "Research needed", "Valid option", "Trim review"];
const rankLabel = (l: OptionLabel) => LABEL_ORDER.indexOf(l);

export function pct(n: number, digits = 1) {
  return `${(n * 100).toFixed(digits)}%`;
}
