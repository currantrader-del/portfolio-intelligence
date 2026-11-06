/**
 * The briefing's numbers. Everything here is computed by code from provider data, with the
 * provider and the market timestamp of every value, so the written briefing can quote these
 * numbers and never needs to invent one. Pure functions first, fetchers at the bottom.
 */
import { INSTRUMENTS, MACRO, type Group, type Instrument, type MacroSpec } from "./instruments";

export const SNAPSHOT_VERSION = "market-snapshot@1";

export type Series = { symbol: string; price: number; prevClose: number | null; marketTime: string; closes: { date: string; close: number }[]; provider: "yahoo" };

export type Row = {
  symbol: string; label: string; group: Group; kind: Instrument["kind"];
  last: number; marketTime: string; provider: string;
  /** "live" = market time within 20 minutes; "delayed" = same day but older; "previous close" = an earlier session. */
  freshness: "live" | "delayed" | "previous close";
  day: number | null; // price: fraction; yield: change in basis points
  week: number | null; // 5 sessions
  month: number | null; // 21 sessions
  ytd: number | null;
  vs50d: number | null; // last / 50-day average - 1 (price instruments only)
  vs200d: number | null;
  from52wHigh: number | null; // last / 52-week high - 1
};

export type Breadth = {
  sectorsUp: number; sectorsTotal: number;
  sectorsAbove50d: number; sectorsAbove200d: number;
  equalVsCapMonth: number | null; // RSP 1m minus SPY 1m, percentage points as a fraction
  smallVsLargeMonth: number | null; // Russell 2000 1m minus S&P 500 1m
  leaders: { symbol: string; label: string; month: number }[];
  laggards: { symbol: string; label: string; month: number }[];
};

export type MacroRow = { id: string; label: string; unit: MacroSpec["unit"]; value: number; date: string; previous: number | null; previousDate: string | null; source: string };

export type Snapshot = {
  version: string;
  takenAt: string;
  rows: Row[];
  missing: string[];
  breadth: Breadth | null;
  macro: MacroRow[];
  macroMissing: string[];
  notes: string[];
};

const etDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

function back(closes: Series["closes"], n: number) {
  return closes.length > n ? closes[closes.length - 1 - n].close : null;
}

export function computeRow(inst: Instrument, s: Series, now: Date): Row {
  const c = s.closes;
  const last = s.price;
  const ch = (ref: number | null) => (ref === null || ref <= 0 ? null : inst.kind === "yield" ? (last - ref) * 100 : last / ref - 1);
  const year = now.getUTCFullYear();
  const lastPrevYear = [...c].reverse().find((b) => Number(b.date.slice(0, 4)) < year)?.close ?? null;
  const avg = (n: number) => (c.length >= n ? c.slice(-n).reduce((a, b) => a + b.close, 0) / n : null);
  const a50 = avg(50), a200 = avg(200);
  const hi = c.length >= 200 ? Math.max(...c.slice(-252).map((b) => b.close), last) : null;
  const ageMin = (now.getTime() - Date.parse(s.marketTime)) / 60000;
  const freshness: Row["freshness"] = ageMin <= 20 ? "live" : etDate(new Date(s.marketTime)) === etDate(now) ? "delayed" : "previous close";
  // History bars include today's partial bar on trading days: step back from the bar before it.
  const hist = c.length && c[c.length - 1].date === etDate(new Date(s.marketTime)) ? c.slice(0, -1) : c;
  return {
    symbol: inst.symbol, label: inst.label, group: inst.group, kind: inst.kind,
    last, marketTime: s.marketTime, provider: s.provider, freshness,
    day: ch(s.prevClose),
    week: ch(back(hist, 4)),
    month: ch(back(hist, 20)),
    ytd: ch(lastPrevYear),
    vs50d: inst.kind === "price" && a50 ? last / a50 - 1 : null,
    vs200d: inst.kind === "price" && a200 ? last / a200 - 1 : null,
    from52wHigh: inst.kind === "price" && hi ? last / hi - 1 : null,
  };
}

export function computeBreadth(rows: Row[]): Breadth | null {
  const sectors = rows.filter((r) => r.group === "sector" && r.symbol !== "SMH");
  if (sectors.length < 6) return null;
  const by = (s: string) => rows.find((r) => r.symbol === s);
  const diff = (a?: Row, b?: Row) => (a?.month != null && b?.month != null ? a.month - b.month : null);
  const ranked = rows.filter((r) => r.group === "sector" && r.month !== null).sort((a, b) => b.month! - a.month!);
  return {
    sectorsUp: sectors.filter((r) => (r.day ?? 0) > 0).length,
    sectorsTotal: sectors.length,
    sectorsAbove50d: sectors.filter((r) => (r.vs50d ?? -1) > 0).length,
    sectorsAbove200d: sectors.filter((r) => (r.vs200d ?? -1) > 0).length,
    equalVsCapMonth: diff(by("RSP"), by("SPY")),
    smallVsLargeMonth: diff(by("^RUT"), by("^GSPC")),
    leaders: ranked.slice(0, 3).map((r) => ({ symbol: r.symbol, label: r.label, month: r.month! })),
    laggards: ranked.slice(-3).reverse().map((r) => ({ symbol: r.symbol, label: r.label, month: r.month! })),
  };
}

/** FRED CSV: "observation_date,SERIES\n2026-10-01,3.1\n..." with "." for missing values. */
export function parseFredCsv(csv: string): { date: string; value: number }[] {
  return csv.trim().split(/\r?\n/).slice(1)
    .map((l) => l.split(","))
    .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c[0]) && c[1] !== "." && c[1] !== "" && Number.isFinite(Number(c[1])))
    .map((c) => ({ date: c[0], value: Number(c[1]) }));
}

