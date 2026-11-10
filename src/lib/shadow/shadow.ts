/**
 * Shadow portfolio tests (2026-11-10, part of the 30-day proof-of-value test). A test freezes your portfolio
 * at one moment, applies a proposed change on paper, and then tracks four portfolios forward from the same
 * starting capital:
 *   original      the portfolio as it was, untouched
 *   hypothetical  the same portfolio with the proposed trades
 *   actual        the original plus the real trades you record afterwards
 *   voo           the same starting capital entirely in VOO
 * Pure: no database, no network. Nothing here trades or moves money.
 *
 * No hindsight: every trade is priced at the first market close after the test was created, never earlier,
 * and a test is never edited after creation (it can only be closed; closed tests stay as history).
 * Dividends: values follow dividend- and split-adjusted closes (total return, dividends reinvested).
 * Deposits and withdrawals after the start are added to every portfolio as cash on the same day, so money
 * you add never counts as a gain and every portfolio sees the same flows.
 */
import type { Bar } from "@/lib/market/history";

export const SHADOW_VERSION = "shadow@1";
/** Spread and slippage per trade (Schwab charges no commission on stocks and ETFs). */
export const COST_RATE = 0.0005;
/** Assumed tax rate on realized gains, shown as an estimate and never deducted from the comparison. */
export const TAX_RATE = 0.22;
/** At most this many app-created tests are active at once; your own tests have their own limit. */
export const MAX_APP_ACTIVE = 3; // enforced by the proposal job: never two active tests on one stock
export const MAX_OWN_ACTIVE = 5;

export type TradeUnit = "usd" | "pct_holding" | "pct_proceeds";
/** What the test intends to do. Quantities are worked out at the start close. */
export type ShadowTrade = { side: "sell" | "buy"; symbol: string; amount: number; unit: TradeUnit };
export type ShadowTest = {
  id: string;
  name: string;
  origin: "app" | "you";
  createdAt: string;
  /** NY date of the first close after creation: the trades are priced at this close. */
  startDate: string;
  rationale: string;
  source: { planAt: string | null; researchVersionId: string | null; researchAsOf: string | null; action: string | null };
  base: {
    holdings: { symbol: string; qty: number; avgCost: number | null; price: number }[]; // price: the quote at creation, a fallback only
    cash: number;
    accountIds: string[];
    holdingsAsOf: string | null;
    estimated: boolean;
  };
  trades: ShadowTrade[];
  assumptions: { costRate: number; taxRate: number };
};
export type ShadowStart = { testId: string; startDate: string; prices: Record<string, number> };
export type ShadowClose = { testId: string; at: string; endDate: string; reason: string };
export type LedgerFlow = { accountId: string; tradeDate: string; kind: string; symbol: string | null; quantity: number | null; price: number | null; amount: number };

const r2 = (n: number) => Math.round(n * 100) / 100;
const nyDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
function nyClock(d: Date) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { weekday: p.weekday as string, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The NY date of the first regular close at or after `at`: today before 4 PM ET on a weekday, else the next weekday. */
export function startDateFor(at: Date): string {
  const { weekday, minutes } = nyClock(at);
  let d = nyDate(at);
  if (weekday !== "Sat" && weekday !== "Sun" && minutes < 16 * 60) return d;
  do d = addDays(d, 1);
  while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()));
  return d;
}

/** Whether the close of `date` is final at `now` (a later NY day, or after 4:15 PM ET that day). */
export function closeIsFinal(date: string, now: Date): boolean {
  const today = nyDate(now);
  return date < today || (date === today && nyClock(now).minutes >= 16 * 60 + 15);
}

