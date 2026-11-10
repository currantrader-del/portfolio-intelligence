/**
 * Portfolio improvement proposals: ONE fixed strategy, "stock-to-ETF risk trim" (2026-11-10 direction).
 *
 *   Triggers (only these):  a. an individual stock above the top of its normal range in your policy
 *                              (or above its maximum when it has no range), by at least TRIGGER_MIN_PTS;
 *                           b. a completed research action plan that says Trim (to a lower target) or Exit.
 *   Size:                   back to the top of the range (a), the research target (b), or all of it (Exit).
 *   Proceeds:               a fixed ETF mix, ETF_MIX. The AI never changes the rules, the sizes or the mix;
 *                           it only reviews the candidate and may answer "No change".
 *
 * Historical evidence: only trigger (a) is a price rule, so only it is backtested (backtestCap), monthly, with
 * decisions from prices known at the time, executed at the next close, with costs and adjusted closes.
 * Research triggers cannot be tested historically: research as it stood on past dates does not exist.
 *
 * The current assessment (assess) is recomputed from today's data and NEVER from a shadow test's results.
 * Pure: no database, no network.
 */
import type { Bar } from "@/lib/market/history";
import { barOn } from "./shadow";

export const STRATEGY = { id: "stock-to-etf-trim@1", name: "Stock-to-ETF risk trim" } as const;
export const ETF_MIX = [{ symbol: "VOO", pct: 50 }, { symbol: "VXUS", pct: 25 }, { symbol: "AVUV", pct: 25 }] as const;
/** A stock must be this many percentage points over its line before a trim is considered (avoids churn). */
export const TRIGGER_MIN_PTS = 0.5;
export const TRIGGER_MIN_USD = 100;
/** Backtest: trim only when the stock is 25% above its cap (relative), back to the cap. Fixed, not optimized. */
export const BACKTEST = { band: 1.25, costRate: 0.0005, minYears: 3 } as const;
/** Research older than this needs a refresh before a proposal can stay "Still attractive". */
export const RESEARCH_STALE_DAYS = 120;

export type Trigger = "concentration" | "research_trim" | "research_exit";
export type Candidate = {
  symbol: string; trigger: Trigger[]; currentPct: number; targetPct: number; capPct: number | null;
  sellPct: number; sellShares: number; sellValue: number; price: number;
  research: { versionId: string; asOf: string; action: string | null; thesis: string | null; bull: number | null; base: number | null; bear: number | null; weighted: number | null; confidence: string | null } | null;
  planReason: string | null;
};

export type HoldingFact = { symbol: string; quantity: number; price: number; value: number; weight: number; etf: boolean };
export type ResearchFact = { symbol: string; versionId: string; asOf: string; action: string | null; thesis: string | null; confidence: string | null; scenarios: { name: string; value: number }[]; weighted: number | null; complete: boolean };
export type PlanFact = { symbol: string; action: string | null; targetPct: number | null; reason: string };

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The stocks the strategy would trim today, and by how much. Nothing is proposed without a trigger. */
export function findCandidates(a: { holdings: HoldingFact[]; total: number; capFor: (symbol: string) => { normalHigh: number | null; max: number | null }; research: ResearchFact[]; plan: PlanFact[] }): Candidate[] {
  const out: Candidate[] = [];
  for (const h of a.holdings) {
    if (h.etf || h.quantity <= 0 || h.value <= 0) continue;
    const cur = h.weight * 100;
    const caps = a.capFor(h.symbol);
    const line = caps.normalHigh ?? caps.max;
    const triggers: Trigger[] = [];
    let target = cur;
    if (line !== null && cur - line * 100 >= TRIGGER_MIN_PTS) { triggers.push("concentration"); target = Math.min(target, line * 100); }
    const r = a.research.find((x) => x.symbol === h.symbol && x.complete) ?? null;
    const p = a.plan.find((x) => x.symbol === h.symbol) ?? null;
    if (r && p?.action === "Exit") { triggers.push("research_exit"); target = 0; }
    else if (r && p?.action === "Trim" && p.targetPct !== null && p.targetPct < cur) { triggers.push("research_trim"); target = Math.min(target, p.targetPct); }
    if (!triggers.length) continue;
    const sellFrac = target <= 0 ? 1 : (cur - target) / cur;
    const sellShares = target <= 0 ? h.quantity : Math.floor(h.quantity * sellFrac * 1000) / 1000;
    const sellValue = sellShares * h.price;
    if (sellValue < TRIGGER_MIN_USD) continue;
    const sc = (n: string) => r?.scenarios.find((s) => s.name === n)?.value ?? null;
    out.push({
      symbol: h.symbol, trigger: triggers, currentPct: r1(cur), targetPct: r1(target), capPct: line === null ? null : r1(line * 100),
      sellPct: r1((sellShares / h.quantity) * 100), sellShares, sellValue: r2(sellValue), price: h.price,
      research: r ? { versionId: r.versionId, asOf: r.asOf, action: r.action, thesis: r.thesis, bull: sc("bull"), base: sc("base"), bear: sc("bear"), weighted: r.weighted, confidence: r.confidence } : null,
      planReason: p?.reason ?? null,
    });
  }
  return out.sort((x, y) => y.sellValue - x.sellValue);
}

