/**
 * Trade ideas as stored records (model_runs, insert-only):
 *   trade_request -> trade_scan (one AI search; its ideas and the ones the app rejected)
 *   trade_idea    (one per accepted idea, with the prices locked in at that moment: the paper trade)
 *   trade_close   (when target, stop or end date is reached, with the result versus VOO)
 *   trade_taken   (the investor says they actually made the trade)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildWorkspace } from "@/lib/workspace-core";
import { dispatchJob, save } from "@/lib/intel/jobs";
import { runAgent } from "@/lib/assistant/agent";
import { extractJson } from "@/lib/research/aiResearch";
import { getQuote, getQuotes } from "@/lib/market/quotes";
import { getHistory } from "@/lib/market/history";
import { analyze } from "@/lib/market/ta";
import { UNIVERSE } from "@/lib/market/universe";
import { SCAN_VERSION, findSetup, rankSetups, setupsText, type Setup } from "./scan";
import { TRADE_LIMITS, TRADE_SYSTEM, TRADE_VERSION, evaluate, tradeQuestion, validateIdea, type Entry, type Mark, type Result, type TradeIdea } from "./trades";

export const BENCH = "VOO";
export const SCAN_RUNNING_MIN = 12;
const etDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

export type MarketScan = { version: string; at: string; scanned: number; failed: number; found: number; setups: Setup[]; ms: number };
export type StoredScan = { ok: boolean; error?: string; trigger: string; focus: string | null; screen?: { at: string; scanned: number; failed: number; found: number; setups: Setup[] } | null; ideaIds: string[]; rejected: { symbol: string; why: string }[]; noneReason: string | null; costUsd: number; ms: number; searches: number; model: string | null };
export type Trade = {
  id: string; at: string; idea: TradeIdea; entry: Entry;
  close: { at: string; result: Result; mark: Mark } | null;
  taken: { at: string; price: number | null; quantity: number | null; note: string } | null;
};

/**
 * Screens the whole universe in code: a year of daily bars for each stock, the technicals, and the best
 * chart setup. Reused for 6 hours (prices only change during the session), so repeated searches are cheap.
 */
export async function marketScan(db: SupabaseClient, extra: string[], now = new Date()): Promise<MarketScan> {
  const { data: cached } = await db.from("model_runs").select("computed_at, outputs").eq("kind", "market_scan").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  if (cached && now.getTime() - new Date(cached.computed_at as string).getTime() < 6 * 3600_000 && (cached.outputs as MarketScan).version === SCAN_VERSION) return cached.outputs as MarketScan;
  const t0 = Date.now();
  const sector = new Map(UNIVERSE);
  const symbols = [...new Set([...UNIVERSE.map(([s]) => s), ...extra.map((s) => s.toUpperCase())])];
  const setups: Setup[] = [];
  let failed = 0;
  for (let i = 0; i < symbols.length; i += 12) {
    await Promise.all(symbols.slice(i, i + 12).map(async (s) => {
      const h = await getHistory(s, "1y").catch(() => null);
      const ta = h ? analyze(h.bars) : null;
      if (!h || !ta) { failed++; return; }
      const setup = findSetup(s, sector.get(s) ?? null, h.bars, ta);
      if (setup) setups.push(setup);
    }));
  }
  const out: MarketScan = { version: SCAN_VERSION, at: now.toISOString(), scanned: symbols.length - failed, failed, found: setups.length, setups: rankSetups(setups), ms: Date.now() - t0 };
  await save(db, "market_scan", SCAN_VERSION, { symbols: symbols.length }, out);
  return out;
}

/** At least two price/trend lookups and one web search: the minimum for a decision worth recording. */
export function researched(steps: { tool: string }[], searches: number) {
  return steps.filter((s) => s.tool === "get_quote" || s.tool === "get_technicals").length >= 2 && searches >= 1;
}

export async function scanStatus(db: SupabaseClient) {
  const { data: req } = await db.from("model_runs").select("id, computed_at").eq("kind", "trade_request").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const { data: scan } = await db.from("model_runs").select("id, computed_at, inputs, outputs").eq("kind", "trade_scan").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const running = !!req && (!scan || (scan.inputs as { request_id?: string }).request_id !== req.id) && Date.now() - new Date(req.computed_at).getTime() < SCAN_RUNNING_MIN * 60_000;
  return { running, latest: scan ? { at: scan.computed_at as string, ...(scan.outputs as StoredScan) } : null };
}

