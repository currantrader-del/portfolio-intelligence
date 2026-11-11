/**
 * Opportunity Radar (2026-11-11): once a week, at most three new long-term ideas worth a research look, or none.
 *
 * 1. Code screen (free): every S&P 500 stock's last year of prices, sorted into three kinds of candidate:
 *      leaders      beating the S&P 500 over 12 months, in an uptrend, near their high
 *      pullbacks    beating the S&P 500 over 12 months but 12-35% below their high
 *      setups       a chart setup with defined risk (the trade scan's screen, upward ones only)
 *    Stocks you hold, have researched, or Radar named in the last 8 weeks are left out; at most two per sector.
 * 2. One AI pass (Sonnet, a few web searches, about $0.40): picks at most three, each with dated evidence.
 *    Analyst ratings, fund holdings and social posts are idea inputs only: they are labelled, and an idea
 *    resting on them alone cannot be "strong".
 * 3. Nothing is researched or bought automatically. Each idea's price and VOO are locked in, so the Radar
 *    page shows how the ideas did against VOO, including the ones you passed on.
 * Pure functions here; the job (job.ts) fetches, asks and stores.
 */
import type { Bar } from "@/lib/market/history";
import { findSetup, setupLabel } from "@/lib/trades/scan";

export const RADAR_VERSION = "radar@1";
export const RADAR_LIMITS = { turns: 14, searches: 5, ms: 9 * 60_000, maxTokens: 8000 };
export const MAX_IDEAS = 3;
export const COOLDOWN_DAYS = 56;

export type CandidateKind = "leader" | "pullback" | "setup";
export type Candidate = { symbol: string; sector: string | null; kind: CandidateKind; price: number; ret12m: number | null; vsSpy12m: number | null; fromHigh: number; why: string; score: number };

export type Metrics = { price: number; ret12m: number | null; ret3m: number | null; fromHigh: number; above200: boolean | null };

const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;

/** Price behaviour over the last year, from daily closes. Pure. */
export function metricsOf(bars: Bar[]): Metrics | null {
  if (bars.length < 60) return null;
  const c = bars.map((b) => b.close);
  const price = c[c.length - 1];
  const high = Math.max(...bars.slice(-252).map((b) => b.high ?? b.close));
  const at = (n: number) => (c.length > n ? c[c.length - 1 - n] : null);
  const y = at(Math.min(251, c.length - 1)), q = at(63);
  const s200 = c.length >= 200 ? c.slice(-200).reduce((a, b) => a + b, 0) / 200 : null;
  return { price, ret12m: y && c.length >= 240 ? price / y - 1 : null, ret3m: q ? price / q - 1 : null, fromHigh: price / high - 1, above200: s200 ? price > s200 : null };
}

/** Sorts one stock into a candidate kind, or none. Pure. */
export function classify(symbol: string, sector: string | null, m: Metrics, spy12m: number | null, setup: ReturnType<typeof findSetup>): Candidate | null {
  const vs = m.ret12m !== null && spy12m !== null ? m.ret12m - spy12m : null;
  const base = { symbol, sector, price: m.price, ret12m: m.ret12m, vsSpy12m: vs, fromHigh: m.fromHigh };
  if (vs !== null && vs > 0.1 && m.above200 && m.fromHigh > -0.08) return { ...base, kind: "leader", score: vs, why: `${pct(m.ret12m!)} over 12 months (${pct(vs)} vs the S&P 500), ${pct(m.fromHigh)} from its high` };
  if (vs !== null && vs > 0 && m.fromHigh <= -0.12 && m.fromHigh >= -0.35) return { ...base, kind: "pullback", score: vs + 0.5 * -m.fromHigh, why: `${pct(m.fromHigh)} below its 52-week high after ${pct(m.ret12m!)} over 12 months (${pct(vs)} vs the S&P 500)` };
  if (setup && setup.direction === "up") return { ...base, kind: "setup", score: setup.score / 5, why: `${setupLabel(setup.kind)}: ${setup.why}` };
  return null;
}

/** The shortlist the AI sees: the best of each kind, at most two per sector, without excluded names. Pure. */
export function shortlist(all: Candidate[], exclude: Set<string>, perKind = 6, perSector = 2): Candidate[] {
  const out: Candidate[] = [];
  const bySector = new Map<string, number>();
  for (const kind of ["leader", "pullback", "setup"] as const) {
    let n = 0;
    for (const c of all.filter((x) => x.kind === kind && !exclude.has(x.symbol)).sort((a, b) => b.score - a.score)) {
      const k = c.sector ?? c.symbol;
      if ((bySector.get(k) ?? 0) >= perSector) continue;
      bySector.set(k, (bySector.get(k) ?? 0) + 1);
      out.push(c);
      if (++n >= perKind) break;
    }
  }
  return out;
}

export function shortlistText(list: Candidate[], scanned: number): string {
  if (!list.length) return `The app screened ${scanned} stocks and none fit (after leaving out what you hold, have researched or Radar named recently).`;
  const label = { leader: "Leader", pullback: "Pullback in a leader", setup: "Chart setup" } as const;
  return [`The app screened ${scanned} S&P 500 stocks in code (prices only). Candidates, leaving out what you hold, have researched or Radar named in the last 8 weeks:`,
    ...list.map((c) => `- ${c.symbol} (${c.sector ?? "—"}), ${label[c.kind]}: $${c.price.toFixed(2)}; ${c.why}.`)].join("\n");
}

