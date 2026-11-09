/**
 * Layer 3: deterministic portfolio math. Same inputs always give the same outputs.
 *
 * Quantities come from the latest statement per account, plus any trades recorded in the ledger after it.
 * Prices come from delayed quotes when available, otherwise from the statement (and are labelled so).
 * The result is an ESTIMATE of today's portfolio unless every account was synced from the broker today:
 * trades not in the ledger are invisible to it.
 *
 * Two views, two denominators:
 *  - Invested portfolio (`total`): holdings in the brokerage, Acorns and retirement accounts plus the cash inside
 *    them. Every holding weight, bucket weight, company exposure and allocation limit uses this. Savings outside
 *    the brokerage never change it.
 *  - Total investable capital (`investableCapital`): the invested portfolio plus savings. Used for capital
 *    planning, liquidity and "share of everything I could invest" views.
 * There is no protected savings reserve (investor's direction, 2026-11-09): brokerage cash and transferable
 * savings both count as available, shown separately. `protectedReserve` stays in the shape as 0.
 */
import type { Quote } from "@/lib/market/quotes";
import { companyLimit, type Policy, type Range } from "@/lib/policy/limits";
import { bucketOf, LOOKTHROUGH, type Bucket } from "./classify";
import { COMPANIES, FUNDS, canonical } from "@/lib/exposure/reference";

const FUND_ALIAS: Record<string, string> = { IVV: "VOO", SPY: "VOO" };
const OUTSIDE_US = /outside the US|ex[- ]US|emerging/i;

/**
 * How much more of a company the held ETFs could contain beyond their itemized top holdings. A company not in
 * a fund's published top list can weigh at most as much as the smallest listed holding, so that weight is a
 * hard upper bound. Funds that cannot hold the company (bond funds, a country or size mandate that excludes
 * it) add nothing; a fund with no itemized holdings at all is listed as unknown. Pure.
 */
export function lookthroughUpperBound(symbol: string, etfs: { symbol: string; value: number }[]): { extra: number; funds: string[]; unknown: string[] } {
  const sym = canonical(symbol);
  const co = COMPANIES[sym];
  let extra = 0;
  const funds: string[] = [], unknown: string[] = [];
  for (const e of etfs) {
    const f = FUNDS[FUND_ALIAS[e.symbol] ?? e.symbol];
    if (!f || f.assetClass === "bond" || e.value <= 0) continue;
    if (f.top?.some((t) => canonical(t.symbol) === sym)) continue; // already counted from the itemized list
    if (co && f.countries) {
      const itemized = Object.values(f.countries).reduce((a, x) => a + x, 0);
      if (!(f.countries[co.country] > 0) && (itemized > 0.99 || (co.country === "United States" && OUTSIDE_US.test(f.mandate)))) continue;
    }
    if (co && f.size && f.sizeBasis === "mandate" && !(f.size[co.size] && f.size[co.size]! > 0)) continue;
    if (!f.top?.length) { unknown.push(e.symbol); continue; }
    if (f.holdingsCount && f.top.length >= f.holdingsCount) continue;
    extra += Math.min(...f.top.map((t) => t.weight)) * e.value;
    funds.push(e.symbol);
  }
  return { extra, funds, unknown };
}

export type SnapshotInput = {
  accountId: string;
  accountName: string;
  accountRole: string;
  asOf: string;
  sourceKind?: string; // statement | manual | csv_import | schwab_api
  totalValue: number | null;
  cashValue: number | null;
  positions: { symbol: string; quantity: number | null; price: number | null; marketValue: number | null; costBasis: number | null }[];
};

export type Holding = {
  symbol: string;
  quantity: number;
  price: number;
  priceSource: "quote" | "statement";
  priceAsOf: string;
  value: number;
  weight: number;
  dayPct: number | null;
  dayDollar: number | null;
  contributionPts: number | null; // percentage points of the whole portfolio's move
  costBasis: number | null; // null if any lot is missing basis
  unrealized: number | null;
  bucket: Bucket;
  accounts: string[];
  holdingsAsOf: string; // oldest snapshot date this holding depends on
};

