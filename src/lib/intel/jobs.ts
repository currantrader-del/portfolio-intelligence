/**
 * The briefing as independent jobs. Each step stores its own result (model_runs rows are only ever
 * inserted), so a slow or failed step never loses the others:
 *   start (Next route)      -> market_snapshot row with the plan: which desks run, which are reused
 *   desk  (background job)  -> one briefing_desk row per desk, "ok" or "failed"
 *   synthesize (background) -> market_briefing row with coverage and outlook gates
 * The last desk to finish starts the synthesis; the browser only watches and has a fallback.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DESKS, DESK_VERSION, type DeskKey, type DeskResult } from "./desks";
import { costOf, runDesk, runSynthesis, SYNTHESIS_VERSION } from "./run";
import { runHoldingsDesk } from "./holdings";
import { mergedCalendar, type PortfolioContext, type PreviousOutlook, type Stance, type Synthesis } from "./synthesis";
import { computeObservations, OBSERVATIONS_VERSION, type Observation } from "./observations";
import { computeCoverage, type Coverage } from "./coverage";
import type { Snapshot } from "./snapshot";

export const JOB_PATH = "/.netlify/functions/intel-job-background";
/** How long a desk's research is reused before it is searched again. */
export const DESK_TTL_MIN: Record<DeskKey, number> = { world: 60, us: 60, markets: 60, events: 12 * 60, holdings: 30 };
/** How long FRED data is reused: the series are daily at most, most are monthly. */
export const MACRO_TTL_MIN = 6 * 60;
/** A desk with no result after this long is treated as unavailable. */
export const DESK_DEADLINE_MIN = 8;

export type Plan = { run: DeskKey[]; reuse: Partial<Record<DeskKey, { id: string; at: string }>> };
export type SnapshotInputs = { at: string; provider: string; holdings: string[]; watch: string[]; portfolio: PortfolioContext; plan: Plan; names?: Record<string, string> };
export type Briefing = {
  version: string; generatedAt: string; model: string; snapshotId: string; deskIds: string[]; missingDesks: string[];
  synthesis: Synthesis; calendar: DeskResult["calendar"]; problems: string[];
  costUsd: number; coverage?: Coverage; ms?: number; reused?: Partial<Record<DeskKey, string>>;
  /** Added 2026-11-06 (synthesis@2). */
  observations?: { version: string; items: Observation[]; unavailable: string[] };
  outlookChange?: OutlookChange;
};
export type OutlookChange = { previousId: string | null; previousAt: string | null; shortTerm: { from: Stance | null; to: Stance }; longTerm: { from: Stance | null; to: Stance } };

/** The stance change against the previous briefing; null "from" means there was none. Pure, tested. */
export function outlookChange(prev: { id: string; at: string; synthesis: Pick<Synthesis, "shortTerm" | "longTerm"> } | null, now: Pick<Synthesis, "shortTerm" | "longTerm">): OutlookChange {
  return {
    previousId: prev?.id ?? null, previousAt: prev?.at ?? null,
    shortTerm: { from: prev?.synthesis.shortTerm?.stance ?? null, to: now.shortTerm.stance },
    longTerm: { from: prev?.synthesis.longTerm?.stance ?? null, to: now.longTerm.stance },
  };
}

async function previousBriefing(db: SupabaseClient, before: string) {
  const { data } = await db.from("model_runs").select("id, computed_at, outputs").eq("kind", "market_briefing").lt("computed_at", before).order("computed_at", { ascending: false }).limit(1).maybeSingle();
  return data ? { id: data.id as string, at: data.computed_at as string, synthesis: (data.outputs as Briefing).synthesis } : null;
}

const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

export async function save(db: SupabaseClient, kind: string, version: string, inputs: unknown, outputs: unknown) {
  const { data, error } = await db.from("model_runs").insert({ kind, code_version: version, inputs, inputs_sha256: sha(inputs), outputs }).select("id").single();
  if (error) throw new Error(`Could not save ${kind}: ${error.message}`);
  return data.id as string;
}

