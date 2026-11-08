/**
 * Evidence behind the decision engine's return comparison and research-refresh rules.
 *
 * Nothing here is a cutoff. Each investment alternative carries its published, dated forecasts as
 * they were published (a range stays a range, a point stays a point; sources are never merged into
 * one made-up number). A stock is then compared with those alternatives on expected return, downside,
 * valuation uncertainty and concentration, and the comparison is summarised as a reasoned judgment.
 * Research goes stale when something happens (a filing, a financing, a move into a different action
 * zone), not when a calendar counter runs out.
 */
import type { Filing, FilingsResult } from "@/lib/market/sec";
import type { ParsedConclusion } from "@/lib/research/valuation";
import { annualized, yearsUntil, zoneFor } from "@/lib/research/valuation";

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const f1 = (n: number) => `${(n * 100).toFixed(1)}%`;

export type Forecast = {
  firm: string;
  asset: string; // what the forecast covers, in the source's words
  low: number;
  high: number; // equal to low for a point estimate
  kind: "range" | "point";
  horizonYears: [number, number];
  asOf: string;
  method: string; // what the source says about how it was made, and what it does not say
  url: string;
};

const VANGUARD_URL = "https://corporate.vanguard.com/content/corporatesite/us/en/corp/vemo/vemo-return-forecasts.html";
const JPM_URL = "https://am.jpmorgan.com/us/en/asset-management/institutional/about-us/media/press-releases/jp-morgan-releases-2027-long-term-capital-market-assumptions/";
const VANGUARD_METHOD = "Vanguard Capital Markets Model, 10,000 Monte Carlo simulations, geometric (compound) nominal returns before costs and taxes. The page does not say what the range endpoints represent (for example a percentile band).";
const JPM_METHOD = "Single published figure; the release does not say whether it is a median or mean, or compound or arithmetic. Built from a quantitative and qualitative process; passive (no active management).";

export type Alternative = { symbol: string; label: string; forecasts: Forecast[]; note: string };

/** Investment alternatives with published long-run forecasts. Checked against the sources on 2026-11-08. */
export const ALTERNATIVES: Alternative[] = [
  {
    symbol: "VOO", label: "U.S. stocks (VOO)", note: "Your stated benchmark: what you would earn by simply owning the S&P 500.",
    forecasts: [
      { firm: "Vanguard", asset: "U.S. equities (MSCI US Broad Market)", low: 0.048, high: 0.068, kind: "range", horizonYears: [10, 10], asOf: "2026-09-30", method: VANGUARD_METHOD, url: VANGUARD_URL },
      { firm: "J.P. Morgan", asset: "U.S. large cap", low: 0.075, high: 0.075, kind: "point", horizonYears: [10, 15], asOf: "2026-10-19", method: JPM_METHOD, url: JPM_URL },
    ],
  },
  {
    symbol: "VXUS", label: "International stocks (VXUS)", note: "VXUS holds developed and emerging markets; the sources forecast them separately, so both are shown.",
    forecasts: [
      { firm: "Vanguard", asset: "Developed ex-U.S. equities", low: 0.053, high: 0.073, kind: "range", horizonYears: [10, 10], asOf: "2026-09-30", method: VANGUARD_METHOD, url: VANGUARD_URL },
      { firm: "Vanguard", asset: "Emerging-market equities", low: 0.037, high: 0.057, kind: "range", horizonYears: [10, 10], asOf: "2026-09-30", method: VANGUARD_METHOD, url: VANGUARD_URL },
      { firm: "J.P. Morgan", asset: "Emerging-market equities", low: 0.071, high: 0.071, kind: "point", horizonYears: [10, 15], asOf: "2026-10-19", method: JPM_METHOD, url: JPM_URL },
    ],
  },
];

/** The span across a set of forecasts, kept with its sources. Never averaged into a single number. */
export function span(forecasts: Forecast[]): { low: number; high: number } {
  return { low: Math.min(...forecasts.map((x) => x.low)), high: Math.max(...forecasts.map((x) => x.high)) };
}

