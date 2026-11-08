/**
 * Full AI research for one company, run as a background job (src/lib/research/aiResearchJob.ts).
 *   POST {symbol}       -> {requestId}  (refused when today's cost limit is reached or one is already running)
 *   GET ?symbol=<SYM>   -> the latest request for that company: {status: "none" | "running" | "lost" | "done", ...}
 */
import { createClient } from "@/lib/supabase/server";
import { dispatchJob, save } from "@/lib/intel/jobs";
import { DAILY_CAP, spentToday } from "@/lib/intel/start";
import { budgetGate, loadSpend } from "@/lib/costs/spend";
import { RESEARCH_VERSION } from "@/lib/research/aiResearch";
import { RUNNING_WINDOW_MIN } from "@/lib/research/aiResearchJob";
import { isEtf } from "@/lib/portfolio/classify";

export const runtime = "nodejs";
export const maxDuration = 30;

const clean = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);

async function latest(db: Awaited<ReturnType<typeof createClient>>, symbol: string) {
  const { data: req } = await db.from("model_runs").select("id, computed_at").eq("kind", "research_request").eq("inputs->>symbol", symbol).order("computed_at", { ascending: false }).limit(1).maybeSingle();
  if (!req) return { status: "none" as const };
  const { data: res } = await db.from("model_runs").select("id, computed_at, outputs").eq("kind", "research_result").eq("inputs->>request_id", req.id).limit(1).maybeSingle();
  if (res) return { status: "done" as const, requestId: req.id, startedAt: req.computed_at, finishedAt: res.computed_at, result: res.outputs };
  const lost = Date.now() - new Date(req.computed_at).getTime() > RUNNING_WINDOW_MIN * 60_000;
  return { status: lost ? ("lost" as const) : ("running" as const), requestId: req.id, startedAt: req.computed_at };
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "The assistant is not configured yet: add ANTHROPIC_API_KEY in Netlify environment variables." }, { status: 503 });
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  const { data: s } = await db.auth.getSession();
  const token = s.session?.access_token;
  if (!auth.user || !token) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { symbol?: string; confirm?: boolean } | null;
  const symbol = clean(body?.symbol);
  if (!symbol) return Response.json({ error: "No company given." }, { status: 400 });
  if (isEtf(symbol)) return Response.json({ error: "Broad ETFs don't need company research." }, { status: 400 });
  const { data: company } = await db.from("companies").select("id").eq("symbol", symbol).maybeSingle();
  if ((await latest(db, symbol)).status === "running") return Response.json({ error: "Research on this company is already running." }, { status: 409 });
  const spent = await spentToday(db);
  if (spent.answers >= DAILY_CAP.answers || spent.total >= DAILY_CAP.total) return Response.json({ error: `Today's cost limit is reached ($${spent.total.toFixed(2)} spent; limits $${DAILY_CAP.answers} for questions and research, $${DAILY_CAP.total} in all). It resets at midnight UTC.` }, { status: 429 });
  const gate = budgetGate(await loadSpend(db), "research", 0.35, body?.confirm === true);
  if (!gate.ok) return Response.json({ error: gate.message, needsConfirm: gate.needsConfirm }, { status: 409 });
  if (!company) {
    // A stock not on the list yet is added as an idea, so research works for any ticker.
    const at = new Date().toISOString();
    const { error } = await db.from("companies").insert({ symbol, name: null, watchlist_status: "watch", pipeline_stage: "idea", pipeline_note: null, stage_updated_at: at, stage_history: [{ stage: "idea", at, note: "Added for AI research" }] });
    if (error) return Response.json({ error: `Could not add ${symbol}: ${error.message}` }, { status: 500 });
  }
  try {
    const requestId = await save(db, "research_request", RESEARCH_VERSION, { symbol }, {});
    await dispatchJob(new URL(req.url).origin, { job: "research", requestId, token });
    return Response.json({ requestId });
  } catch (e) {
    return Response.json({ error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}

export async function GET(req: Request) {
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const symbol = clean(new URL(req.url).searchParams.get("symbol"));
  if (!symbol) return Response.json({ error: "Give symbol." }, { status: 400 });
  return Response.json(await latest(db, symbol));
}
