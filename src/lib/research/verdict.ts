/**
 * One answer for a company's research page: was it researched, and what is the single next step.
 * Pure: built from the record in use, the update plan (new filings, free re-pricing, full-rerun reasons)
 * and the price-zone check, so the status card, the update button and the list badge cannot disagree.
 * (Investor, 2026-11-12: "Was it researched or not? If the app wants to reassess then reassess it.")
 */
import type { UpdatePlan } from "./updatePlan";

export type NextStep =
  | { kind: "update"; text: string; cost: string }
  | { kind: "full"; text: string; cost: string }
  | { kind: "none"; text: string }
  | { kind: "unknown"; text: string };

export type Verdict = { researched: boolean; headline: string; detail: string | null; next: NextStep };

const usd = (c: { low: number; high: number }) => `$${c.low.toFixed(2)}–$${c.high.toFixed(2)}`;
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function researchVerdict(a: {
  inUse: { asOf: string; isInvestigation: boolean; open: string[]; label: string } | null;
  plan: UpdatePlan | null;
  zoneChange: string | null;
}): Verdict {
  const u = a.inUse;
  if (!u) return { researched: false, headline: "Not researched yet", detail: null, next: a.plan ? { kind: "full", text: "A full investigation is the first step.", cost: usd(a.plan.estimates.full) } : { kind: "unknown", text: "Start research below." } };
  const n = u.open.length;
  const headline = u.isInvestigation
    ? `Researched: full investigation of ${day(u.asOf)}, all phases finished${n ? `, ${n} question${n === 1 ? "" : "s"} left open` : ""}`
    : `Researched only as ${u.label.toLowerCase()} (${day(u.asOf)})`;
  const detail = n ? "In use for Hold, No Add and Trim. New money waits until the open questions are answered." : null;
  const p = a.plan;
  if (!p) return { researched: true, headline, detail, next: { kind: "unknown", text: "The update check could not run just now." } };
  if (p.recommend === "full") return { researched: true, headline, detail, next: { kind: "full", text: `A full investigation is needed: ${p.fullReasons[0]}`, cost: usd(p.estimates.full) } };
  if (p.recommend === "update") {
    const f = p.newEvidence;
    const what = f.length === 1 ? `${f[0].label} ${f[0].category === "analyst" ? "uploaded" : "filed"} ${day(f[0].filed)}` : `${f.length} new items since ${day(p.foundation!.asOf)} (latest ${day(f[0].filed)})`;
    return { researched: true, headline, detail, next: { kind: "update", text: `Reassess: ${what}. A targeted update reads only what is new${n ? " and works on the open questions" : ""}, builds on this research, and replaces it only if it finishes.`, cost: usd(p.estimates.update) } };
  }
  if (p.summary.startsWith("SEC filings could not be checked")) return { researched: true, headline, detail, next: { kind: "unknown", text: "SEC filings could not be checked just now, so the app can't tell whether anything new was filed. Try again later; no AI run starts until it can." } };
  return { researched: true, headline, detail, next: { kind: "none", text: a.zoneChange
    ? `No reassessment needed: nothing new was filed. ${a.zoneChange}; the saved scenarios are re-priced for free below.`
    : "No reassessment needed: nothing new filed since the research. Price moves are re-priced for free below; no AI is needed." } };
}
