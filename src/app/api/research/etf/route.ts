/**
 * The ETF check (src/lib/research/etfJob.ts), started by you.
 *   POST {symbol, confirm?} -> {requestId}  (asks first past today's limit, a budget, or the approval threshold)
 *   GET ?symbol=<SYM>       -> the latest check: {status: "none" | "running" | "lost" | "done", ...}
 */
import { createClient } from "@/lib/supabase/server";
import { dispatchJob, save } from "@/lib/intel/jobs";
import { confirmBlock, dailyCapBlock, spentToday } from "@/lib/intel/start";
import { budgetGate, loadSpend } from "@/lib/costs/spend";
import { ETF_CHECK_ESTIMATE, ETF_CHECK_VERSION, ETF_RUNNING_WINDOW_MIN } from "@/lib/research/etf";
import { isEtf } from "@/lib/portfolio/classify";
import { FUNDS } from "@/lib/exposure/reference";

export const runtime = "nodejs";
export const maxDuration = 30;

const clean = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);

async function latest(db: Awaited<ReturnType<typeof createClient>>, symbol: string) {
  const { data: req } = await db.from("model_runs").select("id, computed_at").eq("kind", "etf_check_request").eq("inputs->>symbol", symbol).order("computed_at", { ascending: false }).limit(1).maybeSingle();
  if (!req) return { status: "none" as const };
  const { data: res } = await db.from("model_runs").select("id, computed_at, outputs").eq("kind", "etf_check").eq("inputs->>request_id", req.id).limit(1).maybeSingle();
  if (res) return { status: "done" as const, requestId: req.id, startedAt: req.computed_at, finishedAt: res.computed_at, result: res.outputs };
  const lost = Date.now() - new Date(req.computed_at).getTime() > ETF_RUNNING_WINDOW_MIN * 60_000;
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
  if (!symbol) return Response.json({ error: "No fund given." }, { status: 400 });
  if (!isEtf(symbol) && !FUNDS[symbol]) return Response.json({ error: `${symbol} is not a fund the app knows. Company research is on its research page.` }, { status: 400 });
  if ((await latest(db, symbol)).status === "running") return Response.json({ error: "A check on this fund is already running." }, { status: 409 });
  const daily = dailyCapBlock(await spentToday(db));
  const gate = budgetGate(await loadSpend(db), "research", ETF_CHECK_ESTIMATE.high, body?.confirm === true);
  const block = confirmBlock(daily, gate, body?.confirm === true);
  if (block) return Response.json({ error: block, needsConfirm: true }, { status: 409 });
  try {
    const requestId = await save(db, "etf_check_request", ETF_CHECK_VERSION, { symbol, at: new Date().toISOString() }, {});
    await dispatchJob(new URL(req.url).origin, { job: "etf_check", requestId, token });
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
  if (!symbol) return Response.json({ error: "No fund given." }, { status: 400 });
  return Response.json(await latest(db, symbol));
}