export const VOO = ALTERNATIVES[0];
export const VOO_SPAN = span(VOO.forecasts);

/** A risk-free alternative for the same horizon: Treasury yields from FRED, interpolated to the horizon. */
export type RiskFree = { rate: number; detail: string; asOf: string | null } | null;
export function riskFreeFor(years: number, yields: { y2: { value: number; date: string } | null; y10: { value: number; date: string } | null }): RiskFree {
  const { y2, y10 } = yields;
  if (!y2 && !y10) return null;
  if (y2 && y10) {
    const t = Math.max(0, Math.min(1, (years - 2) / 8));
    const rate = (y2.value + t * (y10.value - y2.value)) / 100;
    return { rate: r4(rate), detail: `Treasury yield for about ${years.toFixed(1)} years, interpolated between the 2-year (${y2.value.toFixed(2)}%) and 10-year (${y10.value.toFixed(2)}%) yields`, asOf: y10.date };
  }
  const one = (y2 ?? y10)!;
  return { rate: r4(one.value / 100), detail: `${y2 ? "2-year" : "10-year"} Treasury yield (${one.value.toFixed(2)}%)`, asOf: one.date };
}

export type Factor = { label: string; finding: string; leans: "for" | "against" | "neutral" };

export type Assessment = {
  expected: number; // probability-weighted annual return at today's price, from the research's scenarios
  scenarios: { name: string; probability: number; annual: number; total: number }[];
  horizonYears: number;
  probLoss: number; // research odds that the stock is worth less than today's price at the horizon
  probBeatVooLow: number; // research odds of beating even the lowest VOO forecast
  probBeatVooHigh: number; // research odds of beating the highest VOO forecast
  vsVoo: "above_all" | "within" | "below_all";
  riskFree: RiskFree;
  factors: Factor[];
  /** The MODELED return compared with VOO. Not a buy signal: the research's own conclusion decides the action. */
  judgment: "favourable" | "mixed" | "unfavourable";
  /** True when the research horizon is close enough to the forecasts' 10-15 years to compare annual rates directly. */
  horizonCompatible: boolean;
  /** Total return over the research's own horizon: the stock's probability-weighted case vs VOO's forecasts compounded over the same years. */
  overHorizon: { years: number; stock: number; vooLow: number; vooHigh: number };
  summary: string;
};

/**
 * Compares one stock (its research scenarios, re-priced at today's price) with owning VOO and with a
 * risk-free Treasury for the same horizon. The judgment is reasoned from the factors, in this order:
 *  - favourable: the expected return is above EVERY published VOO forecast, and by the research's own odds
 *    the stock is more likely than not to beat even the lowest one;
 *  - unfavourable: the expected return is below every VOO forecast (owning the index is expected to do better);
 *  - mixed: anything in between, i.e. within the forecasts' own uncertainty. Mixed is not a buy on return grounds.
 * Downside, valuation uncertainty and concentration are reported beside it, never folded into a hidden premium.
 * Returns null when the research has no usable scenarios: no number is invented.
 */