export async function startTradeScan(db: SupabaseClient, origin: string, token: string, trigger: string, focus: string | null = null): Promise<string | null> {
  if ((await scanStatus(db)).running) return null;
  const requestId = await save(db, "trade_request", TRADE_VERSION, { trigger, focus }, {});
  await dispatchJob(origin, { job: "trades", requestId, token });
  return requestId;
}

/** Locks in the prices of an accepted idea: the stock, the option contract when there is one, and VOO. */
async function lockEntry(idea: TradeIdea, now: Date): Promise<Entry> {
  const [opt, voo] = await Promise.all([idea.option ? getQuote(idea.option.contract) : Promise.resolve(null), getQuote(BENCH)]);
  const premium = opt?.price ?? idea.option?.estPremium ?? null;
  return { at: now.toISOString(), underlying: idea.entryRef, premium: idea.option ? premium : null, premiumSource: idea.option ? (opt ? "quote" : premium ? "estimate" : null) : null, voo: voo?.price ?? null };
}

export async function runTradeScan(db: SupabaseClient, requestId: string, notify?: (t: Trade[]) => Promise<void>): Promise<string> {
  const { data: req } = await db.from("model_runs").select("id, inputs").eq("id", requestId).eq("kind", "trade_request").maybeSingle();
  if (!req) throw new Error("Unknown trade request");
  const { trigger = "manual", focus = null } = req.inputs as { trigger?: string; focus?: string | null };
  const out = (o: Omit<StoredScan, "trigger" | "focus">) => save(db, "trade_scan", TRADE_VERSION, { request_id: requestId, trigger }, { ...o, trigger, focus });
  const ws = await buildWorkspace(db);
  const now = new Date();
  try {
    const held = ws.portfolio.holdings.map((h) => h.symbol), researchedSyms = ws.research.map((r) => r.symbol);
    const screen = await marketScan(db, [...held, ...researchedSyms], now).catch((e) => { console.error(`trades: market scan failed: ${(e as Error).message}`); return null; });
    const question = tradeQuestion(etDay(now), focus, screen ? setupsText(screen.setups, screen.scanned) : null);
    let ans = await runAgent(db, ws, { question, system: TRADE_SYSTEM, limits: TRADE_LIMITS, page: "/trades", symbol: focus });
    let spent = { costUsd: ans.costUsd, ms: ans.ms };
    // An answer that skipped the research is sent back once with the steps it missed.
    if (!researched(ans.steps, ans.searches)) {
      ans = await runAgent(db, ws, { question: "You answered without doing the research. Do steps 1-4 now with the tools (quotes and technicals for each candidate, a web search for the catalyst and its date), then reply with the JSON.", history: [{ role: "user", content: question }, { role: "assistant", content: ans.answer || "(no answer)" }], system: TRADE_SYSTEM, limits: TRADE_LIMITS, page: "/trades", symbol: focus });
      spent = { costUsd: spent.costUsd + ans.costUsd, ms: spent.ms + ans.ms };
    }
    const meta = { ...spent, searches: ans.searches, model: ans.model, screen: screen ? { at: screen.at, scanned: screen.scanned, failed: screen.failed, found: screen.found, setups: screen.setups } : null };
    if (!researched(ans.steps, ans.searches)) return out({ ok: false, error: "The search did not research any candidates; nothing was decided. Try again.", ideaIds: [], rejected: [], noneReason: null, ...meta });
    const json = extractJson(ans.answer) as { ideas?: unknown[]; none_reason?: string | null } | null;
    if (!json || !Array.isArray(json.ideas)) return out({ ok: false, error: `The answer was not in the expected format${ans.stopped ? ` (stopped: ${ans.stopped})` : ""}`, ideaIds: [], rejected: [], noneReason: null, ...meta });
    const raws = json.ideas.slice(0, 2);
    const syms = raws.map((r) => String((r as { symbol?: unknown })?.symbol ?? "").toUpperCase()).filter(Boolean);
    const [prices, charts] = await Promise.all([
      getQuotes(syms),
      Promise.all(syms.map(async (s) => [s, await getHistory(s, "1y").then((h) => (h ? analyze(h.bars) : null)).catch(() => null)] as const)).then((x) => new Map(x)),
    ]);
    const ideaIds: string[] = [], rejected: StoredScan["rejected"] = [], made: Trade[] = [];
    for (const raw of raws) {
      const sym = String((raw as { symbol?: unknown })?.symbol ?? "").toUpperCase();
      const v = validateIdea(raw, { today: etDay(now), price: prices.get(sym)?.price ?? null, ta: charts.get(sym) ?? null });
      if ("rejected" in v) { rejected.push({ symbol: v.symbol, why: v.rejected }); continue; }
      if (!prices.get(sym)) { rejected.push({ symbol: sym, why: "no live price to lock in" }); continue; }
      const entry = await lockEntry(v.idea, now);
      if (v.idea.option && !entry.premium) { rejected.push({ symbol: sym, why: "no option price to lock in" }); continue; }
      const id = await save(db, "trade_idea", TRADE_VERSION, { request_id: requestId }, { idea: v.idea, entry });
      ideaIds.push(id);
      made.push({ id, at: entry.at, idea: v.idea, entry, close: null, taken: null });
    }
    const id = await out({ ok: true, ideaIds, rejected, noneReason: typeof json.none_reason === "string" ? json.none_reason.slice(0, 1500) : null, ...meta });
    if (made.length && notify) await notify(made).catch((e) => console.error(`trades: notify failed: ${(e as Error).message}`));
    return id;
  } catch (e) {
    return out({ ok: false, error: (e as Error).message.slice(0, 300), ideaIds: [], rejected: [], noneReason: null, costUsd: 0, ms: 0, searches: 0, model: null, screen: null });
  }
}

