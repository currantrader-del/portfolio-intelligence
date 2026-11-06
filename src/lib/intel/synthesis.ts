/**
 * The briefing's written synthesis: what matters today, a short-term and a long-term outlook that
 * are assessed separately, and what it means for the portfolio. Every statement points at the
 * evidence it rests on (desk items, snapshot rows, macro series), and references that do not
 * exist are removed and reported. It never recommends buying; the most it asks is a review.
 */
import type { DeskResult } from "./desks";
import { fmtChange } from "./desks";
import type { Snapshot } from "./snapshot";

export const SYNTHESIS_VERSION = "synthesis@1";

export type Ref = string; // "W1" desk item, "C3" calendar event, "S:^GSPC" snapshot row, "F:DGS10" macro series
export type Point = { text: string; refs: Ref[] };
export type Stance = "bullish" | "neutral" | "bearish" | "mixed";
export type Scenario = { summary: string; conditions: string[]; signposts: string[] };
export type Synthesis = {
  headline: string;
  summary: Point[];
  attention: Point[];
  shortTerm: { stance: Stance; evidence: "weak" | "moderate" | "strong"; drivers: Point[]; contrary: Point[]; wouldChange: string[] };
  longTerm: { stance: Stance; evidence: "weak" | "moderate" | "strong"; base: Scenario; bull: Scenario; bear: Scenario; contrary: Point[]; wouldChange: string[] };
  portfolio: { subject: string; text: string; action: "none" | "monitor" | "research" | "review"; refs: Ref[] }[];
  gaps: string[];
};

export type PortfolioContext = {
  quality: string; // e.g. "Estimated, based on last statement holdings"
  holdings: { symbol: string; weight: number; bucket: string; research: string | null; limit: string | null }[];
  cashNote: string | null;
  upcoming: string[];
};

const point = { type: "object", additionalProperties: false, required: ["text", "refs"], properties: { text: { type: "string" }, refs: { type: "array", items: { type: "string" } } } };
const scenario = { type: "object", additionalProperties: false, required: ["summary", "conditions", "signposts"], properties: { summary: { type: "string" }, conditions: { type: "array", items: { type: "string" } }, signposts: { type: "array", items: { type: "string" } } } };
const stance = { type: "string", enum: ["bullish", "neutral", "bearish", "mixed"] };
const evidence = { type: "string", enum: ["weak", "moderate", "strong"] };
export const SYNTHESIS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["headline", "summary", "attention", "shortTerm", "longTerm", "portfolio", "gaps"],
  properties: {
    headline: { type: "string" },
    summary: { type: "array", items: point },
    attention: { type: "array", items: point },
    shortTerm: { type: "object", additionalProperties: false, required: ["stance", "evidence", "drivers", "contrary", "wouldChange"], properties: { stance, evidence, drivers: { type: "array", items: point }, contrary: { type: "array", items: point }, wouldChange: { type: "array", items: { type: "string" } } } },
    longTerm: { type: "object", additionalProperties: false, required: ["stance", "evidence", "base", "bull", "bear", "contrary", "wouldChange"], properties: { stance, evidence, base: scenario, bull: scenario, bear: scenario, contrary: { type: "array", items: point }, wouldChange: { type: "array", items: { type: "string" } } } },
    portfolio: { type: "array", items: { type: "object", additionalProperties: false, required: ["subject", "text", "action", "refs"], properties: { subject: { type: "string" }, text: { type: "string" }, action: { type: "string", enum: ["none", "monitor", "research", "review"] }, refs: { type: "array", items: { type: "string" } } } } },
    gaps: { type: "array", items: { type: "string" } },
  },
};

