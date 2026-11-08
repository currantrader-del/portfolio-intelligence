/**
 * The portfolio plan (src/lib/plan).
 *   POST          -> starts a rebuild: {requestId} or {skipped: "already running"}
 *   GET           -> {running, startedAt, latest}
 */
import { loadSpend, manualGate } from "@/lib/costs/spend";
import { createClient } from "@/lib/supabase/server";
import { DAILY_CAP, spentToday } from "@/lib/intel/start";
import { planStatus, startPlan } from "@/lib/plan/job";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "The assistant is not configured yet: add ANTHROPIC_API_KEY in Netlify environment variables." }, { status: 503 });
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  const { data: s } = await db.auth.getSession();
  if (!auth.user || !s.session?.access_token) return Response.json({ error: "Sign in first." }, { status: 401 });
  const spent = await spentToday(db);
  if (spent.answers >= DAILY_CAP.answers || spent.total >= DAILY_CAP.total) return Response.json({ error: `Today's cost limit is reached ($${spent.total.toFixed(2)} spent). It resets at midnight UTC.` }, { status: 429 });
  const body = (await req.json().catch(() => ({}))) as { confirm?: boolean };
  const gate = manualGate(await loadSpend(db), "portfolio_plan", body.confirm === true);
  if (!gate.ok) return Response.json({ error: gate.message, needsConfirm: gate.needsConfirm }, { status: 409 });
  try {
    const requestId = await startPlan(db, new URL(req.url).origin, s.session.access_token, "manual");
    return Response.json(requestId ? { requestId } : { skipped: "A rebuild is already running." });
  } catch (e) {
    return Response.json({ error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}

export async function GET() {
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return Response.json({ error: "Sign in first." }, { status: 401 });
  return Response.json(await planStatus(db));
}
