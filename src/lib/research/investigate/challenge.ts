/**
 * Checks that do not depend on the model: sensitivity tests for the skeptical review, an independent
 * recomputation of the valuation, and whether the written conclusion matches the numbers, the
 * evidence and the portfolio. All deterministic, so they can be tested and audited.
 */
import { computeValuation, type ScenarioSpec, type ValuationResult } from "./valuationCalc";
import type { ConsistencyCheck, RunState } from "./types";

type Specs = ScenarioSpec[];
const clone = (x: Specs): Specs => JSON.parse(JSON.stringify(x));
/** The upper end of the dated VOO forecasts the app compares against (J.P. Morgan 10-15y, 7.5%). */
export const VOO_HIGH = 0.075;

function run(s: Pick<RunState, "valuation" | "price" | "today">, specs: Specs): ValuationResult | null {
  if (!s.valuation) return null;
  return computeValuation({ scenarios: specs, horizon_date: s.valuation.horizon_date, price: s.price.value, today: s.today });
}

const MARGINS = ["operating_margin", "ebitda_margin", "fcf_margin"] as const;

/** Applies one change to the scenarios ("all" or one name): multiply or set an input, or set probabilities. */
export function applyChange(specs: Specs, c: { scenario?: string; input?: string; multiply?: number; add?: number; set?: number; probabilities?: Partial<Record<"bear" | "base" | "bull", number>> }): Specs {
  const out = clone(specs);
  for (const sc of out) {
    if (c.probabilities && c.probabilities[sc.name] !== undefined) sc.probability = c.probabilities[sc.name]!;
    if (!c.input || (c.scenario && c.scenario !== "all" && c.scenario !== sc.name)) continue;
    const keys = c.input === "margin" ? MARGINS.filter((k) => Number.isFinite(sc.inputs[k] as number)) : [c.input];
    for (const k of keys) {
      const cur = sc.inputs[k as keyof typeof sc.inputs] as number | undefined;
      if (!Number.isFinite(cur as number) && c.set === undefined) continue;
      const next = c.set !== undefined ? c.set : c.multiply !== undefined ? (cur as number) * c.multiply : (cur as number) + (c.add ?? 0);
      (sc.inputs as Record<string, number>)[k] = next;
    }
  }
  return out;
}

/** The standard sensitivity pack computed for every investigation before the skeptic reads it. */
export function stressTests(s: Pick<RunState, "valuation" | "price" | "today">) {
  const v = s.valuation;
  if (!v || !v.result.ok) return [];
  const base = v.specs;
  const p = Object.fromEntries(base.map((x) => [x.name, x.probability])) as Record<"bear" | "base" | "bull", number>;
  const rows: { label: string; specs: Specs; note: string }[] = [
    { label: "As modeled", specs: base, note: "The research's own inputs" },
    { label: "All multiples 20% lower", specs: applyChange(base, { scenario: "all", input: "multiple", multiply: 0.8 }), note: "Multiple compression only" },
    { label: "All margins 5 points lower", specs: applyChange(base, { scenario: "all", input: "margin", add: -0.05 }), note: "Margin pressure only" },
    { label: "All revenue 15% lower", specs: applyChange(base, { scenario: "all", input: "revenue", multiply: 0.85 }), note: "Lower demand only" },
    { label: "Bear probability +15 points (from base)", specs: applyChange(base, { probabilities: { bear: Math.min(0.95, p.bear + 0.15), base: Math.max(0.01, p.base - 0.15) } }), note: "More weight on the bear case" },
    { label: "Equal probabilities", specs: applyChange(base, { probabilities: { bear: 1 / 3, base: 1 / 3, bull: 1 / 3 } }), note: "No view on which scenario is likelier" },
  ];
  const out = rows.map((r) => {
    const res = run(s, r.specs);
    return { label: r.label, weighted_value: res?.weighted_value ?? null, annualized_return: res?.annualized_return ?? null, note: res?.ok ? r.note : `${r.note} (not computable: ${res?.errors.join("; ")})` };
  });
  // Break-even: how much weight the bear case can take (from base) before the expected return falls to
  // the VOO forecast and to zero.
  for (const [target, label] of [[VOO_HIGH, "VOO's 7.5% forecast"], [0, "a 0% return"]] as const) {
    let lo = 0, hi = p.base, found: number | null = null;
    const at = (shift: number) => run(s, applyChange(base, { probabilities: { bear: p.bear + shift, base: p.base - shift } }))?.annualized_return ?? null;
    if ((at(0) ?? -1) <= target) found = 0;
    else if ((at(hi - 0.0001) ?? 1) > target) found = null;
    else {
      for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if ((at(mid) ?? 0) > target) lo = mid; else hi = mid; }
      found = hi;
    }
    out.push({ label: `Bear probability at which the expected return falls to ${label}`, weighted_value: null, annualized_return: target, note: found === null ? "Not reached even with all of the base weight moved to bear" : `Bear ${((p.bear + found) * 100).toFixed(0)}% (base ${((p.base - found) * 100).toFixed(0)}%), versus ${(p.bear * 100).toFixed(0)}% modeled` });
  }
  return out;
}

