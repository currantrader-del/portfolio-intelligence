/**
 * Layer 1: market data. Prices come only from a provider, never from the AI layer.
 * Primary: Yahoo Finance chart endpoint (free, delayed for some exchanges). Fallback: Stooq CSV.
 * Every quote carries its provider and timestamp.
 */
export type Quote = {
  symbol: string;
  price: number;
  prevClose: number | null;
  asOf: string; // ISO
  provider: "yahoo" | "stooq";
  delayClass: "realtime" | "delayed" | "eod";
};

export function parseYahooChart(symbol: string, body: unknown): Quote | null {
  const meta = (body as { chart?: { result?: { meta?: Record<string, unknown> }[] } })?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const price = Number(meta.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  const prev = Number(meta.chartPreviousClose ?? meta.previousClose);
  const t = Number(meta.regularMarketTime);
  return {
    symbol,
    price,
    prevClose: Number.isFinite(prev) && prev > 0 ? prev : null,
    asOf: new Date((Number.isFinite(t) ? t : Date.now() / 1000) * 1000).toISOString(),
    provider: "yahoo",
    delayClass: "delayed",
  };
}

/** Stooq CSV with fields s,d2,t2,o,h,l,c,v,p (symbol, date, time, OHLC, volume, previous close). */
export function parseStooqCsv(symbol: string, csv: string): Quote | null {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const head = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const row = lines[1].split(",");
  const get = (k: string) => row[head.indexOf(k)];
  const price = Number(get("close"));
  if (!Number.isFinite(price) || price <= 0) return null;
  const prev = Number(get("prev"));
  const date = get("date");
  const time = get("time") ?? "22:00:00";
  // Stooq timestamps are CET/CEST; treat as approximate and label the quote delayed.
  const asOf = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T${time}+01:00`).toISOString() : new Date().toISOString();
  return { symbol, price, prevClose: Number.isFinite(prev) && prev > 0 ? prev : null, asOf, provider: "stooq", delayClass: "delayed" };
}

const UA = "Mozilla/5.0 (compatible; PortfolioIntelligence/1.0)";

async function fetchYahoo(symbol: string): Promise<Quote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, next: { revalidate: 60 } });
  if (!res.ok) return null;
  return parseYahooChart(symbol, await res.json());
}

async function fetchStooq(symbol: string): Promise<Quote | null> {
  const s = symbol.startsWith("^") ? symbol : `${symbol.toLowerCase().replace(".", "-")}.us`;
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlcvp&h&e=csv`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, next: { revalidate: 60 } });
  if (!res.ok) return null;
  return parseStooqCsv(symbol, await res.text());
}

export async function getQuote(symbol: string): Promise<Quote | null> {
  try {
    const q = await fetchYahoo(symbol);
    if (q) return q;
  } catch {
    /* fall through */
  }
  try {
    return await fetchStooq(symbol);
  } catch {
    return null;
  }
}

/** Fetches many quotes in parallel. Missing symbols are simply absent from the map. */
export async function getQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const unique = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const results = await Promise.all(unique.map(async (s) => [s, await getQuote(s)] as const));
  return new Map(results.filter((r): r is readonly [string, Quote] => r[1] !== null));
}

export function dayChangePct(q: Quote | undefined | null): number | null {
  if (!q || !q.prevClose) return null;
  return q.price / q.prevClose - 1;
}

/** Benchmarks shown in the header and used in the brief. ETFs stand in for indexes (free data). */
export const BENCHMARKS = [
  { symbol: "SPY", label: "S&P 500" },
  { symbol: "QQQ", label: "Nasdaq 100" },
  { symbol: "SOXX", label: "Semis" },
] as const;