export type LedgerEntry = {
  accountId: string;
  tradeDate: string; // YYYY-MM-DD
  kind: "buy" | "sell" | "deposit" | "withdrawal" | "dividend" | "interest" | "fee" | "transfer_in" | "transfer_out";
  symbol: string | null;
  quantity: number | null;
  price: number | null;
  amount: number; // signed cash effect on the account
};

export type AccountView = {
  id: string; name: string; role: string; asOf: string; sourceKind: string; value: number;
  statementTotal: number | null; // what the statement itself said
  statementComputed: number; // positions at statement values + cash, to check the statement adds up
  statementGap: number | null; // statementTotal - statementComputed
  tradesAfter: number; // ledger rows applied after the statement
  ageDays: number; // days since the statement
  /** Latest of the statement date and the last recorded transaction (confirmations) in this account. */
  knownThrough: string;
  knownAgeDays: number;
};

/**
 * What an account's cash can do. Cash never moves between accounts on its own: Acorns invests its own cash in
 * its own portfolios, a Roth follows contribution rules, and savings can only fund the brokerage through a
 * transfer you plan. Only the self-directed brokerage account can buy a chosen stock or ETF.
 */
export type AccountCashUse = "self_directed" | "managed" | "retirement_managed" | "savings";
export type AccountCash = { id: string; name: string; role: string; cash: number; use: AccountCashUse; canBuyChosen: boolean; note: string; basis?: CashBasis };
/**
 * Where an account's cash figure comes from, and whether anything confirms it. A figure that only follows from
 * arithmetic (statement cash plus transactions you recorded since) is shown as derived, never as confirmed:
 * a missing trade, a pending deposit or a fee would make it wrong without the arithmetic noticing.
 */
export type CashBasis = {
  statementCash: number; statementAsOf: string; sourceKind: string; ledgerNet: number; ledgerRows: number; lastActivity: string | null;
  confirmed: boolean; status: "statement" | "manual" | "derived"; detail: string; checks: string[];
};
/** A statement or your own entry older than this does not confirm today's cash. */
export const CASH_CONFIRM_DAYS = 7;

export function cashBasis(a: { cashValue: number | null; asOf: string; sourceKind?: string | null; after: { amount: number; tradeDate: string }[]; statementGap: number | null; now: Date }): CashBasis {
  const stmt = a.cashValue ?? 0;
  const net = Math.round(a.after.reduce((x, t) => x + t.amount, 0) * 100) / 100;
  const last = a.after.reduce<string | null>((m, t) => (!m || t.tradeDate > m ? t.tradeDate : m), null);
  const age = Math.max(0, Math.floor((a.now.getTime() - new Date(a.asOf).getTime()) / 86_400_000));
  const kind = a.sourceKind ?? "statement";
  const derived = a.after.length > 0;
  const cash = Math.round((stmt + net) * 100) / 100;
  const d = (iso: string) => iso.slice(0, 10);
  const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const checks: string[] = [];
  if (a.cashValue === null) checks.push("The statement on file has no cash figure.");
  if (cash < -0.005) checks.push(`Recorded transactions spend ${money(-cash)} more than the cash on the ${d(a.asOf)} statement: a deposit or trade is missing from the records.`);
  if (a.statementGap !== null && Math.abs(a.statementGap) > 1) checks.push(`The ${d(a.asOf)} statement total differs from its positions plus cash by ${money(a.statementGap)}.`);
  if (age > CASH_CONFIRM_DAYS) checks.push(`The ${kind === "manual" ? "balance you entered" : "statement"} is ${age} days old.`);
  const status: CashBasis["status"] = derived ? "derived" : kind === "manual" ? "manual" : "statement";
  const detail = derived
    ? `${money(stmt)} on the ${d(a.asOf)} statement ${net >= 0 ? "plus" : "less"} ${money(net)} from ${a.after.length} recorded transaction${a.after.length === 1 ? "" : "s"} through ${last} = ${money(cash)}. Worked out, not confirmed: nothing since ${d(a.asOf)} shows the actual balance or buying power.`
    : kind === "manual" ? `${money(stmt)} as you entered it on ${d(a.asOf)}.` : `${money(stmt)} on the ${d(a.asOf)} statement, with no recorded activity since.`;
  return { statementCash: stmt, statementAsOf: a.asOf, sourceKind: kind, ledgerNet: net, ledgerRows: a.after.length, lastActivity: last, confirmed: !derived && checks.length === 0, status, detail, checks };
}