/** The bar on or before a date (null when the history starts later). */
export function barOn(bars: Bar[], date: string): Bar | null {
  let lo = 0, hi = bars.length - 1, best: Bar | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= date) { best = bars[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/**
 * The start close: the first bar on or after the start date whose close is final. Prices are the unadjusted
 * closes (what you would have paid). Null while that close has not happened yet.
 */
export function startFromHistory(t: ShadowTest, histories: Map<string, Bar[]>, now: Date): ShadowStart | null {
  const voo = histories.get("VOO") ?? [];
  const bar = voo.find((b) => b.date >= t.startDate);
  if (!bar || !closeIsFinal(bar.date, now)) return null;
  const prices: Record<string, number> = {};
  for (const s of symbolsOf(t)) {
    const b = (histories.get(s) ?? []).find((x) => x.date === bar.date);
    if (b) prices[s] = b.raw ?? b.close;
  }
  return { testId: t.id, startDate: bar.date, prices };
}

export const symbolsOf = (t: ShadowTest) => [...new Set(["VOO", ...t.base.holdings.map((h) => h.symbol), ...t.trades.map((x) => x.symbol)])];

/** A position as dollars at a date; it grows with the adjusted close from that date. */
type Lot = { symbol: string; dollars: number; date: string };
type Book = { lots: Lot[]; cash: { amount: number; date: string }[] };
export type ResolvedTrade = { side: "sell" | "buy"; symbol: string; qty: number; price: number; value: number; cost: number };
export type Resolved = {
  startDate: string; startValue: number; trades: ResolvedTrade[]; costs: number; taxEstimate: number; realizedGain: number | null;
  notes: string[]; exposure: { symbol: string; before: number; after: number }[]; largest: { before: { symbol: string; pct: number } | null; after: { symbol: string; pct: number } | null };
  books: { original: Book; hypothetical: Book; voo: Book };
};

/** Applies the trades at the start prices. Sells first, then buys from the proceeds and the cash. */
export function resolveTest(t: ShadowTest, start: ShadowStart): Resolved {
  const notes: string[] = [];
  const priceOf = (s: string) => start.prices[s] ?? t.base.holdings.find((h) => h.symbol === s)?.price ?? null;
  const qty = new Map(t.base.holdings.map((h) => [h.symbol, h.qty]));
  const value = (q: Map<string, number>) => [...q].reduce((a, [s, n]) => a + n * (priceOf(s) ?? 0), 0);
  const startValue = value(qty) + t.base.cash;
  const before = new Map(qty);
  let cash = t.base.cash, proceeds = 0, costs = 0, gain = 0, gainKnown = true;
  const trades: ResolvedTrade[] = [];
  for (const tr of t.trades.filter((x) => x.side === "sell")) {
    const p = priceOf(tr.symbol), held = qty.get(tr.symbol) ?? 0;
    if (!p || held <= 0) { notes.push(`${tr.symbol}: not held or no price at the start, so the sell was skipped`); continue; }
    let n = tr.unit === "pct_holding" ? held * Math.min(100, tr.amount) / 100 : tr.amount / p;
    if (n > held) { notes.push(`${tr.symbol}: sell capped at the ${held} shares held`); n = held; }
    const v = n * p, c = v * t.assumptions.costRate;
    const avg = t.base.holdings.find((h) => h.symbol === tr.symbol)?.avgCost ?? null;
    if (avg === null) gainKnown = false; else gain += (p - avg) * n;
    qty.set(tr.symbol, held - n);
    cash += v - c; proceeds += v - c; costs += c;
    trades.push({ side: "sell", symbol: tr.symbol, qty: n, price: p, value: r2(v), cost: r2(c) });
  }
  for (const tr of t.trades.filter((x) => x.side === "buy")) {
    const p = priceOf(tr.symbol);
    if (!p) { notes.push(`${tr.symbol}: no price at the start, so the buy was skipped`); continue; }
    let dollars = tr.unit === "pct_proceeds" ? proceeds * Math.min(100, tr.amount) / 100 : tr.unit === "usd" ? tr.amount : 0;
    if (dollars > cash + 0.005) { notes.push(`${tr.symbol}: buy cut to the $${r2(Math.max(0, cash))} cash available`); dollars = Math.max(0, cash); }
    if (dollars <= 0) continue;
    const c = dollars * t.assumptions.costRate, n = (dollars - c) / p;
    qty.set(tr.symbol, (qty.get(tr.symbol) ?? 0) + n);
    cash -= dollars; costs += c;
    trades.push({ side: "buy", symbol: tr.symbol, qty: n, price: p, value: r2(dollars), cost: r2(c) });
  }
  const lotsOf = (q: Map<string, number>): Lot[] => [...q].filter(([, n]) => n > 1e-9).map(([s, n]) => ({ symbol: s, dollars: n * (priceOf(s) ?? 0), date: start.startDate }));
  const weights = (q: Map<string, number>, c: number) => { const tot = value(q) + c; return new Map([...q].map(([s, n]) => [s, tot ? (n * (priceOf(s) ?? 0)) / tot : 0])); };
  const wb = weights(before, t.base.cash), wa = weights(qty, cash);
  const top = (w: Map<string, number>) => { const e = [...w].sort((a, b) => b[1] - a[1])[0]; return e ? { symbol: e[0], pct: r2(e[1] * 100) } : null; };
  return {
    startDate: start.startDate, startValue: r2(startValue), trades, costs: r2(costs),
    realizedGain: gainKnown ? r2(gain) : null, taxEstimate: gainKnown ? r2(Math.max(0, gain) * t.assumptions.taxRate) : 0,
    notes: gainKnown ? notes : [...notes, "Cost basis is missing for a sold holding, so the tax estimate is not shown"],
    exposure: [...new Set(t.trades.map((x) => x.symbol))].map((s) => ({ symbol: s, before: r2((wb.get(s) ?? 0) * 100), after: r2((wa.get(s) ?? 0) * 100) })),
    largest: { before: top(wb), after: top(wa) },
    books: {
      original: { lots: lotsOf(before), cash: [{ amount: t.base.cash, date: start.startDate }] },
      hypothetical: { lots: lotsOf(qty), cash: [{ amount: cash, date: start.startDate }] },
      voo: { lots: [{ symbol: "VOO", dollars: startValue, date: start.startDate }], cash: [] },
    },
  };
}

const EXTERNAL = new Set(["deposit", "withdrawal", "transfer_in", "transfer_out"]);

/**
 * The actual portfolio: the original plus your recorded trades after the test was created, priced at their
 * real prices. Deposits and withdrawals become flows that every portfolio receives as cash. Dividends are
 * already in the adjusted closes, so recorded dividends are not added again.
 */
export function actualBook(t: ShadowTest, r: Resolved, ledger: LedgerFlow[], histories: Map<string, Bar[]>): { book: Book; flows: { amount: number; date: string }[] } {
  const created = nyDate(new Date(t.createdAt));
  const book: Book = { lots: [...r.books.original.lots], cash: [...r.books.original.cash] };
  const flows: { amount: number; date: string }[] = [];
  const accounts = new Set(t.base.accountIds);
  for (const e of ledger.filter((x) => accounts.has(x.accountId) && x.tradeDate > created).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))) {
    const date = e.tradeDate < r.startDate ? r.startDate : e.tradeDate;
    if ((e.kind === "buy" || e.kind === "sell") && e.symbol && e.quantity) {
      const b = barOn(histories.get(e.symbol.toUpperCase()) ?? [], date);
      const close = b ? (b.raw ?? b.close) : e.price ?? 0;
      book.lots.push({ symbol: e.symbol.toUpperCase(), dollars: (e.kind === "buy" ? 1 : -1) * Math.abs(e.quantity) * close, date });
      book.cash.push({ amount: e.amount, date });
    } else if (EXTERNAL.has(e.kind)) {
      flows.push({ amount: e.amount, date });
    } else if (e.kind === "fee") {
      book.cash.push({ amount: e.amount, date });
    }
  }
  return { book, flows };
}

