/**
 * Research investigations (src/lib/research/investigate): a full initial investigation or a
 * material-event refresh, run as a chain of background steps.
 *   POST {symbol, type: "full" | "refresh"}  -> {requestId}
 *   POST {symbol, resume: true}              -> restarts a stalled or paused run from its last checkpoint
 *   GET ?symbol=<SYM>                         -> the latest run's status and checkpoints (restarts a stalled run, at most 3 times)
 */
import { createClient } from "@/lib/supabase/server";
import { dispatchJob } from "@/lib/intel/jobs";
import { DAILY_CAP, spentToday } from "@/lib/intel/start";
import { isEtf } from "@/lib/portfolio/classify";
import { investigationStatus, resumeIfStalled, startInvestigation } from "@/lib/research/investigate/run";

export const runtime = "nodejs";
export const maxDuration = 30;

const clean = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "The assistant is not configured yet: add ANTHROPIC_API_KEY in Netlify environment variables." }, { status: 503 });
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  const { data: sess } = await db.auth.getSession();
  const token = sess.session?.access_token;
  if (!auth.user || !token) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { symbol?: string; type?: string; resume?: boolean } | null;
  const symbol = clean(body?.symbol);
  if (!symbol) return Response.json({ error: "No company given." }, { status: 400 });
  if (isEtf(symbol)) return Response.json({ error: "Broad ETFs don't need company research." }, { status: 400 });
  const st = await investigationStatus(db, symbol);
  const origin = new URL(req.url).origin;
  if (body?.resume) {
    if (st.status !== "stalled" && st.status !== "paused") return Response.json({ error: st.status === "running" ? "The research is still running." : "There is nothing to resume." }, { status: 409 });
    await resumeIfStalled(db, st.requestId!, () => dispatchJob(origin, { job: "investigate", requestId: st.requestId!, token }), true);
    return Response.json({ requestId: st.requestId });
  }
  if (st.status === "running") return Response.json({ error: "Research on this company is already running." }, { status: 409 });
  const type = body?.type === "refresh" ? "material_event_refresh" : "full_investigation";
  const { data: company } = await db.from("companies").select("id, research_versions(id)").eq("symbol", symbol).maybeSingle();
  if (!company) {
    const at = new Date().toISOString();
    const { error } = await db.from("companies").insert({ symbol, name: null, watchlist_status: "watch", pipeline_stage: "idea", pipeline_note: null, stage_updated_at: at, stage_history: [{ stage: "idea", at, note: "Added for research" }] });
    if (error) return Response.json({ error: `Could not add ${symbol}: ${error.message}` }, { status: 500 });
  }
  if (type === "material_event_refresh" && !(company?.research_versions ?? []).length) return Response.json({ error: "There is no earlier research to refresh. Run a full investigation first." }, { status: 400 });
  const spent = await spentToday(db);
  if (spent.answers >= DAILY_CAP.answers || spent.total >= DAILY_CAP.total) return Response.json({ error: `Today's cost limit is reached ($${spent.total.toFixed(2)} spent). It resets at midnight UTC.` }, { status: 429 });
  try {
    const requestId = await startInvestigation(db, symbol, type);
    await dispatchJob(origin, { job: "investigate", requestId, token });
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
  const st = await investigationStatus(db, symbol);
  // A run whose hand-off between steps was lost is restarted from its last checkpoint when anyone
  // looks at it (the scheduled sweep does the same when nobody is looking). Capped in resumeIfStalled.
  if (st.status === "stalled" && st.autoResume && process.env.ANTHROPIC_API_KEY) {
    const { data: sess } = await db.auth.getSession();
    const token = sess.session?.access_token;
    const restarted = token ? await resumeIfStalled(db, st.requestId, () => dispatchJob(new URL(req.url).origin, { job: "investigate", requestId: st.requestId, token })).catch(() => false) : false;
    if (restarted) return Response.json({ ...st, status: "running", autoResumed: true });
  }
  return Response.json(st);
}
