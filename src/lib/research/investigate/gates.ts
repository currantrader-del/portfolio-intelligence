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
  if (summary.trim().length < 400) out.push("The phase summary is too short to show the work; summarise what was reviewed, found and concluded");
  return out;
}

export function finalGate(s: RunState): { complete: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const p of s.phases) if (p.status !== "complete" && p.status !== "carried_forward") reasons.push(`Phase ${p.n} (${p.title}) is ${p.status}${p.gate.length ? `: ${p.gate[0]}` : ""}`);
  for (const d of s.inventory.filter((x) => x.required && !docDone(x))) reasons.push(`${describeDoc(d)} was not fully reviewed (${docStatus(d).replace(/_/g, " ")})`);
  for (const q of s.questions) {
    if (q.status === "open") reasons.push(`Question ${q.id} is still open: ${q.question}`);
    else if (q.status === "unresolvable" && (q.could_change_conclusion || q.materiality === "high")) reasons.push(`Material question ${q.id} could not be resolved: ${q.question} (${q.why_unresolvable ?? "no reason given"})`);
  }
  for (const f of s.findings.filter((x) => x.key && !x.withdrawn && (x.check.status === "quote_not_found" || x.check.status === "quote_found_value_not_in_quote")))
    reasons.push(`Key finding ${f.id} did not match its source: ${f.claim}`);
  if (!s.valuation?.result.ok) reasons.push("The valuation did not compute cleanly");
  for (const o of s.objections) {
    if (!o.response?.trim() || !o.outcome) reasons.push(`Skeptic objection ${o.id} was not answered`);
  }
  if (s.type === "full_investigation" && !s.objections.length) reasons.push("No skeptical review was recorded");
  if (!s.summary) reasons.push("No final investment summary");
  return { complete: reasons.length === 0, reasons };
}
