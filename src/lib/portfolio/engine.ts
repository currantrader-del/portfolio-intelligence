/**
 * Layer 3: deterministic portfolio math. Same inputs always give the same outputs.
 * Quantities come from the latest holdings snapshot per account; prices from live quotes when available,
 * otherwise from the snapshot (and then labelled as statement prices).
 */
import type { Quote } from "@/lib/market/quotes";
import { companyMax, type Policy, type Range } from "@/lib/policy/limits";
import { bucketOf, LOOKTHROUGH, type Bucket } from "./classify";

export type SnapshotInput = {
  accountId: string;
  accountName: string;
  accountRole: string;
  asOf: string;
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

export type BucketRow = { bucket: Bucket; value: number; weight: number; normal: Range; hardMax: number | null; status: "below" | "within" | "above" | "over_max" | "no_limit" };
export type CompanyExposure = { symbol: string; direct: number; viaEtfs: number; total: number; max: number; headroomDollars: number };

export type PortfolioView = {
  total: number;
  cash: number;
  invested: number;
  dayDollar: number | null;
  dayPct: number | null;
  holdings: Holding[];
  buckets: BucketRow[];
  exposures: CompanyExposure[];
  accounts: { id: string; name: string; role: string; asOf: string; value: number }[];
  oldestHoldingsAsOf: string | null;
  pricedLive: number; // count of holdings priced from a live quote
};

export function buildPortfolio(
  snapshots: SnapshotInput[],
  quotes: Map<string, Quote>,
  policy: Policy | null,
  classifications: Record<string, string | null | undefined> = {},
): PortfolioView {
  const bySymbol = new Map<string, { quantity: number; stmtValue: number; stmtPrice: number | null; cost: number | null; costKnown: boolean; accounts: Set<string>; asOf: string }>();
  let cash = 0;
  const accounts: PortfolioView["accounts"] = [];

  for (const s of snapshots) {
    cash += s.cashValue ?? 0;
    let acctValue = s.cashValue ?? 0;
    for (const p of s.positions) {
      const sym = p.symbol.toUpperCase();
      const q = quotes.get(sym);
      const qty = p.quantity ?? 0;
      acctValue += q ? qty * q.price : (p.marketValue ?? 0);
      const cur = bySymbol.get(sym) ?? { quantity: 0, stmtValue: 0, stmtPrice: null, cost: 0, costKnown: true, accounts: new Set<string>(), asOf: s.asOf };
      cur.quantity += qty;
      cur.stmtValue += p.marketValue ?? 0;
      cur.stmtPrice = p.price ?? cur.stmtPrice;
      if (p.costBasis === null || p.costBasis === undefined) cur.costKnown = false;
      else cur.cost = (cur.cost ?? 0) + p.costBasis;
      cur.accounts.add(s.accountName);
      if (s.asOf < cur.asOf) cur.asOf = s.asOf;
      bySymbol.set(sym, cur);
    }
    accounts.push({ id: s.accountId, name: s.accountName, role: s.accountRole, asOf: s.asOf, value: round2(acctValue) });
  }

  const rows = [...bySymbol.entries()].map(([symbol, h]) => {
    const q = quotes.get(symbol);
    const price = q ? q.price : h.stmtPrice ?? (h.quantity ? h.stmtValue / h.quantity : 0);
    const value = q ? h.quantity * q.price : h.stmtValue;
    const dayPct = q?.prevClose ? q.price / q.prevClose - 1 : null;
    const dayDollar = q?.prevClose ? h.quantity * (q.price - q.prevClose) : null;
    return { symbol, h, q, price, value, dayPct, dayDollar };
  });

  const invested = rows.reduce((a, r) => a + r.value, 0);
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
  return {
    total: round2(total),
    cash: round2(cash),
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