/** What selling gives up if the research's bull case (and its base case) comes true. From the research only. */
export function upsideGivenUp(c: Candidate): { bullUsd: number | null; baseUsd: number | null } {
  const at = (v: number | null) => (v && c.price ? r2(c.sellShares * (v - c.price)) : null);
  return { bullUsd: at(c.research?.bull ?? null), baseUsd: at(c.research?.base ?? null) };
}

/** The proposal's ETF purchases: the fixed mix applied to the sale proceeds. */
export function mixBuys(proceeds: number) {
  return ETF_MIX.map((m) => ({ symbol: m.symbol, pct: m.pct, usd: r2((proceeds * m.pct) / 100) }));
}

/* ------------------------------------------------------------------ backtest */

export type Metrics = { totalReturn: number; cagr: number; maxDrawdown: number; volatility: number; returnPerRisk: number | null };
export type Backtest =
  | { symbol: string; ok: false; why: string }
  | {
      symbol: string; ok: true; from: string; to: string; years: number; capPct: number; trims: number; turnoverPerYear: number; costs: number;
      rule: Metrics; noChange: Metrics; voo: Metrics; mix: Metrics;
      /** Share of 12-month windows (monthly steps) in which the rule did at least as well as no change. */
      windowsBetter: number; windows: number;
    };

function metrics(values: number[], years: number): Metrics {
  const rets: number[] = [];
  let peak = values[0], mdd = 0;
  for (let i = 1; i < values.length; i++) {
    rets.push(values[i] / values[i - 1] - 1);
    peak = Math.max(peak, values[i]); mdd = Math.min(mdd, values[i] / peak - 1);
  }
  const total = values[values.length - 1] / values[0] - 1;
  const cagr = years > 0 ? (1 + total) ** (1 / years) - 1 : 0;
  const mean = rets.reduce((a, x) => a + x, 0) / (rets.length || 1);
  const vol = Math.sqrt(rets.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1)) * Math.sqrt(252);
  const pc = (x: number) => Math.round(x * 1000) / 10;
  return { totalReturn: pc(total), cagr: pc(cagr), maxDrawdown: pc(mdd), volatility: pc(vol), returnPerRisk: vol > 0.005 ? Math.round((cagr / vol) * 100) / 100 : null };
}

/**
 * A stylized two-part portfolio: the stock at its cap and the rest in VOO. Monthly, on the first trading day,
 * the weight is read from that day's close; if it is above cap x band, the stock is sold back to the cap at the
 * NEXT day's close and the proceeds buy the fixed ETF mix. Compared with no change, all VOO and all the mix.
 */
