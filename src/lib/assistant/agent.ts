/**
 * The research assistant: one Claude conversation that already knows the investor (portfolio, policy,
 * research, decisions, latest briefing) and decides for itself what to look up, for any ticker, with
 * the app's data tools plus web search. Runs as a background job, so deep questions are not cut off
 * by the 60-second request limit. Every answer stores its steps, timing, tokens and cost.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace } from "@/lib/workspace-core";
import { runTool, TOOLS } from "./tools";
import { investorContext } from "./context";
import { getHistory } from "@/lib/market/history";
import { htmlText } from "@/lib/intel/verify";
import type { Briefing } from "@/lib/intel/jobs";
import type { DeskResult } from "@/lib/intel/desks";

export const AGENT_VERSION = "assistant@2";
export const MODELS = {
  standard: { id: "claude-sonnet-5-5", effort: "medium" as const, inPerM: 2, outPerM: 10 },
  deep: { id: "claude-opus-5-5", effort: "high" as const, inPerM: 4, outPerM: 20 },
};
const PER_SEARCH = 0.01;
/** Cost controls per question. */
export const LIMITS = { turns: 14, searches: 8, ms: 8 * 60_000, maxTokens: 12000 };

export type Step = { tool: string; input: unknown; ok: boolean; ms: number; preview: string };
export type AgentAnswer = {
  version: string; mode: "app" | "baseline"; question: string; answer: string; model: string;
  ms: number; turns: number; searches: number; steps: Step[];
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
  costUsd: number; contextBriefingId: string | null; stopped: string | null;
};

export const SYSTEM = `You are the investment research assistant inside Portfolio Intelligence, working for one private investor. Below the rules you get their current portfolio, accounts, cash, protected reserve, policy limits, stored research, recent decisions and the latest market briefing. Use that context without being asked; never ask them to paste their portfolio.

How to work:
- Decide yourself what evidence the question needs, fetch it, then reason. Do not ask the investor which company or source to look at.
- Market context: start from the latest briefing in the context (call get_briefing for its evidence). Search the web for markets only when the briefing is older than a few hours or does not cover the question.
- Any ticker, researched or not: get_quote and get_technicals for price and trend; get_fundamentals for reported financials; get_filings for recent SEC filings, then read_document on the ones that matter (an 8-K's press release exhibit, the 10-Q); web_search for guidance, consensus estimates, analyst views, competitive news and anything the filings do not cover. For a company the investor holds, also get_research.
- Be economical: about 2-5 searches for a normal question, more only when the question needs it. Do not repeat a lookup whose result you already have.
- Stored research is historical. Compare it with what you find now; say plainly when a thesis needs reassessment and why (new results, guidance, financing, a big price move). Never present an old call as current.

How to answer:
- Lead with the conclusion in 1-3 sentences: what happened or what you recommend. Then the reasoning, then the evidence.
- Recommendations: when the question asks what to do, give a specific recommendation (hold, add, trim, sell, hold cash, research first), with dollar amounts and where they would go, sized within the policy limits and the investor's buckets. Always compare against holding cash. Consider fundamentals, valuation versus growth, expected returns, company risks, technical context, concentration and ETF look-through, and the quality of the evidence. If the evidence is not good enough for a specific call, say exactly what is missing and what you would check, and give the best interim action.
- simulate_new_capital is the app's rule-based check. Use it, but it is an input, not the answer: if a gate fails only because research is stale, you may do the missing research now and say what you verified. Broad ETFs within their policy ranges need no company research.
- Never treat a price drop as a reason to buy by itself, and never treat room under a limit as a reason to add. Never invest the protected reserve. New cash does not have to be invested now.
- Label the kind of evidence: reported by a source (name and date), from a filing (form and date), the app's data (prices are delayed), your calculation (show it briefly), or your judgment. No invented numbers, probabilities or price targets presented as facts; if you estimate, say it is an estimate and how you got it.
- Portfolio values are estimates unless the context says the holdings are verified; say so when it matters.
- Write plainly: short paragraphs, a short list or small table when it helps, headings only for long answers. Put sources as links at the end of the relevant point.
- You cannot place trades. The investor decides.`;

