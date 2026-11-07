/**
 * Starting a briefing: market snapshot (code), the desk plan, and the desk jobs. Used by the
 * Markets page (signed-in user) and by the morning schedule (intel-cron), so both run the same steps.
 */
import { startPlan } from "@/lib/plan/job";
import { startTradeScan } from "@/lib/trades/job";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildWorkspace } from "@/lib/workspace-core";
import { takeSnapshot } from "./snapshot";
import { DESKS, DESK_VERSION, type DeskResult } from "./desks";
import { portfolioContext, watchlist } from "./context";
import { briefingFor, dispatchJob, planDesks, recentMacro, save, type SnapshotInputs } from "./jobs";
import { AGENT_VERSION } from "@/lib/assistant/agent";

export async function startBriefing(db: SupabaseClient, token: string, origin: string, force = false) {
  const now = new Date();
  const [cachedMacro, plan, ws] = await Promise.all([recentMacro(db, now), planDesks(db, now, force), buildWorkspace(db)]);
  const snapshot = await takeSnapshot(now, { cachedMacro });
  if (snapshot.rows.length < 10) return { error: `Market data could not be retrieved (${snapshot.rows.length} of the panel loaded).`, fetchLog: snapshot.fetchLog };
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
  return { snapshotId, rows: snapshot.rows.length, missing: snapshot.missing.length, macro: snapshot.macro.length, macroSource: snapshot.macroSource, run: plan.run, reuse: plan.reuse, failedStart };
}

/** What has been spent today (UTC) on briefings, and on assistant answers plus company research (one shared bucket), from the stored rows. */
export async function spentToday(db: SupabaseClient, now = new Date()) {
  const since = `${now.toISOString().slice(0, 10)}T00:00:00Z`;
  const { data } = await db.from("model_runs").select("kind, outputs->>costUsd").in("kind", ["market_briefing", "assistant_answer", "research_result", "portfolio_plan", "watch_run", "trade_scan"]).gte("computed_at", since);
  let briefings = 0, answers = 0;
  for (const r of (data ?? []) as { kind: string; costUsd: string | null }[]) {
    const c = Number(r.costUsd ?? 0) || 0;
    if (r.kind === "market_briefing") briefings += c; else answers += c;
  }
  return { briefings, answers, total: briefings + answers };
}

/** Daily cost controls (US dollars). */
export const DAILY_CAP = { answers: 3, total: 5 };

/**
 * The scheduled morning run: today's briefing first, then the assistant's answer to MORNING_QUESTION,
 * which reads that briefing. Stops before spending anything when today's cost limit is reached.
 */
export async function runMorning(db: SupabaseClient, token: string, origin: string, ask: (requestId: string) => Promise<string>) {
  const spent = await spentToday(db);
  if (spent.total >= DAILY_CAP.total) return { skipped: `cost limit reached ($${spent.total.toFixed(2)} spent today)` };
  const b = await startBriefing(db, token, origin);
  if ("error" in b) console.error(`morning: briefing did not start: ${b.error}`);
  else {
    // Wait for the briefing to be written (usually 3-5 minutes), so the answer reads today's evidence.
    for (let i = 0; i < 40 && !(await briefingFor(db, b.snapshotId!)); i++) await new Promise((r) => setTimeout(r, 15000));
  }
  const requestId = await save(db, "assistant_request", AGENT_VERSION, { question: MORNING_QUESTION, mode: "app", purpose: "morning" }, {});
  const answerId = await ask(requestId);
  // The portfolio plan is rebuilt weekly (Mondays), after the briefing it reads.
  let plan: string | null = null;
  if (new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date()) === "Mon") {
    plan = await startPlan(db, origin, token, "weekly").catch((e) => { console.error(`morning: plan did not start: ${(e as Error).message}`); return null; });
  }
  // A weekly look for a short-term trade (Wednesdays), so ideas come without being asked; "none" is the usual answer.
  let trades: string | null = null;
  if (new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date()) === "Wed") {
    trades = await startTradeScan(db, origin, token, "weekly").catch((e) => { console.error(`morning: trade scan did not start: ${(e as Error).message}`); return null; });
  }
  return { briefing: "error" in b ? null : b.snapshotId, requestId, answerId, plan, trades };
}

export const MORNING_QUESTION ="Morning briefing. Using today's market briefing and my portfolio: what happened in markets and the world, and why it matters; where short-term and long-term conditions appear to be heading and what changed in that view; what changed for my specific holdings (filings, results, research that needs reassessment); what deserves my attention; what actions, if any, are justified (including holding cash); and which opportunities warrant more research. Lead with the conclusions in a few lines, then the explanation.";