export function synthesisSystem() {
  return `You write the daily market briefing for one private investor, as a careful private-wealth adviser would. You are given the app's market snapshot (authoritative numbers), US macro data from FRED, research-desk items found by web search (each with an id and sources), a calendar, and the investor's portfolio context.

Rules:
- Use only the evidence given. Do not introduce numbers, events, quotes or expectations that are not in it. If evidence is missing, say what is missing.
- Every summary, attention, driver and contrary point must cite the ids it rests on in "refs": desk items (e.g. "W2", "U1", "M4"), calendar events ("C3"), snapshot rows ("S:^GSPC") or macro series ("F:DGS10"). Items marked UNSOURCED may be mentioned only as unconfirmed.
- Keep reported facts, statistics, interpretations and speculation distinct in your wording ("reported", "the data show", "one explanation is", "it is possible that").
- Do not explain a market move unless a desk item links the cause to the move; otherwise say the cause is not established.
- Short-term outlook covers 1-20 trading days: trend, breadth, volatility, rotation, upcoming releases, positioning and sentiment where evidence exists. Long-term covers about 6-36 months: growth, policy, inflation, earnings, valuation, credit, investment cycles, structural themes, geopolitics. Assess them independently; they may disagree. State a stance and how strong the evidence is. Do not give probabilities or price targets, and do not imply direction can be predicted reliably.
- Portfolio implications: refer to holdings by symbol. Use "action" none, monitor, research or review only. Never recommend buying, adding, selling or trimming, and never treat a price drop or room under a limit as a reason to buy. Holdings values are estimates unless the context says verified.
- Plain, direct English. Short sentences. Headline: one sentence on the single most important thing today.

Reply with exactly one JSON object in a \`\`\`json fenced block and nothing else. Shape (a Point is {"text": string, "refs": string[]}; a Scenario is {"summary": string, "conditions": string[], "signposts": string[]}):
{
  "headline": string,
  "summary": Point[3-6],
  "attention": Point[0-4],
  "shortTerm": {"stance": "bullish"|"neutral"|"bearish"|"mixed", "evidence": "weak"|"moderate"|"strong", "drivers": Point[], "contrary": Point[], "wouldChange": string[]},
  "longTerm": {"stance": same values, "evidence": same values, "base": Scenario, "bull": Scenario, "bear": Scenario, "contrary": Point[], "wouldChange": string[]},
  "portfolio": [{"subject": symbol or theme, "text": string, "action": "none"|"monitor"|"research"|"review", "refs": string[]}],
  "gaps": string[]
}`;
}

export function synthesisPrompt(ctx: { now: Date; snapshot: Snapshot; desks: DeskResult[]; portfolio: PortfolioContext }) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ctx.now);
  const s = ctx.snapshot;
  const rows = s.rows.map((r) => `S:${r.symbol} ${r.label}: ${r.kind === "yield" ? `${r.last.toFixed(2)}%` : r.last.toFixed(2)}; day ${fmtChange(r.day, r.kind)}, 1w ${fmtChange(r.week, r.kind)}, 1m ${fmtChange(r.month, r.kind)}, ytd ${fmtChange(r.ytd, r.kind)}${r.vs200d != null ? `, vs 200-day ${fmtChange(r.vs200d, "price")}` : ""} [${r.freshness} ${r.marketTime}]`).join("\n");
  const b = s.breadth;
  const breadth = b ? `Sector breadth: ${b.sectorsUp}/${b.sectorsTotal} sectors up today; ${b.sectorsAbove50d}/${b.sectorsTotal} above their 50-day average; ${b.sectorsAbove200d}/${b.sectorsTotal} above their 200-day average; equal-weight minus cap-weight S&P 500 over 1 month ${fmtChange(b.equalVsCapMonth, "price")}; Russell 2000 minus S&P 500 over 1 month ${fmtChange(b.smallVsLargeMonth, "price")}.` : "Sector breadth unavailable.";
  const macro = s.macro.map((m) => `F:${m.id} ${m.label}: ${m.value.toFixed(2)}${m.unit === "%" ? "%" : m.unit === "k" ? "k" : ""} (${m.date})${m.previous != null ? `, previous ${m.previous.toFixed(2)} (${m.previousDate})` : ""}`).join("\n");
  const items = ctx.desks.flatMap((d) => d.items.map((it, i) => `${d.desk[0].toUpperCase()}${i + 1} [${d.title}; ${it.kind}; ${it.significance}${it.unsourced ? "; UNSOURCED" : ""}] ${it.headline}: ${it.detail}${it.portfolio ? ` Portfolio note: ${it.portfolio}` : ""} Sources: ${it.sources.map((x) => `${x.publisher ?? ""} ${x.published ?? "undated"}`).join("; ")}`)).join("\n");
  const cal = mergedCalendar(ctx.desks).map((c, i) => `C${i + 1} ${c.date}${c.time ? ` ${c.time}` : ""} ${c.event} [${c.type}, ${c.status}]${c.expectation ? ` expectation: ${c.expectation}` : ""}${c.symbols.length ? ` (${c.symbols.join(", ")})` : ""}`).join("\n");
  const missing = [...s.missing, ...s.macroMissing, ...ctx.desks.flatMap((d) => d.uncertainties)];
  const p = ctx.portfolio;
  return `Now: ${day} (New York).

MARKET SNAPSHOT (app data feed)
${rows}
${breadth}

US MACRO (FRED; each value has its observation date)
${macro || "unavailable"}

DESK ITEMS
${items || "none"}

CALENDAR
${cal || "none"}

PORTFOLIO (${p.quality})
${p.holdings.map((h) => `${h.symbol}: ${(h.weight * 100).toFixed(1)}% of portfolio, ${h.bucket}${h.limit ? `, limit ${h.limit}` : ""}${h.research ? `, research ${h.research}` : ""}`).join("\n")}
${p.cashNote ?? ""}
App-tracked events: ${p.upcoming.join("; ") || "none"}

NOT AVAILABLE OR UNCONFIRMED
${missing.join("\n") || "nothing reported"}`;
}