const EXTRA_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_briefing",
    description: "The latest stored daily market briefing with its evidence: summary, short- and long-term outlooks, computed market observations (trend, breadth, credit, rates, volatility), portfolio notes, the official calendar, and each research item with its source and verification status. Use for 'what happened in the market' before searching the web.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_technicals",
    description: "Price trend for any ticker from daily closes (delayed): last price, returns over 1 month, 3 months, 6 months and year to date, distance from the 50- and 200-day averages and from the 52-week high and low, 20-day volatility, and 3-month performance relative to SPY.",
    input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false },
    strict: true,
  },
  {
    name: "read_document",
    description: "Reads a web page or SEC document (for example a 10-Q, 10-K, an 8-K or its press-release exhibit) and returns its text, or the passages most relevant to 'focus' when given. For an SEC filing it also lists the other documents in the same filing, so you can open the press release (usually ex99-1).",
    input_schema: { type: "object", properties: { url: { type: "string" }, focus: { type: "string", description: "What to look for, e.g. 'revenue guidance, capex, share count'. Empty for the beginning of the document." } }, required: ["url", "focus"], additionalProperties: false },
    strict: true,
  },
];

const r4 = (n: number | null) => (n == null ? null : Math.round(n * 10000) / 10000);
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export async function technicals(symbol: string) {
  const [h, spy] = await Promise.all([getHistory(symbol, "1y"), getHistory("SPY", "1y")]);
  if (!h || h.bars.length < 30) return { error: `No price history for ${symbol}.` };
  const c = h.bars.map((b) => b.close);
  const last = c[c.length - 1];
  const back = (n: number) => (c.length > n ? last / c[c.length - 1 - n] - 1 : null);
  const ytdStart = h.bars.find((b) => b.date >= `${h.bars[h.bars.length - 1].date.slice(0, 4)}-01-01`);
  const rets = c.slice(-21).map((x, i, a) => (i ? Math.log(x / a[i - 1]) : 0)).slice(1);
  const sd = Math.sqrt(avg(rets.map((r) => r * r)) - avg(rets) ** 2);
  const s = spy?.bars.map((b) => b.close) ?? [];
  const spy3m = s.length > 63 ? s[s.length - 1] / s[s.length - 64] - 1 : null;
  const m3 = back(63);
  return {
    layer: "market_data", symbol: symbol.toUpperCase(), provider: h.provider, as_of: h.bars[h.bars.length - 1].date, last,
    returns: { "1m": r4(back(21)), "3m": r4(m3), "6m": r4(back(126)), ytd: ytdStart ? r4(last / ytdStart.close - 1) : null },
    vs_50d_avg: c.length >= 50 ? r4(last / avg(c.slice(-50)) - 1) : null,
    vs_200d_avg: c.length >= 200 ? r4(last / avg(c.slice(-200)) - 1) : null,
    from_52w_high: r4(last / Math.max(...c) - 1), from_52w_low: r4(last / Math.min(...c) - 1),
    vol_20d_annualized: Number.isFinite(sd) ? r4(sd * Math.sqrt(252)) : null,
    vs_spy_3m: m3 != null && spy3m != null ? r4(m3 - spy3m) : null,
  };
}

const SEC_UA = process.env.SEC_USER_AGENT || "PortfolioIntelligence/1.0 (personal research app)";

