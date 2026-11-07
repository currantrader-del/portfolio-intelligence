/**
 * One reading of "how usable is the research on this company today", shared by every page.
 * The label decides the pill; the detail explains it in a sentence.
 */
import { researchAgeDays, type ResearchRecord } from "./records";
import { repriceCheck } from "./valuation";

export type Coverage = { key: "current" | "incomplete" | "refresh" | "conflict" | "none"; label: string; tone: "gain" | "warn" | "neutral"; dot: "solid" | "hollow"; detail: string };

export function coverage(r: ResearchRecord | undefined, price: number | null, now: Date, freshDays: number): Coverage {
  if (!r || (!r.current && !r.latest)) return { key: "none", label: "Not researched", tone: "neutral", dot: "hollow", detail: "No research on file" };
  if (r.conflict) return { key: "conflict", label: "Conflict", tone: "warn", dot: "solid", detail: `${r.versions} dated records disagree; none is marked current` };
  const v = r.current!;
  const complete = v.completeness === "complete";
  // No live price is a data gap, not a reason to redo the research: judge it on age alone then.
  const check = price ? repriceCheck(v.parsed, price, researchAgeDays(r, now), freshDays) : (researchAgeDays(r, now) ?? 0) > freshDays ? { ok: false, reason: `Research is ${researchAgeDays(r, now)} days old, past the ${freshDays}-day limit.` } : { ok: true, reason: null };
  if (!check.ok) return { key: "refresh", label: "Refresh", tone: "warn", dot: "hollow", detail: check.reason ?? "Needs a refresh" };
  return complete
    ? { key: "current", label: "Current", tone: "gain", dot: "solid", detail: "Complete research, within the freshness window" }
    : { key: "incomplete", label: "Incomplete", tone: "warn", dot: "hollow", detail: "Partial archive: some phases are missing" };
}
