/**
 * One reading of "how usable is the research on this company today", shared by every page.
 * The label decides the pill; the detail explains it in a sentence.
 */
import { researchAgeDays, type FilingCheckInfo, type ResearchRecord, type VersionRow } from "./records";
import { repriceCheck } from "./valuation";
import { isInvestigation } from "./standing";

/**
 * How deep the research behind a record actually goes. Six sections written by Claude are automated
 * preliminary research, not verified research: the label says what was checked, not how long it is.
 *   preliminary         automated (AI) research, or any record that lists questions it could not verify
 *   company_research    a complete record with no open questions, not produced automatically
 *   filings_checked     ...and the app's SEC filing check after the research found nothing unresolved
 *   documents_reviewed  ...and you marked the source documents as fully reviewed (not recorded yet, so never claimed)
 */
export type ResearchDepth = {
  level: "preliminary" | "company_research" | "filings_checked" | "documents_reviewed";
  label: string;
  automated: boolean;
  openQuestions: string[];
  filings: { state: "checked" | "unresolved" | "not_checked"; detail: string };
};

const AUTOMATED_ORIGINS = new Set(["claude_full", "claude_targeted_update"]);

/** A new report filed after the research that the filing check flagged and no newer research has resolved. */
export function unresolvedFiling(researchAsOf: string, fc: FilingCheckInfo | null | undefined): string | null {
  if (!fc || fc.status !== "WAIT / REVIEW" || !fc.document || fc.document.filed <= researchAsOf) return null;
  return `${fc.document.form} filed ${fc.document.filed}, after the research${fc.material.length ? `: ${fc.material.length} material change${fc.material.length > 1 ? "s" : ""} (${fc.material[0]})` : `: ${fc.reason.replace(/\.$/, "")}`}`;
}

export function researchDepth(v: Pick<VersionRow, "research_as_of" | "completeness" | "origin" | "conclusion">, fc: FilingCheckInfo | null | undefined): ResearchDepth {
  const nv = (v.conclusion as { not_verified?: unknown })?.not_verified;
  const openQuestions = Array.isArray(nv) ? nv.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  // A complete full investigation (approved before it is ever in use) is not the old one-minute automated research.
  const investigation = isInvestigation(v) && v.completeness === "complete";
  const automated = !investigation && AUTOMATED_ORIGINS.has(v.origin);
  const pending = unresolvedFiling(v.research_as_of, fc);
  const checkedAfter = fc && fc.at.slice(0, 10) >= v.research_as_of;
  const filings: ResearchDepth["filings"] = pending
    ? { state: "unresolved", detail: pending }
    : checkedAfter && fc!.status === "CURRENT"
      ? { state: "checked", detail: `SEC filings checked by the app on ${fc!.at.slice(0, 10)}: nothing unresolved` }
      : { state: "not_checked", detail: checkedAfter ? `The app's filing check on ${fc!.at.slice(0, 10)} could not confirm everything (${fc!.reason.replace(/\.$/, "")})` : "The app has not checked SEC filings since this research" };
  const complete = v.completeness === "complete";
  const level: ResearchDepth["level"] = automated || openQuestions.length || !complete ? "preliminary" : filings.state === "checked" ? "filings_checked" : "company_research";
  const label = level === "preliminary" ? (automated ? "Automated research (preliminary)" : "Preliminary research") : level === "filings_checked" ? `${investigation ? "Full investigation" : "Company research"}, filings checked` : investigation ? "Full investigation" : "Company research";
  return { level, label, automated, openQuestions, filings };
}

export type Coverage = { key: "current" | "unapproved" | "incomplete" | "refresh" | "conflict" | "none"; label: string; tone: "gain" | "warn" | "neutral"; dot: "solid" | "hollow"; detail: string };

const ageText = (age: number | null, reminderDays: number) => (age ?? 0) > reminderDays ? ` ${age} days old.` : "";

export function coverage(r: ResearchRecord | undefined, price: number | null, now: Date, reminderDays: number): Coverage {
  if (!r || (!r.current && !r.latest)) return { key: "none", label: "Not researched", tone: "neutral", dot: "hollow", detail: "No research on file" };
  if (r.conflict) return { key: "conflict", label: "Conflict", tone: "warn", dot: "solid", detail: `${r.versions} dated records disagree; none is marked current` };
  const v = r.current!;
  const complete = v.completeness === "complete";
  // No live price is a data gap, not a reason to redo the research: judge it on age alone then.
  const age = researchAgeDays(r, now);
  // Only a completed investigation supports buy ranges and new money; a preliminary screen supports Hold or No Add.
  if (r.authoritative === false) {
    const what = r.authority === "preliminary_screen" ? "Preliminary screen" : r.authority === "historical" ? "Older research" : "Research";
    return { key: "unapproved", label: "Preliminary", tone: "warn", dot: "hollow",
      detail: `${what}: enough for monitoring and Hold or No Add, not for new money, buy ranges or research-based targets. A targeted investigation is the research task.${ageText(age, reminderDays)}` };
  }
  const check = price ? repriceCheck(v.parsed, price, age, reminderDays) : { ok: true, reason: null, note: undefined };
  if (!check.ok) return { key: "refresh", label: "Refresh", tone: "warn", dot: "hollow", detail: check.reason ?? "Needs a refresh" };
  // A material new filing the research has not absorbed means it is not current, however complete it looks.
  const pending = unresolvedFiling(v.research_as_of, r.filingCheck);
  if (pending) return { key: "refresh", label: "Refresh", tone: "warn", dot: "hollow", detail: `Unresolved new filing: ${pending}` };
  if (!complete) return { key: "incomplete", label: "Incomplete", tone: "warn", dot: "hollow", detail: "Partial archive: some phases are missing" };
  const d = researchDepth(v, r.filingCheck);
  const ageNote = (age ?? 0) > reminderDays ? ` ${age} days old, so check filings since then (age alone doesn't make it wrong).` : "";
  if (d.level === "preliminary") {
    const q = d.openQuestions.length;
    return {
      key: "current", label: q ? `Preliminary · ${q} open` : "Preliminary", tone: "warn", dot: "hollow",
      detail: `${d.label}: usable for comparison, not verified.${q ? ` ${q} question${q > 1 ? "s" : ""} it could not verify, e.g. ${d.openQuestions[0]}.` : ""} ${d.filings.detail}.${ageNote}`,
    };
  }
  return { key: "current", label: "Current", tone: "gain", dot: "solid", detail: `${d.label}; no large price move since. ${d.filings.detail}.${ageNote}` };
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
  else if (hasResearch && coverageKey === "current") s = { stage: "ready", reason: "Research is on file and current, so it can be compared for new money (automated research stays preliminary until its open questions are checked)." };
  else if (hasResearch && coverageKey === "unapproved") s = { stage: "researching", reason: "Research is on file but you have not approved it, so it cannot be used for new money yet." };
  else if (hasResearch) s = { stage: "researching", reason: coverageKey === "incomplete" ? "Research is on file but incomplete." : "Research is on file but needs a refresh before it can be relied on." };
  else if (screenVerdict === "Weak on screen") s = { stage: "passed", reason: "Weak on the first screen and no research on file." };
  else if (screenVerdict) s = { stage: "screening", reason: `Screened: ${screenVerdict.toLowerCase()}. Next is AI research.` };
  if (!s || s.stage === stage) return null;
  // Passed is a decision already made; only research that says avoid reopens it, and never the other way.
  if (stage === "passed") return null;
  return s;
}
