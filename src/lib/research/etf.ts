/**
 * ETF research (2026-11-16: "no way to research AVUV and other ETFs").
 *
 * Two parts:
 *  - etfFacts: free, code only. What the fund holds (from the dated fund reference data), what you already
 *    own of it, its policy group and the room left under that group's range, and how much it overlaps with
 *    your stocks and your other funds.
 *  - The ETF check: one short paid AI pass (about $0.30-0.60, started by you) that looks up the fee, the
 *    fund's valuation and factor tilt, and its returns against VOO, then says whether it fits your
 *    portfolio now. Its prompt and its validator live here; the job is in etfJob.ts.
 * Nothing here trades or moves money.
 */
import { FUNDS, type FundProfile, type SourceRef } from "@/lib/exposure/reference";
import { bucketOf, type Bucket } from "@/lib/portfolio/classify";
import type { PortfolioView } from "@/lib/portfolio/engine";

export const ETF_CHECK_VERSION = "etf-check@1";
export const ETF_CHECK_LIMITS = { turns: 10, searches: 5, ms: 5 * 60_000, maxTokens: 5000 };
/** What one ETF check usually costs (shown before you start one; replaced by measured runs once there are some). */
export const ETF_CHECK_ESTIMATE = { low: 0.3, high: 0.6 };
export const ETF_RUNNING_WINDOW_MIN = 10;

export type EtfOverlap = { with: string; kind: "stock" | "fund"; shared: { symbol: string; weight: number }[]; sharedWeight: number; note: string };
export type EtfFacts = {
  symbol: string;
  profile: FundProfile | null;
  held: { value: number; weight: number; accounts: string[] } | null;
  bucket: Bucket;
  group: { value: number; weight: number; low: number; high: number; hardMax: number | null; status: string; roomToHigh: number } | null;
  overlaps: EtfOverlap[];
  sources: { what: string; source: SourceRef; ageDays: number }[];
  gaps: string[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const days = (iso: string, now: Date) => Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000));

/** Pure: everything the app already knows about an ETF and how it sits in your portfolio. */
export function etfFacts(symbol: string, p: PortfolioView, now: Date = new Date()): EtfFacts {
  const sym = symbol.toUpperCase();
  const profile = FUNDS[sym] ?? null;
  const h = p.holdings.find((x) => x.symbol === sym);
  const held = h ? { value: r2(h.value), weight: h.weight, accounts: h.accounts } : null;
  const bucket = bucketOf(sym);
  const row = p.buckets.find((b) => b.bucket === bucket);
  const group = row?.normal ? {
    value: r2(row.value), weight: row.weight, low: row.normal.low, high: row.normal.high, hardMax: row.hardMax, status: row.status,
    roomToHigh: r2(Math.max(0, row.normal.high * p.total - row.value)),
  } : null;

  const overlaps: EtfOverlap[] = [];
  const top = profile?.top ?? [];
  // Your individual stocks that are among the fund's largest holdings.
  for (const s of p.holdings.filter((x) => !FUNDS[x.symbol] && x.symbol !== sym)) {
    const t = top.find((x) => x.symbol === s.symbol);
    if (t) overlaps.push({ with: s.symbol, kind: "stock", shared: [t], sharedWeight: t.weight, note: `${(t.weight * 100).toFixed(1)}% of ${sym}; you also hold it directly` });
  }
  // Your other funds: the share of this fund's largest holdings that the other fund also holds (a lower bound).
  for (const f of p.holdings.filter((x) => FUNDS[x.symbol] && x.symbol !== sym)) {
    const other = FUNDS[f.symbol];
    const otherTop = new Map((other.top ?? []).map((x) => [x.symbol, x.weight]));
    const shared = top.filter((x) => otherTop.has(x.symbol)).map((x) => ({ symbol: x.symbol, weight: Math.min(x.weight, otherTop.get(x.symbol)!) }));
    const sameMarket = profile?.countries && other.countries && Object.keys(profile.countries).some((c) => (other.countries![c] ?? 0) > 0.5 && (profile.countries![c] ?? 0) > 0.5);
    if (shared.length || (sameMarket && profile?.size && other.size && Object.keys(profile.size).some((k) => (other.size as Record<string, number>)[k]))) {
      const w = shared.reduce((a, x) => a + x.weight, 0);
      overlaps.push({
        with: f.symbol, kind: "fund", shared, sharedWeight: r2(w * 10000) / 10000,
        note: shared.length ? `At least ${(w * 100).toFixed(1)}% of ${sym} is in companies ${f.symbol} also holds among its largest positions` : `Same market and company size as ${f.symbol}; their largest holdings don't overlap, so the overlap is likely small`,
      });
    }
  }
  overlaps.sort((a, b) => b.sharedWeight - a.sharedWeight);

  const sources: EtfFacts["sources"] = [];
  if (profile?.topSource) sources.push({ what: "Largest holdings", source: profile.topSource, ageDays: days(profile.topSource.asOf, now) });
  if (profile?.sectorsSource) sources.push({ what: "Sectors", source: profile.sectorsSource, ageDays: days(profile.sectorsSource.asOf, now) });
  if (profile?.countriesSource) sources.push({ what: "Countries", source: profile.countriesSource, ageDays: days(profile.countriesSource.asOf, now) });
  const gaps = [
    ...(profile ? [] : [`The app has no holdings data on file for ${sym}; the ETF check can look it up.`]),
    ...(profile && !profile.sectors && !profile.notes?.length ? ["No published sector split on file."] : []),
    ...(profile?.notes ?? []),
  ];
  return { symbol: sym, profile, held, bucket, group, overlaps, sources, gaps };
}