/** A change the skeptic asks for, computed by the app. */
export function customStress(s: Pick<RunState, "valuation" | "price" | "today">, changes: Parameters<typeof applyChange>[1][]) {
  if (!s.valuation) return { error: "No valuation to test yet" };
  let specs = s.valuation.specs;
  for (const c of changes) specs = applyChange(specs, c);
  const res = run(s, specs);
  if (!res) return { error: "No valuation" };
  return { ok: res.ok, errors: res.errors, weighted_value: res.weighted_value, annualized_return: res.annualized_return, scenarios: res.scenarios.map((x) => ({ name: x.name, probability: x.probability, value_per_share: x.value_per_share })), versus_modeled: { weighted_value: s.valuation.result.weighted_value, annualized_return: s.valuation.result.annualized_return } };
}

/**
 * Recomputes every scenario from its inputs with plain arithmetic, separately from valuationCalc, and
 * compares. Any difference means a calculation error somewhere.
 */
export function crossCheckValuation(v: NonNullable<RunState["valuation"]>, price: number | null, today: string): string[] {
  const issues: string[] = [];
  let weighted = 0;
  for (const sc of v.specs) {
    const i = sc.inputs as Record<string, number>;
    let value: number;
    if (sc.method === "pe") value = ((i.revenue * i.operating_margin + (i.net_other_income ?? 0)) * (1 - i.tax_rate) / i.diluted_shares) * i.multiple;
    else if (sc.method === "ev_ebitda") value = (i.revenue * i.ebitda_margin * i.multiple - i.net_debt) / i.diluted_shares;
    else if (sc.method === "ev_sales") value = (i.revenue * i.multiple - i.net_debt) / i.diluted_shares;
    else value = (i.revenue * i.fcf_margin * i.multiple) / i.diluted_shares;
    if (sc.floor_value && value < sc.floor_value) value = sc.floor_value;
    value = Math.max(0, value);
    const app = v.result.scenarios.find((x) => x.name === sc.name)?.value_per_share;
    if (app === undefined || Math.abs(app - value) > Math.max(0.01, Math.abs(value) * 0.0005)) issues.push(`${sc.name}: app value ${app} vs recomputed ${value.toFixed(2)}`);
    weighted += sc.probability * value;
  }
  if (v.result.weighted_value === null || Math.abs(v.result.weighted_value - weighted) > 0.01 + weighted * 0.0005) issues.push(`Weighted value: app ${v.result.weighted_value} vs recomputed ${weighted.toFixed(2)}`);
  if (price && v.result.annualized_return !== null) {
    const years = (Date.parse(v.horizon_date) - Date.parse(today)) / (365.25 * 864e5);
    const ann = Math.pow(weighted / price, 1 / years) - 1;
    if (Math.abs(ann - v.result.annualized_return) > 0.002) issues.push(`Annualized return: app ${(v.result.annualized_return * 100).toFixed(2)}% vs recomputed ${(ann * 100).toFixed(2)}%`);
  }
  return issues;
}

