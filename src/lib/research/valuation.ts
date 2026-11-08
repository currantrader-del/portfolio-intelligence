/**
 * Reads a stored research conclusion (Layer 2) and re-prices it at today's price (Layer 3).
 * The scenario values are the research's; only the price and the clock change here.
 */
export type PriceZone = { low: number; high: number; action: string; label: string };
export type Scenario = { name: "bear" | "base" | "bull"; value: number; probability: number };
export type ParsedConclusion = {
  action: string | null;
  classification: string | null;
  confidence: string | null;
  thesis: string | null;
  referencePrice: number | null;
  referenceDate: string | null;
  scenarios: Scenario[];
  weightedValue: number | null;
  horizonDate: string | null;
  zones: PriceZone[];
  allocation: Record<string, unknown> | null;
};

export function money(s: unknown): number | null {
  if (typeof s === "number") return s;
  if (typeof s !== "string") return null;
  const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** "< $35" | "$35–$40" | "> $70" -> numeric band. */
export function parseZone(label: string, action: string): PriceZone | null {
  const nums = (label.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (/^\s*</.test(label) && nums.length >= 1) return { low: 0, high: nums[0], action, label };
  if (/^\s*>/.test(label) && nums.length >= 1) return { low: nums[0], high: Infinity, action, label };
  if (nums.length >= 2) return { low: nums[0], high: nums[1], action, label };
  return null;
}

function addYears(isoDate: string, years: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Math.round(years * 365.25));
  return d.toISOString().slice(0, 10);
}

export function parseConclusion(c: Record<string, unknown> | null | undefined): ParsedConclusion {
  const v = (c?.valuation ?? {}) as Record<string, unknown>;
  const scenarios: Scenario[] = (["bear", "base", "bull"] as const)
    .map((name) => ({ name, value: Number(v[`${name}_value`]), probability: Number(v[`${name}_probability`]) }))
    .filter((s) => Number.isFinite(s.value) && Number.isFinite(s.probability) && s.probability > 0);
  const probSum = scenarios.reduce((a, s) => a + s.probability, 0);
  const weightedValue = scenarios.length && Math.abs(probSum - 1) < 0.02
    ? scenarios.reduce((a, s) => a + s.value * s.probability, 0)
    : money(v.probability_weighted_terminal_value);
  const referenceDate = typeof c?.reference_date === "string" ? c.reference_date : null;
  let horizonDate: string | null = typeof v.terminal_date === "string" ? v.terminal_date : null;
  if (!horizonDate && referenceDate && Number(v.approx_holding_period_years) > 0) horizonDate = addYears(referenceDate, Number(v.approx_holding_period_years));
  const zones = Array.isArray(c?.price_framework)
    ? (c!.price_framework as { price_zone?: string; action?: string }[])
        .map((z) => (z.price_zone && z.action ? parseZone(z.price_zone, z.action) : null))
        .filter((z): z is PriceZone => z !== null)
    : [];
  const str = (k: string) => (typeof c?.[k] === "string" ? (c[k] as string) : null);
  return {
    action: str("action"),
    classification: str("classification"),
    confidence: str("confidence"),
    thesis: str("thesis"),
    referencePrice: money(c?.reference_price),
    referenceDate,
    scenarios,
    weightedValue,
    horizonDate,
    zones,
    allocation: (c?.allocation as Record<string, unknown>) ?? null,
  };
}

export function yearsUntil(horizonDate: string, now: Date): number {
  return (new Date(horizonDate + "T00:00:00Z").getTime() - now.getTime()) / (365.25 * 86_400_000);
}

/** Annualized price return from `price` to `target` by the horizon. Floors the horizon at 3 months. */
export function annualized(price: number, target: number, horizonDate: string, now: Date): number {
  const years = Math.max(0.25, yearsUntil(horizonDate, now));
  return Math.pow(target / price, 1 / years) - 1;
}

export function expectedReturnAt(pc: ParsedConclusion, price: number, now: Date): number | null {
  if (!pc.weightedValue || !pc.horizonDate || !(price > 0)) return null;
  return annualized(price, pc.weightedValue, pc.horizonDate, now);
}

export function scenarioReturnsAt(pc: ParsedConclusion, price: number, now: Date) {
  if (!pc.horizonDate || !(price > 0)) return [];
  return pc.scenarios.map((s) => ({ ...s, annualized: annualized(price, s.value, pc.horizonDate!, now) }));
}

export function zoneFor(zones: PriceZone[], price: number): PriceZone | null {
  return zones.find((z) => price >= z.low && price < z.high) ?? null;
}

/** Price this far from the research reference (either way) means the scenarios must be refreshed before they are re-priced. */
export const REPRICE_LIMIT = 0.15;

/**
 * Whether stored scenarios may be re-priced at today's price. A big move (especially a drop) can change the
 * probabilities, financing, dilution and cash-flow assumptions, so the old scenarios are not stretched to fit it.
 */
export function repriceCheck(p: ParsedConclusion, price: number | null, ageDays?: number | null, reminderDays = 120): { ok: boolean; reason: string | null; drift: number | null; note?: string } {
  if (!price || !p.referencePrice) return { ok: false, reason: "No reference price to compare", drift: null };
  const drift = price / p.referencePrice - 1;
  if (Math.abs(drift) > REPRICE_LIMIT) {
    return { ok: false, drift, reason: `Price is ${Math.round(Math.abs(drift) * 100)}% ${drift < 0 ? "below" : "above"} the $${p.referencePrice} research reference. The scenarios need a refresh before they can be re-priced; a lower price is not a buy signal by itself.` };
  }
  // Age alone never blocks re-pricing: events do (see refreshState in policy/evidence). Old research only earns a reminder.
  if (ageDays != null && ageDays > reminderDays) return { ok: true, drift, reason: null, note: `${ageDays} days since the research: check what has been filed since.` };
  return { ok: true, reason: null, drift };
}