export const ETF_CHECK_SYSTEM = `You are the fund analyst inside Portfolio Intelligence, working for one private investor whose portfolio, policy limits and cash are given below. You are checking one exchange-traded fund. Be brief and exact.

How to work:
- Use web_search (at most 5 searches) for the issuer's fund page and one independent fund data page (for example Morningstar, stockanalysis.com or etf.com). Use read_document on a fund page only if a figure you need is not in the search results.
- Every number comes from a source you retrieved (name it with its date) or is labeled as your estimate. Never invent figures. A figure you could not find is null and goes in not_verified.
- Judge fit against THIS investor: their policy group for this fund, the room left in it, the overlap with what they already own, and their goal (beat the S&P 500 over the long term while managing downside and concentration). Holding cash or doing nothing is always a valid answer. A diversified ETF is a long-term choice, not a short-term opportunity: do not invent urgency.
- This is research only. Never place trades or move money.

Answer with ONE JSON object and nothing else:
{
 "as_of": "YYYY-MM-DD",
 "name": "fund name",
 "expense_ratio_pct": number|null,
 "aum_usd_bn": number|null,
 "holdings_count": number|null,
 "valuation": { "pe": number|null, "pb": number|null, "vs_sp500": "one sentence: cheaper, similar or more expensive than the S&P 500, with figures" },
 "factor_tilt": "one or two sentences: size, value/growth, profitability, momentum, quality as published or measured",
 "returns": { "y1_pct": number|null, "y3_ann_pct": number|null, "y5_ann_pct": number|null, "voo_y1_pct": number|null, "voo_y5_ann_pct": number|null, "as_of": "YYYY-MM-DD" },
 "role": "one sentence: what this fund does in this investor's portfolio",
 "risks": ["two to four short risks"],
 "verdict": "Add" | "Hold" | "Skip",
 "amount": "a dollar amount or range if Add, else empty",
 "why": "two or three sentences tying the verdict to the room under the policy group, overlap, valuation and fees",
 "sources": [{ "title": "...", "url": "https://...", "date": "YYYY-MM-DD" }],
 "not_verified": ["..."]
}`;