export function backtestCap(symbol: string, capPct: number, h: Map<string, Bar[]>): Backtest {
  const need = [symbol, ...ETF_MIX.map((m) => m.symbol)];
  for (const s of need) if (!(h.get(s)?.length)) return { symbol, ok: false, why: `no price history for ${s}` };
  const first = need.map((s) => h.get(s)![0].date).sort().pop()!;
  const dates = h.get("VOO")!.map((b) => b.date).filter((d) => d >= first);
  const years = dates.length / 252;
  if (years < BACKTEST.minYears) return { symbol, ok: false, why: `only ${r1(years)} years of history (needs ${BACKTEST.minYears})` };
  const px = (s: string, d: string) => barOn(h.get(s)!, d)!.close;
  const cap = capPct / 100, V0 = 10_000, d0 = dates[0];
  // Units in adjusted-price terms, so dividends are reinvested.
  const rule = new Map<string, number>([[symbol, (V0 * cap) / px(symbol, d0)], ["VOO", (V0 * (1 - cap)) / px("VOO", d0)]]);
  const hold = new Map(rule);
  const value = (u: Map<string, number>, d: string) => [...u].reduce((a, [s, n]) => a + n * px(s, d), 0);
  const vooU = V0 / px("VOO", d0);
  const mixU = new Map(ETF_MIX.map((m) => [m.symbol, (V0 * m.pct) / 100 / px(m.symbol, d0)]));
  const vals = { rule: [] as number[], hold: [] as number[], voo: [] as number[], mix: [] as number[] };
  let pending = false, trims = 0, traded = 0, costs = 0;
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    if (pending) {
      const tot = value(rule, d), sv = rule.get(symbol)! * px(symbol, d), excess = sv - cap * tot;
      if (excess > 0) {
        rule.set(symbol, rule.get(symbol)! - excess / px(symbol, d));
        const net = excess * (1 - 2 * BACKTEST.costRate); // a cost on the sale and on the purchases
        costs += excess - net; traded += excess; trims++;
        for (const m of ETF_MIX) rule.set(m.symbol, (rule.get(m.symbol) ?? 0) + (net * m.pct) / 100 / px(m.symbol, d));
      }
      pending = false;
    }
    if (i > 0 && d.slice(0, 7) !== dates[i - 1].slice(0, 7)) {
      const tot = value(rule, d), w = (rule.get(symbol)! * px(symbol, d)) / tot;
      if (w > cap * BACKTEST.band) pending = true;
    }
    vals.rule.push(value(rule, d)); vals.hold.push(value(hold, d)); vals.voo.push(vooU * px("VOO", d)); vals.mix.push(value(mixU, d));
  }
  // 12-month windows starting at each month start.
  const starts = dates.map((d, i) => (i === 0 || d.slice(0, 7) !== dates[i - 1].slice(0, 7) ? i : -1)).filter((i) => i >= 0);
  let windows = 0, better = 0;
  for (const s of starts) {
    const e = s + 252;
    if (e >= dates.length) break;
    windows++;
    if (vals.rule[e] / vals.rule[s] >= vals.hold[e] / vals.hold[s] - 1e-9) better++;
  }
  const avg = vals.rule.reduce((a, x) => a + x, 0) / vals.rule.length;
  return {
    symbol, ok: true, from: d0, to: dates[dates.length - 1], years: r1(years), capPct, trims, turnoverPerYear: Math.round((traded / avg / years) * 1000) / 10, costs: r2(costs),
    rule: metrics(vals.rule, years), noChange: metrics(vals.hold, years), voo: metrics(vals.voo, years), mix: metrics(vals.mix, years),
    windowsBetter: windows ? Math.round((better / windows) * 100) : 0, windows,
  };
}

export type Evidence = { tested: Backtest[]; summary: string; limits: string[] };

