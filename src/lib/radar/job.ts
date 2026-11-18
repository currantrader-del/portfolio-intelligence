/**
 * Opportunity Radar as stored records (model_runs, insert-only):
 *   radar_request -> radar_run (the screen, the ideas with prices locked in, what was turned down, the cost)
 * Your answer to each idea ("Look into it" / "Not interested") is an eval_action (subject "radar").
 * Runs weekly (Wednesday morning) and on demand from the Radar page. No phone push, no automatic research.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildWorkspace } from "@/lib/workspace-core";
import { dispatchJob, save } from "@/lib/intel/jobs";
import { runAgent } from "@/lib/assistant/agent";
import { extractJson } from "@/lib/research/aiResearch";
import { getQuotes } from "@/lib/market/quotes";
import { getHistory } from "@/lib/market/history";
import { analyze } from "@/lib/market/ta";
import { UNIVERSE } from "@/lib/market/universe";
import { findSetup } from "@/lib/trades/scan";
import { COOLDOWN_DAYS, MAX_IDEAS, RADAR_LIMITS, RADAR_SYSTEM, RADAR_VERSION, classify, metricsOf, radarQuestion, shortlist, shortlistText, validateRadarIdea, type Candidate, type RadarIdea } from "./radar";

export const RADAR_RUNNING_MIN = 14;
const etDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

export type RadarRun = {
  ok: boolean; error?: string; trigger: string; at: string;
  screen: { scanned: number; failed: number; candidates: Candidate[] } | null;
  ideas: RadarIdea[]; rejected: { symbol: string; why: string }[]; noneReason: string | null;
  costUsd: number; ms: number; searches: number; model: string | null;
};

export async function radarRuns(db: SupabaseClient, limit = 12): Promise<(RadarRun & { id: string })[]> {
  const { data } = await db.from("model_runs").select("id, outputs").eq("kind", "radar_run").order("computed_at", { ascending: false }).limit(limit);
  return ((data ?? []) as { id: string; outputs: RadarRun }[]).map((r) => ({ ...r.outputs, id: r.id }));
}

export async function radarStatus(db: SupabaseClient) {
  const { data: req } = await db.from("model_runs").select("id, computed_at").eq("kind", "radar_request").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const { data: run } = await db.from("model_runs").select("inputs").eq("kind", "radar_run").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const running = !!req && (run?.inputs as { request_id?: string } | undefined)?.request_id !== req.id && Date.now() - new Date(req.computed_at as string).getTime() < RADAR_RUNNING_MIN * 60_000;
  return { running };
}

export async function startRadar(db: SupabaseClient, origin: string, token: string, trigger: "weekly" | "manual"): Promise<string | null> {
  if ((await radarStatus(db)).running) return null;
  const requestId = await save(db, "radar_request", RADAR_VERSION, { trigger }, {});
  await dispatchJob(origin, { job: "radar", requestId, token });
  return requestId;
}

/** The code screen across the S&P 500 (free prices). */
export async function radarScreen(exclude: Set<string>): Promise<{ scanned: number; failed: number; candidates: Candidate[] }> {
  const spy = await getHistory("SPY", "1y").catch(() => null);
  const spy12 = spy ? metricsOf(spy.bars)?.ret12m ?? null : null;
  const all: Candidate[] = [];
  let failed = 0;
  for (let i = 0; i < UNIVERSE.length; i += 12) {
    await Promise.all(UNIVERSE.slice(i, i + 12).map(async ([s, sector]) => {
      if (exclude.has(s)) return;
      const h = await getHistory(s, "1y").catch(() => null);
      const m = h ? metricsOf(h.bars) : null;
      if (!h || !m || m.price < 10) { if (!h || !m) failed++; return; }
      const ta = analyze(h.bars);
      const c = classify(s, sector, m, spy12, ta ? findSetup(s, sector, h.bars, ta) : null);
      if (c) all.push(c);
    }));
  }
  return { scanned: UNIVERSE.length - exclude.size - failed, failed, candidates: shortlist(all, exclude) };
}

export async function runRadar(db: SupabaseClient, requestId: string): Promise<string> {
  const { data: req } = await db.from("model_runs").select("id, inputs").eq("id", requestId).eq("kind", "radar_request").maybeSingle();
  if (!req) throw new Error("Unknown radar request");
  const trigger = (req.inputs as { trigger?: string }).trigger ?? "manual";
  const now = new Date();
  const out = (o: Omit<RadarRun, "trigger" | "at">) => save(db, "radar_run", RADAR_VERSION, { request_id: requestId, trigger }, { ...o, trigger, at: now.toISOString() });
  try {
    const ws = await buildWorkspace(db, now);
    const past = await radarRuns(db, 20);
    const recent = past.filter((r) => Date.parse(r.at) > now.getTime() - COOLDOWN_DAYS * 86_400_000).flatMap((r) => r.ideas.map((i) => i.symbol));
    // GOOG and GOOGL are one company: leaving out one leaves out both.
    const exclude = new Set([...ws.portfolio.holdings.map((h) => h.symbol), ...ws.research.map((r) => r.symbol), ...recent]);
    if (exclude.has("GOOGL") || exclude.has("GOOG")) { exclude.add("GOOGL"); exclude.add("GOOG"); }
    const screen = await radarScreen(exclude);
    const ans = await runAgent(db, ws, { question: radarQuestion(etDay(now), shortlistText(screen.candidates, screen.scanned)), system: RADAR_SYSTEM, limits: RADAR_LIMITS, page: "/radar" });
    const meta = { costUsd: ans.costUsd, ms: ans.ms, searches: ans.searches, model: ans.model, screen };
    const json = extractJson(ans.answer) as { ideas?: unknown[]; none_reason?: string | null } | null;
    if (!json || !Array.isArray(json.ideas)) return out({ ok: false, error: `The answer was not in the expected format${ans.stopped ? ` (stopped: ${ans.stopped})` : ""}`, ideas: [], rejected: [], noneReason: null, ...meta });
    const raws = json.ideas.slice(0, MAX_IDEAS);
    const syms = raws.map((r) => String((r as { symbol?: unknown })?.symbol ?? "").toUpperCase()).filter(Boolean);
    const q = await getQuotes([...syms, "VOO"]);
    const ideas: RadarIdea[] = [], rejected: RadarRun["rejected"] = [];
    const listed = new Set(screen.candidates.map((c) => c.symbol));
    for (const raw of raws) {
      const sym = String((raw as { symbol?: unknown })?.symbol ?? "").toUpperCase();
      const v = validateRadarIdea(raw, { price: q.get(sym)?.price ?? null, exclude: new Set([...exclude, ...ideas.map((i) => i.symbol)]), shortlist: listed, vooPrice: q.get("VOO")?.price ?? null, now });
      if ("rejected" in v) rejected.push({ symbol: v.symbol, why: v.rejected }); else ideas.push(v.idea);
    }
    return out({ ok: true, ideas, rejected, noneReason: typeof json.none_reason === "string" ? json.none_reason.slice(0, 2000) : null, ...meta });
  } catch (e) {
    return out({ ok: false, error: (e as Error).message.slice(0, 300), ideas: [], rejected: [], noneReason: null, costUsd: 0, ms: 0, searches: 0, model: null, screen: null });
  }
}