/** All paper trades, newest first, with their close and whether the investor took them. */
export async function loadTrades(db: SupabaseClient): Promise<Trade[]> {
  const [{ data: ideas }, { data: closes }, { data: taken }] = await Promise.all([
    db.from("model_runs").select("id, computed_at, outputs").eq("kind", "trade_idea").order("computed_at", { ascending: false }).limit(200),
    db.from("model_runs").select("computed_at, inputs, outputs").eq("kind", "trade_close").limit(500),
    db.from("model_runs").select("computed_at, inputs, outputs").eq("kind", "trade_taken").order("computed_at", { ascending: false }).limit(500),
  ]);
  const byIdea = <T,>(rows: { computed_at: string; inputs: unknown; outputs: unknown }[] | null, f: (r: { computed_at: string; outputs: unknown }) => T) => {
    const m = new Map<string, T>();
    for (const r of rows ?? []) { const k = (r.inputs as { idea_id?: string }).idea_id; if (k && !m.has(k)) m.set(k, f(r)); }
    return m;
  };
  const c = byIdea(closes as never, (r) => ({ at: r.computed_at, ...(r.outputs as { result: Result; mark: Mark }) }));
  const t = byIdea(taken as never, (r) => ({ at: r.computed_at, ...(r.outputs as { price: number | null; quantity: number | null; note: string }) }));
  return ((ideas ?? []) as { id: string; computed_at: string; outputs: { idea: TradeIdea; entry: Entry } }[]).map((r) => ({ id: r.id, at: r.computed_at, ...r.outputs, close: c.get(r.id) ?? null, taken: t.get(r.id) ?? null }));
}

/** Current marks for open trades (stock, option contract, VOO). */
export async function markOpen(open: Trade[], now: Date): Promise<Map<string, Mark>> {
  if (!open.length) return new Map();
  const q = await getQuotes([...new Set([...open.map((t) => t.idea.symbol), ...open.flatMap((t) => (t.idea.option ? [t.idea.option.contract] : [])), BENCH])]);
  return new Map(open.map((t) => [t.id, { underlying: q.get(t.idea.symbol)?.price ?? null, premium: t.idea.option ? q.get(t.idea.option.contract)?.price ?? null : null, voo: q.get(BENCH)?.price ?? null, today: etDay(now) }]));
}

/** Closes paper trades that reached their target, stop or end date. Runs with the 30-minute check. */
export async function checkTrades(db: SupabaseClient, now = new Date()): Promise<(Trade & { close: NonNullable<Trade["close"]> })[]> {
  const open = (await loadTrades(db)).filter((t) => !t.close);
  const marks = await markOpen(open, now);
  const closed: (Trade & { close: NonNullable<Trade["close"]> })[] = [];
  for (const t of open) {
    const mark = marks.get(t.id)!;
    const result = evaluate(t.idea, t.entry, mark);
    // Closes only with a price to score it at; a missing quote waits for the next check.
    if (result.status === "open" || result.returnPct === null) continue;
    await save(db, "trade_close", TRADE_VERSION, { idea_id: t.id }, { result, mark });
    closed.push({ ...t, close: { at: now.toISOString(), result, mark } });
  }
  return closed;
}

export function describeIdea(i: TradeIdea) {
  const what = i.option ? `${i.symbol} $${i.option.strike} ${i.option.type} exp ${i.option.expiry}` : `${i.symbol} stock`;
  return `${what}: target $${i.target}, stop $${i.stop}, by ${i.endDate}`;
}
