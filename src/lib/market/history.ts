import { FIXTURE, fixtureHistory } from "@/lib/dev/fixture";
/**
 * Layer 1: daily price history (free, delayed). Yahoo chart first, Stooq daily CSV as a fallback.
 * Closes are split- and dividend-adjusted where the provider gives an adjusted close.
 */
export type Bar = { date: string; close: number }; // date YYYY-MM-DD
export type History = { symbol: string; bars: Bar[]; provider: "yahoo" | "stooq"; adjusted: boolean; fetchedAt: string };

const UA = "Mozilla/5.0 (compatible; PortfolioIntelligence/1.0)";

export function parseYahooHistory(symbol: string, body: unknown): History | null {
  const r = (body as { chart?: { result?: { timestamp?: number[]; meta?: { exchangeTimezoneName?: string }; indicators?: { quote?: { close?: (number | null)[] }[]; adjclose?: { adjclose?: (number | null)[] }[] } }[] } })?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const adj = r?.indicators?.adjclose?.[0]?.adjclose;
  const raw = r?.indicators?.quote?.[0]?.close;
  const closes = adj ?? raw ?? [];
  const tz = r?.meta?.exchangeTimezoneName ?? "America/New_York";
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const byDate = new Map<string, number>();
  ts.forEach((t, i) => {
    const c = closes[i];
    if (c != null && Number.isFinite(c) && c > 0) byDate.set(fmt.format(new Date(t * 1000)), c);
  });
  const bars = [...byDate].map(([date, close]) => ({ date, close })).sort((a, b) => a.date.localeCompare(b.date));
  return bars.length ? { symbol, bars, provider: "yahoo", adjusted: !!adj, fetchedAt: new Date().toISOString() } : null;
}

export function parseStooqHistory(symbol: string, csv: string): History | null {
  const lines = csv.trim().split(/\r?\n/);
  const head = (lines.shift() ?? "").toLowerCase().split(",");
  const di = head.indexOf("date");
  const ci = head.indexOf("close");
  if (di < 0 || ci < 0) return null;
  const bars = lines
    .map((l) => l.split(","))
    .map((c) => ({ date: c[di], close: Number(c[ci]) }))
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  return bars.length ? { symbol, bars, provider: "stooq", adjusted: false, fetchedAt: new Date().toISOString() } : null;
}

export type Range = "3mo" | "6mo" | "1y" | "2y" | "5y";

export async function getHistory(symbol: string, range: Range = "1y"): Promise<History | null> {
  if (FIXTURE) return fixtureHistory(symbol, range);
  const sym = symbol.toUpperCase();
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d&events=div,split`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, next: { revalidate: 3600 } });
    if (res.ok) {
      const h = parseYahooHistory(sym, await res.json());
      if (h) return h;
    }
  } catch {
    /* fall through */
  }
  try {
    const s = sym.startsWith("^") ? sym : `${sym.toLowerCase().replace(".", "-")}.us`;
    const days = { "3mo": 92, "6mo": 183, "1y": 366, "2y": 731, "5y": 1827 }[range];
    const d1 = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&d1=${d1}&i=d`, { headers: { "User-Agent": UA }, next: { revalidate: 3600 } });
    if (res.ok) return parseStooqHistory(sym, await res.text());
  } catch {
    /* none */
  }
  return null;
}

export async function getHistories(symbols: string[], range: Range = "1y"): Promise<Map<string, History>> {
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const out = await Promise.all(uniq.map(async (s) => [s, await getHistory(s, range)] as const));
  return new Map(out.filter((x): x is readonly [string, History] => x[1] !== null));
}
