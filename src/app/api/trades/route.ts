/**
 * Trade ideas (src/lib/trades).
 *   POST {focus?}  -> starts a search for a short-term trade: {requestId} or {skipped}
 *   GET            -> {running, latest}
 */
import { loadSpend, manualGate } from "@/lib/costs/spend";
import { createClient } from "@/lib/supabase/server";
import { confirmBlock, dailyCapBlock, spentToday } from "@/lib/intel/start";
import { scanStatus, startTradeScan } from "@/lib/trades/job";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "The assistant is not configured yet: add ANTHROPIC_API_KEY in Netlify environment variables." }, { status: 503 });
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  const { data: s } = await db.auth.getSession();
  if (!auth.user || !s.session?.access_token) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { focus?: string; confirm?: boolean };
  const focus = body.focus && /^[A-Za-z][A-Za-z0-9.-]{0,9}$/.test(body.focus.trim()) ? body.focus.trim().toUpperCase() : null;
  const spent = await spentToday(db);
  const daily = dailyCapBlock(spent);
  const gate = manualGate(await loadSpend(db), "trade_scan", body.confirm === true);
  const block = confirmBlock(daily, gate, body.confirm === true);
  if (block) return Response.json({ error: block, needsConfirm: true }, { status: 409 });
  try {
    const requestId = await startTradeScan(db, new URL(req.url).origin, s.session.access_token, "manual", focus);
    return Response.json(requestId ? { requestId } : { skipped: "A search is already running." });
  } catch (e) {
    return Response.json({ error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}

export async function GET() {
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return Response.json({ error: "Sign in first." }, { status: 401 });
  return Response.json(await scanStatus(db));
}