export async function readDocument(url: string, focus: string) {
  let u: URL;
  try { u = new URL(url); } catch { return { error: "Not a valid URL." }; }
  const sec = /(^|\.)sec\.gov$/.test(u.hostname);
  const ua = sec ? SEC_UA : "Mozilla/5.0 (compatible; PortfolioIntelligence/1.0; research assistant)";
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,text/plain,application/json" }, redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { error: `HTTP ${res.status} from ${u.hostname}`, url };
    const text = htmlText((await res.text()).slice(0, 6_000_000));
    let others: string[] | undefined;
    const m = sec ? u.pathname.match(/^(\/Archives\/edgar\/data\/\d+\/\d{18})\//) : null;
    if (m) {
      const idx = await fetch(`https://www.sec.gov${m[1]}/index.json`, { headers: { "User-Agent": SEC_UA }, cache: "no-store", signal: AbortSignal.timeout(10000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { directory?: { item?: { name: string }[] } } | null;
      others = (idx?.directory?.item ?? []).map((i) => i.name).filter((n) => /\.(htm|html|txt|pdf)$/i.test(n)).map((n) => `https://www.sec.gov${m[1]}/${n}`).slice(0, 25);
    }
    const LIMIT = 9000;
    let body = text;
    if (focus.trim() && text.length > LIMIT) {
      const words = [...new Set(focus.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))];
      const chunks = text.match(/[\s\S]{1,700}(?=\s|$)/g) ?? [];
      const scored = chunks.map((ch, i) => ({ i, ch, s: words.reduce((a, w) => a + (ch.toLowerCase().split(w).length - 1), 0) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, Math.floor(LIMIT / 700)).sort((a, b) => a.i - b.i);
      body = scored.length ? scored.map((x) => x.ch).join(" … ") : text.slice(0, LIMIT);
    } else body = text.slice(0, LIMIT);
    return { layer: "external_document", url, retrieved_at: new Date().toISOString(), ms: Date.now() - t0, length: text.length, excerpt: focus.trim() ? `passages matching "${focus}"` : "beginning of the document", text: body, other_documents_in_filing: others };
  } catch (e) {
    return { error: (e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message.slice(0, 120), url };
  }
}

async function briefingEvidence(db: SupabaseClient) {
  const { data } = await db.from("model_runs").select("id, computed_at, outputs").eq("kind", "market_briefing").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return { error: "No briefing stored yet." };
  const b = data.outputs as Briefing;
  const { data: desks } = await db.from("model_runs").select("outputs").in("id", b.deskIds);
  return {
    layer: "stored_briefing", id: data.id, written_at: data.computed_at,
    headline: b.synthesis.headline, summary: b.synthesis.summary, attention: b.synthesis.attention,
    short_term: b.synthesis.shortTerm, long_term: { stance: b.synthesis.longTerm.stance, evidence: b.synthesis.longTerm.evidence, base: b.synthesis.longTerm.base, contrary: b.synthesis.longTerm.contrary, wouldChange: b.synthesis.longTerm.wouldChange },
    portfolio_notes: b.synthesis.portfolio,
    observations: b.observations?.items.map((o) => ({ id: o.id, area: o.area, text: o.text, reading: o.reading })),
    calendar: b.calendar.map((c) => ({ date: c.date, time: c.time, event: c.event, status: c.status, source: c.source?.url ?? null })),
    items: (desks ?? []).flatMap((d) => { const r = d.outputs as DeskResult; return r.items.map((it, i) => ({ id: `${r.desk[0].toUpperCase()}${i + 1}`, desk: r.title, kind: it.kind, headline: it.headline, detail: it.detail.slice(0, 400), source: it.sources[0] ? `${it.sources[0].publisher ?? ""} ${it.sources[0].published ?? ""} ${it.sources[0].url}` : null, check: it.check?.status ?? null })); }),
  };
}

function cost(model: { inPerM: number; outPerM: number }, u: AgentAnswer["usage"], searches: number) {
  return (u.input * model.inPerM + u.cacheRead * model.inPerM * 0.1 + u.cacheWrite * model.inPerM * 1.25 + u.output * model.outPerM) / 1e6 + searches * PER_SEARCH;
}

type Run = { client?: Anthropic; question: string; history?: { role: "user" | "assistant"; content: string }[]; page?: string | null; symbol?: string | null; deep?: boolean };

/** The app's assistant: investor context + tools + web search. */
export async function runAgent(db: SupabaseClient, ws: Workspace, run: Run): Promise<AgentAnswer> {
  const t0 = Date.now();
  const model = run.deep ? MODELS.deep : MODELS.standard;
  const client = run.client ?? new Anthropic();
  const ctx = await investorContext(ws, db);
  const where = run.page ? `\nThe investor is on page ${run.page}${run.symbol ? `, looking at ${run.symbol}` : ""}.` : "";
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: SYSTEM },
    { type: "text", text: `INVESTOR CONTEXT (loaded by the app)\n${ctx.text}`, cache_control: { type: "ephemeral" } },
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = [...(run.history ?? []).slice(-10).map((m) => ({ role: m.role, content: m.content })), { role: "user", content: `${run.question}${where}` }];
  const tools: Anthropic.Beta.BetaToolUnion[] = [...TOOLS, ...EXTRA_TOOLS, { type: "web_search_20250305", name: "web_search", max_uses: LIMITS.searches } as Anthropic.Beta.BetaWebSearchTool20250305];
  return loop({ client, model, system, messages, tools, t0, question: run.question, mode: "app", briefingId: ctx.briefingId, exec: (name, input) => execTool(name, input, ws, db) });
}

/** The comparison: a plain Claude conversation where the investor pastes their holdings, with web search only. */
export async function runBaseline(ws: Workspace, question: string, client = new Anthropic()): Promise<AgentAnswer> {
  const t0 = Date.now();
  const p = ws.portfolio;
  const pasted = `My portfolio: ${p.holdings.map((h) => `${h.symbol} ${(h.weight * 100).toFixed(1)}%`).join(", ")}. Total about $${Math.round(p.total).toLocaleString("en-US")}, cash about $${Math.round(p.cashDetail.brokerage).toLocaleString("en-US")}.`;
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: `${pasted}\n\n${question}` }];
  const tools: Anthropic.Beta.BetaToolUnion[] = [{ type: "web_search_20250305", name: "web_search", max_uses: LIMITS.searches } as Anthropic.Beta.BetaWebSearchTool20250305];
  return loop({ client, model: MODELS.standard, system: [{ type: "text", text: `You are Claude, a helpful assistant. Today is ${ws.now.toISOString().slice(0, 10)}.` }], messages, tools, t0, question, mode: "baseline", briefingId: null, exec: async () => ({ error: "no tools" }) });
}

async function execTool(name: string, input: Record<string, unknown>, ws: Workspace, db: SupabaseClient): Promise<unknown> {
  if (name === "get_briefing") return briefingEvidence(db);
  if (name === "get_technicals") return technicals(String(input.symbol ?? ""));
  if (name === "read_document") return readDocument(String(input.url ?? ""), String(input.focus ?? ""));
  return runTool(name, input, ws, db);
}

async function loop(a: { client: Anthropic; model: (typeof MODELS)["standard"] | (typeof MODELS)["deep"]; system: Anthropic.Beta.BetaTextBlockParam[]; messages: Anthropic.Beta.BetaMessageParam[]; tools: Anthropic.Beta.BetaToolUnion[]; t0: number; question: string; mode: AgentAnswer["mode"]; briefingId: string | null; exec: (name: string, input: Record<string, unknown>) => Promise<unknown> }): Promise<AgentAnswer> {
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const steps: Step[] = [];
  let searches = 0, turns = 0, served = a.model.id, answer = "", stopped: string | null = null;
  for (; turns < LIMITS.turns; turns++) {
    if (Date.now() - a.t0 > LIMITS.ms) { stopped = "time limit"; break; }
    const res = await a.client.beta.messages.create({
      model: a.model.id, max_tokens: LIMITS.maxTokens, system: a.system, tools: a.tools,
      output_config: { effort: a.model.effort }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", messages: a.messages,
    });
    served = res.model;
    usage.input += res.usage.input_tokens; usage.cacheRead += res.usage.cache_read_input_tokens ?? 0; usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0; usage.output += res.usage.output_tokens;
    const s = res.usage.server_tool_use?.web_search_requests ?? 0;
    searches += s;
    for (const b of res.content) if (b.type === "server_tool_use") steps.push({ tool: "web_search", input: (b as { input: unknown }).input, ok: true, ms: 0, preview: "" });
    if (res.stop_reason === "refusal") { answer = "I can't help with that one."; stopped = "refusal"; break; }
    a.messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason === "pause_turn") continue;
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !uses.length) {
      answer = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("").trim();
      if (res.stop_reason === "max_tokens") stopped = "answer cut at the length limit";
      break;
    }
    const results = await Promise.all(uses.map(async (u) => {
      const t = Date.now();
      try {
        const out = await a.exec(u.name, (u.input ?? {}) as Record<string, unknown>);
        const content = JSON.stringify(out);
        const ok = !(out && typeof out === "object" && "error" in (out as object));
        steps.push({ tool: u.name, input: u.input, ok, ms: Date.now() - t, preview: content.slice(0, 800) });
        return { type: "tool_result" as const, tool_use_id: u.id, content: content.length > 60000 ? content.slice(0, 60000) + "…[truncated]" : content };
      } catch (e) {
        steps.push({ tool: u.name, input: u.input, ok: false, ms: Date.now() - t, preview: (e as Error).message.slice(0, 200) });
        return { type: "tool_result" as const, tool_use_id: u.id, content: `Tool failed: ${(e as Error).message}`, is_error: true };
      }
    }));
    a.messages.push({ role: "user", content: results });
  }
  if (!answer) { answer = "I ran out of steps before finishing. Ask again with a narrower question."; stopped ??= "step limit"; }
  return { version: AGENT_VERSION, mode: a.mode, question: a.question, answer, model: served, ms: Date.now() - a.t0, turns: turns + 1, searches, steps, usage, costUsd: Number(cost(a.model, usage, searches).toFixed(4)), contextBriefingId: a.briefingId, stopped };
}
