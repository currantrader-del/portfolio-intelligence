/**
 * Daily briefing. This route does only the quick parts; research and writing run as background jobs
 * (see src/lib/intel/jobs.ts and netlify/functions/intel-job-background.mts):
 *   POST start       -> market snapshot (code), the desk plan, and the desk jobs started
 *   POST synthesize  -> starts the writing job (the browser's fallback if no desk job started it)
 *   GET ?snapshotId= -> progress: which desks have stored results, and whether the briefing exists
 * Every stored row is new (nothing is updated), with its inputs hashed, so every briefing can be audited.
 */
import { createClient } from "@/lib/supabase/server";
import { buildWorkspace } from "@/lib/workspace";
import { takeSnapshot, type Snapshot } from "@/lib/intel/snapshot";
import { DESKS, DESK_VERSION, type DeskResult } from "@/lib/intel/desks";
import { costOf } from "@/lib/intel/run";
import { portfolioContext, watchlist } from "@/lib/intel/context";
import { briefingFor, deskRows, dispatchJob, planDesks, recentMacro, save, type SnapshotInputs } from "@/lib/intel/jobs";

export const runtime = "nodejs";
export const maxDuration = 60;

async function session() {
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  const { data: s } = await db.auth.getSession();
  return { db, user: auth.user, token: s.session?.access_token ?? null };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { action?: string; snapshotId?: string; force?: boolean } | null;
  const { db, user, token } = await session();
  if (!user || !token) return Response.json({ error: "Sign in first." }, { status: 401 });
  const origin = new URL(req.url).origin;
  try {
    if (body?.action === "start") {
      if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "ANTHROPIC_API_KEY is not set in Netlify." }, { status: 503 });
      const now = new Date();
      const [cachedMacro, plan, ws] = await Promise.all([recentMacro(db, now), planDesks(db, now, !!body.force), buildWorkspace(db)]);
      const snapshot = await takeSnapshot(now, { cachedMacro });
      if (snapshot.rows.length < 10) return Response.json({ error: `Market data could not be retrieved (${snapshot.rows.length} of the panel loaded).`, fetchLog: snapshot.fetchLog }, { status: 502 });
      const inputs: SnapshotInputs = { at: snapshot.takenAt, provider: "yahoo+fred", holdings: ws.portfolio.holdings.map((h) => h.symbol), watch: watchlist(ws), portfolio: portfolioContext(ws), plan, names: Object.fromEntries(ws.research.filter((r) => r.name).map((r) => [r.symbol, r.name!])) };
      const snapshotId = await save(db, "market_snapshot", snapshot.version, inputs, snapshot);
      const started = await Promise.allSettled(plan.run.map((k) => dispatchJob(origin, { job: "desk", snapshotId, desk: k, token })));
      // A desk whose job could not start is recorded as failed, so the briefing does not wait for it.
      const failedStart = plan.run.flatMap((k, i) => { const r = started[i]; return r.status === "rejected" ? [`${k}: ${(r.reason as Error)?.message ?? "did not start"}`] : []; });
      for (const f of failedStart) {
        const k = f.split(":")[0] as (typeof plan.run)[number];
        const d = DESKS.find((x) => x.key === k)!;
        await save(db, "briefing_desk", DESK_VERSION, { snapshot_id: snapshotId, desk: k, holdings: inputs.holdings }, { version: DESK_VERSION, desk: k, title: d.title, generatedAt: now.toISOString(), model: "", items: [], calendar: [], uncertainties: [], searches: 0, pagesReturned: 0, problems: [], usage: { input: 0, output: 0, searches: 0 }, status: "failed", error: f, ms: 0, requests: [] } satisfies DeskResult);
      }
      if (!plan.run.length || failedStart.length === plan.run.length) await dispatchJob(origin, { job: "synthesize", snapshotId, token });
      return Response.json({
        snapshotId, rows: snapshot.rows.length, missing: snapshot.missing.length, macro: snapshot.macro.length, macroSource: snapshot.macroSource,
        run: plan.run, reuse: plan.reuse, failedStart,
      });
    }
    if (body?.action === "synthesize" && body.snapshotId) {
      if (await briefingFor(db, body.snapshotId)) return Response.json({ ok: true, already: true });
      await dispatchJob(origin, { job: "synthesize", snapshotId: body.snapshotId, token });
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).message.slice(0, 300) }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("snapshotId");
  const { db, user } = await session();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!id) return Response.json({ error: "snapshotId is required." }, { status: 400 });
  const { data: snap } = await db.from("model_runs").select("id, computed_at, inputs, outputs").eq("id", id).eq("kind", "market_snapshot").maybeSingle();
  if (!snap) return Response.json({ error: "Unknown snapshot." }, { status: 404 });
  const inputs = snap.inputs as SnapshotInputs;
  const s = snap.outputs as Snapshot;
  const rows = await deskRows(db, id);
  const desks = DESKS.map((d) => {
    const reused = inputs.plan?.reuse?.[d.key];
    if (reused) return { key: d.key, state: "reused", note: `reused research from ${reused.at}` };
    const r = rows.get(d.key)?.result as DeskResult | undefined;
    if (!r) return { key: d.key, state: "run", note: null };
    if (r.status === "failed") return { key: d.key, state: "fail", note: r.error ?? "failed" };
    const checked = r.items.filter((i) => i.check && i.check.status !== "not_checked").length;
    const what = d.key === "events" ? `${r.calendar.length} events, ${r.calendar.filter((c) => c.status === "confirmed").length} confirmed` : `${r.items.length} items, ${checked} checked on their pages`;
    return { key: d.key, state: "done", note: `${what}, ${r.searches} searches, ${Math.round((r.ms ?? 0) / 1000)}s, $${costOf(r.usage).toFixed(2)}` };
  });
  const b = await briefingFor(db, id);
  return Response.json({ snapshotId: id, startedAt: snap.computed_at, rows: s.rows.length, macro: s.macro.length, macroSource: s.macroSource, desks, briefingId: b?.id ?? null });
}