export function assessVsAlternatives(pc: ParsedConclusion, price: number, now: Date, ctx: {
  riskFree?: RiskFree;
  weightNow?: number | null;
  weightAfter?: number | null;
  limit?: { normalHigh: number | null; hcHigh: number | null; max: number | null } | null;
  completeness?: string | null;
  confidence?: string | null;
} = {}): Assessment | null {
  if (!pc.horizonDate || !(price > 0) || !pc.weightedValue) return null;
  const sc = pc.scenarios.filter((s) => s.probability > 0);
  const probSum = sc.reduce((a, s) => a + s.probability, 0);
  if (sc.length < 2 || Math.abs(probSum - 1) > 0.02) return null;
  const horizonYears = Math.max(0.25, yearsUntil(pc.horizonDate, now));
  const scenarios = sc.map((s) => ({ name: s.name, probability: s.probability, annual: r4(annualized(price, s.value, pc.horizonDate!, now)), total: r4(s.value / price - 1) }));
  const expected = r4(annualized(price, pc.weightedValue, pc.horizonDate, now));
  const odds = (pred: (a: number) => boolean) => r4(scenarios.filter((s) => pred(s.annual)).reduce((a, s) => a + s.probability, 0));
  const probLoss = r4(scenarios.filter((s) => s.total < 0).reduce((a, s) => a + s.probability, 0));
  const probBeatVooLow = odds((a) => a > VOO_SPAN.low);
  const probBeatVooHigh = odds((a) => a > VOO_SPAN.high);
  const vsVoo = expected > VOO_SPAN.high ? "above_all" : expected < VOO_SPAN.low ? "below_all" : "within";
  const bear = [...scenarios].sort((a, b) => a.annual - b.annual)[0];
  const best = [...scenarios].sort((a, b) => b.annual - a.annual)[0];
  const factors: Factor[] = [];

  factors.push({ label: "Expected return vs VOO", leans: vsVoo === "above_all" ? "for" : vsVoo === "below_all" ? "against" : "neutral",
    finding: `${f1(expected)} a year expected vs published VOO forecasts of ${VOO.forecasts.map((x) => `${x.kind === "range" ? `${f1(x.low)}–${f1(x.high)}` : f1(x.low)} (${x.firm})`).join(" and ")}: ${vsVoo === "above_all" ? "above all of them" : vsVoo === "below_all" ? "below all of them" : "inside their spread, so the difference is within forecast uncertainty"}.` });
  if (ctx.riskFree) factors.push({ label: "Vs a risk-free Treasury", leans: expected > ctx.riskFree.rate ? "neutral" : "against", finding: `${f1(ctx.riskFree.rate)} a year is available without stock risk (${ctx.riskFree.detail}).` });
  factors.push({ label: "Odds of beating VOO", leans: probBeatVooLow > 0.5 ? "for" : "against",
    finding: `Using the research's own scenario probabilities (subjective assumptions, not statistical confidence): ${Math.round(probBeatVooLow * 100)}% chance of beating the lowest VOO forecast, ${Math.round(probBeatVooHigh * 100)}% of beating the highest.` });
  factors.push({ label: "Downside", leans: probLoss >= 0.3 ? "against" : "neutral",
    finding: `${Math.round(probLoss * 100)}% chance of being worth less than today at the horizon. Bear case (${Math.round(bear.probability * 100)}%): ${f1(bear.total)} in total, ${f1(bear.annual)} a year.` });
  factors.push({ label: "Valuation uncertainty", leans: "neutral",
    finding: `Outcomes range from ${f1(bear.annual)} to ${f1(best.annual)} a year${ctx.confidence ? `; research confidence ${ctx.confidence}` : ""}${ctx.completeness && ctx.completeness !== "complete" ? `; research is ${ctx.completeness}` : ""}.` });
  const horizonCompatible = horizonYears >= 8;
  const T = horizonYears;
  const overHorizon = { years: r4(T), stock: r4(Math.pow(1 + expected, T) - 1), vooLow: r4(Math.pow(1 + VOO_SPAN.low, T) - 1), vooHigh: r4(Math.pow(1 + VOO_SPAN.high, T) - 1) };
  factors.push({ label: "Same horizon", leans: "neutral", finding: horizonCompatible
    ? `The research runs about ${T.toFixed(1)} years, close to the forecasts' 10-15 years.`
    : `Over the research's ${T.toFixed(1)} years: ${f1(overHorizon.stock)} total expected for the stock vs ${f1(overHorizon.vooLow)}–${f1(overHorizon.vooHigh)} for VOO if its 10-year forecasts held over the same period. No published forecast covers ${T.toFixed(1)} years, and index returns over a few years can differ widely from 10-year forecasts, so this comparison is approximate.` });
  if (ctx.weightNow != null) {
    const lim = ctx.limit;
    const after = ctx.weightAfter ?? ctx.weightNow;
    const where = !lim ? "no limit of its own" : lim.max !== null && after > lim.max ? `above its ${f1(lim.max)} maximum` : lim.hcHigh !== null && lim.normalHigh !== null && after > lim.normalHigh ? `in its high-conviction range (up to ${f1(lim.hcHigh)})` : lim.normalHigh !== null ? `within its normal range (up to ${f1(lim.normalHigh)})` : "below its maximum";
    factors.push({ label: "Concentration", leans: !lim || (lim.max !== null && after > lim.max) ? "against" : "neutral", finding: `${f1(ctx.weightNow)} of the portfolio now${ctx.weightAfter != null && ctx.weightAfter !== ctx.weightNow ? `, ${f1(after)} after this purchase` : ""}: ${where}.` });
  }

  const judgment: Assessment["judgment"] = vsVoo === "above_all" && probBeatVooLow > 0.5 ? "favourable" : vsVoo === "below_all" ? "unfavourable" : "mixed";
  const approx = horizonCompatible ? "" : ` (approximate: ${T.toFixed(1)}-year research vs 10-year forecasts)`;
  const summary = judgment === "favourable"
    ? `Modeled return favourable vs VOO${approx}: ${f1(expected)} a year at today's price is above every published VOO forecast, and the research's subjective scenario odds of beating the lowest one are better than even. Downside: ${Math.round(probLoss * 100)}% assumed chance of a loss, bear case ${f1(bear.total)}.`
    : judgment === "unfavourable"
      ? `Modeled return unfavourable vs VOO${approx}: ${f1(expected)} a year at today's price is below every published VOO forecast, so owning the index is expected to do better.`
      : `Modeled return mixed vs VOO${approx}: ${f1(expected)} a year at today's price${vsVoo === "above_all" ? " is above the VOO forecasts, but the research's subjective odds of beating even the lowest one are not better than even" : " is within the spread of VOO forecasts"}.`;
  return { expected, scenarios, horizonYears: r4(horizonYears), probLoss, probBeatVooLow, probBeatVooHigh, vsVoo, riskFree: ctx.riskFree ?? null, factors, judgment, summary, horizonCompatible, overHorizon };
}

