/**
 * The ETF check as a background job: one short AI pass (started by you) for one fund. The result is saved
 * as model_runs kind "etf_check" with its cost; it never changes holdings, limits or company research.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildWorkspace } from "@/lib/workspace-core";
import { save } from "@/lib/intel/jobs";
import { runAgent } from "@/lib/assistant/agent";
import { extractJson } from "./aiResearch";
import { ETF_CHECK_LIMITS, ETF_CHECK_SYSTEM, ETF_CHECK_VERSION, etfCheckQuestion, etfFacts, validateEtfCheck } from "./etf";

export async function runEtfCheck(db: SupabaseClient, requestId: string): Promise<string> {
  const { data: req } = await db.from("model_runs").select("id, inputs").eq("id", requestId).eq("kind", "etf_check_request").maybeSingle();
  if (!req) throw new Error("Unknown ETF check request");
  const symbol = String((req.inputs as { symbol?: string }).symbol ?? "").toUpperCase();
  const done = (o: Record<string, unknown>) => save(db, "etf_check", ETF_CHECK_VERSION, { request_id: requestId, symbol }, { symbol, ...o });
  const ws = await buildWorkspace(db);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(ws.now);
  const facts = etfFacts(symbol, ws.portfolio, ws.now);
  const price = ws.quotes.get(symbol)?.price ?? ws.portfolio.holdings.find((h) => h.symbol === symbol)?.price ?? null;
  try {
    const ans = await runAgent(db, ws, { question: etfCheckQuestion({ symbol, today, facts, price }), system: ETF_CHECK_SYSTEM, limits: ETF_CHECK_LIMITS, page: `/research/${symbol}`, symbol });
    const meta = { costUsd: ans.costUsd, model: ans.model, searches: ans.searches, ms: ans.ms };
    const check = validateEtfCheck(extractJson(ans.answer), today);
    if ("error" in check) return done({ ok: false, error: `${check.error}${ans.stopped ? ` (stopped: ${ans.stopped})` : ""}`, ...meta });
    return done({ ok: true, check, ...meta });
  } catch (e) {
    return done({ ok: false, error: (e as Error).message.slice(0, 300), costUsd: 0 });
  }
}
