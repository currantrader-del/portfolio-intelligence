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
import { TRADE_LIMITS, TRADE_SYSTEM, TRADE_VERSION, evaluate, tradeQuestion, validateIdea, type Entry, type Mark, type Result, type TradeIdea } from "./trades";

export const BENCH = "VOO";
export const SCAN_RUNNING_MIN = 12;
const etDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

export type StoredScan = { ok: boolean; error?: string; trigger: string; focus: string | null; ideaIds: string[]; rejected: { symbol: string; why: string }[]; noneReason: string | null; costUsd: number; ms: number; searches: number; model: string | null };
export type Trade = {
  id: string; at: string; idea: TradeIdea; entry: Entry;
  close: { at: string; result: Result; mark: Mark } | null;
  taken: { at: string; price: number | null; quantity: number | null; note: string } | null;
};

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
    const ans = await runAgent(db, ws, { question: tradeQuestion(etDay(now), focus), system: TRADE_SYSTEM, limits: TRADE_LIMITS, page: "/trades", symbol: focus });
    const meta = { costUsd: ans.costUsd, ms: ans.ms, searches: ans.searches, model: ans.model };
    const json = extractJson(ans.answer) as { ideas?: unknown[]; none_reason?: string | null } | null;
    if (!json || !Array.isArray(json.ideas)) return out({ ok: false, error: `The answer was not in the expected format${ans.stopped ? ` (stopped: ${ans.stopped})` : ""}`, ideaIds: [], rejected: [], noneReason: null, ...meta });
    const raws = json.ideas.slice(0, 2);
    const prices = await getQuotes(raws.map((r) => String((r as { symbol?: unknown })?.symbol ?? "").toUpperCase()).filter(Boolean));
    const ideaIds: string[] = [], rejected: StoredScan["rejected"] = [], made: Trade[] = [];
    for (const raw of raws) {
      const sym = String((raw as { symbol?: unknown })?.symbol ?? "").toUpperCase();
      const v = validateIdea(raw, { today: etDay(now), price: prices.get(sym)?.price ?? null });
      if ("rejected" in v) { rejected.push({ symbol: v.symbol, why: v.rejected }); continue; }
      if (!prices.get(sym)) { rejected.push({ symbol: sym, why: "no live price to lock in" }); continue; }
      const entry = await lockEntry(v.idea, now);
      if (v.idea.option && !entry.premium) { rejected.push({ symbol: sym, why: "no option price to lock in" }); continue; }
      const id = await save(db, "trade_idea", TRADE_VERSION, { request_id: requestId }, { idea: v.idea, entry });
      ideaIds.push(id);
      made.push({ id, at: entry.at, idea: v.idea, entry, close: null, taken: null });
    }
    const id = await out({ ok: true, ideaIds, rejected, noneReason: typeof json.none_reason === "string" ? json.none_reason.slice(0, 600) : null, ...meta });
    if (made.length && notify) await notify(made).catch((e) => console.error(`trades: notify failed: ${(e as Error).message}`));
    return id;
  } catch (e) {
    return out({ ok: false, error: (e as Error).message.slice(0, 300), ideaIds: [], rejected: [], noneReason: null, costUsd: 0, ms: 0, searches: 0, model: null });
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