// ---------- Event-driven research refresh ----------

export type RefreshTrigger = { kind: "results" | "financing" | "material_event" | "zone_change" | "price_move" | "unverified"; detail: string; date?: string; url?: string };
export type RefreshState = { status: "current" | "refresh" | "unverified"; triggers: RefreshTrigger[] };

const RESULTS_FORMS = /^(10-K|10-Q|20-F|40-F)(\/A)?$/;
const FINANCING_FORMS = /^(424B[1-8]|S-1|S-3|S-3ASR|F-3|F-1)(\/A)?$/;
const FINANCING_ITEMS = ["2.03", "3.02"];
const MATERIAL_ITEMS = ["1.01", "1.02", "2.01", "2.05", "2.06", "4.01", "4.02", "5.01", "5.02"];
/** Used only when the research has no action zones of its own to compare against. */
export const FALLBACK_PRICE_MOVE = 0.15;

/** A clause that makes an action conditional ("only if", "only after", "re-check ... first"). Returns the condition text, or null. */
export function conditionIn(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/\b(only (?:if|after|when|once)|after .{0,40}(?:verified|confirmed)|provided|subject to|re-?check[^.]*first|research trigger)\b[^.]*\.?/i);
  return m ? m[0].trim().replace(/\.$/, "") : null;
}

export type ResearchStance = {
  /** add: the research itself supports adding at this price; conditional: only once a stated condition is met; hold / trim otherwise. */
  kind: "add" | "conditional" | "hold" | "trim";
  /** The research's own words that decide it (the price zone at today's price, else the overall conclusion). */
  text: string;
  from: "zone" | "conclusion";
  condition: string | null;
};

/**
 * What the completed research itself says about adding at today's price. The research conclusion decides the
 * action; a favourable modeled return never overrides it. A conditional add ("consider a small add only if ...")
 * is not an add until the condition is confirmed.
 */
