/**
 * Layer 3: deterministic portfolio math. Same inputs always give the same outputs.
 *
 * Quantities come from the latest statement per account, plus any trades recorded in the ledger after it.
 * Prices come from delayed quotes when available, otherwise from the statement (and are labelled so).
 * The result is an ESTIMATE of today's portfolio unless every account was synced from the broker today:
 * trades not in the ledger are invisible to it.
 *
 * Percentages use investable capital as the denominator: invested + brokerage cash + savings above the
 * protected reserve. The protected reserve is tracked but excluded from every percentage (policy rule).
 */
import type { Quote } from "@/lib/market/quotes";
import { companyMax, type Policy, type Range } from "@/lib/policy/limits";
import { bucketOf, LOOKTHROUGH, type Bucket } from "./classify";

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
  ageDays: number;
};

export type CashView = {
  brokerage: number; // cash inside brokerage and retirement accounts
  savings: number | null; // cash accounts; null when never entered
  savingsAsOf: string | null;
  protectedReserve: number; // policy floor, excluded from every percentage
  reserveShortfall: number; // reserve not covered by savings
  deployableSavings: number; // savings above the reserve
  deployable: number; // brokerage + deployable savings
};

export type DataQuality = {
  status: "estimated" | "verified";
  headline: string;
  reasons: string[];
  missing: string[];
};

export type BucketRow = { bucket: Bucket; value: number; weight: number; normal: Range; hardMax: number | null; status: "below" | "within" | "above" | "over_max" | "no_limit" };
export type CompanyExposure = { symbol: string; direct: number; viaEtfs: number; total: number; max: number; headroomDollars: number };

export type PortfolioView = {
  total: number; // investable capital: the denominator for every weight
  netWorthTracked: number; // investable + protected reserve
  cash: number; // deployable cash (brokerage + savings above the reserve)
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
  const missing: string[] = [];

  for (const s of snapshots) {
    const isCashAccount = s.accountRole === "cash" || s.accountRole === "protected_savings";
    const after = ledger.filter((t) => t.accountId === s.accountId && t.tradeDate > s.asOf.slice(0, 10));
    const cashAfter = (s.cashValue ?? 0) + after.reduce((a, t) => a + t.amount, 0);
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
    accounts.push({
      id: s.accountId, name: s.accountName, role: s.accountRole, asOf: s.asOf, sourceKind: s.sourceKind ?? "statement", value: round2(acctValue),
      statementTotal: s.totalValue, statementComputed: round2(stmtComputed), statementGap: gap, tradesAfter: after.length,
      ageDays: Math.max(0, Math.floor((now.getTime() - new Date(s.asOf).getTime()) / 86_400_000)),
    });
    if (gap !== null && Math.abs(gap) > 1) missing.push(`${s.accountName}: statement total differs from its positions plus cash by ${gap > 0 ? "" : "-"}$${Math.abs(gap).toFixed(2)}`);
  }

  const reserve = policy?.protectedSavingsFloor ?? 10000;
  const deployableSavings = savings === null ? 0 : Math.max(0, savings - reserve);
  const cashDetail: CashView = {
    brokerage: round2(brokerageCash),
    savings: savings === null ? null : round2(savings),
    savingsAsOf,
    protectedReserve: reserve,
    reserveShortfall: savings === null ? reserve : round2(Math.max(0, reserve - savings)),
    deployableSavings: round2(deployableSavings),
    deployable: round2(brokerageCash + deployableSavings),
  };
  const cash = brokerageCash + deployableSavings;
  if (savings === null) missing.push("Savings balance not entered, so deployable savings and the protected reserve are not counted");

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
      const max = companyMax(policy, h.symbol);
      const totalExp = h.value + via;
      return {
        symbol: h.symbol,
        direct: total ? h.value / total : 0,
        viaEtfs: total ? via / total : 0,
        total: total ? totalExp / total : 0,
        max,
        headroomDollars: round2(Math.max(0, max * total - totalExp)),
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
  const quality: DataQuality = synced
    ? { status: "verified", headline: "Verified holdings synced from your broker today", reasons, missing }
    : { status: "estimated", headline: "Estimated, based on last verified holdings", reasons, missing };
  return {
    total: round2(total),
    netWorthTracked: round2(total + Math.min(reserve, savings ?? 0)),
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