export type EvidenceKind = "filing" | "results" | "news" | "analyst" | "fund" | "social" | "other";
export type RadarIdea = {
  symbol: string; name: string | null; idea: string; whyNow: string; risks: string[]; wouldChange: string;
  evidence: { title: string; url: string; kind: EvidenceKind; date: string | null }[];
  strength: "strong" | "worth_a_look"; fromShortlist: boolean;
  /** Locked in by the app when the idea was made. */
  price: number; vooPrice: number | null; at: string;
};

export const RADAR_SYSTEM = `You are the opportunity scout inside Portfolio Intelligence, working for one private investor whose profile, goals, portfolio and research are given below. Once a week you name at most three NEW companies worth a proper research look for a long-term holding (a year or more), and you often name none.

The bar for each idea (all must hold, or leave it out):
- A specific, checkable reason the business could be worth more than the price suggests, with a recent dated fact behind it: results, guidance, a contract, a product, a filing. "It went up" or "it fell" is not a reason.
- Why now: what changed in the last few months.
- What would make the idea wrong, stated plainly.
- Analyst ratings and targets, fund holdings (13F) and social posts are idea inputs only. Label them as such in evidence. An idea that rests only on them is never "strong".
- Before naming an idea, argue against it as a skeptic would. If the case does not survive, drop it.
- Prefer names from the app's shortlist. You may name one from outside it only with strong dated evidence, and say so.
- Never name a company the investor holds or has researched (both are listed in the context).
- This is a lead for research, not a buy recommendation. Do not size a position or give a price target.

Use web_search (a few searches at most) for the recent facts, and get_quote, get_technicals or get_fundamentals where useful.

Reply with exactly one JSON object in a \`\`\`json fenced block and nothing else:
{
  "ideas": [{
    "symbol": string,
    "name": string,
    "idea": string,                 // 2-3 sentences: what the business could be underpriced on
    "why_now": string,              // the recent dated fact
    "risks": string[],
    "would_change": string,         // what would make you drop it
    "evidence": [{ "title": string, "url": string, "kind": "filing" | "results" | "news" | "analyst" | "fund" | "social" | "other", "date": "YYYY-MM-DD" | null }],
    "strength": "strong" | "worth_a_look"
  }],
  "none_reason": string | null      // when ideas is empty: why nothing cleared the bar this week
}`;

export function radarQuestion(today: string, list: string) {
  return `Today is ${today}. This is the weekly Opportunity Radar. Name at most ${MAX_IDEAS} new long-term ideas worth researching, or none.

${list}

Check the facts with a few web searches before you answer, then reply with the JSON.`;
}

const KINDS: EvidenceKind[] = ["filing", "results", "news", "analyst", "fund", "social", "other"];
const INPUT_ONLY: EvidenceKind[] = ["analyst", "fund", "social"];

/** Checks one idea from the model. Pure: the caller supplies the price and what to exclude. */
export function validateRadarIdea(raw: unknown, ctx: { price: number | null; exclude: Set<string>; shortlist: Set<string>; vooPrice: number | null; now: Date }): { idea: RadarIdea } | { rejected: string; symbol: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const symbol = String(r.symbol ?? "").trim().toUpperCase();
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return { rejected: "no valid ticker", symbol: symbol || "?" };
  if (ctx.exclude.has(symbol)) return { rejected: "already held, researched or named recently", symbol };
  if (!ctx.price) return { rejected: "no live price", symbol };
  const idea = str(r.idea, 700), whyNow = str(r.why_now, 500);
  if (idea.length < 30 || whyNow.length < 15) return { rejected: "no specific reason or no 'why now'", symbol };
  const evidence = (Array.isArray(r.evidence) ? r.evidence : []).flatMap((e) => {
    const x = (e ?? {}) as Record<string, unknown>;
    const url = str(x.url, 500);
    if (!/^https?:\/\//.test(url)) return [];
    const kind = KINDS.includes(x.kind as EvidenceKind) ? (x.kind as EvidenceKind) : "other";
    const date = typeof x.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : null;
    return [{ title: str(x.title, 200) || url, url, kind, date }];
  }).slice(0, 8);
  if (!evidence.length) return { rejected: "no sources", symbol };
  const solid = evidence.some((e) => !INPUT_ONLY.includes(e.kind));
  if (!solid) return { rejected: "rests only on analyst, fund or social inputs", symbol };
  const strength = r.strength === "strong" ? "strong" : "worth_a_look";
  return {
    idea: {
      symbol, name: str(r.name, 120) || null, idea, whyNow,
      risks: (Array.isArray(r.risks) ? r.risks : []).map((x) => str(x, 300)).filter(Boolean).slice(0, 5),
      wouldChange: str(r.would_change, 400), evidence, strength, fromShortlist: ctx.shortlist.has(symbol),
      price: ctx.price, vooPrice: ctx.vooPrice, at: ctx.now.toISOString(),
    },
  };
}

/** How an idea has done since it was named, against VOO over the same days. Pure. */
export function ideaResult(i: Pick<RadarIdea, "price" | "vooPrice">, price: number | null, vooPrice: number | null) {
  const r = price && i.price ? price / i.price - 1 : null;
  const v = vooPrice && i.vooPrice ? vooPrice / i.vooPrice - 1 : null;
  return { returnPct: r, vooPct: v, edgePct: r !== null && v !== null ? r - v : null };
}