const money = (t: string) => [...t.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
const percents = (t: string) => [...t.matchAll(/(-?\d+(?:\.\d+)?)\s?%/g)].map((m) => Number(m[1]) / 100);

/** Whether an action asks for buying more ("Buy below $150", "Add"), not "no add" or "do not add". */
export function actionAdds(action: string | null | undefined): boolean {
  const a = String(action ?? "").toLowerCase();
  if (!a.trim()) return false;
  const cleaned = a.replace(/\b(no|not|don't|do not|never|without|avoid)\s+(new\s+)?(add|adding|buy|buying)\b/g, "");
  // Only the lead clause is the action; later clauses ("add only if...", "consider an add below $150") are conditions.
  const lead = cleaned.split(/[.;]/)[0];
  return /\b(add|buy|accumulate|increase)\b/.test(lead) && !/\bonly if\b|\bwait\b/.test(lead);
}

/**
 * Whether the written conclusion matches the computed numbers, the evidence state and the portfolio.
 * Issues keep the record incomplete; they are listed for the investor.
 */
export function consistencyCheck(s: RunState): ConsistencyCheck {
  const checks: ConsistencyCheck["checks"] = [];
  const add = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail });
  const v = s.valuation, sm = s.summary;
  if (v) {
    const cross = crossCheckValuation(v, s.price.value, s.today);
    add("Valuation recomputed independently", cross.length === 0, cross.length ? cross.join("; ") : `All ${v.specs.length} scenarios, the weighted value and the annual return match`);
  } else add("Valuation recomputed independently", false, "No valuation");
  if (sm && v?.result.weighted_value) {
    const w = v.result.weighted_value, ann = v.result.annualized_return;
    const statesW = money(`${sm.valuation} ${sm.headline}`).some((x) => Math.abs(x - w) <= Math.max(1, w * 0.01));
    add("Summary states the app's weighted value", statesW, statesW ? `$${w.toFixed(2)} is in the summary` : `The summary does not state the app's weighted value of $${w.toFixed(2)}`);
    if (ann !== null) {
      const statesR = percents(`${sm.expected_return} ${sm.valuation}`).some((x) => Math.abs(x - ann) <= 0.006);
      add("Summary states the app's expected annual return", statesR, statesR ? `${(ann * 100).toFixed(1)}% a year is in the summary` : `The summary does not state the app's ${(ann * 100).toFixed(1)}% a year`);
    }
  }
  const adds = actionAdds(sm?.action);
  const pc = s.portfolioCheck;
  if (sm) {
    if (adds && pc?.weight !== null && pc?.weight !== undefined && pc.normalHigh !== null && pc.weight >= pc.normalHigh)
      add("Action respects the position limits", false, `The action adds, but the position is already ${(pc.weight * 100).toFixed(1)}%, at or above the ${(pc.normalHigh * 100).toFixed(0)}% top of its normal range`);
    else if (adds && pc?.headroomDollars !== null && pc?.headroomDollars !== undefined && pc.headroomDollars <= 1)
      add("Action respects the position limits", false, "The action adds, but there is no room under the maximum");
    else add("Action respects the position limits", true, adds ? "Adding fits the limits" : "The action does not add");
    const alloc = sm.allocation;
    if (alloc && pc?.max !== null && pc?.max !== undefined && (alloc.max_pct ?? 0) / 100 > pc.max + 1e-9)
      add("Allocation within the policy maximum", false, `The summary allows ${alloc.max_pct}%, above the ${(pc.max * 100).toFixed(0)}% maximum`);
    if (pc && pc.limitAuthority && pc.limitAuthority !== "you") add("Limit used is one you approved", false, `The position limit used is ${pc.limitAuthority === "imported" ? "imported from the old app and not yet approved by you" : `not approved by you (${pc.limitAuthority})`}; treat it as provisional`);
    // A favourable modeled return is not permission to add: an add needs complete research and room.
    if (adds && s.completeness && !s.completeness.complete) add("Adding needs complete research", false, "The action adds while the research is incomplete");
    if (s.review) {
      // The verdict is on the conclusion before the review: it stands only if a critical objection the
      // analyst could not rebut was met by changing the action.
      const fails = s.review.recommendation === "fails";
      const standing = s.objections.filter((o) => o.severity === "critical" && o.outcome !== "rebutted");
      const unchanged = !s.draft || s.draft.action === sm.action;
      const ok = !(fails && standing.length && unchanged);
      add("Recommendation survives the skeptical review", ok, fails ? (ok ? `The skeptic rejected the draft recommendation; ${standing.length ? "the action was changed" : "every critical objection was rebutted"}` : `The skeptic found the recommendation does not survive (${standing.map((o) => o.id).join(", ")} stand) and the action was not changed`) : `Skeptic: recommendation ${s.review.recommendation.replace(/_/g, " ")}`);
    }
  }
  const issues = checks.filter((c) => !c.ok && c.label !== "Limit used is one you approved").map((c) => `${c.label}: ${c.detail}`);
  return { ok: issues.length === 0, issues, checks };
}

/**
 * The position's weight and limits from the app's own portfolio data (ETF look-through included), for
 * checking the recommendation against. Nothing here comes from the model.
 */
export function portfolioCheckFrom(
  ws: { portfolio: { total: number; exposures: { symbol: string; direct: number; total: number; totalMax: number; max: number; hasLimit: boolean; headroomDollars: number }[] }; policy: { companies: Record<string, { normal: { low: number; high: number } | null; hardMax: number | null; authority?: string }> } | null },
  symbol: string,
): NonNullable<RunState["portfolioCheck"]> {
  const e = ws.portfolio.exposures.find((x) => x.symbol === symbol);
  const lim = ws.policy?.companies[symbol];
  return {
    weight: e ? e.total : 0, direct: e ? e.direct : 0,
    normalHigh: lim?.normal?.high ?? null, max: lim?.hardMax ?? (e?.hasLimit ? e.max : null),
    limitAuthority: lim ? lim.authority ?? null : "none", headroomDollars: e ? e.headroomDollars : null,
  };
}
