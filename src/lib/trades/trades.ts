/**
 * Short-term trade ideas, held to a high bar and scored honestly. Pure: the instructions, the checks
 * a proposed idea must pass, how an open paper trade is marked and closed, and the scoreboard against
 * simply holding VOO over the same days. The job (job.ts) does the searching, pricing and storing.
 *
 * Not day trading: at most two ideas per search, "no trade" is the expected answer, holding periods of
 * one week to six months, long stock or bought calls/puts only (no shorting, no selling options).
 */
export const TRADE_VERSION = "trade-idea@1";
export const TRADE_LIMITS = { turns: 16, searches: 8, ms: 9 * 60_000, maxTokens: 12000 };
/** What VOO is assumed to earn per year; an idea must clear the same days of this, plus a margin. */
export const VOO_YEARLY = 0.07;
export const EDGE_MARGIN = 0.03;
export const MIN_DAYS = 5, MAX_DAYS = 185;

export type Confidence = "medium" | "high";
export type OptionLeg = { type: "call" | "put"; strike: number; expiry: string; contract: string; estPremium: number | null };
export type TradeIdea = {
  symbol: string; instrument: "stock" | "option"; option: OptionLeg | null;
  direction: "up" | "down";
  entryRef: number; target: number; stop: number; endDate: string;
  confidence: Confidence; probability: number;
  thesis: string; whyNow: string; risks: string[]; wouldChange: string;
  sizeUsd: number | null; sources: { title: string; url: string }[];
  /** Computed by the app, not the model. */
  expectedPct: number; hurdlePct: number; rewardRisk: number;
};

export const TRADE_SYSTEM = `You are the trade scout inside Portfolio Intelligence, working for one private investor whose profile, goals, portfolio, cash, policy and research are given below. Your job is to find, at most, the one or two best short-term trades available right now, and far more often to conclude that there is none worth taking.

The bar (all must hold, or propose nothing):
- The investor's goal is to beat simply holding VOO, or cash in savings. A trade must beat VOO over the same days by a clear margin after accounting for the chance it fails. Few trades a year; this is not day trading.
- A specific, checkable reason it should work within one week to six months: a catalyst with a date (earnings, a product, a ruling, an index change), a mispricing the evidence shows, or a technical setup that confirms a fundamental view. "It fell a lot" is not a reason.
- Confidence medium or high, stated honestly with a probability of reaching the target before the stop.
- A defined entry, target and stop on the stock price, and an end date. Reward at least 1.5x the risk.
- Prefer companies with research on file; use get_research, get_quote, get_technicals, get_filings, get_fundamentals, and web_search for the catalyst, the date and the consensus.
- Instruments: buying the stock, or buying a call or put (never selling options, never shorting). Choose an option only when it clearly suits the setup (a dated catalyst, defined risk); pick a real listed monthly expiry after the end date, and a strike near the money. Options can lose 100%; say so in risks.
- Before you propose anything, argue against it as a skeptic would. If the case does not survive, drop it.

Reply with exactly one JSON object in a \`\`\`json fenced block and nothing else:
{
  "ideas": [{
    "symbol": string,
    "instrument": "stock" | "option",
    "option": { "type": "call" | "put", "strike": number, "expiry": "YYYY-MM-DD", "est_premium": number | null } | null,
    "entry_price": number,          // the stock price now, the reference for target and stop
    "target_price": number,         // stock price that means the idea worked
    "stop_price": number,           // stock price that means it failed
    "end_date": "YYYY-MM-DD",       // when the idea is over if neither is hit
    "confidence": "medium" | "high",
    "probability": number,          // 0-1, chance of target before stop
    "thesis": string,               // 2-4 sentences
    "why_now": string,              // the catalyst and its date
    "risks": string[],
    "would_change": string,         // what would make you drop it
    "size_usd": number | null,      // a sensible size given cash, reserve and limits
    "sources": [{ "title": string, "url": string }]
  }],
  "none_reason": string | null      // when ideas is empty: why nothing clears the bar today
}`;

export function tradeQuestion(today: string, focus?: string | null) {
  return `Today is ${today}. Look for the best short-term trade available now${focus ? `, starting with ${focus}` : " across my holdings, my researched companies and anything the market briefing points to"}. Propose at most two, and none unless one clearly clears the bar.`;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);

