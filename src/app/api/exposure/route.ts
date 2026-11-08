/**
 * Market analysis of the portfolio's material exposures, as a background job (src/lib/exposure/reviewJob.ts).
 *   POST -> {requestId}  (refused when today's cost limit is reached or one is already running)
 *   GET  -> the latest request: {status: "none" | "running" | "lost" | "done", ...}
 */
import { createClient } from "@/lib/supabase/server";
import { dispatchJob, save } from "@/lib/intel/jobs";
import { DAILY_CAP, spentToday } from "@/lib/intel/start";
import { REVIEW_KIND, REVIEW_VERSION } from "@/lib/exposure/review";
import { RUNNING_WINDOW_MIN } from "@/lib/exposure/reviewJob";

export const runtime = "nodejs";
export const maxDuration = 30;

async function latest(db: Awaited<ReturnType<typeof createClient>>) {
  const { data: req } = await db.from("model_runs").select("id, computed_at").eq("kind", REVIEW_KIND.request).order("computed_at", { ascending: false }).limit(1).maybeSingle();
  if (!req) return { status: "none" as const };
  const { data: res } = await db.from("model_runs").select("id, computed_at, outputs").eq("kind", REVIEW_KIND.result).eq("inputs->>request_id", req.id).limit(1).maybeSingle();
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
  if ((await latest(db)).status === "running") return Response.json({ error: "An analysis is already running." }, { status: 409 });
  const spent = await spentToday(db);
  if (spent.answers >= DAILY_CAP.answers || spent.total >= DAILY_CAP.total) return Response.json({ error: `Today's cost limit is reached ($${spent.total.toFixed(2)} spent). It resets at midnight UTC.` }, { status: 429 });
  try {
    const requestId = await save(db, REVIEW_KIND.request, REVIEW_VERSION, { at: new Date().toISOString() }, {});
    await dispatchJob(new URL(req.url).origin, { job: "exposure", requestId, token });
    return Response.json({ requestId });
  } catch (e) {
    return Response.json({ error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}

export async function GET() {
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return Response.json({ error: "Sign in first." }, { status: 401 });
  return Response.json(await latest(db));
}
