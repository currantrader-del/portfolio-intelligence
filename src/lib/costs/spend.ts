/**
 * What the AI costs, by feature and by model, against two monthly budgets:
 *   everyday  scheduled briefings, the weekly plan and trade scan, and your questions
 *   research  quick screens, full investigations and updates (budgeted separately, as agreed)
 * plus, once started, the 30-day proof-of-value test: one ceiling for all AI ($20), a warning at $15,
 * reported in five categories (2026-11-09 direction).
 * Costs come from what each run recorded (model_runs outputs.costUsd). Pure functions here; the loader
 * reads only the small fields it needs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type BudgetClass = "everyday" | "research";
export const FEATURES: Record<string, { label: string; cls: BudgetClass }> = {
  market_briefing: { label: "Morning briefing", cls: "everyday" },
  morning_answer: { label: "Morning answer", cls: "everyday" },
  assistant_answer: { label: "Your questions (Ask)", cls: "everyday" },
  portfolio_plan: { label: "Portfolio plan", cls: "everyday" },
  trade_scan: { label: "Trade ideas scan", cls: "everyday" },
  watch_run: { label: "Watch alerts", cls: "everyday" },
  exposure_review: { label: "Exposure review", cls: "everyday" },
  research_result: { label: "Quick screens", cls: "research" },
  full_investigation: { label: "Full investigations", cls: "research" },
  material_event_refresh: { label: "Research updates", cls: "research" },
};
export const COST_KINDS = ["market_briefing", "assistant_answer", "portfolio_plan", "trade_scan", "watch_run", "exposure_review", "research_result", "investigation_step"];

export type CostSettings = {
  everydayMonthly: number; researchMonthly: number; approveAbove: number;
  /** The 30-day test: one ceiling for all AI from evalStart, a warning at evalWarnAt. Null until you start the test. */
  evalStart: string | null; evalCeiling: number; evalWarnAt: number;
};
/** Everyday AI about $10-20 a month (the agreed target); research budgeted on its own; ask before any job above $3. */
export const DEFAULT_COST_SETTINGS: CostSettings = { everydayMonthly: 20, researchMonthly: 25, approveAbove: 3, evalStart: null, evalCeiling: 25, evalWarnAt: 20 };
export const EVAL_DAYS = 30;

/** The five cost categories the test reports. The morning answer counts as part of the briefing. */
export type EvalCategory = "briefings" | "research_updates" | "company_analysis" | "questions" | "monitoring";
export const EVAL_CATEGORY_LABEL: Record<EvalCategory, string> = {
  briefings: "Market briefings (with the morning answer)",
  research_updates: "Research updates and investigations",
  company_analysis: "Company and portfolio analysis",
  questions: "Your questions",
  monitoring: "Background monitoring and alerts",
};
export const EVAL_CATEGORY: Record<string, EvalCategory> = {
  market_briefing: "briefings", morning_answer: "briefings",
  material_event_refresh: "research_updates", full_investigation: "research_updates", research_result: "research_updates",
  portfolio_plan: "company_analysis", exposure_review: "company_analysis", trade_scan: "company_analysis",
  assistant_answer: "questions", watch_run: "monitoring",
};

export type EvalSummary = {
  start: string; end: string; day: number; active: boolean; ceiling: number; warnAt: number;
  spent: number; left: number; warn: boolean; over: boolean; projected: number;
  byCategory: { key: EvalCategory; label: string; cost: number; runs: number }[];
};