/** OCC option symbol, as quote services use it: NVDA261218C00150000. */
export function occSymbol(symbol: string, expiry: string, type: "call" | "put", strike: number) {
  return `${symbol.toUpperCase()}${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}${type === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

/**
 * Checks one proposed idea against the bar. The app recomputes the numbers itself; the model's
 * confidence is not enough. `price` is the app's own quote for the stock, when it has one.
 */
export function validateIdea(raw: unknown, ctx: { today: string; price: number | null }): { idea: TradeIdea } | { rejected: string; symbol: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const symbol = str(r.symbol).toUpperCase();
  const no = (why: string) => ({ rejected: why, symbol: symbol || "?" });
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return no("no valid symbol");
  const instrument = r.instrument === "option" ? "option" : r.instrument === "stock" ? "stock" : null;
  if (!instrument) return no("instrument must be stock or option");
  const entryRef = ctx.price ?? num(r.entry_price);
  const target = num(r.target_price), stop = num(r.stop_price);
  if (!entryRef || !target || !stop || entryRef <= 0) return no("entry, target and stop are required");
  const modelEntry = num(r.entry_price);
  if (ctx.price && modelEntry && Math.abs(modelEntry / ctx.price - 1) > 0.05) return no(`the idea was written for $${modelEntry}, but the stock is at $${ctx.price.toFixed(2)}`);

  let option: OptionLeg | null = null;
  if (instrument === "option") {
    const o = (r.option ?? {}) as Record<string, unknown>;
    const type = o.type === "call" || o.type === "put" ? o.type : null;
    const strike = num(o.strike), expiry = str(o.expiry);
    if (!type || !strike || strike <= 0 || !isDate(expiry)) return no("option needs a type, strike and expiry");
    const wd = new Date(`${expiry}T12:00:00Z`).getUTCDay();
    if (wd !== 5 && wd !== 4) return no("option expiry must be a listed Friday (or Thursday before a holiday)");
    if (Math.abs(strike / entryRef - 1) > 0.25) return no("option strike is too far from the stock price");
    option = { type, strike, expiry, contract: occSymbol(symbol, expiry, type, strike), estPremium: num(o.est_premium) };
  }
  const direction: "up" | "down" = option?.type === "put" ? "down" : "up";
  if (direction === "up" ? !(target > entryRef && stop < entryRef) : !(target < entryRef && stop > entryRef)) return no("target and stop are on the wrong sides of the price");

  const endDate = str(r.end_date);
  if (!isDate(endDate)) return no("no end date");
  const hold = days(ctx.today, endDate);
  if (hold < MIN_DAYS || hold > MAX_DAYS) return no(`holding period of ${hold} days is outside ${MIN_DAYS}-${MAX_DAYS}`);
  if (option && option.expiry < endDate) return no("option expires before the idea ends");

  const confidence = r.confidence === "high" || r.confidence === "medium" ? r.confidence : null;
  if (!confidence) return no("confidence is below medium");
  const probability = num(r.probability);
  if (probability === null || probability <= 0 || probability >= 1) return no("no probability");

  // The numbers that decide it, on the stock price (an option magnifies both sides).
  const up = Math.abs(target / entryRef - 1), down = Math.abs(stop / entryRef - 1);
  const rewardRisk = up / down;
  const expectedPct = probability * up - (1 - probability) * down;
  const hurdlePct = VOO_YEARLY * (hold / 365) + EDGE_MARGIN;
  if (rewardRisk < 1.5) return no(`reward is only ${rewardRisk.toFixed(1)}x the risk`);
  if (expectedPct < hurdlePct) return no(`expected ${(expectedPct * 100).toFixed(1)}% does not beat VOO plus margin (${(hurdlePct * 100).toFixed(1)}%) over ${hold} days`);

  const sources = (Array.isArray(r.sources) ? r.sources : []).map((s) => ({ title: str((s as Record<string, unknown>)?.title), url: str((s as Record<string, unknown>)?.url) })).filter((s) => /^https?:\/\//.test(s.url));
  if (sources.length < 2) return no("fewer than two sources");
  const thesis = str(r.thesis), whyNow = str(r.why_now);
  if (thesis.length < 40 || whyNow.length < 15) return no("thesis or catalyst is missing");
  const risks = (Array.isArray(r.risks) ? r.risks : []).map(str).filter(Boolean).slice(0, 6);
  if (option && !risks.some((x) => /100%|whole premium|expire.*worthless|worthless/i.test(x))) risks.push("The option can expire worthless: the whole premium can be lost.");

  return { idea: { symbol, instrument, option, direction, entryRef, target, stop, endDate, confidence, probability, thesis, whyNow, risks, wouldChange: str(r.would_change), sizeUsd: num(r.size_usd), sources: sources.slice(0, 8), expectedPct, hurdlePct, rewardRisk } };
}

/** What was locked in when the idea was made. */
export type Entry = { at: string; underlying: number; premium: number | null; premiumSource: "quote" | "estimate" | null; voo: number | null };
export type Mark = { underlying: number | null; premium: number | null; voo: number | null; today: string };
export type Status = "open" | "target" | "stop" | "ended";
export type Result = { status: Status; returnPct: number | null; vooPct: number | null; edgePct: number | null; underlyingPct: number | null; priced: "live" | "intrinsic" | "none" };

/** Value of an option at expiry, per share. */
export const intrinsic = (o: Pick<OptionLeg, "type" | "strike">, underlying: number) => Math.max(0, o.type === "call" ? underlying - o.strike : o.strike - underlying);

/**
 * Marks an open paper trade and says whether it is over. Exits are checked when the app looks (every
 * 30 minutes in market hours), so a gap through the stop closes at the price seen, as it would for real.
 */
export function evaluate(idea: TradeIdea, entry: Entry, m: Mark): Result {
  const u = m.underlying;
  let status: Status = "open";
  if (u !== null) {
    const hitT = idea.direction === "up" ? u >= idea.target : u <= idea.target;
    const hitS = idea.direction === "up" ? u <= idea.stop : u >= idea.stop;
    status = hitT ? "target" : hitS ? "stop" : "open";
  }
  const lastDay = idea.option && idea.option.expiry < idea.endDate ? idea.option.expiry : idea.endDate;
  if (status === "open" && m.today > lastDay) status = "ended";
  const underlyingPct = u !== null ? u / entry.underlying - 1 : null;
  let returnPct: number | null = null, priced: Result["priced"] = "none";
  if (idea.instrument === "stock") { returnPct = underlyingPct; priced = u !== null ? "live" : "none"; }
  else if (idea.option && entry.premium) {
    const expired = m.today >= idea.option.expiry;
    if (expired && u !== null) { returnPct = intrinsic(idea.option, u) / entry.premium - 1; priced = "intrinsic"; }
    else if (m.premium !== null) { returnPct = m.premium / entry.premium - 1; priced = "live"; }
  }
  const vooPct = m.voo !== null && entry.voo ? m.voo / entry.voo - 1 : null;
  return { status, returnPct, vooPct, edgePct: returnPct !== null && vooPct !== null ? returnPct - vooPct : null, underlyingPct, priced };
}

/** Closed paper trades against VOO over the same days. */
export function scoreboard(closed: { result: Result; sizeUsd: number | null }[]) {
  const scored = closed.filter((c) => c.result.returnPct !== null && c.result.vooPct !== null);
  const n = scored.length;
  const avg = (f: (c: (typeof scored)[number]) => number) => (n ? scored.reduce((s, c) => s + f(c), 0) / n : null);
  const size = (c: (typeof scored)[number]) => c.sizeUsd ?? 1000;
  return {
    closed: closed.length, scored: n,
    beatVoo: scored.filter((c) => c.result.edgePct! > 0).length,
    hitTarget: closed.filter((c) => c.result.status === "target").length,
    avgReturnPct: avg((c) => c.result.returnPct!), avgVooPct: avg((c) => c.result.vooPct!), avgEdgePct: avg((c) => c.result.edgePct!),
    /** Dollars gained versus putting the same amount in VOO, at the suggested sizes ($1,000 when none). */
    edgeUsd: scored.reduce((s, c) => s + size(c) * c.result.edgePct!, 0),
  };
}
