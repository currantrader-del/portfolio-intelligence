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
 * Research guides the decision but does not freeze it: when the price, the re-priced valuation, results, filings
 * or financing have changed since the research was written, the old conclusion is shown as the old conclusion,
 * and the current recommendation is "reassess first" (no new money) until that is done.
 *
 * Before the diversified option is chosen, each core ETF, the existing holdings and keeping cash are compared
 * on what they do to the whole portfolio's exposure (NVIDIA look-through, technology, semiconductors, AI
 * infrastructure, US share, emerging markets) and to each bucket's range.
 *
 * EXECUTION READINESS (needed before a dollar amount is "ready to execute"):
 *  - the money is verified: planned money that has not arrived is a plan, never an order; cash already held is
 *    capped at what is deployable;
 *  - holdings and balances are verified: a statement, sync or your own check within a week. Trades recorded
 *    since an older statement are not a reconciliation;
 *  - no unresolved material development (results, financing, material 8-K) for any held or receiving stock.
 * Otherwise the result is "conditional": the analysis, the leaning and the conditions are given, and the split
 * is what to do once they are met.
 */
import type { PlannedTransfer, PortfolioView } from "@/lib/portfolio/engine";

const fmt$ = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
import { DEFAULT_ETF_FOR_BUCKET, bucketOf, type Bucket } from "@/lib/portfolio/classify";
import { companyLimit, type Policy } from "@/lib/policy/limits";
import type { ResearchRecord } from "@/lib/research/records";
import type { Quote } from "@/lib/market/quotes";
import type { FilingsResult } from "@/lib/market/sec";
import { ALTERNATIVES, assessVsAlternatives, conditionIn, refreshState, researchStance, riskFreeFor, type Alternative, type Assessment, type ResearchStance, type RiskFree } from "@/lib/policy/evidence";
import type { Yields } from "@/lib/workspace-core";
import { exposureImpact, exposureRules, type ExposureImpact } from "@/lib/decision/exposureImpact";
import type { PolicyRuleRow } from "@/lib/policy/rules";

export const CODE_VERSION = "new-capital@6";

/** planned: new money not yet deposited (a plan). deposited: new money you confirmed has arrived. existing: cash already held. */
export type MoneySource = "planned" | "deposited" | "existing";

/** Holdings older than this are not reliable enough to size a purchase. */
export const HOLDINGS_FRESH_DAYS = 7;

export type OptionLabel = "Candidate" | "Valid option" | "Refresh required" | "Research needed" | "Preliminary research" | "No limit set" | "At limit" | "Not ahead of VOO" | "Research says hold" | "Condition not met" | "Limit not approved" | "Trim review";

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
  /** The research's conclusion as written, and whether it is still today's recommendation. */
  reassessment?: Reassessment | null;
  toVerify: string[];
};

export type Reassessment = {
  conclusion: { action: string; asOf: string; referencePrice: number | null };
  priceMove: number | null; // today's price vs the research reference
  changes: string[]; // what happened since the research
  status: "current" | "needed" | "unverified" | "not_approved";
  current: string; // today's recommendation for this stock, in words
};

export type Gate = { key: string; label: string; ok: boolean; detail: string };

export type NewCapitalResult = {
  amount: number;
  source: MoneySource;
  /** The money the result is sized on, and whether it is verified. */
  funds: { requested: number; used: number; verified: boolean; detail: string };
  asOf: string;
  /** ready: verified money, verified holdings and no open material issue, so the split can be executed. conditional: the opinion stands, but the split is what to do once the open conditions are met. */
  status: "ready" | "conditional";
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
  /** Each way of using the money compared on total-portfolio exposure, and why the diversified option was chosen. */
  exposure: { impacts: ExposureImpact[]; choice: string; reasons: string[] };
  assumptions: { alternatives: Alternative[]; riskFree10y: RiskFree; items: string[] };
  warnings: string[];
};

const ETF_BUCKETS: Bucket[] = ["US broad-market equity", "International equity", "Small/mid-cap"];

