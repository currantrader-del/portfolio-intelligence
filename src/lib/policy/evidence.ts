/**
 * Evidence behind the decision engine's return comparison and research-refresh rules.
 *
 * Nothing here is a universal constant. The benchmark return is a RANGE taken from published,
 * dated capital-market forecasts; the margin a single stock must clear comes from that stock's own
 * scenario spread; and research goes stale when something happens (a filing, a financing, a move
 * into a different action zone), not when a calendar counter runs out.
 */
import type { Filing, FilingsResult } from "@/lib/market/sec";
import type { ParsedConclusion } from "@/lib/research/valuation";
import { annualized, zoneFor } from "@/lib/research/valuation";

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export type ReturnSource = { firm: string; asset: string; low: number; high: number; horizon: string; asOf: string; url: string };

/**
 * Published long-run nominal forecasts for U.S. equities (what VOO holds). Checked 2026-11-08.
 * Vanguard publishes a range; J.P. Morgan a point (low = high).
 */
export const US_EQUITY_FORECASTS: ReturnSource[] = [
  { firm: "Vanguard Capital Markets Model", asset: "U.S. equities", low: 0.048, high: 0.068, horizon: "10 years", asOf: "2026-09-30", url: "https://corporate.vanguard.com/content/corporatesite/us/en/corp/vemo/vemo-return-forecasts.html" },
  { firm: "J.P. Morgan 2027 Long-Term Capital Market Assumptions", asset: "U.S. large cap", low: 0.075, high: 0.075, horizon: "10–15 years", asOf: "2026-10-19", url: "https://am.jpmorgan.com/us/en/asset-management/institutional/about-us/media/press-releases/jp-morgan-releases-2027-long-term-capital-market-assumptions/" },
];

export type Benchmark = { low: number; high: number; mid: number; sources: ReturnSource[] };

/** Range spanned by the sources; the middle is the average of each source's own midpoint. */
export function benchmarkFrom(sources: ReturnSource[]): Benchmark {
  const low = Math.min(...sources.map((s) => s.low));
  const high = Math.max(...sources.map((s) => s.high));
  const mid = sources.reduce((a, s) => a + (s.low + s.high) / 2, 0) / sources.length;
  return { low: r4(low), high: r4(high), mid: r4(mid), sources };
}

export const EVIDENCE_BENCHMARK = benchmarkFrom(US_EQUITY_FORECASTS);

/**
 * How much of a stock's scenario spread must be paid for in extra expected return. This is a risk
 * PREFERENCE, not a fact: 0.5 means "for every 10 points of spread between the stock's outcomes,
 * I want 5 points a year more than the index". Shown to the owner for approval like any other rule.
 */
export const DEFAULT_RISK_MARGIN_FACTOR = 0.5;

export type ReturnComparison = {
  expected: number; // probability-weighted annual return at today's price
  scenarios: { name: string; probability: number; annual: number }[];
  spread: number; // probability-weighted standard deviation of the scenario returns
  margin: number; // factor x spread
  bar: number; // benchmark high end + margin
  benchmark: Benchmark;
  probTrailIndex: number; // chance (by the research's own probabilities) of doing worse than the index middle
  clears: boolean;
  explain: string;
};

/**
 * Compares one stock's research scenarios, re-priced at today's price, with the index.
 * The stock must beat the TOP of the published index range plus a margin set by its own spread,
 * so a wide bear-to-bull range needs a larger expected return. Returns null when the research has
 * no usable scenarios: no number is invented.
 */
export function compareToIndex(pc: ParsedConclusion, price: number, now: Date, benchmark: Benchmark, factor = DEFAULT_RISK_MARGIN_FACTOR): ReturnComparison | null {
  if (!pc.horizonDate || !(price > 0) || !pc.weightedValue) return null;
  const sc = pc.scenarios.filter((s) => s.probability > 0);
  const probSum = sc.reduce((a, s) => a + s.probability, 0);
  if (sc.length < 2 || Math.abs(probSum - 1) > 0.02) return null;
  const scenarios = sc.map((s) => ({ name: s.name, probability: s.probability, annual: annualized(price, s.value, pc.horizonDate!, now) }));
  const expected = annualized(price, pc.weightedValue, pc.horizonDate, now);
  const mean = scenarios.reduce((a, s) => a + s.probability * s.annual, 0);
  const spread = Math.sqrt(scenarios.reduce((a, s) => a + s.probability * (s.annual - mean) ** 2, 0));
  const margin = factor * spread;
  const bar = benchmark.high + margin;
  const probTrailIndex = scenarios.filter((s) => s.annual < benchmark.mid).reduce((a, s) => a + s.probability, 0);
  const clears = expected >= bar;
  const f = (n: number) => `${(n * 100).toFixed(1)}%`;
  const explain = `Expected ${f(expected)} a year at $${price.toFixed(2)} vs a bar of ${f(bar)} (index forecasts top out at ${f(benchmark.high)}, plus ${f(margin)} for this stock's ${f(spread)} scenario spread). ${Math.round(probTrailIndex * 100)}% chance, by the research's own odds, of trailing the index.`;
  return { expected: r4(expected), scenarios, spread: r4(spread), margin: r4(margin), bar: r4(bar), benchmark, probTrailIndex: r4(probTrailIndex), clears, explain };
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

