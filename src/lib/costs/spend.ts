/**
 * What the AI costs, by feature and by model, against two monthly budgets:
 *   everyday  scheduled briefings, the weekly plan and trade scan, and your questions
 *   research  quick screens, full investigations and updates (budgeted separately, as agreed)
 * Costs come from what each run recorded (model_runs outputs.costUsd). Pure functions here; the loader
 * reads only the small fields it needs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type BudgetClass = "everyday" | "research";
export const FEATURES: Record<string, { label: string; cls: BudgetClass }> = {
  market_briefing: { label: "Morning briefing", cls: "everyday" },
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

export type CostSettings = { everydayMonthly: number; researchMonthly: number; approveAbove: number };
/** Everyday AI about $10-20 a month (the agreed target); research budgeted on its own; ask before any job above $3. */
export const DEFAULT_COST_SETTINGS: CostSettings = { everydayMonthly: 20, researchMonthly: 25, approveAbove: 3 };

export type CostRow = { at: string; feature: string; cost: number; model: string | null; runId?: string | null };
export type SpendSummary = {
  month: string; daysElapsed: number; daysInMonth: number;
  byFeature: { feature: string; label: string; cls: BudgetClass; cost: number; runs: number }[];
  byModel: { model: string; cost: number }[];
  classes: Record<BudgetClass, { spent: number; budget: number; projected: number; left: number; over: boolean }>;
  total: number; last7: number; settings: CostSettings;
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
    settings,
  };
}

/**
 * Whether a manual job may start: refused when it would take its budget past the limit, and it needs your
 * explicit OK when its estimate is above the approval threshold. The $20/day cap still applies separately.
 */
/**
 * Whether a manual paid job may start. `confirmed` is your "Start anyway" after seeing the warning;
 * `costAcknowledged` is a cost you already accepted on the page (the full-investigation checkbox), which
 * covers the approval threshold but never the monthly budget: going over it always asks separately.
 */
export function budgetGate(s: SpendSummary, cls: BudgetClass, estimateHigh: number, confirmed: boolean, costAcknowledged = false): { ok: true } | { ok: false; needsConfirm: boolean; message: string } {
  const c = s.classes[cls];
  const name = cls === "research" ? "research" : "everyday AI";
  if (c.spent + estimateHigh > c.budget && !confirmed) return { ok: false, needsConfirm: true, message: `This could take the ${name} budget over its $${c.budget} for the month ($${c.spent.toFixed(2)} spent, up to $${estimateHigh.toFixed(2)} more). Confirm to go ahead anyway.` };
  if (estimateHigh > s.settings.approveAbove && !confirmed && !costAcknowledged) return { ok: false, needsConfirm: true, message: `This may cost up to $${estimateHigh.toFixed(2)}, above your $${s.settings.approveAbove} approval threshold. Confirm to start it.` };
  return { ok: true };
}

/** Reads this month's costs (and the last 7 days) without loading large run states. */
export async function loadSpend(db: SupabaseClient, now = new Date()): Promise<SpendSummary> {
  const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00Z`;
  const since = new Date(Math.min(Date.parse(monthStart), now.getTime() - 7 * 86_400_000)).toISOString();
  const [{ data: simple }, { data: steps }, { data: reqs }, { data: set }] = await Promise.all([
    db.from("model_runs").select("id, kind, computed_at, cost:outputs->>costUsd, model:outputs->>model").in("kind", COST_KINDS.filter((k) => k !== "investigation_step")).gte("computed_at", since).limit(5000),
    db.from("model_runs").select("computed_at, req:inputs->>request_id, cost:outputs->>costUsd, byModel:outputs->state->usage->byModel").eq("kind", "investigation_step").gte("computed_at", since).limit(5000),
    db.from("model_runs").select("id, type:inputs->>type").eq("kind", "investigation_request").gte("computed_at", new Date(Date.parse(since) - 7 * 86_400_000).toISOString()).limit(500),
    db.from("model_runs").select("outputs").eq("kind", "cost_settings").order("computed_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const rows: CostRow[] = [];
  for (const r of (simple ?? []) as { id: string; kind: string; computed_at: string; cost: string | null; model: string | null }[]) {
    const c = Number(r.cost) || 0;
    if (c > 0) rows.push({ at: r.computed_at, feature: r.kind, cost: c, model: r.model, runId: r.id });
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
  const saved = (set?.outputs ?? null) as Partial<CostSettings> | null;
  const settings: CostSettings = { ...DEFAULT_COST_SETTINGS, ...Object.fromEntries(Object.entries(saved ?? {}).filter(([, v]) => typeof v === "number" && v >= 0)) };
  return summarizeSpend(rows, now, settings);
}