function bookValue(b: Book, flows: { amount: number; date: string }[], date: string, histories: Map<string, Bar[]>, missing: Set<string>): { value: number; positions: Map<string, number> } {
  const positions = new Map<string, number>();
  for (const l of b.lots) {
    if (l.date > date) continue;
    const bars = histories.get(l.symbol) ?? [];
    const from = barOn(bars, l.date), to = barOn(bars, date);
    const grow = from && to ? to.close / from.close : (missing.add(l.symbol), 1);
    positions.set(l.symbol, (positions.get(l.symbol) ?? 0) + l.dollars * grow);
  }
  const cash = [...b.cash, ...flows].filter((c) => c.date <= date).reduce((a, c) => a + c.amount, 0);
  return { value: [...positions.values()].reduce((a, v) => a + v, 0) + cash, positions };
}

export const HORIZONS = [
  { key: "1m", label: "1 month", days: 30 }, { key: "3m", label: "3 months", days: 91 }, { key: "6m", label: "6 months", days: 182 },
  { key: "12m", label: "12 months", days: 365 }, { key: "24m", label: "24 months", days: 730 },
] as const;
export const PORTFOLIOS = [
  { key: "original", label: "No change", long: "Original portfolio, unchanged" }, { key: "hypothetical", label: "With change", long: "With the proposed change" },
  { key: "actual", label: "Actual", long: "Actual, with your real trades" }, { key: "voo", label: "All VOO", long: "Same money all in VOO" },
] as const;
export type PortfolioKey = (typeof PORTFOLIOS)[number]["key"];
export type Result = { value: number; gain: number; pct: number };
export type Risk = { largest: { symbol: string; pct: number } | null; volatility: number | null; maxDrawdown: number | null; /** annualized return / annualized volatility, after 20 trading days */ returnPerRisk: number | null };
export type ShadowReport = {
  status: "pending" | "active" | "closed";
  startDate: string; resolved: Resolved | null; asOf: string | null; flows: number;
  now: Record<PortfolioKey, Result> | null;
  horizons: { key: string; label: string; date: string; results: Record<PortfolioKey, Result> | null }[];
  risk: Record<PortfolioKey, Risk> | null;
  missing: string[];
};