export function researchStance(pc: ParsedConclusion, price: number | null): ResearchStance | null {
  const zone = price ? zoneFor(pc.zones, price) : null;
  const text = zone?.action ?? pc.action;
  if (!text) return null;
  const kind = zoneKind(text);
  const condition = conditionIn(text);
  return { kind: kind === "buy" && condition ? "conditional" : kind === "buy" ? "add" : kind, text, from: zone ? "zone" : "conclusion", condition };
}

/** The research's own recommended action, simplified so a change of zone can be detected. */
export function zoneKind(action: string): "buy" | "hold" | "trim" {
  if (/trim|sell|exit|reduce|re-underwrite/i.test(action)) return "trim";
  if (/hold|no add|watch|wait/i.test(action)) return "hold";
  if (/buy|add|accumulate|starter/i.test(action)) return "buy";
  return "hold";
}

/**
 * Research needs a refresh when something has happened since it was written:
 *  - new quarterly/annual results (10-Q, 10-K, 20-F or an 8-K item 2.02),
 *  - a financing or dilution filing (424B*, S-1/S-3/F-3, 8-K 2.03/3.02),
 *  - another material 8-K (agreements, acquisitions, impairments, auditor or management changes),
 *  - the price moving into a different action zone of the research itself (e.g. hold -> buy after a drop).
 * When filings could not be checked, the status is "unverified", never "current".
 */
export function refreshState(args: { asOf: string | null; pc: ParsedConclusion | null; price: number | null; filings: FilingsResult | null | undefined; isEtf?: boolean }): RefreshState {
  const { asOf, pc, price, filings } = args;
  const triggers: RefreshTrigger[] = [];
  if (!asOf) return { status: "refresh", triggers: [{ kind: "unverified", detail: "No research date on file" }] };
  if (!args.isEtf) {
    if (!filings) triggers.push({ kind: "unverified", detail: "SEC filings could not be checked, so new results or financings since the research can't be ruled out" });
    else {
      const after = filings.filings.filter((f) => f.filed > asOf);
      const push = (kind: RefreshTrigger["kind"], f: Filing, what: string) => triggers.push({ kind, detail: `${what}: ${f.form} filed ${f.filed}${f.description ? ` (${f.description})` : ""}`, date: f.filed, url: f.url });
      for (const f of after) {
        if (RESULTS_FORMS.test(f.form) || (f.form.startsWith("8-K") && f.items.includes("2.02"))) push("results", f, "New results since the research");
        else if (FINANCING_FORMS.test(f.form) || (f.form.startsWith("8-K") && f.items.some((i) => FINANCING_ITEMS.includes(i)))) push("financing", f, "Financing or share issuance since the research");
        else if (f.form.startsWith("8-K") && f.items.some((i) => MATERIAL_ITEMS.includes(i))) push("material_event", f, "Material event since the research");
      }
    }
  }
  if (pc && price && pc.referencePrice) {
    const refZone = zoneFor(pc.zones, pc.referencePrice);
    const nowZone = zoneFor(pc.zones, price);
    if (refZone && nowZone) {
      if (zoneKind(refZone.action) !== zoneKind(nowZone.action)) {
        triggers.push({ kind: "zone_change", detail: `Price $${price.toFixed(2)} is in the research's "${nowZone.label}" zone (${nowZone.action}); the research was written at $${pc.referencePrice} in "${refZone.label}" (${refZone.action}). Re-check the scenarios before acting on the new zone` });
      }
    } else {
      const drift = price / pc.referencePrice - 1;
      if (Math.abs(drift) > FALLBACK_PRICE_MOVE) triggers.push({ kind: "price_move", detail: `Price is ${Math.round(Math.abs(drift) * 100)}% ${drift < 0 ? "below" : "above"} the $${pc.referencePrice} research reference, and the research has no price zones to say what that means` });
    }
  }
  const real = triggers.filter((t) => t.kind !== "unverified");
  return { status: real.length ? "refresh" : triggers.length ? "unverified" : "current", triggers };
}