export function newCapital(args: {
  amount: number;
  portfolio: PortfolioView;
  research: ResearchRecord[];
  policy: Policy | null;
  now: Date;
  source?: MoneySource | "new";
  /** You checked today that the holdings and balances shown match your broker accounts. */
  holdingsConfirmed?: boolean;
  /** Policy rules, for the exposure review levels (drafted proposals are used, labelled, when none are on file). */
  rules?: Pick<PolicyRuleRow, "scope" | "subject" | "approval" | "normal_low" | "normal_high" | "value" | "hard_max">[];
  quotes?: Map<string, Quote>;
  /** SEC filings per symbol. A symbol missing here could not be checked, so its research is "unverified". */
  filings?: Map<string, FilingsResult>;
  /** Treasury yields for the risk-free alternative. */
  yields?: Yields | null;
  /** Extra tickers to assess even without research (e.g. a stock you asked about). They get no money without research and a limit. */
  consider?: string[];
  /** Transfers between your accounts that you recorded as planned (savings to brokerage, for example). */
  transfers?: PlannedTransfer[];
  /** Savings you could move under your standing transfer limit (already net of planned transfers).
   *  Only used with source "existing": it can fund the purchase only if you choose to transfer it. */
  authorizedSavings?: number;
}): NewCapitalResult {
  const { portfolio, research, policy, now } = args;
  const source: MoneySource = !args.source || args.source === "new" ? "planned" : args.source;
  const requested = args.amount;
  // ---- Money by account: only the self-directed brokerage account can buy a chosen stock or ETF. Savings
  //      can fund it only through a transfer you planned; Acorns and Roth cash stay where they are. ----
  const cd = portfolio.cashDetail;
  const inv = cd.investingAccount ?? null;
  const invName = inv?.name ?? "your brokerage account";
  const spendable = Math.max(0, cd.spendableNow ?? 0);
  const invAsOf = portfolio.accounts.find((a) => a.id === inv?.id)?.asOf ?? null;
  // A planned transfer counts until the receiving account's records postdate it (then it is already in the cash).
  const pendingIn = (args.transfers ?? []).filter((t) => inv && t.toAccountId === inv.id && (!invAsOf || t.createdAt > invAsOf));
  const plannedIn = Math.round(pendingIn.reduce((a, t) => a + t.amount, 0) * 100) / 100;
  const elsewhere = (cd.accounts ?? []).filter((a) => !a.canBuyChosen && a.use !== "savings" && a.cash >= 0.5);
  const elsewhereNote = elsewhere.length ? ` Cash in ${elsewhere.map((a) => `${a.name} (${fmt$(a.cash)})`).join(" and ")} stays in ${elsewhere.length > 1 ? "those accounts" : "that account"} and is not counted.` : "";
  const reserveNote = "";
  const authorized = source === "existing" ? Math.max(0, Math.round((args.authorizedSavings ?? 0) * 100) / 100) : 0;
  const deployable = spendable + plannedIn + authorized;
  const amount = source === "existing" ? Math.min(requested, Math.floor(deployable * 100) / 100) : requested;
  // "Already deposited" is checked against the investing account's own cash. Once recorded it is already part
  // of that cash, so it must not be added to the portfolio a second time.
  const recordedCash = Math.round(spendable * 100) / 100;
  const depositShows = source === "deposited" && recordedCash + 0.5 >= amount;
  const fromTransfer = source === "existing" ? Math.max(0, Math.round((amount - spendable) * 100) / 100) : 0;
  const savingsHint = cd.deployableSavings >= 1 && !plannedIn ? ` Savings hold ${fmt$(cd.deployableSavings)}; that can be used only after you plan a transfer to ${invName}.` : "";
  const funds: NewCapitalResult["funds"] = source === "planned"
    ? { requested, used: amount, verified: false, detail: `${fmt$(requested)} of planned new money for ${invName}, not yet deposited. This is what to do once it arrives, not an order to place now` }
    : source === "deposited"
      ? depositShows
        ? { requested, used: amount, verified: true, detail: `You said ${fmt$(requested)} of new money arrived in ${invName}, and its recorded cash (${fmt$(recordedCash)}) covers it` }
        : { requested, used: amount, verified: false, detail: `You said ${fmt$(requested)} of new money arrived, but ${invName} shows only ${fmt$(recordedCash)} of cash. Record the deposit (or add a current statement) so the money can be checked.${elsewhereNote}` }
      : fromTransfer > 0
        ? { requested, used: amount, verified: false, detail: authorized < 0.01
          ? `${fmt$(amount)}: ${fmt$(spendable)} already in ${invName} plus ${fmt$(fromTransfer)} from the transfer you planned, which has not arrived yet. ${reserveNote}${elsewhereNote}`
          : `${fmt$(amount)}: ${fmt$(spendable)} already in ${invName} plus ${fmt$(fromTransfer)} from savings${Math.min(fromTransfer, plannedIn) >= 0.01 ? `, ${fmt$(Math.min(fromTransfer, plannedIn))} of it through the transfer you planned, which has not arrived yet` : ""}${fromTransfer - plannedIn >= 0.01 ? `${plannedIn >= 0.01 ? ", and" : ","} ${fmt$(fromTransfer - plannedIn)} only if you choose to transfer it under your standing limit` : ""}. ${reserveNote}${elsewhereNote}` }
        : { requested, used: amount, verified: amount >= 1, detail: (amount < requested
          ? `You asked about ${fmt$(requested)}, but ${invName} holds ${fmt$(spendable)} of cash that can buy a stock or ETF, so this is sized on ${fmt$(amount)}.${savingsHint}`
          : `${fmt$(amount)} of cash already in ${invName}.`) + ` ${reserveNote}${elsewhereNote}` };
  // A cash figure is only as good as what confirms it: arithmetic on recorded transactions is not a balance.
  // Until a statement or your own check confirms the brokerage cash, money sized on it stays conditional.
  if (source !== "planned" && inv && !(inv.confirmed ?? true) && !args.holdingsConfirmed && funds.verified) {
    funds.verified = false;
    funds.detail += ` The ${invName} cash is not confirmed: ${inv.basis?.detail ?? "it is worked out from records, not read from a statement"}${inv.basis?.checks.length ? ` ${inv.basis.checks.join(" ")}` : ""} Check the cash and buying power in the broker's app and confirm.`;
  }
  const audit = policy?.audit;
  const yields = args.yields ?? { y2: null, y10: null };
  // Money already counted as deployable cash only moves within the portfolio; new money grows it.
  const isNew = source === "planned" || (source === "deposited" && !depositShows);
  // Limits apply to the invested portfolio. New money grows it; so does savings moved into the brokerage (an
  // internal transfer: not new capital overall, but it joins the invested portfolio). Savings that stay put never do.
  const movedIn = isNew ? amount : fromTransfer;
  const postTotal = portfolio.total + movedIn;
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
    else if (!r.authoritative) {
      const what = r.authority === "preliminary_screen" ? "a preliminary screen" : r.authority === "historical" ? "older research" : "research";
      fresh = { ok: false, detail: `Preliminary research only: the record on file is ${what}, enough for Hold or No Add, not for new money` };
      toVerify.push(`${symbol}: a targeted investigation before research-based recommendations`);
    }
    else if (r.approval === "provisional") { fresh = { ok: false, detail: "The completed investigation still has material questions open" }; toVerify.push(`${symbol}: a targeted update to resolve the open questions before new money`); }
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
    let valuationChange: string | null = null;
    if (v && price) {
      stance = researchStance(v.parsed, price);
      zoneAction = stance?.from === "zone" ? stance.text : null;
      const years = v.parsed.horizonDate ? Math.max(0.25, (new Date(v.parsed.horizonDate).getTime() - now.getTime()) / (365.25 * 864e5)) : 10;
      assessment = assessVsAlternatives(v.parsed, price, now, {
        riskFree: riskFreeFor(years, yields), weightNow: e?.total ?? 0,
        limit: cl.hasLimit ? { normalHigh, hcHigh, max: cl.newMoneyMax } : null, completeness: v.completeness, confidence: v.parsed.confidence,
      });
      // New evidence on valuation: the research's own scenarios at its reference price vs at today's price.
      const ref = v.parsed.referencePrice;
      const atRef = ref && ref > 0 && Math.abs(price / ref - 1) > 0.005 ? assessVsAlternatives(v.parsed, ref, now, { riskFree: riskFreeFor(years, yields) }) : null;
      if (assessment && atRef && atRef.judgment !== assessment.judgment) {
        valuationChange = `Valuation changed since the research: at its $${ref} reference the modeled return was ${(atRef.expected * 100).toFixed(1)}% a year (${atRef.judgment} vs VOO); at today's $${price.toFixed(2)} it is ${(assessment.expected * 100).toFixed(1)}% (${assessment.judgment})`;
        if (fresh.ok) { fresh = { ok: false, detail: valuationChange }; refreshFirst = true; toVerify.push(`${symbol}: reassess the research conclusion at today's price (valuation change)`); }
        else fresh = { ok: false, detail: `${fresh.detail}; ${valuationChange}` };
      }
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
      else if (assessment.comparison === "approximate") {
        // A few-year stock case vs 10-15-year index forecasts is context, not a pass/fail: the research decides,
        // and only a clear contradiction (its own scenarios below every VOO forecast) holds it back.
        const contradicts = assessment.judgment === "unfavourable";
        valuation = { ok: !contradicts, detail: `${said}. ${assessment.summary}${contradicts ? " The research would add, but its own scenarios at today's price fall below every VOO forecast, so the conclusion needs reassessing before new money." : ""}` };
      } else valuation = { ok: modelFav, detail: `${said}. ${assessment.summary}${modelFav ? "" : " The research would add, but the modeled return does not clearly beat VOO, so no new money on return grounds."}` };
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
    if (!fresh.ok) label = !v || r?.conflict ? "Research needed" : r && !r.authoritative ? "Preliminary research" : "Refresh required";
    else if (!cl.hasLimit) label = "No limit set";
    else if (headroom <= 0) label = "At limit";
    else if (stance?.kind === "conditional") label = "Condition not met";
    else if (stance && stance.kind !== "add") label = "Research says hold";
    else if (!valuation.ok) label = "Not ahead of VOO";
    else if (!approvedByYou) label = "Limit not approved";
    notes.unshift(`Research: ${valuation.detail}`, `Limit: ${limit.detail}`, `Current: ${fresh.detail}`);
    if (agreement === "model_more_positive") notes.push("The modeled return looks better than the research's conclusion. The app follows the research, which weighs uncertainty, downside and conditions the model leaves out.");
    if (v?.parsed.action && stance?.from === "zone") notes.push(`Research conclusion at its reference price: ${v.parsed.action}`);

    // The old conclusion vs today's recommendation. Research guides; it is not frozen when the evidence changes.
    let reassessment: Reassessment | null = null;
    if (v && (v.parsed.action || stance)) {
      const refP = v.parsed.referencePrice ?? null;
      const priceMove = refP && price ? price / refP - 1 : null;
      const st = v.completeness === "complete" ? refreshState({ asOf: v.research_as_of, pc: v.parsed, price, filings: args.filings?.get(symbol) ?? null }) : null;
      const changes = [
        ...(priceMove !== null ? [Math.abs(priceMove) < 0.001 ? `Price unchanged since the research ($${refP})` : `Price ${priceMove >= 0 ? "up" : "down"} ${Math.abs(priceMove * 100).toFixed(1)}% since the research ($${refP} → $${price!.toFixed(2)})`] : []),
        ...(st?.triggers.filter((t) => t.kind !== "unverified").map((t) => t.detail) ?? []),
        ...(valuationChange ? [valuationChange] : []),
      ];
      const status: Reassessment["status"] = r && !r.authoritative ? "not_approved" : fresh.ok ? "current" : st?.status === "unverified" && !valuationChange ? "unverified" : "needed";
      const action = v.parsed.action ?? stance!.text;
      const asOf = v.research_as_of ?? "an unknown date";
      const hint = assessment ? ` At today's price the research's own scenarios model ${(assessment.expected * 100).toFixed(1)}% a year (${assessment.judgment} vs VOO${assessment.comparison === "approximate" ? ", approximate" : ""}); that is a reason to reassess, not a new conclusion.` : "";
      const current = status === "not_approved"
        ? `Preliminary research only. The ${asOf} record ("${action}") is ${r?.authority === "preliminary_screen" ? "a preliminary screen" : "older research"}, enough to hold what you own but not to add. Until a targeted investigation is done: hold, no new money.`
        : status === "current"
        ? `The ${asOf} conclusion still applies: nothing material has changed. ${stance?.kind === "add" ? "Add" : stance?.kind === "conditional" ? `Add only once its condition is met (${stance.condition})` : stance?.kind === "trim" ? "Review a trim" : "Hold; no new money"}.`
        : status === "unverified"
          ? `Filings since ${asOf} could not be checked, so the conclusion is not re-confirmed. Until they are: hold, no new money.`
          : `Reassess first. The ${asOf} conclusion ("${action}") was written before what changed below, so it is not today's recommendation. Until it is reassessed: hold what you own, no new money.${hint}`;
      reassessment = { conclusion: { action, asOf, referencePrice: refP }, priceMove, changes, status, current };
    }

    return {
      kind: held ? "stock" : "new_stock", symbol, label, price, priceSource: h?.priceSource ?? (q ? "quote" : null), expectedReturn: er, assessment, highConviction,
      headroomDollars: headroom, weightNow: e?.total ?? 0, maxWeight: cl.hasLimit ? ceiling : null, limitStatus: lim?.authority === "you" ? "approved" : lim?.authority === "imported" ? "imported" : lim?.status ?? "none",
      eligible: label === "Candidate", notes, researchAction: v?.parsed.action ?? null, zoneAction, refreshFirst, verdicts: { limit, valuation, research: fresh }, stance, agreement, reassessment, toVerify,
    };
  };

  const stockOptions = portfolio.exposures.map((e) => stockOption(e.symbol, true));
  const heldSet = new Set(portfolio.holdings.map((h) => h.symbol));
  const newSymbols = [...research.filter((r) => !heldSet.has(r.symbol) && r.current && r.pipeline?.stage !== "passed").map((r) => r.symbol),
    ...(args.consider ?? []).map((x) => x.toUpperCase()).filter((x) => !heldSet.has(x))].filter((x, i, a) => a.indexOf(x) === i);
  const newOptions = newSymbols.map((symbol) => stockOption(symbol, false));

  // ---- Diversified options: each core ETF, the held stocks and keeping cash, compared on the whole portfolio ----
  const etfBuckets = portfolio.buckets.filter((b) => ETF_BUCKETS.includes(b.bucket));
  const nvdaCl = companyLimit(policy, "NVDA");
  const heldResearched = stockOptions.filter((o) => o.stance).map((o) => ({ symbol: o.symbol, label: "Existing holding" }));
  const ex = exposureImpact({
    holdings: portfolio.holdings.map((h) => ({ symbol: h.symbol, value: h.value })), cash: portfolio.cash + (isNew ? 0 : fromTransfer), amount, source: isNew ? "new" : "existing",
    options: [...etfBuckets.map((b) => ({ symbol: DEFAULT_ETF_FOR_BUCKET[b.bucket] ?? "VOO", label: b.bucket })), ...heldResearched, { symbol: "CASH", label: "Keep cash" }],
    rules: exposureRules(args.rules ?? []),
    nvdaMax: nvdaCl.hasLimit ? { value: nvdaCl.newMoneyMax, status: policy?.companies.NVDA?.authority === "you" ? "approved" : "imported" } : null, now,
  });
  const impactOf = (symbol: string) => ex.impacts.find((x) => x.symbol === symbol) ?? null;
  const etfFacts = etfBuckets.map((b) => {
    const symbol = DEFAULT_ETF_FOR_BUCKET[b.bucket] ?? "VOO";
    const after = postTotal ? (b.value + amount) / postTotal : 0;
    const imp = impactOf(symbol);
    return { b, symbol, after, imp, endsAbove: !!b.normal && after > b.normal.high, below: !!b.normal && b.weight < b.normal.low, crosses: imp?.rows.filter((r) => r.crosses) ?? [] };
  });
  // Which concentrations are already at or over a level on file (approved, imported or proposed).
  const atLevel = (impactOf("CASH")?.rows ?? []).filter((r) => r.level && r.before >= r.level.value).map((r) => r.key);
  const usable = etfFacts.filter((f) => !f.endsAbove && !f.crosses.length);
  const pool = usable.length ? usable : etfFacts;
  const lower = (f: (typeof etfFacts)[number]) => atLevel.reduce((a, k) => { const r = f.imp?.rows.find((x) => x.key === k); return a + (r ? r.before - r.after : 0); }, 0);
  const voo = pool.find((f) => f.symbol === "VOO");
  // Being below a bucket's guide range is information, never a reason to buy: it does not decide the choice.
  const lowerLead = atLevel.length ? [...pool].sort((x, y) => lower(y) - lower(x))[0] : undefined;
  const chosen = (lowerLead && voo && lower(lowerLead) > lower(voo) ? lowerLead : undefined) ?? voo ?? pool[0];
  const exReasons: string[] = [];
  const whyOf = new Map<string, string>();
  const notChosen = (f: (typeof etfFacts)[number]) => f.endsAbove ? `${f.b.bucket} would go to ${pct(f.after)}, above its ${pct(f.b.normal!.high)} normal top`
      : f.crosses.length ? `it would push ${f.crosses.map((r) => r.label).join(", ")} past ${f.crosses.length > 1 ? "their levels" : "its level"}`
      : !ALTERNATIVES.some((a) => a.symbol === f.symbol) ? `no published return forecast on file to compare it with, and no concentration needs it now`
      : `${f.symbol === "VOO" ? "the default" : "a valid alternative"}, not preferred here${f.below ? ` (its bucket is below its guide range, which is not a reason to buy)` : ""}`;
  const vooFact = etfFacts.find((f) => f.symbol === "VOO");
  for (const f of etfFacts) {
    const inRange = `it keeps ${f.b.bucket} under the top of its guide range (${pct(f.b.weight)} → ${pct(f.after)})`;
    const why = f !== chosen ? notChosen(f)
      : f === lowerLead && f !== voo ? `it lowers the concentrations already at their levels (${atLevel.join(", ")}) the most`
      : f.symbol === "VOO" && (f.endsAbove || f.crosses.length) ? `every core ETF has a drawback here (VOO: ${notChosen(f)}), and as your stated benchmark it is the least bad; keeping cash is equally valid`
      : f.symbol === "VOO" ? `it is your stated benchmark with published forecasts, ${inRange}, and none of your concentrations is at a level that calls for a less concentrated fund`
      : `VOO is not preferred here (${vooFact ? notChosen(vooFact) : "not available"}), and ${f.endsAbove || f.crosses.length ? "every core ETF has a drawback, so this is the least bad" : inRange}`;
    whyOf.set(f.symbol, why);
    exReasons.push(`${f.symbol}${f === chosen ? " (chosen)" : ""}: ${why}. ${f.imp?.summary ?? ""} ${f.b.bucket} ${pct(f.b.weight)} → ${pct(f.after)}${f.b.normal ? ` (normal ${pct(f.b.normal.low)}–${pct(f.b.normal.high)})` : ""}.`);
  }
  exReasons.sort((x, y) => Number(y.includes("(chosen)")) - Number(x.includes("(chosen)")));
  const cashImp = impactOf("CASH");
  exReasons.push(`Keep cash: no stock risk, and it earns about ${yields.y2 ? `the 2-year Treasury's ${yields.y2.value.toFixed(2)}%` : "a savings or Treasury rate"} (your savings yield is not entered). ${cashImp?.summary ?? ""} Better than any ETF for money you may need within a few years; the ETF forecasts (10-15 years) only apply to money you can leave invested that long.`);
  const heldWords = stockOptions.filter((o) => o.stance).map((o) => `${o.symbol} (${o.label === "Research says hold" ? "research says hold" : o.label.toLowerCase()})`);
  if (heldWords.length) exReasons.push(`Existing holdings: ${stockOptions.some((o) => o.eligible) ? `${stockOptions.filter((o) => o.eligible).map((o) => o.symbol).join(", ")} qualify for new money; ` : "none qualifies for new money: "}${heldWords.join(", ")}.`);

  const etfOptions: Option[] = [...etfFacts].sort((x, y) => (x === chosen ? -1 : y === chosen ? 1 : 0)).map((f) => {
    const { b, symbol } = f;
    const h = portfolio.holdings.find((x) => x.symbol === symbol);
    const alt = ALTERNATIVES.find((x) => x.symbol === symbol) ?? null;
    const notes = [f === chosen ? `Chosen because ${whyOf.get(symbol)}` : `${b.bucket} is ${pct(b.weight)}${b.normal ? `, normal range ${pct(b.normal.low)}–${pct(b.normal.high)}` : ""}`,
      alt ? `Published forecasts: ${alt.forecasts.map((x) => `${x.firm} ${x.asset} ${x.kind === "range" ? `${pct(x.low)}–${pct(x.high)}` : pct(x.low)} (${x.horizonYears[0] === x.horizonYears[1] ? x.horizonYears[0] : x.horizonYears.join("–")} years, as of ${x.asOf})`).join("; ")}. Forecasts, not promises` : "No published forecast on file for this bucket, so it is not ranked on return",
      ...(f.imp ? [`Whole-portfolio effect: ${f.imp.summary}`] : [])];
    if (b.status === "over_max" || b.status === "above") notes.push("Already above its normal range");
    return {
      kind: "etf" as const, symbol, label: (f === chosen ? "Candidate" : "Valid option") as OptionLabel, price: h?.price ?? args.quotes?.get(symbol)?.price ?? null,
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
    notes: ["Policy: new cash does not have to be invested immediately", "Brokerage cash and transferable savings are shown separately",
      yields.y2 ? `Risk-free alternative: 2-year Treasury ${yields.y2.value.toFixed(2)}% (FRED, ${yields.y2.date}); your savings yield is not entered` : "Treasury yields not loaded; your savings yield is not entered",
      ...(cashImp ? [`Whole-portfolio effect: ${cashImp.summary}`] : [])],
    researchAction: null, zoneAction: null, toVerify: [],
  };

  // ---- Split: stocks that qualify up to their room, the rest to the chosen diversified ETF ----
  const eligible = [...stockOptions, ...newOptions].filter((o) => o.eligible).sort((x, y) => (y.expectedReturn ?? 0) - (x.expectedReturn ?? 0));
  const allocations: { symbol: string; amount: number }[] = [];
  const rationale: string[] = [];
  const wouldChange: string[] = [];
  let remaining = amount;
  let confidence = 6;
  // A bucket maximum (e.g. the high-risk sleeve) is a ceiling on the stocks in it too, shared by all of them.
  const bucketRoom = new Map(portfolio.buckets.filter((b) => b.hardMax !== null).map((b) => [b.bucket, b.hardMax! * postTotal - b.value]));
  for (const c of eligible) {
    if (remaining < 1) break;
    const bucket = portfolio.holdings.find((h) => h.symbol === c.symbol)?.bucket ?? bucketOf(c.symbol, research.find((r) => r.symbol === c.symbol)?.current?.parsed.classification);
    const room = bucketRoom.get(bucket);
    const toStock = Math.floor(Math.min(c.headroomDollars ?? 0, remaining, room ?? Infinity));
    if (toStock <= 0) { if (room !== undefined && room < 1 && (c.headroomDollars ?? 0) >= 1) rationale.push(`${c.symbol}: no new money, because ${bucket} is at its maximum.`); continue; }
    if (room !== undefined) bucketRoom.set(bucket, room - toStock);
    allocations.push({ symbol: c.symbol, amount: toStock });
    remaining -= toStock;
    rationale.push(`${c.symbol}: the research supports adding at today's price ("${c.stance?.text ?? ""}") and nothing material has changed since. ${c.assessment?.summary ?? ""}${c.highConviction ? " Sized to its approved high-conviction range." : ""}`);
    if (/specul|asymmetric/i.test(research.find((r) => r.symbol === c.symbol)?.current?.parsed.classification ?? "")) confidence -= 1;
    wouldChange.push(`${c.symbol}: a price move out of the research's add zone, a filing that changes its scenarios, or new evidence against its thesis.`);
  }
  const etf = etfOptions[0];
  if (remaining >= 1 && etf) {
    allocations.push({ symbol: etf.symbol, amount: Math.round(remaining * 100) / 100 });
    rationale.push(`${eligible.length ? "The rest" : "No stock qualifies for new money on current evidence, so the money"} to ${etf.symbol}, because ${whyOf.get(etf.symbol) ?? "it is the chosen diversified option"}. Holding cash is equally valid for money you may need within a few years.`);
  }
  rationale.push(`Account: bought in ${invName}${fromTransfer > 0 ? (authorized < 0.01 ? `, after the planned ${fmt$(fromTransfer)} transfer arrives` : `, after ${fmt$(fromTransfer)} arrives from savings`) : ""}. Acorns and the Roth are managed separately and never pay for this; selling in a taxable account can realize gains.`);
  wouldChange.push(`${etf?.symbol ?? "The ETF"}: a concentration (NVIDIA, semiconductors, AI infrastructure, technology) reaching its level, which would favour a less concentrated fund, or needing the money within a few years, which favours cash.`);

  // ---- Execution readiness ----
  const brokerAccounts = portfolio.accounts.filter((a) => a.role !== "cash" && a.role !== "protected_savings");
  // A statement, sync or your own check within a week verifies an account. Trades recorded since an older
  // statement show what probably happened; they are not a reconciliation.
  const unverified = brokerAccounts.filter((a) => a.ageDays > HOLDINGS_FRESH_DAYS || a.tradesAfter > 0);
  const gaps = brokerAccounts.filter((a) => a.statementGap !== null && Math.abs(a.statementGap) > 1);
  const confirmed = !!args.holdingsConfirmed;
  const refresh = stockOptions.filter((o) => o.label === "Refresh required" || o.label === "Research needed");
  // Unapproved research does not block a diversified purchase (it does not depend on any company's thesis),
  // but it does keep every stock out of the new money, and that is said plainly.
  const unapproved = [...stockOptions, ...newOptions].filter((o) => o.label === "Preliminary research").map((o) => o.symbol);
  if (unapproved.length) warnings.push(`Only preliminary research for ${unapproved.join(", ")}: enough to hold, so none of them receives new money until a targeted investigation is done.`);
  const receivingStocks = allocations.map((x) => x.symbol).filter((s) => ![...etfOptions].some((e) => e.symbol === s));
  const gates: Gate[] = [
    { key: "funds", label: "The money is verified, in the account that buys", ok: source === "planned" ? false : source === "deposited" ? depositShows : funds.verified && cd.savings !== null,
      detail: source === "planned" ? `${funds.detail}. Choose "New, already deposited" once it has arrived`
        : source === "deposited" ? funds.detail
        : cd.savings === null ? "Enter your savings balance so transferable capital is known"
        : amount < 1 ? `No cash in ${invName} to invest.${savingsHint}` : funds.detail },
    { key: "holdings", label: "Holdings and balances are verified", ok: confirmed || (!unverified.length && !gaps.length),
      detail: confirmed ? `You confirmed today that the holdings and balances shown match your broker accounts${portfolio.quality.reconciliation.complete ? "" : ` (still open, not blocking: ${portfolio.quality.reconciliation.gaps.join("; ")})`}`
        : unverified.length ? `${unverified.map((a) => `${a.name}: statement ${a.asOf.slice(0, 10)} (${a.ageDays} days)${a.tradesAfter ? `, plus ${a.tradesAfter} recorded transactions through ${a.knownThrough}` : ""}`).join("; ")}. Recorded transactions are not a reconciliation: check each account in its app and confirm, or add a current statement`
        : gaps.length ? `Statement totals do not add up for ${gaps.map((a) => a.name).join(", ")}. Check them against your broker accounts and confirm`
        : `Every account verified by a statement or sync within ${HOLDINGS_FRESH_DAYS} days` },
    { key: "research", label: "No unresolved material developments", ok: !refresh.length && !receivingStocks.some((s) => newOptions.find((o) => o.symbol === s)?.label === "Refresh required"),
      detail: refresh.length ? `${refresh.map((o) => o.symbol).join(", ")}: something material changed since the research (results, financing, a material 8-K, a price or valuation change), or filings could not be checked. Until it is reassessed the best use of the money may change` : "No new results, financings, material filings or valuation changes since each held stock's research" },
  ];
  // Ready to execute only when every check passes. The analysis, the leaning and the conditions are given either way.
  const status: NewCapitalResult["status"] = gates.every((g) => g.ok) ? "ready" : "conditional";
  const toVerify = [
    ...gates.filter((g) => !g.ok && g.key !== "research").map((g) => g.detail),
    ...refresh.flatMap((o) => o.toVerify),
    ...[...stockOptions, ...newOptions].filter((o) => o.label === "Condition not met" || o.label === "Limit not approved").flatMap((o) => o.toVerify),
  ].filter((x, i, a) => a.indexOf(x) === i);

  if (refresh.length) wouldChange.unshift(`Reassessed research on ${refresh.map((o) => o.symbol).join(", ")} at today's prices and filings.`);
  for (const o of [...stockOptions, ...newOptions].filter((x) => x.label === "Condition not met")) wouldChange.push(`${o.symbol}: confirmation of the research's condition (${o.stance?.condition}).`);
  confidence -= gates.filter((g) => !g.ok && g.key !== "funds").length;

  const researched = [...stockOptions, ...newOptions].filter((o) => o.stance);
  const why = researched.slice(0, 5).map((o) => `${o.symbol}: ${o.label === "Research says hold" ? "research says hold" : o.label === "Condition not met" ? "add only on a condition not yet met" : o.label === "Refresh required" ? "reassess first" : o.label.toLowerCase()}`).join("; ");
  const choiceWords = etf && whyOf.get(etf.symbol) ? `${etf.symbol}, because ${whyOf.get(etf.symbol)}` : "";
  const lean = eligible.length
    ? `Lean: add to ${eligible.slice(0, 2).map((o) => o.symbol).join(" and ")}, where the research supports it, nothing material has changed and you approved the limit${etf && allocations.some((x) => x.symbol === etf.symbol) ? `; the rest to ${etf.symbol}` : ""}.`
    : `Lean: ${etf?.symbol ?? "VOO"} or keep cash. ${choiceWords ? `${choiceWords}. ` : ""}No stock qualifies for new money right now${why ? ` (${why})` : ""}.`;
  const split = allocations.map((x) => `$${x.amount.toLocaleString()} ${x.symbol}`).join(" + ");
  const openWords = gates.filter((g) => !g.ok).map((g) => g.key === "funds" ? (source === "planned" ? "the money arrives" : source === "deposited" ? "the deposit shows in your recorded cash" : "your cash is confirmed") : g.key === "holdings" ? "your balances are verified" : "open research is reassessed");
  const openList = openWords.length > 1 ? `${openWords.slice(0, -1).join(", ")} and ${openWords[openWords.length - 1]}` : openWords[0] ?? "";
  return {
    amount,
    source,
    funds,
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
      illustrative: status !== "ready",
      confidence: Math.max(1, Math.min(10, confidence)),
      headline: !split ? "Keep cash" : status === "ready" ? split : `${split}, once ${openList}`,
      rationale,
      wouldChange,
    },
    exposure: { impacts: ex.impacts, choice: etf?.symbol ?? "CASH", reasons: exReasons },
    assumptions: {
      alternatives: ALTERNATIVES, riskFree10y: riskFreeFor(10, yields),
      items: [
        funds.detail,
        `Investable capital $${Math.round(portfolio.total).toLocaleString()} (${portfolio.quality.status})`,
        `Prices: ${portfolio.pricedLive} of ${portfolio.holdings.length} holdings from delayed quotes, the rest from statements`,
        "Fund look-through from each fund's dated published holdings and sector/country splits; industry and theme figures are lower bounds",
        "Exposure levels: those you approved, else the app's drafted proposals (labelled proposed)",
        "The money goes to your taxable brokerage account",
      ],
    },
    warnings,
  };
}

const LABEL_ORDER: OptionLabel[] = ["Candidate", "Limit not approved", "Condition not met", "Refresh required", "Preliminary research", "Research says hold", "Not ahead of VOO", "At limit", "No limit set", "Research needed", "Valid option", "Trim review"];
const rankLabel = (l: OptionLabel) => LABEL_ORDER.indexOf(l);

export function pct(n: number, digits = 1) {
  return `${(n * 100).toFixed(digits)}%`;
}

/** Reads the money source from a form or URL value. Anything unrecognised is treated as planned (unverified) money. */
export function parseSource(raw: unknown): MoneySource {
  return raw === "existing" ? "existing" : raw === "deposited" ? "deposited" : "planned";
}

/** The policy rows on file (approved and pending), for the exposure levels. */
export function ruleRowsOf(policy: Policy | null): PolicyRuleRow[] {
  return policy?.audit?.subjects.flatMap((s) => [...(s.approvedRow ? [s.approvedRow] : []), ...s.candidates]) ?? [];
}

/** The decisions table stores the older two-value status; the detailed status stays in the recommendation JSON. */
export function dbStatus(status: NewCapitalResult["status"]): "actionable" | "wait_review" {
  return status === "ready" ? "actionable" : "wait_review";
}