/** Values the four portfolios on every trading day from the start (to the close date for a closed test). Pure. */
export function shadowReport(t: ShadowTest, start: ShadowStart | null, ledger: LedgerFlow[], histories: Map<string, Bar[]>, close: ShadowClose | null): ShadowReport {
  const status = close ? "closed" : start ? "active" : "pending";
  const empty = { startDate: start?.startDate ?? t.startDate, asOf: null, flows: 0, now: null, risk: null, missing: [] };
  if (!start) return { status, resolved: null, horizons: HORIZONS.map((h) => ({ key: h.key, label: h.label, date: addDays(t.startDate, h.days), results: null })), ...empty };
  const r = resolveTest(t, start);
  const { book: actual, flows } = actualBook(t, r, ledger, histories);
  const books: Record<PortfolioKey, Book> = { original: r.books.original, hypothetical: r.books.hypothetical, actual, voo: r.books.voo };
  const end = close?.endDate ?? "9999-12-31";
  const dates = (histories.get("VOO") ?? []).map((b) => b.date).filter((d) => d >= r.startDate && d <= end);
  const missing = new Set<string>();
  const series = dates.map((d) => {
    const flowIn = flows.filter((f) => f.date <= d).reduce((a, f) => a + f.amount, 0);
    const flowToday = flows.filter((f) => f.date === d).reduce((a, f) => a + f.amount, 0);
    const v = Object.fromEntries(PORTFOLIOS.map((p) => [p.key, bookValue(books[p.key], flows, d, histories, missing)])) as Record<PortfolioKey, { value: number; positions: Map<string, number> }>;
    return { date: d, flowIn, flowToday, v };
  });
  const resultAt = (i: number): Record<PortfolioKey, Result> => {
    const s = series[i];
    return Object.fromEntries(PORTFOLIOS.map((p) => {
      const value = s.v[p.key].value, base = r.startValue + s.flowIn, gain = value - base;
      return [p.key, { value: r2(value), gain: r2(gain), pct: base ? Math.round((gain / base) * 10000) / 100 : 0 }];
    })) as Record<PortfolioKey, Result>;
  };
  const last = series.length - 1;
  const horizons = HORIZONS.map((h) => {
    const date = addDays(r.startDate, h.days);
    const i = series.length && series[last].date >= date ? series.findLastIndex((s) => s.date <= date) : -1;
    return { key: h.key, label: h.label, date, results: i >= 0 ? resultAt(i) : null };
  });
  const risk = last < 0 ? null : (Object.fromEntries(PORTFOLIOS.map((p) => {
    // Daily returns with each day's deposits or withdrawals taken out, so flows are not counted as moves.
    const rets: number[] = [];
    let peak = 1, idx = 1, mdd = 0;
    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1].v[p.key].value;
      if (prev <= 0) continue;
      const ret = (series[i].v[p.key].value - series[i].flowToday) / prev - 1;
      rets.push(ret);
      idx *= 1 + ret; peak = Math.max(peak, idx); mdd = Math.min(mdd, idx / peak - 1);
    }
    const mean = rets.reduce((a, x) => a + x, 0) / (rets.length || 1);
    const sd = Math.sqrt(rets.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
    const pos = [...series[last].v[p.key].positions].sort((a, b) => b[1] - a[1])[0];
    const tot = series[last].v[p.key].value;
    return [p.key, {
      largest: pos && tot > 0 ? { symbol: pos[0], pct: r2((pos[1] / tot) * 100) } : null,
      volatility: rets.length >= 5 ? Math.round(sd * Math.sqrt(252) * 1000) / 10 : null,
      returnPerRisk: rets.length >= 20 && sd > 0 ? Math.round((((idx ** (252 / rets.length)) - 1) / (sd * Math.sqrt(252))) * 100) / 100 : null,
      maxDrawdown: rets.length ? Math.round(mdd * 1000) / 10 : null,
    }];
  })) as Record<PortfolioKey, Risk>);
  return {
    status, startDate: r.startDate, resolved: r, asOf: last >= 0 ? series[last].date : null,
    flows: r2(flows.reduce((a, f) => a + f.amount, 0)), now: last >= 0 ? resultAt(last) : null, horizons, risk, missing: [...missing],
  };
}

/** Checks your own test before it is saved. Returns the problem in plain words, or null. */
export function checkOwnTrades(trades: ShadowTrade[], held: Set<string>): string | null {
  if (!trades.length) return "Add at least one trade.";
  if (trades.length > 6) return "Use at most 6 trades in one test.";
  for (const t of trades) {
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t.symbol)) return `"${t.symbol}" is not a ticker symbol.`;
    if (!(t.amount > 0)) return `${t.symbol}: enter an amount above zero.`;
    if (t.unit !== "usd" && t.amount > 100) return `${t.symbol}: a percentage can be at most 100.`;
    if (t.side === "sell" && !held.has(t.symbol)) return `${t.symbol} is not in your portfolio, so it cannot be sold.`;
    if (t.side === "sell" && t.unit === "pct_proceeds") return `${t.symbol}: a sell is a % of the holding or a dollar amount.`;
    if (t.side === "buy" && t.unit === "pct_holding") return `${t.symbol}: a buy is a % of the sale proceeds or a dollar amount.`;
  }
  return null;
}
