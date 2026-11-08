/**
 * Decides, by explicit rules, whether stored research is still usable, needs a targeted refresh,
 * or needs a full reassessment. Pure and deterministic: the same inputs give the same answer, and
 * every trigger says which rule fired and on what evidence. It never decides the investment
 * conclusion itself; it decides how much of the research has to be redone before one is drawn.
 */
import type { Filing } from "@/lib/market/sec";
import { REPRICE_LIMIT, type ParsedConclusion } from "./valuation";

export const REFRESH_RULES_VERSION = "refresh@1";

export type RefreshLevel = "current" | "targeted_refresh" | "full_reassessment";
export type Trigger = { rule: string; level: Exclude<RefreshLevel, "current">; evidence: string; scope: string[] };
export type RefreshDecision = { level: RefreshLevel; triggers: Trigger[]; notChecked: string[]; rulesVersion: string };

/** Big moves (in either direction) beyond this mean the scenario probabilities themselves are in question. */
export const FULL_REASSESS_DRIFT = 0.35;

export function decideRefresh(args: {
  conclusion: ParsedConclusion;
  researchAsOf: string;
  completeness: string;
  price: number | null;
  priceAsOf: string | null;
  filings: Filing[] | null; // null = filings could not be retrieved
  reviewedAccessions?: string[]; // documents the research already covered
  now: Date;
  freshDays: number;
}): RefreshDecision {
  const { conclusion: c, researchAsOf, now } = args;
  const t: Trigger[] = [];
  const notChecked: string[] = [];
  const reviewed = new Set(args.reviewedAccessions ?? []);

  if (args.completeness !== "complete") t.push({ rule: "R1 incomplete research", level: "targeted_refresh", evidence: `Stored research is ${args.completeness}`, scope: ["missing phases"] });

  const age = Math.floor((now.getTime() - new Date(`${researchAsOf}T00:00:00Z`).getTime()) / 86400000);
  // R2 (age) is only a reminder when filings could not be checked; with filings, R3-R6 (events) decide.
  if (age > args.freshDays && args.filings === null) t.push({ rule: "R2 long gap, filings not checked", level: "targeted_refresh", evidence: `${age} days since research and filings could not be retrieved`, scope: ["financials", "catalysts"] });

  if (args.filings === null) notChecked.push("SEC filings could not be retrieved, so new reports and financing were not checked");
  else {
    const after = args.filings.filter((f) => f.filed > researchAsOf && !(f.accession && reviewed.has(f.accession)));
    const periodic = after.filter((f) => f.category === "periodic" || f.category === "results");
    if (periodic.length) t.push({ rule: "R3 new financial report", level: "targeted_refresh", evidence: periodic.map((f) => `${f.form} ${f.filed}`).join(", "), scope: ["financials", "guidance", "valuation inputs"] });
    const financing = after.filter((f) => f.category === "financing" || f.category === "registration");
    if (financing.length) t.push({ rule: "R4 financing filing", level: "targeted_refresh", evidence: financing.map((f) => `${f.form} ${f.filed} (${f.description})`).join(", "), scope: ["capital structure", "share count", "dilution"] });
    const material = after.filter((f) => f.category === "material_event");
    if (material.length) t.push({ rule: "R5 material 8-K", level: "targeted_refresh", evidence: material.map((f) => `${f.form} ${f.filed} (${f.description})`).join(", "), scope: ["thesis", "risks"] });
  }

  if (args.price === null || !c.referencePrice) notChecked.push("No current price or no research reference price, so price drift was not checked");
  else {
    const drift = args.price / c.referencePrice - 1;
    const pct = `${Math.round(Math.abs(drift) * 100)}% ${drift < 0 ? "below" : "above"} the $${c.referencePrice} reference${c.referenceDate ? ` of ${c.referenceDate}` : ""} (price $${args.price}${args.priceAsOf ? ` as of ${args.priceAsOf.slice(0, 10)}` : ""})`;
    if (Math.abs(drift) > FULL_REASSESS_DRIFT) t.push({ rule: "R6 very large price move", level: "full_reassessment", evidence: pct, scope: ["scenario probabilities", "scenario values", "thesis", "price bands"] });
    else if (Math.abs(drift) > REPRICE_LIMIT) t.push({ rule: "R7 large price move", level: "targeted_refresh", evidence: pct, scope: ["what drove the move", "scenario values"] });
    const values = c.scenarios.map((s) => s.value).filter((v) => v > 0);
    if (values.length && (args.price < Math.min(...values) || args.price > Math.max(...values))) t.push({ rule: "R8 price outside scenarios", level: "full_reassessment", evidence: `Price $${args.price} is outside the bear-to-bull range $${Math.min(...values)}–$${Math.max(...values)}`, scope: ["scenario set"] });
  }

  const level: RefreshLevel = t.some((x) => x.level === "full_reassessment") ? "full_reassessment" : t.length ? "targeted_refresh" : "current";
  return { level, triggers: t, notChecked, rulesVersion: REFRESH_RULES_VERSION };
}
