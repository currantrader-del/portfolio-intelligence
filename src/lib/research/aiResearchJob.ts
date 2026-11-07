/**
 * Runs a full AI research request as a background job and saves it as a NEW research version
 * (origin "claude_full"). Earlier versions are never edited; the only change to them is the "current" flag,
 * and that moves to the new version only when the report passed every check (or nothing was current before).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildWorkspace } from "@/lib/workspace-core";
import { save } from "@/lib/intel/jobs";
import { runAgent, type AgentAnswer } from "@/lib/assistant/agent";
import { getFilings, getFundamentals } from "@/lib/market/sec";
import { getQuote } from "@/lib/market/quotes";
import { screenCompany, type ScreenResult } from "./screen";
import { RESEARCH_LIMITS, RESEARCH_SYSTEM, RESEARCH_VERSION, extractJson, researchQuestion, validateReport } from "./aiResearch";

export type ResearchRequest = { symbol: string };
export type ResearchResult = {
  symbol: string; ok: boolean; error?: string; versionId?: string; madeCurrent?: boolean;
  completeness?: string; problems?: string[]; summary?: string;
  costUsd: number; ms: number; searches: number; turns: number; model: string | null; steps: AgentAnswer["steps"];
};

/** A request still running (no result yet) for this company, started within this many minutes, blocks a second one. */
export const RUNNING_WINDOW_MIN = 15;