/** Desks whose recent research can be reused instead of searching again. */
export async function planDesks(db: SupabaseClient, now: Date, force = false): Promise<Plan> {
  const plan: Plan = { run: [], reuse: {} };
  for (const d of DESKS) {
    if (!force) {
      const since = new Date(now.getTime() - DESK_TTL_MIN[d.key] * 60000).toISOString();
      const { data } = await db.from("model_runs").select("id, computed_at, outputs").eq("kind", "briefing_desk").eq("outputs->>desk", d.key).eq("outputs->>version", DESK_VERSION).gte("computed_at", since).order("computed_at", { ascending: false }).limit(3);
      const hit = (data ?? []).find((r) => { const o = r.outputs as DeskResult; return o.status === "ok" && (d.key === "events" ? o.calendar.length : d.key === "holdings" ? 1 : o.items.length) > 0; });
      if (hit) { plan.reuse[d.key] = { id: hit.id, at: hit.computed_at }; continue; }
    }
    plan.run.push(d.key);
  }
  return plan;
}

export async function recentMacro(db: SupabaseClient, now: Date) {
  const since = new Date(now.getTime() - MACRO_TTL_MIN * 60000).toISOString();
  const { data } = await db.from("model_runs").select("id, computed_at, outputs").eq("kind", "market_snapshot").gte("computed_at", since).order("computed_at", { ascending: false }).limit(5);
  const hit = (data ?? []).find((r) => { const s = r.outputs as Snapshot; return s.macro?.length >= 14 && s.macroSource?.kind !== "reused"; });
  return hit ? { snapshotId: hit.id as string, takenAt: hit.computed_at as string, macro: (hit.outputs as Snapshot).macro } : null;
}

async function loadSnapshot(db: SupabaseClient, snapshotId: string) {
  const { data, error } = await db.from("model_runs").select("id, computed_at, inputs, outputs").eq("id", snapshotId).eq("kind", "market_snapshot").maybeSingle();
  if (error || !data) throw new Error("Unknown snapshot");
  return { id: data.id as string, at: data.computed_at as string, inputs: data.inputs as SnapshotInputs, snapshot: data.outputs as Snapshot };
}

export async function deskRows(db: SupabaseClient, snapshotId: string) {
  const { data } = await db.from("model_runs").select("id, computed_at, outputs").eq("kind", "briefing_desk").eq("inputs->>snapshot_id", snapshotId).order("computed_at", { ascending: true });
  const by = new Map<DeskKey, { id: string; at: string; result: DeskResult }>();
  for (const r of data ?? []) by.set((r.outputs as DeskResult).desk, { id: r.id, at: r.computed_at, result: r.outputs as DeskResult });
  return by;
}

export async function runDeskJob(db: SupabaseClient, snapshotId: string, key: DeskKey) {
  const s = await loadSnapshot(db, snapshotId);
  const desk = DESKS.find((d) => d.key === key)!;
  const started = Date.now();
  let result: DeskResult;
  try {
    result = key === "holdings"
      ? await runHoldingsDesk(db, s.inputs.portfolio, new Date())
      : await runDesk(key, { now: new Date(), snapshot: s.snapshot, holdings: s.inputs.holdings, watch: s.inputs.watch, names: s.inputs.names });
  } catch (e) {
    result = {
      version: DESK_VERSION, desk: key, title: desk.title, generatedAt: new Date().toISOString(), model: "", items: [], calendar: [], uncertainties: [],
      searches: 0, pagesReturned: 0, problems: [], usage: { input: 0, output: 0, searches: 0 },
      status: "failed", error: (e as Error).message.slice(0, 300), startedAt: new Date(started).toISOString(), ms: Date.now() - started, requests: [],
    };
  }
  return save(db, "briefing_desk", DESK_VERSION, { snapshot_id: snapshotId, desk: key, holdings: s.inputs.holdings }, result);
}

/** True when every desk this run started has stored a result. */
export async function desksSettled(db: SupabaseClient, snapshotId: string) {
  const s = await loadSnapshot(db, snapshotId);
  const rows = await deskRows(db, snapshotId);
  return s.inputs.plan.run.every((k) => rows.has(k));
}