export function accountCashUse(name: string, role: string): AccountCashUse {
  if (role === "cash" || role === "protected_savings") return "savings";
  // Acorns accounts are robo-managed portfolios: you cannot pick individual stocks or ETFs there.
  if (/acorns/i.test(name)) return role === "retirement" ? "retirement_managed" : "managed";
  return role === "retirement" ? "retirement_managed" : "self_directed";
}
const USE_NOTE: Record<AccountCashUse, string> = {
  self_directed: "Can buy any stock or ETF you choose",
  managed: "Invested by Acorns in its own portfolio; cannot buy a chosen stock or ETF",
  retirement_managed: "Retirement account: annual contribution limits, withdrawals restricted; invested in its own portfolio",
  savings: "Savings: funds the brokerage only through a transfer you plan",
};

/** A transfer you recorded as planned. It counts as conditional money until the receiving account shows it. */
export type PlannedTransfer = { id: string; fromAccountId: string; toAccountId: string; amount: number; date: string; note: string | null; createdAt: string };

export type CashView = {
  /** Each account's own cash and what it can be used for. */
  accounts: AccountCash[];
  /** The self-directed brokerage account new-money decisions buy in (null when none is on file). */
  investingAccount: { id: string; name: string; cash: number; confirmed?: boolean; basis?: CashBasis } | null;
  brokerage: number; // cash inside brokerage and retirement accounts
  savings: number | null; // cash accounts; null when never entered
  savingsAsOf: string | null;
  protectedReserve: number; // policy floor, excluded from every percentage
  reserveShortfall: number; // reserve not covered by savings
  deployableSavings: number; // savings above the reserve
  deployable: number; // brokerage + deployable savings (capital accounting; not all of it can buy anything today)
  /** Cash that can buy a chosen stock or ETF today, without any transfer: the self-directed brokerage cash. */
  spendableNow: number;
};

export type DataQuality = {
  status: "estimated" | "verified";
  headline: string;
  reasons: string[];
  missing: string[];
  /** Whether the total is a reconciled investable capital figure. Incomplete unless every gap is closed. */
  reconciliation: { complete: boolean; label: string; gaps: string[] };
};

/** Lists what stops a total from being called reconciled investable capital. Pure. */
export function reconciliationGaps(args: { brokerAsOfs: string[]; savingsEntered: boolean; reserveApproved: boolean; ledgerRows: number; positionsWithoutBasis: number }): { complete: boolean; label: string; gaps: string[] } {
  const gaps: string[] = [];
  const dates = [...new Set(args.brokerAsOfs.map((d) => d.slice(0, 10)))].sort();
  if (dates.length > 1) gaps.push(`Accounts are as of different dates (${dates.join(", ")})`);
  if (!args.savingsEntered) gaps.push("Savings balance not entered");
  if (!args.reserveApproved) gaps.push("Protected reserve not approved (app default used)");
  if (args.ledgerRows === 0) gaps.push("No transactions recorded, so deposits, withdrawals and trades since each statement are unknown");
  if (args.positionsWithoutBasis > 0) gaps.push(`Cost basis missing for ${args.positionsWithoutBasis} position${args.positionsWithoutBasis > 1 ? "s" : ""}`);
  return { complete: gaps.length === 0, label: gaps.length === 0 ? "Reconciled" : "Incomplete", gaps };
}

