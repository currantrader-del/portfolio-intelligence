/**
 * "Update research": what, if anything, is worth paying an AI to read. Pure and code-only.
 *
 *  - New filings, earnings or material events since the research in use → a targeted update that builds
 *    on the saved evidence and model (reads only what is new; carries the rest forward).
 *  - A price move alone → no AI. The saved scenarios are re-priced for free at today's price.
 *  - A full re-investigation is recommended only when the foundation itself is unreliable: there is no
 *    finished investigation to build on, the price is outside the bear-to-bull range, the research is more
 *    than a year old, or the investigation was never completed.
 */
import type { Filing } from "@/lib/market/sec";

export type CostRange = { low: number; high: number; basis: string };
export type UpdatePlan = {
  foundation: { versionId: string; asOf: string; label: string } | null;
  newEvidence: { label: string; filed: string; category: string }[];
  /** Free re-pricing of the saved scenarios at today's price. */
  reprice: { price: number; reference: number; weighted: number; annualizedNow: number | null; annualizedThen: number | null; outsideRange: boolean } | null;
  recommend: "nothing_new" | "update" | "full";
  fullReasons: string[];
  estimates: { update: CostRange; full: CostRange };
  summary: string;
};

export type Foundation = {
  versionId: string; asOf: string; label: string; complete: boolean; isInvestigation: boolean;
  referencePrice: number | null; terminalDate: string | null;
  scenarios: { bear: number | null; base: number | null; bull: number | null; pBear: number | null; pBase: number | null; pBull: number | null };
  reviewedAccessions: string[];
};

const MATERIAL = new Set(["periodic", "results", "financing", "registration", "material_event"]);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Defaults until the app has measured enough runs of each kind. */
export const DEFAULT_ESTIMATES = { update: { low: 1, high: 2.5, basis: "estimate (no updates measured yet)" }, full: { low: 3, high: 6, basis: "estimate" } } as const;

export function planUpdate(a: { foundation: Foundation | null; filings: Filing[] | null; price: number | null; now: Date; estimates?: Partial<UpdatePlan["estimates"]> }): UpdatePlan {
  const estimates = { update: a.estimates?.update ?? { ...DEFAULT_ESTIMATES.update }, full: a.estimates?.full ?? { ...DEFAULT_ESTIMATES.full } };
  const f = a.foundation;
  const fullReasons: string[] = [];
  if (!f) fullReasons.push("There is no finished investigation to build on; a quick screen is not a foundation for updates.");
  else {
    if (!f.isInvestigation) fullReasons.push(`The research in use (${f.label}) is not a full investigation, so an update would build on weak ground.`);
    if (!f.complete) fullReasons.push("The investigation in use was never completed.");
    const ageDays = Math.floor((a.now.getTime() - Date.parse(`${f.asOf}T00:00:00Z`)) / 86_400_000);
    if (ageDays > 365) fullReasons.push(`The research is ${Math.floor(ageDays / 30)} months old.`);
  }

  // Free re-pricing: the same scenario values, today's price.
  let reprice: UpdatePlan["reprice"] = null;
  const s = f?.scenarios;
  if (f && s && a.price && s.bear !== null && s.base !== null && s.bull !== null && s.pBear !== null && s.pBase !== null && s.pBull !== null && f.referencePrice) {
    const weighted = r2(s.bear * s.pBear + s.base * s.pBase + s.bull * s.pBull);
    const years = f.terminalDate ? (Date.parse(f.terminalDate) - a.now.getTime()) / (365.25 * 86_400_000) : null;
    const yearsThen = f.terminalDate ? (Date.parse(f.terminalDate) - Date.parse(`${f.asOf}T00:00:00Z`)) / (365.25 * 86_400_000) : null;
    const ann = (p: number, y: number | null) => (y && y > 0.25 ? (weighted / p) ** (1 / y) - 1 : null);
    const lo = Math.min(s.bear, s.base, s.bull), hi = Math.max(s.bear, s.base, s.bull);
    const outsideRange = a.price < lo || a.price > hi;
    reprice = { price: a.price, reference: f.referencePrice, weighted, annualizedNow: ann(a.price, years), annualizedThen: ann(f.referencePrice, yearsThen), outsideRange };
    if (outsideRange) fullReasons.push(`The price ($${a.price}) is outside the research's bear-to-bull range ($${lo}–$${hi}), so its scenarios no longer describe the stock.`);
  }

  const reviewed = new Set(f?.reviewedAccessions ?? []);
  const newEvidence = f && a.filings
    ? a.filings.filter((x) => x.filed > f.asOf && MATERIAL.has(x.category) && !(x.accession && reviewed.has(x.accession))).map((x) => ({ label: `${x.form} ${x.description}`.trim(), filed: x.filed, category: x.category }))
    : [];

  const recommend: UpdatePlan["recommend"] = fullReasons.length ? "full" : newEvidence.length ? "update" : "nothing_new";
  const usd = (c: CostRange) => `$${c.low.toFixed(c.low < 10 ? 2 : 0)}–$${c.high.toFixed(c.high < 10 ? 2 : 0)}`;
  const summary = recommend === "full"
    ? `A full investigation is recommended: ${fullReasons[0]} About ${usd(estimates.full)}.`
    : recommend === "update"
      ? `${newEvidence.length} new filing${newEvidence.length === 1 ? "" : "s"} since ${f!.asOf}. An update reads only these, builds on the saved evidence and model, and costs about ${usd(estimates.update)}.`
      : a.filings === null
        ? "SEC filings could not be checked just now; try again later. Price changes are re-priced for free below."
        : `Nothing new filed since ${f!.asOf}. No AI is needed; the price change is re-priced for free.`;
  return { foundation: f ? { versionId: f.versionId, asOf: f.asOf, label: f.label } : null, newEvidence, reprice, recommend, fullReasons, estimates, summary };
}

/** Cost range from measured runs: the middle 80% of what past runs of this kind cost, or the default. */
export function measuredRange(costs: number[], fallback: CostRange): CostRange {
  const xs = costs.filter((c) => c > 0).sort((p, q) => p - q);
  if (xs.length < 2) return fallback;
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(q * (xs.length - 1))))];
  return { low: r2(at(0.1)), high: r2(Math.max(at(0.9), at(0.1) * 1.2)), basis: `measured from ${xs.length} past runs` };
}

/**
 * The server's own check before a paid update starts: an update runs only when there is something new
 * for it to read. A price move, or filings that could not be checked, never starts a paid run.
 */
export function updateAllowed(plan: UpdatePlan, filingsChecked: boolean): { ok: true } | { ok: false; message: string } {
  if (!plan.foundation) return { ok: false, message: "There is no finished investigation to update yet. No paid run was started." };
  if (!filingsChecked) return { ok: false, message: "SEC filings could not be checked just now, so the app cannot tell whether anything is new. No paid run was started; try again later." };
  if (!plan.newEvidence.length) return { ok: false, message: `Nothing material has been filed since ${plan.foundation.asOf}, so there is nothing for an update to read. No paid run was started; price changes are re-priced for free on the research page.` };
  return { ok: true };
}
