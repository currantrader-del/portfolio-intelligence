/**
 * The valuation is computed here, by code, from the scenario inputs the research states. The model
 * supplies assumptions with their sources; the per-share values, the probability-weighted value and
 * the expected annual return are always this file's arithmetic, so a typo or a slip in the model's own
 * maths can't reach a conclusion.
 */

export type Method = "pe" | "ev_ebitda" | "ev_sales" | "p_fcf";
export type ScenarioName = "bear" | "base" | "bull";
export type ScenarioInputs = {
  revenue: number; // fiscal-year revenue at the horizon, in dollars
  multiple: number; // P/E, EV/EBITDA, EV/sales or P/FCF
  diluted_shares: number; // shares, not millions
  operating_margin?: number; // pe
  net_other_income?: number; // pe: interest and other income, dollars (negative for net interest cost)
  tax_rate?: number; // pe
  ebitda_margin?: number; // ev_ebitda
  fcf_margin?: number; // p_fcf
  net_debt?: number; // ev_*: debt minus cash at the horizon (negative = net cash)
};
export type ScenarioSpec = {
  name: ScenarioName;
  probability: number;
  method: Method;
  inputs: ScenarioInputs;
  /** For each input: a finding id (F12), "calc: ..." or "estimate: <reason>". */
  sources: Record<string, string>;
  rationale: string;
  /** Optional explicit floor (for example liquidation or option value); must be justified in the rationale. */
  floor_value?: number | null;
};
export type Step = { label: string; formula: string; value: number };
export type ScenarioResult = { name: ScenarioName; probability: number; method: Method; steps: Step[]; computed_value: number; value_per_share: number; floored: boolean };
export type Trailing = { revenue: number | null; operatingMargin: number | null; fiscalYearEnd: string | null; revenueGrowth: number | null; label: string };
export type Comparison = { scenario: ScenarioName; text: string };
export type ValuationResult = {
  ok: boolean;
  errors: string[];
  scenarios: ScenarioResult[];
  weighted_value: number | null;
  price: number | null;
  horizon_date: string;
  years: number | null;
  total_return: number | null;
  annualized_return: number | null;
  scenario_annualized: { name: ScenarioName; annualized: number | null }[];
  comparisons: Comparison[];
};