export type BucketRow = { bucket: Bucket; value: number; weight: number; normal: Range; hardMax: number | null; status: "below" | "within" | "above" | "over_max" | "no_limit" };
export type CompanyExposure = {
  symbol: string; direct: number; viaEtfs: number; total: number; max: number; hasLimit: boolean; headroomDollars: number;
  /** Upper bound of the ETF share when fund holdings are only partly itemized (equals viaEtfs when fully known). */
  viaEtfsMax: number; totalMax: number;
  /** Funds whose holdings lists are incomplete for this company: bounded, or unknown. */
  lookthroughGaps: string[];
};

export type PortfolioView = {
  total: number; // invested portfolio (holdings + cash inside investment accounts): the denominator for every weight and limit
  /** Invested portfolio plus savings: for capital planning and liquidity, never a limit denominator. */
  investableCapital: number;
  netWorthTracked: number; // investable capital + protected reserve
  cash: number; // cash inside investment accounts (savings excluded; see cashDetail)
  cashDetail: CashView;
  quality: DataQuality;
  sinceStatementDollar: number | null; // estimated price change on statement holdings since each statement
  invested: number;
  dayDollar: number | null;
  dayPct: number | null;
  holdings: Holding[];
  buckets: BucketRow[];
  exposures: CompanyExposure[];
  accounts: AccountView[];
  oldestHoldingsAsOf: string | null;
  pricedLive: number; // count of holdings priced from a live quote
};

