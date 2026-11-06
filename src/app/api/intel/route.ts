/**
 * Daily briefing pipeline, split into short steps so each one stays inside the hosting time limit:
 *   start      -> market snapshot (code), stored as model_runs "market_snapshot"
 *   desk       -> one research desk with web search, stored as "briefing_desk"
 *   synthesize -> outlooks and portfolio implications, stored as "market_briefing"
 * Each stored row is new (nothing is updated), with its inputs hashed, so every briefing can be audited.
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { buildWorkspace } from "@/lib/workspace";
import { takeSnapshot, type Snapshot } from "@/lib/intel/snapshot";
import { DESKS, type DeskKey, type DeskResult } from "@/lib/intel/desks";
import { costOf, runDesk, runSynthesis, SYNTHESIS_VERSION } from "@/lib/intel/run";
import { portfolioContext, watchlist } from "@/lib/intel/context";
import { mergedCalendar } from "@/lib/intel/synthesis";

export const runtime = "nodejs";
export const maxDuration = 60;

const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { action?: string; snapshotId?: string; desk?: string } | null;
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const save = async (kind: string, version: string, inputs: unknown, outputs: unknown) => {
    const { data, error } = await db.from("model_runs").insert({ kind, code_version: version, inputs, inputs_sha256: sha(inputs), outputs }).select("id").single();
    if (error) throw error;
    return data.id as string;
  };

  try {
    if (body?.action === "start") {
      const snapshot = await takeSnapshot(new Date());
      if (snapshot.rows.length < 10) return Response.json({ error: `Market data could not be retrieved (${snapshot.rows.length} of the panel loaded).` }, { status: 502 });
      const id = await save("market_snapshot", snapshot.version, { at: snapshot.takenAt, provider: "yahoo+fred" }, snapshot);
      return Response.json({ snapshotId: id, rows: snapshot.rows.length, missing: snapshot.missing.length, macro: snapshot.macro.length });
    }

    if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "ANTHROPIC_API_KEY is not set in Netlify." }, { status: 503 });
    const snap = body?.snapshotId ? await db.from("model_runs").select("id, outputs").eq("id", body.snapshotId).eq("kind", "market_snapshot").maybeSingle() : null;
    if (!snap?.data) return Response.json({ error: "Unknown snapshot." }, { status: 400 });
    const snapshot = snap.data.outputs as Snapshot;

    if (body?.action === "desk") {
      const key = body.desk as DeskKey;
      if (!DESKS.some((d) => d.key === key)) return Response.json({ error: "Unknown desk." }, { status: 400 });
      const ws = await buildWorkspace(db);
      const holdings = ws.portfolio.holdings.map((h) => h.symbol);
      const result = await runDesk(key, { now: new Date(), snapshot, holdings, watch: watchlist(ws) });
      const id = await save("briefing_desk", result.version, { snapshot_id: snap.data.id, desk: key, holdings }, result);
      return Response.json({ deskId: id, items: result.items.length, unsourced: result.items.filter((i) => i.unsourced).length, calendar: result.calendar.length, searches: result.searches, costUsd: costOf(result.usage) });
    }

    if (body?.action === "synthesize") {
      const { data: rows } = await db.from("model_runs").select("id, outputs").eq("kind", "briefing_desk").eq("inputs->>snapshot_id", snap.data.id).order("computed_at", { ascending: true });
      // Latest result per desk, in desk order.
      const byDesk = new Map<string, { id: string; outputs: DeskResult }>();
      for (const r of rows ?? []) byDesk.set((r.outputs as DeskResult).desk, r as { id: string; outputs: DeskResult });
      const desks = DESKS.map((d) => byDesk.get(d.key)).filter((x): x is { id: string; outputs: DeskResult } => !!x);
      const ws = await buildWorkspace(db);
      const portfolio = portfolioContext(ws);
      const out = await runSynthesis({ now: new Date(), snapshot, desks: desks.map((d) => d.outputs), portfolio });
      const missingDesks = DESKS.filter((d) => !byDesk.has(d.key)).map((d) => d.title);
      const usage = desks.reduce((u, d) => ({ input: u.input + d.outputs.usage.input, output: u.output + d.outputs.usage.output, searches: u.searches + d.outputs.usage.searches }), out.usage);
      const briefing = {
        version: SYNTHESIS_VERSION, generatedAt: new Date().toISOString(), model: out.model,
        snapshotId: snap.data.id, deskIds: desks.map((d) => d.id), missingDesks,
        synthesis: out.synthesis, calendar: mergedCalendar(desks.map((d) => d.outputs)), problems: out.problems,
        costUsd: Number(costOf(usage).toFixed(4)),
      };
      const id = await save("market_briefing", SYNTHESIS_VERSION, { snapshot_id: snap.data.id, desk_ids: briefing.deskIds, portfolio }, briefing);
      return Response.json({ briefingId: id, problems: out.problems.length, costUsd: briefing.costUsd });
    }
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Anthropic.APIError ? `The AI service returned an error (${e.status}): ${e.message.slice(0, 200)}` : (e as Error).message.slice(0, 300);
    return Response.json({ error: msg }, { status: 500 });
  }
}
