/**
 * Builds the portfolio plan as a background job and stores it (model_runs kind "portfolio_plan").
 * Started by the Rebuild button, after each finished AI research, and weekly by the morning run.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildWorkspace } from "@/lib/workspace-core";
import { dispatchJob, save } from "@/lib/intel/jobs";
import { runAgent } from "@/lib/assistant/agent";
import { extractJson } from "@/lib/research/aiResearch";
import { companyMax } from "@/lib/policy/limits";
import { isEtf } from "@/lib/portfolio/classify";
import { PLAN_LIMITS, PLAN_SYSTEM, PLAN_VERSION, planQuestion, validatePlan, type Plan } from "./plan";

export type StoredPlan = { ok: boolean; error?: string; plan?: Plan; costUsd: number; ms: number; searches: number; model: string | null; trigger: string };

/** A plan request with no result within this many minutes counts as lost. */
export const PLAN_RUNNING_MIN = 10;

export async function planStatus(db: SupabaseClient) {
  const { data: req } = await db.from("model_runs").select("id, computed_at, inputs").eq("kind", "plan_request").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const { data: plan } = await db.from("model_runs").select("id, computed_at, inputs, outputs").eq("kind", "portfolio_plan").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const running = !!req && (!plan || (plan.inputs as { request_id?: string }).request_id !== req.id) && Date.now() - new Date(req.computed_at).getTime() < PLAN_RUNNING_MIN * 60_000;
  return { running, startedAt: running ? (req!.computed_at as string) : null, latest: plan ? { at: plan.computed_at as string, ...(plan.outputs as StoredPlan) } : null };
}

/** Starts a rebuild unless one is already running. Returns the request id, or null when skipped. */
export async function startPlan(db: SupabaseClient, origin: string, token: string, trigger: string): Promise<string | null> {
  if ((await planStatus(db)).running) return null;
  const requestId = await save(db, "plan_request", PLAN_VERSION, { trigger }, {});
  await dispatchJob(origin, { job: "plan", requestId, token });
  return requestId;
}

export async function runPlanJob(db: SupabaseClient, requestId: string): Promise<string> {
  const { data: req } = await db.from("model_runs").select("id, inputs").eq("id", requestId).eq("kind", "plan_request").maybeSingle();
  if (!req) throw new Error("Unknown plan request");
  const trigger = String((req.inputs as { trigger?: string }).trigger ?? "manual");
  const out = (o: Omit<StoredPlan, "trigger">) => save(db, "portfolio_plan", PLAN_VERSION, { request_id: requestId, trigger }, { ...o, trigger });
  const ws = await buildWorkspace(db);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(ws.now);
  try {
    const ans = await runAgent(db, ws, { question: planQuestion(today, { ready: ws.research.filter((r) => r.pipeline.stage === "ready" && r.authoritative).map((r) => r.symbol), passed: ws.research.filter((r) => r.pipeline.stage === "passed").map((r) => r.symbol) }), system: PLAN_SYSTEM, limits: PLAN_LIMITS, page: "/plan" });
    const meta = { costUsd: ans.costUsd, ms: ans.ms, searches: ans.searches, model: ans.model };
    const plan = validatePlan(extractJson(ans.answer), {
      holdings: ws.portfolio.holdings.map((h) => ({ symbol: h.symbol, weight: h.weight })),
      researched: ws.research.filter((r) => r.current || r.latest).map((r) => ({ symbol: r.symbol, asOf: (r.current ?? r.latest)!.research_as_of, stage: r.pipeline.stage, approved: !!r.authoritative })),
      maxFor: (s) => (isEtf(s) ? null : companyMax(ws.policy, s)),
      deployable: ws.portfolio.cashDetail.deployable,
    });
    if ("error" in plan) return out({ ok: false, error: `${plan.error}${ans.stopped ? ` (stopped: ${ans.stopped})` : ""}`, ...meta });
    return out({ ok: true, plan, ...meta });
  } catch (e) {
    return out({ ok: false, error: (e as Error).message.slice(0, 300), costUsd: 0, ms: 0, searches: 0, model: null });
  }
}