export function buildPortfolio(
  snapshots: SnapshotInput[],
  quotes: Map<string, Quote>,
  policy: Policy | null,
  classifications: Record<string, string | null | undefined> = {},
  ledger: LedgerEntry[] = [],
  now: Date = new Date(),
): PortfolioView {
  const bySymbol = new Map<string, { quantity: number; stmtValue: number; stmtPrice: number | null; stmtQty: number; cost: number | null; costKnown: boolean; accounts: Set<string>; asOf: string }>();
  let brokerageCash = 0;
  let savings: number | null = null;
  let savingsAsOf: string | null = null;
  const accounts: AccountView[] = [];
  const accountCash: AccountCash[] = [];
  const missing: string[] = [];

  for (const s of snapshots) {
    const isCashAccount = s.accountRole === "cash" || s.accountRole === "protected_savings";
    const after = ledger.filter((t) => t.accountId === s.accountId && t.tradeDate > s.asOf.slice(0, 10));
    const cashAfter = (s.cashValue ?? 0) + after.reduce((a, t) => a + t.amount, 0);
    const use = accountCashUse(s.accountName, s.accountRole);
    const acctCash: AccountCash = { id: s.accountId, name: s.accountName, role: s.accountRole, cash: round2(cashAfter), use, canBuyChosen: use === "self_directed", note: USE_NOTE[use] };
    accountCash.push(acctCash);
    if (isCashAccount) {
      savings = (savings ?? 0) + cashAfter;
      if (!savingsAsOf || s.asOf < savingsAsOf) savingsAsOf = s.asOf;
    } else brokerageCash += cashAfter;

    let acctValue = cashAfter;
    let stmtComputed = s.cashValue ?? 0;
    const qtyDelta = new Map<string, number>();
    for (const t of after) {
      if ((t.kind === "buy" || t.kind === "sell") && t.symbol) {
        const sym = t.symbol.toUpperCase();
        qtyDelta.set(sym, (qtyDelta.get(sym) ?? 0) + (t.kind === "buy" ? 1 : -1) * (t.quantity ?? 0));
      }
    }
    const symbols = new Set([...s.positions.map((p) => p.symbol.toUpperCase()), ...qtyDelta.keys()]);
    for (const sym of symbols) {
      const p = s.positions.find((x) => x.symbol.toUpperCase() === sym);
      const q = quotes.get(sym);
      const stmtQty = p?.quantity ?? 0;
      const qty = stmtQty + (qtyDelta.get(sym) ?? 0);
      stmtComputed += p?.marketValue ?? 0;
      const tradePrice = [...after].reverse().find((t) => t.symbol?.toUpperCase() === sym && t.price)?.price ?? null;
      const fallbackPrice = p?.price ?? (p?.marketValue && stmtQty ? p.marketValue / stmtQty : tradePrice ?? 0);
      acctValue += qty * (q ? q.price : fallbackPrice);
      if (Math.abs(qty) < 1e-9) continue;
      const cur = bySymbol.get(sym) ?? { quantity: 0, stmtValue: 0, stmtPrice: null, stmtQty: 0, cost: 0, costKnown: true, accounts: new Set<string>(), asOf: s.asOf };
      cur.quantity += qty;
      cur.stmtQty += stmtQty;
      cur.stmtValue += (p?.marketValue ?? 0) + (qty - stmtQty) * fallbackPrice;
      cur.stmtPrice = p?.price ?? cur.stmtPrice ?? fallbackPrice;
      const buys = after.filter((t) => t.symbol?.toUpperCase() === sym && t.kind === "buy").reduce((a, t) => a + (t.quantity ?? 0) * (t.price ?? 0), 0);
      const sold = after.some((t) => t.symbol?.toUpperCase() === sym && t.kind === "sell");
      // Basis stays known through recorded buys; a recorded sale makes it unknown (lot choice is not tracked yet).
      const stmtBasis = p ? p.costBasis ?? null : 0;
      if (stmtBasis === null || sold) cur.costKnown = false;
      else cur.cost = (cur.cost ?? 0) + stmtBasis + buys;
      cur.accounts.add(s.accountName);
      if (s.asOf < cur.asOf) cur.asOf = s.asOf;
      bySymbol.set(sym, cur);
    }
    const gap = s.totalValue === null ? null : round2(s.totalValue - stmtComputed);
    acctCash.basis = cashBasis({ cashValue: s.cashValue, asOf: s.asOf, sourceKind: s.sourceKind, after, statementGap: gap, now });
    const knownThrough = after.reduce((m, t) => (t.tradeDate > m ? t.tradeDate : m), s.asOf.slice(0, 10));
    accounts.push({
      id: s.accountId, name: s.accountName, role: s.accountRole, asOf: s.asOf, sourceKind: s.sourceKind ?? "statement", value: round2(acctValue),
      statementTotal: s.totalValue, statementComputed: round2(stmtComputed), statementGap: gap, tradesAfter: after.length,
      ageDays: Math.max(0, Math.floor((now.getTime() - new Date(s.asOf).getTime()) / 86_400_000)),
      knownThrough, knownAgeDays: Math.max(0, Math.floor((now.getTime() - new Date(knownThrough === s.asOf.slice(0, 10) ? s.asOf : `${knownThrough}T21:00:00Z`).getTime()) / 86_400_000)),
    });
    if (gap !== null && Math.abs(gap) > 1) missing.push(`${s.accountName}: statement total differs from its positions plus cash by ${gap > 0 ? "" : "-"}$${Math.abs(gap).toFixed(2)}`);
  }

  // No protected reserve (2026-11-09 direction); the old policy row is kept on file but no longer applied.
  const reserve = 0;
  const deployableSavings = savings === null ? 0 : Math.max(0, savings - reserve);
  const selfDirected = accountCash.filter((a) => a.use === "self_directed").sort((a, b) => b.cash - a.cash);
  const investingAccount = selfDirected[0] ? { id: selfDirected[0].id, name: selfDirected[0].name, cash: Math.max(0, selfDirected[0].cash), confirmed: selfDirected[0].basis?.confirmed ?? false, basis: selfDirected[0].basis } : null;
  const cashDetail: CashView = {
    accounts: accountCash,
    investingAccount,
    spendableNow: round2(Math.max(0, investingAccount?.cash ?? 0)),
    brokerage: round2(brokerageCash),
    savings: savings === null ? null : round2(savings),
    savingsAsOf,
    protectedReserve: reserve,
    reserveShortfall: savings === null ? reserve : round2(Math.max(0, reserve - savings)),
    deployableSavings: round2(deployableSavings),
    deployable: round2(brokerageCash + deployableSavings),
  };
  // Savings stay outside the invested portfolio: entering a savings balance never changes a holding's weight.
  const cash = brokerageCash;
  if (savings === null) missing.push("Savings balance not entered, so transferable savings are not counted");

  const rows = [...bySymbol.entries()].map(([symbol, h]) => {
    const q = quotes.get(symbol);
    const price = q ? q.price : h.stmtPrice ?? (h.quantity ? h.stmtValue / h.quantity : 0);
    const value = q ? h.quantity * q.price : h.stmtValue;
    const dayPct = q?.prevClose ? q.price / q.prevClose - 1 : null;
    const dayDollar = q?.prevClose ? h.quantity * (q.price - q.prevClose) : null;
    return { symbol, h, q, price, value, dayPct, dayDollar };
  });

  const invested = rows.reduce((a, r) => a + r.value, 0);
  const sinceRows = rows.filter((r) => r.q && r.h.stmtQty > 0 && r.h.stmtPrice);
  const sinceStatementDollar = sinceRows.length ? round2(sinceRows.reduce((a, r) => a + r.h.stmtQty * (r.q!.price - r.h.stmtPrice!), 0)) : null;
  const total = invested + cash;
  const prevTotal = rows.reduce((a, r) => a + (r.dayDollar !== null ? r.value - r.dayDollar : r.value), 0) + cash;
  const anyDay = rows.some((r) => r.dayDollar !== null);
  const dayDollar = anyDay ? rows.reduce((a, r) => a + (r.dayDollar ?? 0), 0) : null;

  const holdings: Holding[] = rows
    .map((r) => ({
      symbol: r.symbol,
      quantity: r.h.quantity,
      price: r.price,
      priceSource: r.q ? ("quote" as const) : ("statement" as const),
      priceAsOf: r.q ? r.q.asOf : r.h.asOf,
      value: round2(r.value),
      weight: total ? r.value / total : 0,
      dayPct: r.dayPct,
      dayDollar: r.dayDollar === null ? null : round2(r.dayDollar),
      contributionPts: r.dayDollar === null || !prevTotal ? null : (r.dayDollar / prevTotal) * 100,
      costBasis: r.h.costKnown ? round2(r.h.cost ?? 0) : null,
      unrealized: r.h.costKnown ? round2(r.value - (r.h.cost ?? 0)) : null,
      bucket: bucketOf(r.symbol, classifications[r.symbol]),
      accounts: [...r.h.accounts],
      holdingsAsOf: r.h.asOf,
    }))
    .sort((a, b) => b.value - a.value);

  // Buckets
  const bucketValues = new Map<Bucket, number>();
  for (const h of holdings) bucketValues.set(h.bucket, (bucketValues.get(h.bucket) ?? 0) + h.value);
  bucketValues.set("Deployable cash", (bucketValues.get("Deployable cash") ?? 0) + cash);
  const limitRows = policy?.buckets ?? [];
  const allBuckets = new Set<Bucket>([...bucketValues.keys(), ...limitRows.map((b) => b.bucket)]);
  const buckets: BucketRow[] = [...allBuckets].map((bucket) => {
    const value = bucketValues.get(bucket) ?? 0;
    const weight = total ? value / total : 0;
    const lim = limitRows.find((b) => b.bucket === bucket);
    const normal = lim?.normal ?? null;
    const hardMax = lim?.hardMax ?? null;
    let status: BucketRow["status"] = "no_limit";
    if (hardMax !== null && weight > hardMax) status = "over_max";
    else if (normal) status = weight < normal.low ? "below" : weight > normal.high ? "above" : "within";
    return { bucket, value: round2(value), weight, normal, hardMax, status };
  }).sort((a, b) => b.value - a.value);

  // Company exposure with ETF look-through
  const exposures: CompanyExposure[] = holdings
    .filter((h) => h.bucket === "Quality/growth individual stocks" || h.bucket === "Asymmetric/high-risk growth sleeve")
    .map((h) => {
      const via = holdings.reduce((a, e) => a + (LOOKTHROUGH[e.symbol]?.[h.symbol] ?? 0) * e.value, 0);
      const lim = companyLimit(policy, h.symbol);
      const max = lim.monitorMax;
      const totalExp = h.value + via;
      const bound = lookthroughUpperBound(h.symbol, holdings.filter((e) => e.symbol !== h.symbol));
      const totalExpMax = totalExp + bound.extra;
      return {
        symbol: h.symbol,
        direct: total ? h.value / total : 0,
        viaEtfs: total ? via / total : 0,
        total: total ? totalExp / total : 0,
        max,
        hasLimit: lim.hasLimit,
        // No company-specific limit means no room for new money, whatever the generic ceiling says. Room is
        // measured against the upper bound, so incomplete fund data can never create room that may not exist.
        headroomDollars: lim.hasLimit ? round2(Math.max(0, lim.newMoneyMax * total - totalExpMax)) : 0,
        viaEtfsMax: total ? (via + bound.extra) / total : 0,
        totalMax: total ? totalExpMax / total : 0,
        lookthroughGaps: [...bound.funds.map((f) => `${f}: only its largest holdings are published, so ${h.symbol} could be up to the smallest listed weight`), ...bound.unknown.map((f) => `${f}: holdings not itemized`)],
      };
    });

  const asOfs = snapshots.map((s) => s.asOf).sort();
  const noQuote = holdings.filter((h) => h.priceSource === "statement").map((h) => h.symbol);
  if (noQuote.length) missing.push(`No live quote for ${noQuote.join(", ")}; statement price used`);
  const noBasis = holdings.filter((h) => h.costBasis === null).map((h) => h.symbol);
  if (noBasis.length) missing.push(`Cost basis unknown for ${noBasis.join(", ")}`);
  const synced = accounts.length > 0 && accounts.every((a) => a.sourceKind === "schwab_api" && a.ageDays < 1);
  const brokerAccounts = accounts.filter((a) => a.role !== "cash" && a.role !== "protected_savings");
  const reasons: string[] = [];
  if (!synced) {
    const dates = [...new Set(brokerAccounts.map((a) => a.asOf.slice(0, 10)))].sort();
    reasons.push(`Holdings come from statements dated ${dates.join(" and ")}${accounts.some((a) => a.tradesAfter) ? ", plus trades you recorded since" : ""}. Trades not recorded since then are not included.`);
    reasons.push("Prices are delayed quotes applied to those quantities, so today's figures are estimates, not your broker's reported returns.");
  }
  const reconciliation = reconciliationGaps({
    brokerAsOfs: brokerAccounts.map((a) => a.asOf),
    savingsEntered: savings !== null,
    reserveApproved: true,
    ledgerRows: ledger.length,
    positionsWithoutBasis: noBasis.length,
  });
  const quality: DataQuality = synced
    ? { status: "verified", headline: "Verified holdings synced from your broker today", reasons, missing, reconciliation }
    : { status: "estimated", headline: "Estimated, based on last statement holdings", reasons, missing, reconciliation };
  return {
    total: round2(total),
    investableCapital: round2(total + deployableSavings),
    netWorthTracked: round2(total + deployableSavings + Math.min(reserve, savings ?? 0)),
    cash: round2(cash),
    cashDetail,
    quality,
    sinceStatementDollar,
    invested: round2(invested),
    dayDollar: dayDollar === null ? null : round2(dayDollar),
    dayPct: dayDollar === null || !prevTotal ? null : dayDollar / prevTotal,
    holdings,
    buckets,
    exposures,
    accounts,
    oldestHoldingsAsOf: asOfs[0] ?? null,
    pricedLive: holdings.filter((h) => h.priceSource === "quote").length,
  };
}

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}
