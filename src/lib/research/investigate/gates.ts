/**
 * Completion rules, applied by code. A phase is complete only when its documents were read (or are
 * shown to be unavailable after a real attempt), its questions were answered or explained, and its key
 * numbers passed the source check. The investigation is complete only when every phase is, the
 * valuation computes, the skeptic's objections were answered, and no unresolved question could
 * change the conclusion. Text length is never the test.
 */
import type { InvDoc, RunState } from "./types";

export function docStatus(d: InvDoc): InvDoc["status"] {
  if (d.status === "unavailable" || d.status === "search_result_only" || d.status === "reviewed_earlier") return d.status;
  if (!d.fetched || !d.sections?.length) return d.fetched ? "retrieved" : d.status;
  const material = d.sections.filter((s) => s.material);
  const secs = material.length ? material : d.sections;
  const full = secs.every((s) => s.reviewedParts.length >= s.parts);
  const any = d.sections.some((s) => s.reviewedParts.length > 0);
  return full ? "fully_reviewed" : any ? "partially_reviewed" : "retrieved";
}

const docDone = (d: InvDoc) => {
  const st = docStatus(d);
  if (st === "fully_reviewed" || st === "reviewed_earlier") return true;
  return st === "unavailable" && !!d.unavailable_reason && (d.attempts?.length ?? 0) > 0;
};

const describeDoc = (d: InvDoc) => `${d.id} ${d.title}`;

export function phaseGate(s: RunState, n: number, summary: string): string[] {
  const out: string[] = [];
  for (const d of s.inventory.filter((x) => x.required && x.phases.includes(n) && !docDone(x))) {
    const st = docStatus(d);
    out.push(st === "unavailable" ? `${describeDoc(d)}: marked unavailable without a search attempt and a reason` : `${describeDoc(d)} is ${st.replace(/_/g, " ")}; review it in full (review_document) or show it is unavailable`);
  }
  for (const q of s.questions.filter((x) => x.phase === n && x.status === "open")) out.push(`Question ${q.id} is still open: investigate it, then resolve it or explain why it cannot be resolved`);
  for (const f of s.findings.filter((x) => x.phase === n && x.key && !x.withdrawn && (x.check.status === "quote_not_found" || x.check.status === "quote_found_value_not_in_quote" || x.check.status === "document_unreadable")))
    out.push(`Key finding ${f.id} failed the source check (${f.check.detail}); correct the quote or figure, or record it as an estimate`);
  for (const c of s.conflicts.filter((x) => x.phase === n && !x.resolution.trim())) out.push(`Conflict ${c.id} has no resolution or explanation`);
  if (n === 5 && !s.valuation?.result.ok) out.push(s.valuation ? `The valuation does not compute: ${s.valuation.result.errors.join("; ")}` : "No valuation set (use set_valuation)");
  // Every required document read for this phase has to be used: cited by a finding or named in the summary.
  const cited = citedDocIds(s);
  for (const m of summary.matchAll(/\bD\d+\b/g)) cited.add(m[0]);
  for (const d of s.inventory.filter((x) => x.required && x.phases.includes(n) && docStatus(x) === "fully_reviewed" && !cited.has(x.id)))
    out.push(`${describeDoc(d)} was read but nothing cites it: say in the summary what it showed (cite ${d.id}), even if it changes nothing`);
  if (summary.trim().length < 400) out.push("The phase summary is too short to show the work; summarise what was reviewed, found and concluded");
  return out;
}

/** At least this many key figures must be verified from a primary document (quote found, or XBRL). */
export const MIN_PRIMARY = { full_investigation: 8, material_event_refresh: 4 } as const;

const isPrimary = (f: RunState["findings"][number]) => f.check.status === "verified" || f.check.status === "xbrl";

/** Document ids the research actually used: cited by a finding, a phase checkpoint, an objection answer or the summary. */
export function citedDocIds(s: RunState): Set<string> {
  const text = [
    ...s.phases.map((p) => `${p.summary} ${p.key_points.join(" ")}`),
    ...s.objections.map((o) => `${o.response ?? ""} ${o.test ?? ""} ${o.test_result ?? ""}`),
    s.summary ? JSON.stringify(s.summary) : "",
  ].join(" ");
  const ids = new Set(s.findings.filter((f) => !f.withdrawn && f.doc_id).map((f) => f.doc_id!));
  for (const m of text.matchAll(/\bD\d+\b/g)) ids.add(m[0]);
  return ids;
}

