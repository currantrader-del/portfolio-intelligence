/**
 * The assistant. Questions run as background jobs (src/lib/assistant/jobs.ts), so research that
 * takes a few minutes is not cut off; the browser polls for the stored answer.
 *   POST {messages, page, symbol, deep}  -> {requestId}
 *   POST {action: "demo"}                -> the five test questions, each also asked of plain Claude
 *   POST {action: "morning"}             -> writes the morning briefing now (also scheduled each weekday)
 *   GET ?id=<requestId>                  -> {status: "running" | "done", answer?}
 *   GET ?demo=<demoId>                   -> every request and answer of one demo run
 */
import { createClient } from "@/lib/supabase/server";
import { dispatchJob, save } from "@/lib/intel/jobs";
import { AGENT_VERSION } from "@/lib/assistant/agent";
import { DEMO_QUESTIONS, type AskRequest } from "@/lib/assistant/jobs";
import { DAILY_CAP, MORNING_QUESTION, spentToday } from "@/lib/intel/start";

export const runtime = "nodejs";
export const maxDuration = 30;

type ClientMsg = { role: "user" | "assistant"; content: string };

async function session() {
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  const { data: s } = await db.auth.getSession();
  return { db, user: auth.user, token: s.session?.access_token ?? null };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { action?: string; messages?: ClientMsg[]; page?: string; symbol?: string | null; deep?: boolean } | null;
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "The assistant is not configured yet: add ANTHROPIC_API_KEY in Netlify environment variables." }, { status: 503 });
  const { db, user, token } = await session();
  if (!user || !token) return Response.json({ error: "Sign in first." }, { status: 401 });
  const origin = new URL(req.url).origin;
  const start = async (r: AskRequest) => {
    const id = await save(db, "assistant_request", AGENT_VERSION, r, {});
    await dispatchJob(origin, { job: "ask", requestId: id, token });
    return id;
  };
  const spent = await spentToday(db);
  if (spent.answers >= DAILY_CAP.answers || spent.total >= DAILY_CAP.total) return Response.json({ error: `Today's cost limit is reached ($${spent.total.toFixed(2)} spent; limits $${DAILY_CAP.answers} for questions, $${DAILY_CAP.total} in all). It resets at midnight UTC.` }, { status: 429 });
  try {
    if (body?.action === "morning") {
      const requestId = await start({ question: MORNING_QUESTION, mode: "app", purpose: "morning" });
      return Response.json({ requestId });
    }
    if (body?.action === "demo") {
      const demo = `demo-${new Date().toISOString()}`;
      const ids = await Promise.all(DEMO_QUESTIONS.flatMap((q) => (["app", "baseline"] as const).map((mode) => start({ question: q, mode, demo }))));
      return Response.json({ demo, requestIds: ids });
    }
    const history = (body?.messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-11);
    const last = history.pop();
    if (!last || last.role !== "user") return Response.json({ error: "No question." }, { status: 400 });
    const requestId = await start({ question: last.content.slice(0, 4000), history: history.map((m) => ({ role: m.role, content: m.content.slice(0, 6000) })), page: body?.page ?? null, symbol: body?.symbol ?? null, deep: !!body?.deep, mode: "app" });
    return Response.json({ requestId });
  } catch (e) {
    return Response.json({ error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}

export async function GET(req: Request) {
  const { db, user } = await session();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const u = new URL(req.url);
  const id = u.searchParams.get("id");
  const demo = u.searchParams.get("demo");
  if (id) {
    const { data } = await db.from("model_runs").select("id, computed_at, outputs").eq("kind", "assistant_answer").eq("inputs->>request_id", id).limit(1).maybeSingle();
    return Response.json(data ? { status: "done", answerId: data.id, answer: data.outputs } : { status: "running" });
  }
  if (demo) {
    const { data } = await db.from("model_runs").select("id, computed_at, inputs, outputs").eq("kind", "assistant_answer").eq("inputs->>demo", demo).order("computed_at");
    return Response.json({ demo, answers: data ?? [] });
  }
  return Response.json({ error: "Give id or demo." }, { status: 400 });
}