/** Desk calendars merged, de-duplicated by date and event name. */
export function mergedCalendar(desks: DeskResult[]) {
  const seen = new Set<string>();
  return desks.flatMap((d) => d.calendar)
    .filter((c) => { const k = `${c.date}|${c.event.toLowerCase().replace(/[^a-z0-9]/g, "")}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
}

const BUY_WORDS = /\b(buy(?:s|ing)?|bought|add(?:s|ing)? (?:to|more)|accumulat(?:e|es|ing)|increas(?:e|es|ing) (?:the |your )?(?:position|stake|exposure)|load(?:ing)? up|trim(?:s|ming)?|reduc(?:e|es|ing) (?:the |your )?(?:position|stake))\b|\bsell(?:s|ing)?\b(?!-?off)|\bsold\b/i;

export function validateSynthesis(raw: unknown, ctx: { snapshot: Snapshot; desks: DeskResult[] }): { synthesis: Synthesis; problems: string[] } {
  const problems: string[] = [];
  const known = new Set<string>([
    ...ctx.desks.flatMap((d) => d.items.map((_, i) => `${d.desk[0].toUpperCase()}${i + 1}`)),
    ...mergedCalendar(ctx.desks).map((_, i) => `C${i + 1}`),
    ...ctx.snapshot.rows.map((r) => `S:${r.symbol}`),
    ...ctx.snapshot.macro.map((m) => `F:${m.id}`),
  ]);
  const o = (raw ?? {}) as Record<string, unknown>;
  if (!raw) problems.push("The synthesis was not readable JSON");
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const strs = (v: unknown) => list(v).map(s).filter(Boolean);
  const points = (v: unknown, where: string, needRefs: boolean): Point[] => list(v).flatMap((x) => {
    const p = x as Record<string, unknown>;
    const text = s(p.text);
    if (!text) return [];
    const refs = strs(p.refs);
    const good = refs.filter((r) => known.has(r));
    if (good.length < refs.length) problems.push(`${where}: removed unknown references ${refs.filter((r) => !known.has(r)).join(", ")}`);
    if (needRefs && !good.length) problems.push(`${where}: "${text.slice(0, 60)}" cites no evidence`);
    return [{ text, refs: good }];
  });
  const stanceOf = (v: unknown): Stance => (["bullish", "neutral", "bearish", "mixed"].includes(v as string) ? (v as Stance) : "mixed");
  const evOf = (v: unknown) => (v === "strong" || v === "moderate" ? v : "weak") as "weak" | "moderate" | "strong";
  const scen = (v: unknown): Scenario => { const x = (v ?? {}) as Record<string, unknown>; return { summary: s(x.summary), conditions: strs(x.conditions), signposts: strs(x.signposts) }; };
  const st = (o.shortTerm ?? {}) as Record<string, unknown>;
  const lt = (o.longTerm ?? {}) as Record<string, unknown>;
  const portfolio = list(o.portfolio).flatMap((x) => {
    const p = x as Record<string, unknown>;
    const text = s(p.text);
    if (!text) return [];
    let action = (["none", "monitor", "research", "review"].includes(p.action as string) ? p.action : "review") as Synthesis["portfolio"][number]["action"];
    if (BUY_WORDS.test(text) && !/\b(not|no|never|don't|do not)\b[^.]*\b(buy|add|trim|sell|reduc)/i.test(text)) {
      problems.push(`Portfolio note on ${s(p.subject)} used trade language; marked for review instead`);
      action = "review";
    }
    return [{ subject: s(p.subject) || "Portfolio", text, action, refs: strs(p.refs).filter((r) => known.has(r)) }];
  });
  const synthesis: Synthesis = {
    headline: s(o.headline) || "Briefing",
    summary: points(o.summary, "Summary", true),
    attention: points(o.attention, "Attention", true),
    shortTerm: { stance: stanceOf(st.stance), evidence: evOf(st.evidence), drivers: points(st.drivers, "Short-term drivers", true), contrary: points(st.contrary, "Short-term contrary evidence", true), wouldChange: strs(st.wouldChange) },
    longTerm: { stance: stanceOf(lt.stance), evidence: evOf(lt.evidence), base: scen(lt.base), bull: scen(lt.bull), bear: scen(lt.bear), contrary: points(lt.contrary, "Long-term contrary evidence", true), wouldChange: strs(lt.wouldChange) },
    portfolio,
    gaps: strs(o.gaps),
  };
  return { synthesis, problems };
}