export async function briefingFor(db: SupabaseClient, snapshotId: string) {
  const { data } = await db.from("model_runs").select("id, computed_at").eq("kind", "market_briefing").eq("inputs->>snapshot_id", snapshotId).limit(1).maybeSingle();
  return data as { id: string; computed_at: string } | null;
}

export async function runSynthesisJob(db: SupabaseClient, snapshotId: string) {
  if (await briefingFor(db, snapshotId)) return null; // another job already wrote it
  const t0 = Date.now();
  const s = await loadSnapshot(db, snapshotId);
  const rows = await deskRows(db, snapshotId);
  const reusedIds = Object.values(s.inputs.plan.reuse).map((r) => r!.id);
  const { data: reusedRows } = reusedIds.length ? await db.from("model_runs").select("id, computed_at, outputs").in("id", reusedIds) : { data: [] };
  const reused = new Map((reusedRows ?? []).map((r) => [(r.outputs as DeskResult).desk, { id: r.id as string, at: r.computed_at as string, result: r.outputs as DeskResult }]));
  const desks = DESKS.map((d) => {
    const own = rows.get(d.key);
    if (own) return { key: d.key, row: own, reusedFrom: null as string | null };
    const r = reused.get(d.key);
    return { key: d.key, row: r ?? null, reusedFrom: r ? r.at : null };
  });
  const usable = desks.filter((d) => d.row && d.row.result.status !== "failed").map((d) => d.row!.result);
  const coverage = computeCoverage(s.snapshot, desks.map((d) => ({ key: d.key, result: d.row?.result ?? null, reusedFrom: d.reusedFrom })));
  const { observations, unavailable } = computeObservations(s.snapshot);
  const prev = await previousBriefing(db, new Date().toISOString());
  const previous: PreviousOutlook = prev?.synthesis?.shortTerm ? { at: prev.at, shortTerm: prev.synthesis.shortTerm.stance, longTerm: prev.synthesis.longTerm.stance } : null;
  const out = await runSynthesis({ now: new Date(), snapshot: s.snapshot, desks: usable, portfolio: s.inputs.portfolio, observations, unavailable, previous });
  // Cost of this run only: desks reused from earlier runs were already paid for.
  const fresh = desks.filter((d) => d.row && !d.reusedFrom).map((d) => d.row!.result.usage);
  const usage = fresh.reduce((u, x) => ({ input: u.input + x.input, output: u.output + x.output, searches: u.searches + x.searches }), out.usage);
  const briefing: Briefing = {
    version: SYNTHESIS_VERSION, generatedAt: new Date().toISOString(), model: out.model,
    snapshotId, deskIds: desks.flatMap((d) => (d.row ? [d.row.id] : [])),
    missingDesks: desks.filter((d) => !d.row || d.row.result.status === "failed").map((d) => DESKS.find((x) => x.key === d.key)!.title),
    synthesis: out.synthesis, calendar: mergedCalendar(usable), problems: out.problems,
    costUsd: Number(costOf(usage).toFixed(4)), coverage, ms: Date.now() - t0,
    reused: Object.fromEntries(desks.filter((d) => d.reusedFrom).map((d) => [d.key, d.reusedFrom!])),
    observations: { version: OBSERVATIONS_VERSION, items: observations, unavailable },
    outlookChange: outlookChange(prev, out.synthesis),
  };
  if (await briefingFor(db, snapshotId)) return null; // written by a parallel job while this one ran
  return save(db, "market_briefing", SYNTHESIS_VERSION, { snapshot_id: snapshotId, desk_ids: briefing.deskIds, portfolio: s.inputs.portfolio }, briefing);
}

/** Starts a background job on this site. Netlify answers 202 at once and runs it for up to 15 minutes. */
export async function dispatchJob(origin: string, body: { job: "desk" | "synthesize"; snapshotId: string; desk?: DeskKey; token: string } | { job: "ask"; requestId: string; token: string }) {
  const res = await fetch(`${origin}${JOB_PATH}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(10000) });
  if (res.status >= 300 && res.status < 400) throw new Error(`Background job was redirected (HTTP ${res.status} to ${res.headers.get("location") ?? "?"})`);
  if (res.status !== 202 && !res.ok) throw new Error(`Background job did not start (HTTP ${res.status})`);
  return res.status;
}
