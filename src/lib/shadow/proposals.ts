/**
 * Runs the one improvement strategy (see improve.ts) and keeps every result (model_runs, no new tables):
 *   shadow_proposal    the candidates, the historical evidence, the AI review (or why there was none), and the
 *                      shadow test it started. Never edited; a "No change" verdict is kept too.
 *   shadow_assessment  the weekly current assessment (Still attractive / No longer attractive / More research needed).
 * Started after each weekly plan. One small AI review per new candidate set (about $0.05-0.15), inside the budget.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchJob, save } from "@/lib/intel/jobs";
import { buildWorkspace } from "@/lib/workspace-core";
import { planStatus } from "@/lib/plan/job";
import { automatedAllowed } from "@/lib/costs/spend";
import { extractJson } from "@/lib/research/aiResearch";
import { getHistories, type Bar } from "@/lib/market/history";
import { isEtf } from "@/lib/portfolio/classify";
import { companyMax } from "@/lib/policy/limits";
import { researchReviewLevel } from "@/lib/decision/positionMath";
import type { Workspace } from "@/lib/workspace-core";
import type { Plan } from "@/lib/plan/plan";
import { loadAlertPrefs } from "@/lib/watch/priceMoves";
import { pushNtfy, watchSettings } from "@/lib/watch/job";
import {
  ETF_MIX, REVIEW_MODEL, REVIEW_SYSTEM, STRATEGY, assess, backtestCap, findCandidates, mixBuys, reviewQuestion, sameCandidates, summarizeEvidence, upsideGivenUp, validateReview,
  type Assessment, type Backtest, type Candidate, type Evidence, type HoldingFact, type PlanFact, type ResearchFact, type Review,
} from "./improve";
import { createShadowTest, loadShadowTests, shadowReports } from "./store";
import { SHADOW_VERSION, type ShadowReport } from "./shadow";

export type Proposal = {
  strategy: string; at: string; planAt: string | null;
  candidates: Candidate[]; proceeds: number; buys: { symbol: string; pct: number; usd: number }[];
  upside: Record<string, { bullUsd: number | null; baseUsd: number | null }>;
  evidence: Evidence;
  review: Review | null; reviewSkipped: string | null; costUsd: number; model: string | null;
  testId: string | null; pushed: boolean;
};

export function capsFor(ws: Workspace) {
  return (symbol: string) => {
    const c = ws.policy?.companies[symbol];
    const max = isEtf(symbol) ? null : companyMax(ws.policy, symbol);
    const cur = ws.research.find((r) => r.symbol === symbol)?.current ?? null;
    const review = cur && !isEtf(symbol) ? researchReviewLevel(cur.parsed.allocation, max, cur.research_as_of)?.value ?? null : null;
    return { normalHigh: c?.normal?.high ?? null, max, review };
  };
}

export function factsFrom(ws: Workspace, plan: Plan | null): { holdings: HoldingFact[]; research: ResearchFact[]; plan: PlanFact[] } {
  return {
    // Combined exposure (direct + through funds), the same number Decisions and Risk show.
    holdings: ws.portfolio.holdings.map((h) => ({ symbol: h.symbol, quantity: h.quantity, price: h.price, value: h.value, weight: ws.portfolio.exposures.find((e) => e.symbol === h.symbol)?.total ?? h.weight, direct: h.weight, etf: isEtf(h.symbol) })),
    research: ws.research.filter((r) => r.current).map((r) => ({
      symbol: r.symbol, versionId: r.current!.id, asOf: r.current!.research_as_of, action: r.current!.parsed.action, thesis: r.current!.parsed.thesis?.slice(0, 600) ?? null,
      confidence: r.current!.parsed.confidence, scenarios: r.current!.parsed.scenarios, weighted: r.current!.parsed.weightedValue, complete: !!r.authoritative,
    })),
    plan: (plan?.positions ?? []).map((p) => ({ symbol: p.symbol, action: p.plan?.action ?? null, targetPct: p.targetPct, reason: p.reason.slice(0, 500) })),
  };
}

export async function loadProposals(db: SupabaseClient): Promise<(Proposal & { id: string })[]> {
  const { data } = await db.from("model_runs").select("id, outputs").eq("kind", "shadow_proposal").order("computed_at", { ascending: false }).limit(100);
  return ((data ?? []) as { id: string; outputs: Proposal }[]).map((r) => ({ ...r.outputs, id: r.id }));
}

export async function loadAssessments(db: SupabaseClient): Promise<Map<string, Assessment[]>> {
  const { data } = await db.from("model_runs").select("outputs").eq("kind", "shadow_assessment").order("computed_at", { ascending: true }).limit(1000);
  const m = new Map<string, Assessment[]>();
  for (const r of (data ?? []) as { outputs: Assessment & { proposalId: string } }[]) m.set(r.outputs.proposalId, [...(m.get(r.outputs.proposalId) ?? []), r.outputs]);
  return m;
}

/** Today's assessment of a proposal, from today's data only. */
export function assessNow(p: Proposal, ws: Workspace, plan: Plan | null): Assessment {
  const caps = capsFor(ws);
  const f = factsFrom(ws, plan);
  return assess(p, {
    at: ws.now,
    weightPct: (s) => { const h = ws.portfolio.holdings.find((x) => x.symbol === s); if (!h) return null; const w = ws.portfolio.exposures.find((e) => e.symbol === s)?.total ?? h.weight; return Math.round(w * 1000) / 10; },
    capPct: (s) => { const c = caps(s); const line = c.review ?? c.normalHigh ?? c.max; return line === null ? null : Math.round(line * 1000) / 10; },
    research: (s) => { const r = f.research.find((x) => x.symbol === s); return r ? { versionId: r.versionId, asOf: r.asOf, complete: r.complete } : null; },
    planAction: (s) => f.plan.find((x) => x.symbol === s)?.action ?? null,
  });
}

