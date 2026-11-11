/**
 * The 30-day proof-of-value log (2026-11-09 direction). Everything is stored in model_runs (no new tables):
 *   eval_feedback        your verdict on an alert (useful, false, repetitive) or an event the app missed
 *   eval_recommendation  each morning's recommendation, with the research versions, prices and data it used
 *   paper_decision       a hypothetical buy or trim recorded when an action plan's entry criteria were met,
 *                        with the VOO price at the same moment, so outcomes can be compared over matching periods
 * Nothing here trades, moves money or changes research.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { save } from "@/lib/intel/jobs";
import type { DecisionAlert } from "@/lib/watch/decisionAlerts";

export const EVAL_VERSION = "eval@1";
export type Verdict = "useful" | "false" | "repetitive" | "missed";
export const VERDICT_LABEL: Record<Verdict, string> = { useful: "Useful", false: "False or misleading", repetitive: "Repetitive or unnecessary", missed: "Missed event" };

export type Feedback = { verdict: Verdict; runId: string | null; alertId: string | null; symbol: string | null; note: string | null; at: string };

export async function saveFeedback(db: SupabaseClient, f: Omit<Feedback, "at">) {
  return save(db, "eval_feedback", EVAL_VERSION, { run_id: f.runId, alert_id: f.alertId }, { ...f, at: new Date().toISOString() });
}

/** Latest verdict per alert (a later click replaces an earlier one), plus every missed-event report. */
export async function loadFeedback(db: SupabaseClient, sinceDays = 45): Promise<{ byAlert: Map<string, Verdict>; all: (Feedback & { id: string })[] }> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const { data } = await db.from("model_runs").select("id, outputs").eq("kind", "eval_feedback").gte("computed_at", since).order("computed_at", { ascending: true }).limit(2000);
  const all = ((data ?? []) as { id: string; outputs: Feedback }[]).map((r) => ({ ...r.outputs, id: r.id }));
  const byAlert = new Map<string, Verdict>();
  for (const f of all) if (f.runId && f.alertId) byAlert.set(`${f.runId}|${f.alertId}`, f.verdict);
  return { byAlert, all };
}

export type PaperDecision = {
  symbol: string; side: "buy" | "trim"; price: number; vooPrice: number | null; at: string;
  reason: string; researchVersionId: string | null; researchAsOf: string | null; alertId: string;
};

/** Records a paper decision for each actionable alert (buy opportunity or trim review), once per alert id. */
export async function recordPaperDecisions(db: SupabaseClient, alerts: DecisionAlert[], ctx: { vooPrice: number | null; now: Date }): Promise<number> {
  const actionable = alerts.filter((a) => (a.category === "buy_opportunity" || a.category === "position_review") && a.price);
  if (!actionable.length) return 0;
  const { data } = await db.from("model_runs").select("outputs").eq("kind", "paper_decision").limit(2000);
  const have = new Set(((data ?? []) as { outputs: PaperDecision }[]).map((r) => r.outputs.alertId));
  let n = 0;
  for (const a of actionable) {
    if (have.has(a.id)) continue;
    const d: PaperDecision = {
      symbol: a.symbol, side: a.category === "buy_opportunity" ? "buy" : "trim", price: a.price!, vooPrice: ctx.vooPrice, at: ctx.now.toISOString(),
      reason: `${a.title}. ${a.action}`, researchVersionId: a.researchVersionId ?? null, researchAsOf: a.researchAsOf ?? null, alertId: a.id,
    };
    await save(db, "paper_decision", EVAL_VERSION, { symbol: d.symbol, alert_id: d.alertId }, d);
    n++;
  }
  return n;
}

/** A paper decision's result against VOO over the same period. Pure. */
export function paperResult(d: PaperDecision, price: number | null, vooPrice: number | null): { returnPct: number | null; vooPct: number | null; edgePct: number | null } {
  const r = price && d.price ? price / d.price - 1 : null;
  const v = vooPrice && d.vooPrice ? vooPrice / d.vooPrice - 1 : null;
  // A trim is judged as moving the money into VOO: its edge is VOO's return minus the stock's.
  const signed = r === null ? null : d.side === "buy" ? r : -r;
  const vooSigned = v === null ? null : d.side === "buy" ? v : -v;
  return { returnPct: r, vooPct: v, edgePct: signed !== null && vooSigned !== null ? signed - vooSigned : null };
}

/**
 * What you actually did about a recommendation, alert or Radar idea (one tap: "I did this" or "I passed"),
 * with the price and VOO at that moment, so the test can compare what the app said with what you did and
 * how each turned out. A later tap on the same item replaces an earlier one. Stored as model_runs "eval_action".
 */
export type MyAction = "did" | "passed";
export type ActionSubject = "recommendation" | "alert" | "radar";
export const MY_ACTION_LABEL: Record<MyAction, string> = { did: "You did this", passed: "You passed" };
export type ActionRecord = { subject: ActionSubject; ref: string; symbol: string | null; summary: string; action: MyAction; note: string | null; price: number | null; vooPrice: number | null; at: string };

export const actionRef = (subject: ActionSubject, id: string) => `${subject}:${id}`;

export async function saveMyAction(db: SupabaseClient, r: Omit<ActionRecord, "at">) {
  return save(db, "eval_action", EVAL_VERSION, { ref: actionRef(r.subject, r.ref) }, { ...r, at: new Date().toISOString() });
}

/** Latest tap per item, keyed by actionRef(subject, id). */
export async function loadMyActions(db: SupabaseClient, sinceDays = 60): Promise<Map<string, ActionRecord>> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const { data } = await db.from("model_runs").select("outputs").eq("kind", "eval_action").gte("computed_at", since).order("computed_at", { ascending: true }).limit(2000);
  const m = new Map<string, ActionRecord>();
  for (const r of (data ?? []) as { outputs: ActionRecord }[]) m.set(actionRef(r.outputs.subject, r.outputs.ref), r.outputs);
  return m;
}

/** Counts for the test summary. Pure. */
export function actionCounts(all: Iterable<ActionRecord>) {
  let did = 0, passed = 0;
  for (const a of all) if (a.action === "did") did++; else passed++;
  return { did, passed };
}