/**
 * Whether the investigation is complete. Work rules (phases, documents, questions, sources, the
 * skeptical review and the answers to it, consistency) and evidence rules (enough primary evidence,
 * every unverified key figure classified, nothing thesis-changing left unresolved) are both applied;
 * a run that only finished its steps is not complete. "material_uncertainty" means the work was done
 * but a material question has no reliable answer; "work_incomplete" means work is missing.
 */
export function finalGate(s: RunState): { complete: boolean; reasons: string[]; kind: "complete" | "work_incomplete" | "material_uncertainty" } {
  const work: string[] = [], uncertain: string[] = [];
  const full = s.type === "full_investigation";
  for (const p of s.phases) if (p.status !== "complete" && p.status !== "carried_forward") work.push(`Phase ${p.n} (${p.title}) is ${p.status}${p.gate.length ? `: ${p.gate[0]}` : ""}`);
  for (const d of s.inventory.filter((x) => x.required && !docDone(x))) work.push(`${describeDoc(d)} was not fully reviewed (${docStatus(d).replace(/_/g, " ")})`);
  const cited = citedDocIds(s);
  for (const d of s.inventory.filter((x) => x.required && docDone(x) && docStatus(x) !== "unavailable" && docStatus(x) !== "reviewed_earlier" && !cited.has(x.id)))
    work.push(`${describeDoc(d)} was read but nothing in the research cites it`);
  for (const q of s.questions) {
    if (q.status === "open") work.push(`Question ${q.id} is still open: ${q.question}`);
    else if (q.status === "unresolvable" && (q.could_change_conclusion || q.materiality === "high")) uncertain.push(`Material question ${q.id} could not be resolved: ${q.question} (${q.why_unresolvable ?? "no reason given"})`);
  }
  for (const f of s.findings.filter((x) => x.key && !x.withdrawn && (x.check.status === "quote_not_found" || x.check.status === "quote_found_value_not_in_quote")))
    work.push(`Key finding ${f.id} did not match its source: ${f.claim}`);
  const primary = s.findings.filter((f) => f.key && !f.withdrawn && isPrimary(f)).length;
  const need = MIN_PRIMARY[s.type];
  if (primary < need) work.push(`Only ${primary} key figures are verified from primary documents; at least ${need} are needed`);
  for (const f of s.findings.filter((x) => x.key && !x.withdrawn && !isPrimary(x))) {
    if (!f.classification) work.push(`Key finding ${f.id} is not verified from a primary document and was not classified: ${f.claim}`);
    else if (f.classification.cls === "unresolved_thesis_changing") uncertain.push(`Key finding ${f.id} is unresolved and could change the thesis: ${f.claim} (${f.classification.impact})`);
  }
  if (!s.valuation?.result.ok) work.push("The valuation did not compute cleanly");
  // The skeptical review: recorded, covering every area, and every objection answered.
  if (!s.review) work.push(full ? "No skeptical review was recorded" : "No skeptical review of the refresh was recorded");
  for (const o of s.objections) {
    if (!o.response?.trim() || !o.outcome) work.push(`Skeptic objection ${o.id} was not answered`);
    else if (o.severity !== "minor" && !(o.response_evidence ?? []).length) work.push(`Skeptic objection ${o.id} (${o.severity}) was answered without evidence`);
  }
  if (s.review) {
    const changed = s.objections.some((o) => o.severity !== "minor" && (o.outcome === "accepted" || o.outcome === "partly_accepted")) || s.review.recommendation !== "survives" || s.review.valuation !== "survives";
    if (changed && !(s.summaryAt && s.summaryAt > s.review.at)) work.push("The skeptic required changes, but the conclusion was not revisited after the review");
  }
  if (s.valuationAt && s.summaryAt && s.valuationAt > s.summaryAt) work.push("The valuation was changed after the summary was written");
  if (s.consistency && !s.consistency.ok) work.push(...s.consistency.issues.map((x) => `Consistency: ${x}`));
  if (!s.summary) work.push("No final investment summary");
  const reasons = [...work, ...uncertain];
  return { complete: reasons.length === 0, reasons, kind: work.length ? "work_incomplete" : uncertain.length ? "material_uncertainty" : "complete" };
}