export type CostRow = { at: string; feature: string; cost: number; model: string | null; runId?: string | null };
export type SpendSummary = {
  month: string; daysElapsed: number; daysInMonth: number;
  byFeature: { feature: string; label: string; cls: BudgetClass; cost: number; runs: number }[];
  byModel: { model: string; cost: number }[];
  classes: Record<BudgetClass, { spent: number; budget: number; projected: number; left: number; over: boolean }>;
  total: number; last7: number; settings: CostSettings;
  /** The 30-day test window, once it has been started. */
  evaluation: EvalSummary | null;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Friendly model names; anything unknown is shown as recorded. */
export function modelFamily(m: string | null): string {
  if (!m) return "Not recorded";
  const x = m.toLowerCase();
  for (const f of ["opus", "sonnet", "haiku"]) if (x.includes(f)) return f[0].toUpperCase() + f.slice(1);
  return m;
}

export function summarizeSpend(rows: CostRow[], now: Date, settings: CostSettings = DEFAULT_COST_SETTINGS): SpendSummary {
  const month = now.toISOString().slice(0, 7);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const daysElapsed = Math.max(1, now.getUTCDate() - 1 + now.getUTCHours() / 24);
  const inMonth = rows.filter((r) => r.at.slice(0, 7) === month);
  const feat = new Map<string, { cost: number; runs: Set<string> }>();
  const model = new Map<string, number>();
  inMonth.forEach((r, i) => {
    const f = feat.get(r.feature) ?? { cost: 0, runs: new Set<string>() };
    f.cost += r.cost; f.runs.add(r.runId ?? `row${i}`); feat.set(r.feature, f);
    const m = modelFamily(r.model);
    model.set(m, (model.get(m) ?? 0) + r.cost);
  });
  const byFeature = [...feat.entries()].map(([feature, v]) => ({ feature, label: FEATURES[feature]?.label ?? feature, cls: FEATURES[feature]?.cls ?? "everyday", cost: r2(v.cost), runs: v.runs.size })).sort((a, b) => b.cost - a.cost);
  const cls = (c: BudgetClass) => {
    const spent = r2(byFeature.filter((f) => f.cls === c).reduce((s, f) => s + f.cost, 0));
    const budget = c === "everyday" ? settings.everydayMonthly : settings.researchMonthly;
    // Research is lumpy (a few manual runs), so its projection is what has been spent; everyday AI is projected at its daily pace.
    const projected = c === "everyday" ? r2((spent / daysElapsed) * daysInMonth) : spent;
    return { spent, budget, projected, left: r2(budget - spent), over: spent >= budget };
  };
  const since7 = now.getTime() - 7 * 86_400_000;
  return {
    month, daysElapsed: r2(daysElapsed), daysInMonth, byFeature,
    byModel: [...model.entries()].map(([m, c]) => ({ model: m, cost: r2(c) })).sort((a, b) => b.cost - a.cost),
    classes: { everyday: cls("everyday"), research: cls("research") },
    total: r2(inMonth.reduce((s, r) => s + r.cost, 0)),
    last7: r2(rows.filter((r) => Date.parse(r.at) >= since7).reduce((s, r) => s + r.cost, 0)),
    settings, evaluation: summarizeEvaluation(rows, now, settings),
  };
}

/** Spending inside the 30-day test window, in the five categories, against the single test ceiling. Pure. */
export function summarizeEvaluation(rows: CostRow[], now: Date, settings: CostSettings): EvalSummary | null {
  if (!settings.evalStart || Number.isNaN(Date.parse(settings.evalStart))) return null;
  const startMs = Date.parse(settings.evalStart);
  const endMs = startMs + EVAL_DAYS * 86_400_000;
  const inWin = rows.filter((r) => { const t = Date.parse(r.at); return t >= startMs && t < endMs; });
  const cat = new Map<EvalCategory, { cost: number; runs: Set<string> }>();
  inWin.forEach((r, i) => {
    const k = EVAL_CATEGORY[r.feature] ?? "company_analysis";
    const c = cat.get(k) ?? { cost: 0, runs: new Set<string>() };
    c.cost += r.cost; c.runs.add(r.runId ?? `row${i}`); cat.set(k, c);
  });
  const spent = r2(inWin.reduce((a, r) => a + r.cost, 0));
  const t = now.getTime();
  const elapsed = Math.min(EVAL_DAYS, Math.max(1, (t - startMs) / 86_400_000));
  return {
    start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
    day: Math.min(EVAL_DAYS, Math.max(0, Math.ceil((t - startMs) / 86_400_000))),
    active: t >= startMs && t < endMs, ceiling: settings.evalCeiling, warnAt: settings.evalWarnAt,
    spent, left: r2(settings.evalCeiling - spent), warn: spent >= settings.evalWarnAt, over: spent >= settings.evalCeiling,
    projected: r2((spent / elapsed) * EVAL_DAYS),
    byCategory: (Object.keys(EVAL_CATEGORY_LABEL) as EvalCategory[]).map((key) => ({ key, label: EVAL_CATEGORY_LABEL[key], cost: r2(cat.get(key)?.cost ?? 0), runs: cat.get(key)?.runs.size ?? 0 })),
  };
}

/**
 * Whether a manual paid job may start. `confirmed` is your "Start anyway" after seeing the warning;
 * `costAcknowledged` is a cost you already accepted on the page (the full-investigation checkbox), which
 * covers the approval threshold but never a budget: going over the month's budget or the test ceiling always asks separately.
 */
export function budgetGate(s: SpendSummary, cls: BudgetClass, estimateHigh: number, confirmed: boolean, costAcknowledged = false): { ok: true } | { ok: false; needsConfirm: boolean; message: string } {
  const c = s.classes[cls];
  const name = cls === "research" ? "research" : "everyday AI";
  const e = s.evaluation;
  if (e?.active && e.spent + estimateHigh > e.ceiling && !confirmed) return { ok: false, needsConfirm: true, message: `This could take the 30-day test past its $${e.ceiling} AI ceiling ($${e.spent.toFixed(2)} spent, up to $${estimateHigh.toFixed(2)} more). Confirm to go ahead anyway.` };
  if (c.spent + estimateHigh > c.budget && !confirmed) return { ok: false, needsConfirm: true, message: `This could take the ${name} budget over its $${c.budget} for the month ($${c.spent.toFixed(2)} spent, up to $${estimateHigh.toFixed(2)} more). Confirm to go ahead anyway.` };
  if (estimateHigh > s.settings.approveAbove && !confirmed && !costAcknowledged) return { ok: false, needsConfirm: true, message: `This may cost up to $${estimateHigh.toFixed(2)}, above your $${s.settings.approveAbove} approval threshold. Confirm to start it.` };
  return { ok: true };
}

/** The saved settings over the defaults: numbers must be zero or more; the test start must be a date. */
export function settingsFrom(saved: unknown): CostSettings {
  const o = (saved ?? {}) as Record<string, unknown>;
  const nums = Object.fromEntries(Object.entries(o).filter(([k, v]) => k !== "evalStart" && typeof v === "number" && v >= 0));
  const evalStart = typeof o.evalStart === "string" && !Number.isNaN(Date.parse(o.evalStart)) ? o.evalStart : null;
  return { ...DEFAULT_COST_SETTINGS, ...nums, evalStart };
}

/** Reads this month's costs (and the last 7 days, and the test window) without loading large run states. */
export async function loadSpend(db: SupabaseClient, now = new Date()): Promise<SpendSummary> {
  const { data: set } = await db.from("model_runs").select("outputs").eq("kind", "cost_settings").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const settings = settingsFrom(set?.outputs ?? null);
  const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00Z`;
  const evalStart = settings.evalStart ? Date.parse(settings.evalStart) : Infinity;
  const since = new Date(Math.min(Date.parse(monthStart), now.getTime() - 7 * 86_400_000, evalStart)).toISOString();
  const [{ data: simple }, { data: steps }, { data: reqs }] = await Promise.all([
    db.from("model_runs").select("id, kind, computed_at, cost:outputs->>costUsd, model:outputs->>model, purpose:inputs->>purpose").in("kind", COST_KINDS.filter((k) => k !== "investigation_step")).gte("computed_at", since).limit(5000),
    db.from("model_runs").select("computed_at, req:inputs->>request_id, cost:outputs->>costUsd, byModel:outputs->state->usage->byModel").eq("kind", "investigation_step").gte("computed_at", since).limit(5000),
    db.from("model_runs").select("id, type:inputs->>type").eq("kind", "investigation_request").gte("computed_at", new Date(Date.parse(since) - 7 * 86_400_000).toISOString()).limit(500),
  ]);
  const rows: CostRow[] = [];
  for (const r of (simple ?? []) as { id: string; kind: string; computed_at: string; cost: string | null; model: string | null; purpose?: string | null }[]) {
    const c = Number(r.cost) || 0;
    // The scheduled morning answer is reported with the briefing, not as one of your questions.
    const feature = r.kind === "assistant_answer" && r.purpose === "morning" ? "morning_answer" : r.kind;
    if (c > 0) rows.push({ at: r.computed_at, feature, cost: c, model: r.model, runId: r.id });
  }
  const typeOf = new Map(((reqs ?? []) as { id: string; type: string | null }[]).map((r) => [r.id, r.type === "material_event_refresh" ? "material_event_refresh" : "full_investigation"]));
  // Investigation steps record cost per step; the model split comes from each run's latest cumulative usage.
  type Step = { computed_at: string; req: string | null; cost: string | null; byModel: Record<string, { costUsd?: number }> | null };
  const latest = new Map<string, Step>();
  for (const s of (steps ?? []) as Step[]) {
    if (!s.req) continue;
    const c = Number(s.cost) || 0;
    const feature = typeOf.get(s.req) ?? "full_investigation";
    if (c > 0) rows.push({ at: s.computed_at, feature, cost: c, model: null, runId: s.req });
    const prev = latest.get(s.req);
    if (!prev || s.computed_at > prev.computed_at) latest.set(s.req, s);
  }
  // Re-attribute each run's step costs to models in proportion to its recorded split.
  for (const [req, s] of latest) {
    const split = Object.entries(s.byModel ?? {}).map(([m, v]) => [m, Number(v?.costUsd) || 0] as const).filter(([, v]) => v > 0);
    const tot = split.reduce((a, [, v]) => a + v, 0);
    if (!tot) continue;
    const mine = rows.filter((r) => r.runId === req && r.model === null);
    const out = mine.flatMap((r) => split.map(([m, v]) => ({ ...r, model: m, cost: (r.cost * v) / tot })));
    for (const r of mine) rows.splice(rows.indexOf(r), 1);
    rows.push(...out);
  }
  return summarizeSpend(rows, now, settings);
}

/** What one run of a feature usually costs, until the month has enough runs of it to measure. */
export const DEFAULT_RUN_COST: Record<string, number> = {
  market_briefing: 0.6, morning_answer: 0.15, assistant_answer: 0.15, portfolio_plan: 0.5, trade_scan: 0.6, watch_run: 0.05, exposure_review: 0.3, research_result: 0.35,
};

/** The expected cost of one more run: this month's average once there are two runs, never below half the default. */
export function runEstimate(s: SpendSummary, feature: string): number {
  const d = DEFAULT_RUN_COST[feature] ?? 0.5;
  const f = s.byFeature.find((x) => x.feature === feature);
  return r2(f && f.runs >= 2 ? Math.max(f.cost / f.runs, d / 2) : d);
}

/**
 * Automated jobs never ask and never go over: one starts only when its budget (and, during the test, the
 * test ceiling) has room for its expected cost; otherwise it is skipped and the reason is recorded.
 */
export function automatedGate(s: SpendSummary, feature: string): { ok: true } | { ok: false; reason: string } {
  const cls = FEATURES[feature]?.cls ?? "everyday";
  const c = s.classes[cls];
  const est = runEstimate(s, feature);
  const e = s.evaluation;
  if (e?.active && e.spent + est > e.ceiling) return { ok: false, reason: `skipped: the 30-day test has $${Math.max(0, e.left).toFixed(2)} left of its $${e.ceiling} AI ceiling, and ${FEATURES[feature]?.label ?? feature} usually costs about $${est.toFixed(2)}` };
  if (c.spent + est > c.budget) return { ok: false, reason: `skipped: the monthly ${cls === "research" ? "research" : "everyday AI"} budget has $${Math.max(0, c.left).toFixed(2)} left of $${c.budget}, and ${FEATURES[feature]?.label ?? feature} usually costs about $${est.toFixed(2)}` };
  return { ok: true };
}

/** Manual job check by feature: a warning that needs your OK when it could take the month over its budget. */
export function manualGate(s: SpendSummary, feature: string, confirmed: boolean) {
  return budgetGate(s, FEATURES[feature]?.cls ?? "everyday", runEstimate(s, feature), confirmed);
}

/** The automated-job check against the stored spend. If spending cannot be read, the job does not start. */
export async function automatedAllowed(db: SupabaseClient, feature: string, now = new Date()): Promise<{ ok: true } | { ok: false; reason: string }> {
  const s = await loadSpend(db, now).catch(() => null);
  if (!s) return { ok: false, reason: "skipped: this month's AI spending could not be read, so no paid job was started" };
  return automatedGate(s, feature);
}

/** Whether the 30-day test is running now (for pausing optional jobs during it). */
export async function evaluationActive(db: SupabaseClient, now = new Date()): Promise<boolean> {
  const { data } = await db.from("model_runs").select("outputs").eq("kind", "cost_settings").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const s = settingsFrom(data?.outputs ?? null);
  if (!s.evalStart) return false;
  const t = now.getTime(), start = Date.parse(s.evalStart);
  return t >= start && t < start + EVAL_DAYS * 86_400_000;
}