/** One plain summary across every stock tested, with the limits that always apply. */
export function summarizeEvidence(tested: Backtest[], hasResearchTrigger: boolean): Evidence {
  const ok = tested.filter((b): b is Extract<Backtest, { ok: true }> => b.ok);
  const limits = [
    "Survivorship bias: only stocks you hold today were tested, and stocks that failed or were delisted are missing.",
    "A stylized portfolio (the stock at its cap, the rest in VOO), not your real history.",
    "Past results do not show what will happen next.",
  ];
  if (hasResearchTrigger) limits.unshift("The research-based part of this proposal cannot be backtested: research as it stood on past dates does not exist.");
  if (!ok.length) return { tested, summary: "Not enough reliable history to test the concentration rule, so there is no historical evidence for or against it.", limits };
  const lessDd = ok.filter((b) => b.rule.maxDrawdown > b.noChange.maxDrawdown + 0.05).length;
  const moreRet = ok.filter((b) => b.rule.cagr > b.noChange.cagr + 0.05).length;
  const betterRisk = ok.filter((b) => (b.rule.returnPerRisk ?? -9) > (b.noChange.returnPerRisk ?? -9) + 0.005).length;
  const beatVoo = ok.filter((b) => b.rule.cagr > b.voo.cagr).length;
  const yrs = Math.min(...ok.map((b) => b.years));
  return {
    tested,
    summary: `Over ${yrs}+ years on ${ok.length} of your stocks, trimming back to the cap reduced the worst drop in ${lessDd}, raised the yearly return in ${moreRet}, and improved return per unit of risk in ${betterRisk}. The trimmed portfolio beat all-VOO in ${beatVoo} of ${ok.length}.`,
    limits,
  };
}

/* ------------------------------------------------------------------ assessment */

export type AssessmentStatus = "Still attractive" | "No longer attractive" | "More research needed";
export type Assessment = { status: AssessmentStatus; reasons: string[]; at: string };

/**
 * Today's view of a proposal, from today's weights, research and plan. A shadow test's gains or losses are
 * deliberately not an input: recent performance is not a reason to act.
 */
export function assess(p: { candidates: Pick<Candidate, "symbol" | "trigger" | "research">[] }, now: { at: Date; weightPct: (s: string) => number | null; capPct: (s: string) => number | null; research: (s: string) => { versionId: string; asOf: string; complete: boolean } | null; planAction: (s: string) => string | null }): Assessment {
  const reasons: string[] = [];
  let holds = 0, needs = 0;
  for (const c of p.candidates) {
    const w = now.weightPct(c.symbol), cap = now.capPct(c.symbol), r = now.research(c.symbol), act = now.planAction(c.symbol);
    const conc = c.trigger.includes("concentration") && w !== null && cap !== null && w - cap >= TRIGGER_MIN_PTS;
    const res = (c.trigger.includes("research_trim") || c.trigger.includes("research_exit")) && (act === "Trim" || act === "Exit");
    if (w === null || w <= 0) { reasons.push(`${c.symbol} is no longer held`); continue; }
    if (conc) reasons.push(`${c.symbol} is still above its ${cap}% line (${w}%)`);
    if (res) reasons.push(`the plan still says ${act} ${c.symbol}`);
    if (conc || res) holds++;
    else reasons.push(`${c.symbol}: the reason for the trim no longer applies${act ? ` (plan now: ${act})` : ""}`);
    if (r && c.research && r.versionId !== c.research.versionId) { needs++; reasons.push(`${c.symbol} has newer research than the proposal; review it`); }
    if (r && (now.at.getTime() - Date.parse(r.asOf)) / 86_400_000 > RESEARCH_STALE_DAYS) { needs++; reasons.push(`${c.symbol} research is over ${RESEARCH_STALE_DAYS} days old`); }
    if (c.research && (!r || !r.complete)) { needs++; reasons.push(`${c.symbol} no longer has a completed investigation`); }
  }
  const status: AssessmentStatus = holds === 0 ? "No longer attractive" : needs > 0 ? "More research needed" : "Still attractive";
  return { status, reasons, at: now.at.toISOString() };
}

/* ------------------------------------------------------------------ AI review */