async function review(q: string): Promise<{ review: Review | null; costUsd: number; error: string | null }> {
  const res = await new Anthropic().messages.create({ model: REVIEW_MODEL.id, max_tokens: 1200, system: REVIEW_SYSTEM, messages: [{ role: "user", content: q }] });
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
  const costUsd = (res.usage.input_tokens * REVIEW_MODEL.inPerM + res.usage.output_tokens * REVIEW_MODEL.outPerM) / 1e6;
  const r = validateReview(extractJson(text));
  return { review: r, costUsd, error: r ? null : "the review could not be read" };
}

/**
 * After a plan: find candidates, test the concentration rule historically, ask for one review, and start a
 * forward shadow test (and one phone notification) only when the review says it is worth your time.
 */
export type CheckResult = { at: string; trigger: string; outcome: string; proposalId: string | null };

/** Every check is recorded (model_runs "shadow_proposal_check"), so the page can say when it last looked and what it found. */
export async function runImprovement(db: SupabaseClient, ws: Workspace, plan: Plan | null, planAt: string | null, trigger = "plan"): Promise<CheckResult> {
  const done = async (outcome: string, proposalId: string | null = null) => {
    const r: CheckResult = { at: new Date().toISOString(), trigger, outcome, proposalId };
    await save(db, "shadow_proposal_check", SHADOW_VERSION, { trigger }, r).catch(() => null);
    return r;
  };
  const caps = capsFor(ws);
  const facts = factsFrom(ws, plan);
  const candidates = findCandidates({ ...facts, total: ws.portfolio.total, capFor: caps });
  if (!candidates.length) return done("No change proposed: no stock is above its policy line, and no completed research says Trim or Exit.");
  const recent = (await loadProposals(db)).filter((p) => Date.now() - Date.parse(p.at) < 28 * 86_400_000);
  const same = recent.find((p) => sameCandidates(p.candidates, candidates));
  if (same) return done("Same candidates as a proposal from the last four weeks, with no new research, so it was not reviewed again.", same.id);
  const active = (await loadShadowTests(db)).filter((e) => !e.close && e.test.origin === "app");
  if (active.some((e) => e.test.trades.some((t) => t.side === "sell" && candidates.some((c) => c.symbol === t.symbol)))) return done("A shadow test on the same stock is already running.");

  // Historical evidence: the concentration rule on every individual stock you hold with enough history.
  const stocks = facts.holdings.filter((h) => !h.etf).map((h) => h.symbol);
  const hist = await getHistories([...stocks, ...ETF_MIX.map((m) => m.symbol)], "5y");
  const bars = new Map<string, Bar[]>([...hist].map(([s, x]) => [s, x.bars]));
  const tested: Backtest[] = stocks.map((s) => { const c = caps(s); const line = c.review ?? c.normalHigh ?? c.max ?? 0.05; return backtestCap(s, Math.round(line * 1000) / 10, bars); });
  const evidence = summarizeEvidence(tested, candidates.some((c) => c.trigger.some((t) => t !== "concentration")));

  const proceeds = Math.round(candidates.reduce((a, c) => a + c.sellValue, 0) * 100) / 100;
  const buys = mixBuys(proceeds);
  const largest = [...ws.portfolio.holdings].sort((a, b) => b.weight - a.weight).slice(0, 5).map((h) => ({ symbol: h.symbol, pct: Math.round(h.weight * 1000) / 10 }));
  let rev: Review | null = null, reviewSkipped: string | null = null, costUsd = 0;
  const gate = await automatedAllowed(db, "shadow_proposal");
  if (!gate.ok) reviewSkipped = gate.reason;
  else {
    try {
      const r = await review(reviewQuestion({ candidates, proceeds, total: ws.portfolio.total, evidence, largest, market: plan ? `${plan.market.stance}. ${plan.market.longTerm}` : null }));
      rev = r.review; costUsd = r.costUsd; reviewSkipped = r.error;
    } catch (e) { reviewSkipped = `the review failed: ${(e as Error).message.slice(0, 200)}`; }
  }

  let testId: string | null = null, pushed = false;
  if (rev?.verdict === "Worth reviewing") {
    testId = await createShadowTest(db, ws, {
      name: proposalTitle(candidates), origin: "app", rationale: rev.reason,
      source: { planAt, researchVersionId: candidates[0].research?.versionId ?? null, researchAsOf: candidates[0].research?.asOf ?? null, action: STRATEGY.name },
      trades: [
        ...candidates.map((c) => ({ side: "sell" as const, symbol: c.symbol, amount: c.sellPct, unit: "pct_holding" as const })),
        ...ETF_MIX.map((m) => ({ side: "buy" as const, symbol: m.symbol, amount: m.pct, unit: "pct_proceeds" as const })),
      ],
    });
    pushed = await notify(db, candidates, rev).catch(() => false);
  }
  const out: Proposal = {
    strategy: STRATEGY.id, at: ws.now.toISOString(), planAt, candidates, proceeds, buys,
    upside: Object.fromEntries(candidates.map((c) => [c.symbol, upsideGivenUp(c)])), evidence,
    review: rev, reviewSkipped, costUsd, model: rev || costUsd ? REVIEW_MODEL.id : null, testId, pushed,
  };
  const id = await save(db, "shadow_proposal", SHADOW_VERSION, { strategy: STRATEGY.id, symbols: candidates.map((c) => c.symbol), plan_at: planAt }, out);
  await save(db, "shadow_assessment", SHADOW_VERSION, { proposal_id: id }, { proposalId: id, ...assessNow(out, ws, plan) });
  return done(rev ? (rev.verdict === "Worth reviewing" ? "Proposal worth reviewing: a shadow test has started." : "Reviewed: No change is the better answer for now (kept in the history).") : `Proposal saved without a review: ${reviewSkipped}`, id);
}