/** Applies the series transform; returns the latest value and the one before it, each with its own observation date. */
export function macroRow(spec: MacroSpec, obs: { date: string; value: number }[]): MacroRow | null {
  const source = `https://fred.stlouisfed.org/series/${spec.id}`;
  const scale = spec.id === "ICSA" ? 1 / 1000 : 1;
  const at = (i: number) => obs[obs.length - 1 - i];
  const t = (i: number): { value: number; date: string } | null => {
    const o = at(i);
    if (!o) return null;
    if (spec.transform === "level") return { value: o.value * scale, date: o.date };
    if (spec.transform === "mom_change") { const p = at(i + 1); return p ? { value: o.value - p.value, date: o.date } : null; }
    if (spec.transform === "qoq_saar") { const p = at(i + 1); return p ? { value: ((o.value / p.value) ** 4 - 1) * 100, date: o.date } : null; }
    // yoy: same month a year earlier, matched by date rather than position
    const target = `${Number(o.date.slice(0, 4)) - 1}${o.date.slice(4)}`;
    const p = obs.find((x) => x.date === target);
    return p ? { value: (o.value / p.value - 1) * 100, date: o.date } : null;
  };
  const a = t(0), b = t(1);
  if (!a) return null;
  return { id: spec.id, label: spec.label, unit: spec.unit, value: a.value, date: a.date, previous: b?.value ?? null, previousDate: b?.date ?? null, source };
}

export function buildSnapshot(series: Map<string, Series>, macro: Map<string, { date: string; value: number }[]>, now: Date): Snapshot {
  const rows: Row[] = [];
  const missing: string[] = [];
  for (const inst of INSTRUMENTS) {
    const s = series.get(inst.symbol);
    if (s) rows.push(computeRow(inst, s, now)); else missing.push(`${inst.label} (${inst.symbol})`);
  }
  const macroRows: MacroRow[] = [];
  const macroMissing: string[] = [];
  for (const spec of MACRO) {
    const r = macro.get(spec.id) ? macroRow(spec, macro.get(spec.id)!) : null;
    if (r) macroRows.push(r); else macroMissing.push(spec.label);
  }
  const notes = [
    "Prices are from the free Yahoo Finance chart feed; index and futures quotes can be delayed. Each row carries its market time.",
    "Treasury yields from Yahoo are CBOE yield indices; their changes are in basis points. FRED daily yields are official closes and lag by a day.",
    "Breadth here is sector-level (11 SPDR sector funds), not a count of individual stocks.",
  ];
  if (rows.some((r) => r.freshness === "previous close")) notes.push("Some markets were closed at snapshot time; their values are previous-session closes.");
  return { version: SNAPSHOT_VERSION, takenAt: now.toISOString(), rows, missing, breadth: computeBreadth(rows), macro: macroRows, macroMissing, notes };
}

// ---------- fetchers ----------

const UA = "Mozilla/5.0 (compatible; PortfolioIntelligence/1.0)";

export function parseYahooSeries(symbol: string, body: unknown): Series | null {
  const r = (body as { chart?: { result?: { meta?: Record<string, unknown>; timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] } })?.chart?.result?.[0];
  const meta = r?.meta;
  const price = Number(meta?.regularMarketPrice);
  const t = Number(meta?.regularMarketTime);
  if (!meta || !Number.isFinite(price) || price <= 0 || !Number.isFinite(t) || t <= 0) return null;
  const tz = String(meta.exchangeTimezoneName ?? "America/New_York");
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const raw = r?.indicators?.quote?.[0]?.close ?? [];
  const byDate = new Map<string, number>();
  (r?.timestamp ?? []).forEach((ts, i) => { const c = raw[i]; if (c != null && Number.isFinite(c) && c > 0) byDate.set(fmt.format(new Date(ts * 1000)), c); });
  const closes = [...byDate].map(([date, close]) => ({ date, close })).sort((a, b) => a.date.localeCompare(b.date));
  const prev = Number(meta.previousClose ?? NaN);
  // With range=1y, chartPreviousClose is the close before the range; the session's prior close is the bar before today's.
  const lastDate = fmt.format(new Date(t * 1000));
  const prior = [...closes].reverse().find((b) => b.date < lastDate)?.close ?? null;
  return { symbol, price, prevClose: Number.isFinite(prev) && prev > 0 ? prev : prior, marketTime: new Date(t * 1000).toISOString(), closes, provider: "yahoo" };
}

async function fetchSeries(symbol: string): Promise<Series | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    return res.ok ? parseYahooSeries(symbol, await res.json()) : null;
  } catch {
    return null;
  }
}

async function fetchFred(id: string): Promise<{ date: string; value: number }[] | null> {
  try {
    const start = new Date(Date.now() - 800 * 86400000).toISOString().slice(0, 10);
    const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`, { headers: { "User-Agent": UA }, next: { revalidate: 3600 }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const obs = parseFredCsv(await res.text());
    return obs.length ? obs : null;
  } catch {
    return null;
  }
}

export async function takeSnapshot(now = new Date()): Promise<Snapshot> {
  const [series, macro] = await Promise.all([
    Promise.all(INSTRUMENTS.map(async (i) => [i.symbol, await fetchSeries(i.symbol)] as const)),
    Promise.all(MACRO.map(async (m) => [m.id, await fetchFred(m.id)] as const)),
  ]);
  return buildSnapshot(
    new Map(series.filter((x): x is readonly [string, Series] => x[1] !== null)),
    new Map(macro.filter((x): x is readonly [string, { date: string; value: number }[]] => x[1] !== null)),
    now,
  );
}