const NEEDS: Record<Method, (keyof ScenarioInputs)[]> = {
  pe: ["revenue", "operating_margin", "tax_rate", "diluted_shares", "multiple"],
  ev_ebitda: ["revenue", "ebitda_margin", "multiple", "net_debt", "diluted_shares"],
  ev_sales: ["revenue", "multiple", "net_debt", "diluted_shares"],
  p_fcf: ["revenue", "fcf_margin", "multiple", "diluted_shares"],
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${r2(n)}`);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function valueScenario(s: ScenarioSpec): { steps: Step[]; value: number } {
  const i = s.inputs;
  const steps: Step[] = [];
  const shares = i.diluted_shares;
  if (s.method === "pe") {
    const ebit = i.revenue * (i.operating_margin ?? 0);
    steps.push({ label: "Operating income", formula: `${fmt(i.revenue)} x ${pct(i.operating_margin ?? 0)}`, value: ebit });
    const pre = ebit + (i.net_other_income ?? 0);
    if (i.net_other_income) steps.push({ label: "Pre-tax income", formula: `${fmt(ebit)} + ${fmt(i.net_other_income)}`, value: pre });
    const ni = pre * (1 - (i.tax_rate ?? 0));
    steps.push({ label: "Net income", formula: `${fmt(pre)} x (1 - ${pct(i.tax_rate ?? 0)})`, value: ni });
    const eps = ni / shares;
    steps.push({ label: "EPS", formula: `${fmt(ni)} / ${(shares / 1e6).toFixed(1)}M shares`, value: eps });
    const v = eps * i.multiple;
    steps.push({ label: "Value per share", formula: `$${eps.toFixed(2)} x ${i.multiple}x P/E`, value: v });
    return { steps, value: v };
  }
  if (s.method === "p_fcf") {
    const fcf = i.revenue * (i.fcf_margin ?? 0);
    steps.push({ label: "Free cash flow", formula: `${fmt(i.revenue)} x ${pct(i.fcf_margin ?? 0)}`, value: fcf });
    const v = (fcf * i.multiple) / shares;
    steps.push({ label: "Value per share", formula: `${fmt(fcf)} x ${i.multiple}x / ${(shares / 1e6).toFixed(1)}M shares`, value: v });
    return { steps, value: v };
  }
  const base = s.method === "ev_ebitda" ? i.revenue * (i.ebitda_margin ?? 0) : i.revenue;
  if (s.method === "ev_ebitda") steps.push({ label: "EBITDA", formula: `${fmt(i.revenue)} x ${pct(i.ebitda_margin ?? 0)}`, value: base });
  const ev = base * i.multiple;
  steps.push({ label: "Enterprise value", formula: `${fmt(base)} x ${i.multiple}x`, value: ev });
  const eq = ev - (i.net_debt ?? 0);
  steps.push({ label: "Equity value", formula: `${fmt(ev)} - net debt ${fmt(i.net_debt ?? 0)}`, value: eq });
  const v = eq / shares;
  steps.push({ label: "Value per share", formula: `${fmt(eq)} / ${(shares / 1e6).toFixed(1)}M shares`, value: v });
  return { steps, value: v };
}

export function computeValuation(a: { scenarios: ScenarioSpec[]; horizon_date: string; price: number | null; today: string; trailing?: Trailing | null }): ValuationResult {
  const errors: string[] = [];
  const names = a.scenarios.map((s) => s.name);
  for (const n of ["bear", "base", "bull"] as const) if (names.filter((x) => x === n).length !== 1) errors.push(`Needs exactly one ${n} scenario`);
  const pSum = a.scenarios.reduce((t, s) => t + (Number.isFinite(s.probability) ? s.probability : NaN), 0);
  if (!(Math.abs(pSum - 1) <= 0.001)) errors.push(`Probabilities add up to ${Number.isFinite(pSum) ? pSum.toFixed(3) : "an invalid number"}, not 1`);
  if (a.scenarios.some((s) => !(s.probability > 0 && s.probability < 1))) errors.push("Each probability must be between 0 and 1");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.horizon_date) || a.horizon_date <= a.today) errors.push("The horizon date must be a future date (YYYY-MM-DD)");

  const results: ScenarioResult[] = [];
  for (const s of a.scenarios) {
    const missing = NEEDS[s.method]?.filter((k) => !Number.isFinite(s.inputs?.[k] as number));
    if (!NEEDS[s.method]) { errors.push(`${s.name}: unknown method ${s.method}`); continue; }
    if (missing.length) { errors.push(`${s.name}: missing ${missing.join(", ")} for the ${s.method} method`); continue; }
    if (!(s.inputs.diluted_shares > 1e5)) errors.push(`${s.name}: diluted shares look wrong (${s.inputs.diluted_shares}); give the share count, not millions`);
    if (!(s.inputs.revenue > 1e5)) errors.push(`${s.name}: revenue looks wrong (${s.inputs.revenue}); give dollars, not millions`);
    for (const k of ["operating_margin", "ebitda_margin", "fcf_margin", "tax_rate"] as const) {
      const v = s.inputs[k];
      if (v !== undefined && !(v > -1 && v < 1)) errors.push(`${s.name}: ${k} must be a fraction (0.25 for 25%)`);
    }
    const unsourced = NEEDS[s.method].filter((k) => !String(s.sources?.[k] ?? "").trim());
    if (unsourced.length) errors.push(`${s.name}: no source or stated estimate for ${unsourced.join(", ")}`);
    if (!s.rationale?.trim()) errors.push(`${s.name}: no rationale`);
    const { steps, value } = valueScenario(s);
    const floor = s.floor_value ?? null;
    const floored = floor !== null && Number.isFinite(floor) && floor > value;
    if (floored) steps.push({ label: "Floor applied", formula: `max(${r2(value)}, floor ${r2(floor!)})`, value: floor! });
    results.push({ name: s.name, probability: s.probability, method: s.method, steps, computed_value: r2(value), value_per_share: r2(floored ? floor! : value), floored });
  }
  const by = (n: ScenarioName) => results.find((r) => r.name === n);
  const [bear, base, bull] = [by("bear"), by("base"), by("bull")];
  if (bear && base && bull && !(bear.value_per_share <= base.value_per_share && base.value_per_share <= bull.value_per_share)) errors.push("Scenario values are not ordered bear ≤ base ≤ bull");
  if (results.some((r) => r.value_per_share < 0)) errors.push("A scenario value is negative; use a floor with a reason if equity could be worthless");

  const weighted = results.length === 3 ? r2(results.reduce((t, r) => t + r.value_per_share * r.probability, 0)) : null;
  const years = /^\d{4}-\d{2}-\d{2}$/.test(a.horizon_date) ? (Date.parse(a.horizon_date) - Date.parse(a.today)) / (365.25 * 86_400_000) : null;
  const ann = (v: number | null) => (v !== null && a.price && years && years > 0.25 ? (v / a.price) ** (1 / years) - 1 : null);
  const comparisons: Comparison[] = [];
  const t = a.trailing;
  for (const s of a.scenarios) {
    const parts: string[] = [];
    if (t?.revenue && years && years > 0.25) {
      const cagr = (s.inputs.revenue / t.revenue) ** (1 / years) - 1;
      parts.push(`revenue ${fmt(s.inputs.revenue)} vs ${t.label} ${fmt(t.revenue)} = ${pct(cagr)} a year${t.revenueGrowth !== null ? ` (last reported growth ${pct(t.revenueGrowth)})` : ""}`);
    }
    const m = s.inputs.operating_margin;
    if (m !== undefined && t?.operatingMargin !== null && t?.operatingMargin !== undefined) parts.push(`operating margin ${pct(m)} vs ${pct(t.operatingMargin)} reported`);
    if (parts.length) comparisons.push({ scenario: s.name, text: parts.join("; ") });
  }
  return {
    ok: errors.length === 0,
    errors,
    scenarios: results,
    weighted_value: weighted,
    price: a.price,
    horizon_date: a.horizon_date,
    years: years !== null ? r2(years) : null,
    total_return: weighted !== null && a.price ? r2(weighted / a.price - 1) : null,
    annualized_return: ann(weighted) !== null ? Math.round(ann(weighted)! * 10000) / 10000 : null,
    scenario_annualized: results.map((r) => ({ name: r.name, annualized: ann(r.value_per_share) !== null ? Math.round(ann(r.value_per_share)! * 10000) / 10000 : null })),
    comparisons,
  };
}