export async function lastCheck(db: SupabaseClient): Promise<CheckResult | null> {
  const { data } = await db.from("model_runs").select("outputs").eq("kind", "shadow_proposal_check").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  return (data?.outputs as CheckResult | undefined) ?? null;
}

/** "Check now" on Plan: runs the same check in the background, with the latest stored plan. */
export async function startImprovementCheck(db: SupabaseClient, origin: string, token: string): Promise<string> {
  const requestId = await save(db, "shadow_proposal_request", SHADOW_VERSION, { trigger: "manual" }, {});
  await dispatchJob(origin, { job: "improve", requestId, token });
  return requestId;
}

export async function runImprovementJob(db: SupabaseClient): Promise<CheckResult> {
  const ws = await buildWorkspace(db);
  const st = await planStatus(db);
  const plan = st.latest?.ok ? st.latest.plan ?? null : null;
  return runImprovement(db, ws, plan, st.latest?.at ?? null, "manual");
}

export function proposalTitle(cs: Pick<Candidate, "symbol" | "sellPct">[]) {
  const sells = cs.map((c) => (c.sellPct >= 99.9 ? `sell all ${c.symbol}` : `trim ${c.symbol} ${c.sellPct}%`)).join(", ");
  return `${sells[0].toUpperCase()}${sells.slice(1)} into VOO, VXUS and AVUV`;
}

