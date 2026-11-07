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

/**
 * The pipeline stage the evidence points to, with the reason, so the investor can accept it in one tap
 * instead of deciding it. Null when the current stage already fits. Never moves anything by itself;
 * "Owned" follows the holdings and "Passed" stays the investor's call unless the research says avoid.
 */
export function suggestStage(args: { stage: string; held: boolean; coverageKey: Coverage["key"]; hasResearch: boolean; action: string | null; screenVerdict: string | null }): { stage: "screening" | "researching" | "ready" | "passed"; reason: string } | null {
  const { stage, held, coverageKey, hasResearch, action, screenVerdict } = args;
  if (held || stage === "owned") return null;
  let s: { stage: "screening" | "researching" | "ready" | "passed"; reason: string } | null = null;
  if (hasResearch && coverageKey === "current" && action && /\b(avoid|pass|do not (buy|own)|don't buy|sell|exit)\b/i.test(action)) s = { stage: "passed", reason: `The research says: ${action}` };
  else if (hasResearch && coverageKey === "current") s = { stage: "ready", reason: "Research is complete and current, so it can be compared for new money." };
  else if (hasResearch) s = { stage: "researching", reason: coverageKey === "incomplete" ? "Research is on file but incomplete." : "Research is on file but needs a refresh before it can be relied on." };
  else if (screenVerdict === "Weak on screen") s = { stage: "passed", reason: "Weak on the first screen and no research on file." };
  else if (screenVerdict) s = { stage: "screening", reason: `Screened: ${screenVerdict.toLowerCase()}. Next is AI research.` };
  if (!s || s.stage === stage) return null;
  // Passed is a decision already made; only research that says avoid reopens it, and never the other way.
  if (stage === "passed") return null;
  return s;
}