export const REVIEW_MODEL = { id: "claude-sonnet-5-5", inPerM: 2, outPerM: 10 };
export const REVIEW_SYSTEM = `You review ONE proposed portfolio change for a private long-term investor whose goal is to beat the S&P 500 over the long term while managing downside and concentration risk. The app's fixed strategy ("Stock-to-ETF risk trim") produced the proposal from rules: the stocks, share quantities and the ETF mix are fixed; you may not change them, add trades or suggest other ETFs.

Decide whether the proposal is genuinely worth the investor's review, or whether "No change" is the better answer. No change is a fully valid verdict: do not approve a change to create activity. Judge the forward-looking case only: valuation against the research scenarios, the thesis, fundamentals and risks in the research given, concentration, and what the sold shares could still earn. Never use recent performance of any shadow test as a reason. Use only the facts given; say when something important is missing.

Reply with exactly one JSON object in a \`\`\`json fenced block and nothing else:
{ "verdict": "Worth reviewing" | "No change",
  "reason": string,            // 2-3 plain sentences: why risk/reward improves (or why no change is better)
  "upside_given_up": string,   // 1-2 sentences: what the investor gives up if the stock does well, using the research scenarios given
  "invalidation": string,      // 1-2 sentences: what would make this proposal unattractive or wrong
  "risk_effect": string,       // 1 sentence: what happens to concentration and downside
  "confidence": "low" | "medium" | "high" }`;

export type Review = { verdict: "Worth reviewing" | "No change"; reason: string; upsideGivenUp: string; invalidation: string; riskEffect: string; confidence: "low" | "medium" | "high" };

export function reviewQuestion(a: { candidates: Candidate[]; proceeds: number; total: number; evidence: Evidence; largest: { symbol: string; pct: number }[]; market: string | null }) {
  const lines = a.candidates.map((c) => {
    const u = upsideGivenUp(c);
    const r = c.research;
    return [
      `- ${c.symbol}: weight ${c.currentPct}% (line ${c.capPct ?? "none"}%), sell ${c.sellShares} shares (${c.sellPct}% of the holding, $${Math.round(c.sellValue)}) at about $${c.price}, to ${c.targetPct}%. Triggers: ${c.trigger.join(", ")}.`,
      r ? `  Research ${r.asOf}: action ${r.action ?? "n/a"}, confidence ${r.confidence ?? "n/a"}; scenarios bear ${r.bear ?? "n/a"} / base ${r.base ?? "n/a"} / bull ${r.bull ?? "n/a"}, weighted ${r.weighted ?? "n/a"}. Thesis: ${r.thesis ?? "n/a"}` : "  No completed research on file.",
      c.planReason ? `  Plan: ${c.planReason}` : "",
      u.bullUsd !== null ? `  If the bull case happens, the sold shares would gain about $${Math.round(u.bullUsd)} more (base case: $${u.baseUsd === null ? "n/a" : Math.round(u.baseUsd)}).` : "",
    ].filter(Boolean).join("\n");
  });
  return `Proposal: sell the stock below and buy ${mixBuys(a.proceeds).map((m) => `${m.symbol} ${m.pct}% ($${Math.round(m.usd)})`).join(", ")} with the $${Math.round(a.proceeds)} proceeds. Portfolio $${Math.round(a.total)}; largest positions ${a.largest.map((x) => `${x.symbol} ${x.pct}%`).join(", ")}.
${lines.join("\n")}
Historical evidence (concentration rule only): ${a.evidence.summary} Limits: ${a.evidence.limits.join(" ")}
Market view from the latest plan: ${a.market ?? "not available"}.`;
}

const str = (v: unknown, max = 800) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export function validateReview(raw: unknown): Review | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const verdict = o.verdict === "Worth reviewing" ? "Worth reviewing" : o.verdict === "No change" ? "No change" : null;
  if (!verdict || !str(o.reason)) return null;
  const confidence = o.confidence === "high" || o.confidence === "medium" ? o.confidence : "low";
  return { verdict, reason: str(o.reason), upsideGivenUp: str(o.upside_given_up), invalidation: str(o.invalidation), riskEffect: str(o.risk_effect, 400), confidence };
}

/** The same candidates (stocks and rough size) as an earlier proposal: reviewed again only when research changed. */
export function sameCandidates(a: Pick<Candidate, "symbol" | "sellPct" | "research">[], b: Pick<Candidate, "symbol" | "sellPct" | "research">[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x) => { const y = b.find((z) => z.symbol === x.symbol); return !!y && Math.abs(y.sellPct - x.sellPct) < 10 && (y.research?.versionId ?? null) === (x.research?.versionId ?? null); });
}