async function notify(db: SupabaseClient, cs: Candidate[], r: Review): Promise<boolean> {
  const [s, prefs] = await Promise.all([watchSettings(db), loadAlertPrefs(db)]);
  if (!s.enabled || !s.topic || !prefs.intelligence) return false;
  const origin = process.env.URL ?? "";
  await pushNtfy(s.topic, {
    title: "Portfolio change worth reviewing",
    body: `${proposalTitle(cs)}. ${r.reason.slice(0, 220)} A paper test has started; nothing was traded.`,
    priority: "default", click: origin ? `${origin}/plan` : undefined,
  });
  return true;
}

/** Weekly (Mondays): a dated assessment for every proposal whose shadow test is still running. Code only. */
export async function recordAssessments(db: SupabaseClient, ws: Workspace, plan: Plan | null): Promise<number> {
  const [proposals, tests] = await Promise.all([loadProposals(db), loadShadowTests(db)]);
  const running = new Set(tests.filter((e) => !e.close).map((e) => e.test.id));
  let n = 0;
  for (const p of proposals.filter((x) => x.testId && running.has(x.testId))) {
    await save(db, "shadow_assessment", SHADOW_VERSION, { proposal_id: p.id }, { proposalId: p.id, ...assessNow(p, ws, plan) });
    n++;
  }
  return n;
}

/** What Plan and Today show: proposals being tracked (with today's assessment and their test), and the rest as history. */
export async function improvementView(db: SupabaseClient, ws: Workspace, shadows?: { test: { id: string }; close: unknown; report: ShadowReport }[]) {
  const [proposals, last, st] = await Promise.all([loadProposals(db), lastCheck(db), planStatus(db)]);
  const plan = st.latest?.ok ? st.latest.plan ?? null : null;
  const tracked = proposals.filter((p) => p.review?.verdict === "Worth reviewing" && p.testId);
  const rows = tracked.length ? shadows ?? (await shadowReports(db, ws)) : [];
  const all = tracked.map((p) => {
    const t = rows.find((x) => x.test.id === p.testId);
    return { p, assessment: assessNow(p, ws, plan), report: t?.report ?? null, testClosed: !t || !!t.close };
  }).filter((x) => !x.testClosed);
  // A superseded proposal (newer research or a changed line) or one whose reason is gone is never shown as a
  // current opportunity. It moves to history with today's status; its paper test keeps running for the record.
  const current = (x: (typeof all)[number]) => x.assessment.status === "Still attractive" || x.assessment.status === "More research needed";
  const active = all.filter(current);
  const retired = new Map(all.filter((x) => !current(x)).map((x) => [x.p.id, x]));
  const activeIds = new Set(active.map((x) => x.p.id));
  return { active, history: proposals.filter((p) => !activeIds.has(p.id)).map((p) => ({ ...p, nowStatus: retired.get(p.id)?.assessment ?? null, testRunning: retired.has(p.id) })), last };
}