export async function runResearchJob(db: SupabaseClient, requestId: string): Promise<string> {
  const { data: req } = await db.from("model_runs").select("id, inputs").eq("id", requestId).eq("kind", "research_request").maybeSingle();
  if (!req) throw new Error("Unknown research request");
  const symbol = String((req.inputs as ResearchRequest).symbol ?? "").toUpperCase();
  const done = (r: Omit<ResearchResult, "symbol">) => save(db, "research_result", RESEARCH_VERSION, { request_id: requestId, symbol }, { symbol, ...r });
  const empty = { costUsd: 0, ms: 0, searches: 0, turns: 0, model: null, steps: [] };

  const { data: company } = await db.from("companies").select("id, symbol, name, pipeline_stage, stage_history, research_versions(id, research_as_of, completeness, origin, is_current, conclusion)").eq("symbol", symbol).maybeSingle();
  if (!company) return done({ ok: false, error: `${symbol} is not in your research list.`, ...empty });

  // The free SEC screen runs first and is stored on the company as before; the research reads its result.
  const screen = await runScreenFor(db, company, symbol).catch(() => null);

  const ws = await buildWorkspace(db);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(ws.now);
  const appPrice = ws.quotes.get(symbol)?.price ?? ws.portfolio.holdings.find((h) => h.symbol === symbol)?.price ?? null;
  type V = { id: string; research_as_of: string; completeness: string; origin: string; is_current: boolean; conclusion: Record<string, unknown> | null };
  const versions = ((company.research_versions ?? []) as V[]).sort((a, b) => b.research_as_of.localeCompare(a.research_as_of));
  const current = versions.find((v) => v.is_current) ?? null;
  const prior = current ?? versions[0] ?? null;
  const earlier = prior ? `${prior.research_as_of}, ${prior.completeness}, action "${prior.conclusion?.action ?? "none"}", reference price ${prior.conclusion?.reference_price ?? "none"}. Use get_research for details.` : null;

  let ans: AgentAnswer;
  try {
    ans = await runAgent(db, ws, { question: researchQuestion({ symbol, name: company.name, today, price: appPrice, earlier, screen: screen ? screenText(screen) : null }), system: RESEARCH_SYSTEM, limits: RESEARCH_LIMITS, page: `/research/${symbol}`, symbol });
  } catch (e) {
    return done({ ok: false, error: (e as Error).message.slice(0, 300), ...empty });
  }
  const meta = { costUsd: ans.costUsd, ms: ans.ms, searches: ans.searches, turns: ans.turns, model: ans.model, steps: ans.steps };
  const report = validateReport(extractJson(ans.answer), { today, appPrice });
  if ("error" in report) return done({ ok: false, error: `${report.error}${ans.stopped ? ` (stopped: ${ans.stopped})` : ""}`, ...meta });

  const changeSummary = `AI research (${ans.model}, ${ans.searches} searches, $${ans.costUsd.toFixed(2)}). ${report.summary}${report.problems.length ? ` Not complete: ${report.problems.join("; ")}.` : ""}`.slice(0, 2000);
  const { data: version, error: vErr } = await db.from("research_versions").insert({
    company_id: company.id, research_as_of: today, completeness: report.completeness, origin: "claude_full", is_current: false,
    supersedes_id: prior?.id ?? null, conclusion: { ...report.conclusion, generated_by: RESEARCH_VERSION, request_id: requestId }, change_summary: changeSummary,
  }).select("id").single();
  if (vErr || !version) return done({ ok: false, error: `Could not save the research: ${vErr?.message ?? "no id"}`, ...meta });

  if (report.phases.length) {
    const { error } = await db.from("research_phases").insert(report.phases.map((p) => ({ version_id: version.id, phase_number: p.phase_number, title: p.title, body_markdown: p.body_markdown, extraction: "verbatim", details: { generated_by: RESEARCH_VERSION } })));
    if (error) report.problems.push(`Phases not saved: ${error.message}`);
  }
  if (report.sources.length) {
    const { error } = await db.from("research_sources").insert(report.sources.map((s) => ({ version_id: version.id, title: s.title, url: s.url, document_date: s.document_date, details: { cited_by: RESEARCH_VERSION } })));
    if (error) report.problems.push(`Sources not saved: ${error.message}`);
  }

  // Only a report that passed every check replaces the current research. A partial one is kept beside it.
  let madeCurrent = false;
  if (report.completeness === "complete" || !current) {
    if (current) {
      const { error } = await db.from("research_versions").update({ is_current: false }).eq("id", current.id);
      if (error) report.problems.push(`Could not retire the previous current research: ${error.message}`);
    }
    const { error } = await db.from("research_versions").update({ is_current: true }).eq("id", version.id);
    if (error) report.problems.push(`Could not mark the new research current: ${error.message}`);
    else madeCurrent = true;
  }
  // Research on file moves an idea along the pipeline (never past "researching"; Ready stays the investor's call).
  if (company.pipeline_stage === "idea" || company.pipeline_stage === "screening") {
    const at = new Date().toISOString();
    await db.from("companies").update({ pipeline_stage: "researching", stage_updated_at: at, stage_history: [...((company.stage_history as unknown[]) ?? []), { stage: "researching", at, note: "AI research written" }] }).eq("id", company.id);
  }
  return done({ ok: true, versionId: version.id, madeCurrent, completeness: report.completeness, problems: report.problems, summary: report.summary, ...meta });
}

async function runScreenFor(db: SupabaseClient, company: { id: string; name: string | null; pipeline_stage?: string | null; stage_history?: unknown }, symbol: string): Promise<ScreenResult> {
  const [fundamentals, filings, quote] = await Promise.all([getFundamentals(symbol), getFilings(symbol), getQuote(symbol)]);
  const result = screenCompany({ symbol, fundamentals, filings: "error" in filings ? null : filings, price: quote?.price ?? null, priceAsOf: quote?.asOf ?? null });
  const update: Record<string, unknown> = { screen: result, screened_at: result.computedAt };
  if (!company.name && !("error" in fundamentals) && fundamentals.company) { update.name = fundamentals.company; company.name = fundamentals.company; }
  await db.from("companies").update(update).eq("id", company.id);
  return result;
}

function screenText(s: ScreenResult) {
  return `${s.verdict}. ${s.checks.map((c) => `${c.label}: ${c.value} (${c.status})`).join("; ")}. To verify: ${s.toVerify.join("; ") || "nothing flagged"}.`;
}