export function etfCheckQuestion(a: { symbol: string; today: string; facts: EtfFacts; price: number | null }): string {
  const f = a.facts;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `Check the ETF ${a.symbol} for this investor. Today is ${a.today}.${a.price ? ` App price: $${a.price.toFixed(2)}.` : ""}`,
    f.profile ? `On file: ${f.profile.name}. ${f.profile.mandate}. ${f.profile.holdingsCount ?? "?"} holdings.` : "The app has no fund data on file for it.",
    f.held ? `They hold $${f.held.value.toFixed(0)} (${pct(f.held.weight)} of the invested portfolio).` : "They do not hold it.",
    f.group ? `Policy group "${f.bucket}": ${pct(f.group.weight)} now, normal range ${pct(f.group.low)}-${pct(f.group.high)}, about $${f.group.roomToHigh.toFixed(0)} of room to the top of the range.` : `Policy group "${f.bucket}" has no range on file.`,
    f.overlaps.length ? `Overlap with what they own: ${f.overlaps.slice(0, 5).map((o) => `${o.with} (${o.note})`).join("; ")}.` : "No overlap found with their holdings' largest positions.",
  ];
  return lines.join("\n");
}

export type EtfCheck = {
  as_of: string; name: string | null; expense_ratio_pct: number | null; aum_usd_bn: number | null; holdings_count: number | null;
  valuation: { pe: number | null; pb: number | null; vs_sp500: string };
  factor_tilt: string;
  returns: { y1_pct: number | null; y3_ann_pct: number | null; y5_ann_pct: number | null; voo_y1_pct: number | null; voo_y5_ann_pct: number | null; as_of: string | null };
  role: string; risks: string[]; verdict: "Add" | "Hold" | "Skip"; amount: string; why: string;
  sources: { title: string; url: string; date: string | null }[]; not_verified: string[];
};

const num = (v: unknown, lo = -1e6, hi = 1e6) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const str = (v: unknown, max = 600) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Pure: checks the model's JSON. Anything malformed is refused rather than shown. */
export function validateEtfCheck(raw: unknown, today: string): EtfCheck | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "The answer was not the expected JSON." };
  const o = raw as Record<string, unknown>;
  const verdict = o.verdict === "Add" || o.verdict === "Hold" || o.verdict === "Skip" ? o.verdict : null;
  if (!verdict) return { error: "The answer had no Add/Hold/Skip verdict." };
  const sources = (Array.isArray(o.sources) ? o.sources : []).map((s) => s as Record<string, unknown>)
    .filter((s) => typeof s.url === "string" && /^https?:\/\//.test(s.url as string))
    .map((s) => ({ title: str(s.title, 200) || String(s.url), url: String(s.url).slice(0, 500), date: /^\d{4}-\d{2}-\d{2}$/.test(String(s.date ?? "")) ? String(s.date) : null })).slice(0, 12);
  if (!sources.length) return { error: "The answer cited no sources." };
  const why = str(o.why, 900);
  if (!why) return { error: "The answer gave no reason." };
  const v = (o.valuation ?? {}) as Record<string, unknown>;
  const r = (o.returns ?? {}) as Record<string, unknown>;
  const d = (x: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x ?? "")) ? String(x) : null);
  return {
    as_of: d(o.as_of) ?? today, name: str(o.name, 200) || null,
    expense_ratio_pct: num(o.expense_ratio_pct, 0, 5), aum_usd_bn: num(o.aum_usd_bn, 0, 5000), holdings_count: num(o.holdings_count, 1, 100000),
    valuation: { pe: num(v.pe, 0, 500), pb: num(v.pb, 0, 100), vs_sp500: str(v.vs_sp500, 400) },
    factor_tilt: str(o.factor_tilt, 500),
    returns: { y1_pct: num(r.y1_pct, -100, 1000), y3_ann_pct: num(r.y3_ann_pct, -100, 1000), y5_ann_pct: num(r.y5_ann_pct, -100, 1000), voo_y1_pct: num(r.voo_y1_pct, -100, 1000), voo_y5_ann_pct: num(r.voo_y5_ann_pct, -100, 1000), as_of: d(r.as_of) },
    role: str(o.role, 400), risks: (Array.isArray(o.risks) ? o.risks : []).map((x) => str(x, 300)).filter(Boolean).slice(0, 5),
    verdict, amount: verdict === "Add" ? str(o.amount, 120) : "", why, sources,
    not_verified: (Array.isArray(o.not_verified) ? o.not_verified : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 8),
  };
}
