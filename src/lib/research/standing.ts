/**
 * Which research is which, in one place, so every page tells the same story:
 *   in use     the record decisions are based on (is_current), and how it came to be in use
 *   pending    the newest investigation that is not in use (running, or waiting for your decision)
 *   history    everything else, kept on file unchanged
 *   gaps       what is still open in the record in use and in the pending investigation
 * A record is never "current" just because nothing newer was approved: the label says how it got there
 * and how deep it goes.
 */
import type { VersionRow } from "./records";

export type Approval = "approved" | "provisional" | "automatic";
export type Quality = "complete_investigation" | "incomplete_investigation" | "preliminary_ai" | "imported" | "partial";

type V = VersionRow & { created_at?: string | null };
type C = { review_state?: string; research_type?: string; not_verified?: unknown; completion?: { reasons?: unknown; kind?: string }; adoption?: { mode?: string; open_items?: unknown } };
const conc = (v: V) => (v.conclusion ?? {}) as C;

export const isInvestigation = (v: Pick<V, "conclusion">) => ["full_investigation", "material_event_refresh"].includes(String(conc(v as V).research_type ?? ""));

/** How a record in use came to be in use: approved by you (in full or provisionally), or set automatically before approvals existed. */
export function approvalOf(v: V): Approval {
  const rs = conc(v).review_state;
  if (rs === "adopted") return "approved";
  if (rs === "adopted_provisional") return "provisional";
  return "automatic";
}

export function qualityOf(v: V): Quality {
  if (isInvestigation(v)) return v.completeness === "complete" ? "complete_investigation" : "incomplete_investigation";
  if (v.origin === "claude_full" || v.origin === "claude_targeted_update") return "preliminary_ai";
  if (v.origin === "chatgpt_original" || v.origin === "chatgpt_reconstructed") return v.completeness === "complete" ? "imported" : "partial";
  return v.completeness === "complete" ? "imported" : "partial";
}

export const QUALITY_LABEL: Record<Quality, string> = {
  complete_investigation: "Full investigation, complete",
  incomplete_investigation: "Full investigation, incomplete",
  preliminary_ai: "Preliminary (automated AI research)",
  imported: "Imported from the old app",
  partial: "Partial record",
};
export const APPROVAL_LABEL: Record<Approval, string> = {
  approved: "approved by you",
  provisional: "approved provisionally by you",
  automatic: "set automatically, not approved by you",
};

/** The open items a record lists: its completion reasons, or the questions it could not verify. */
export function openItems(v: V): string[] {
  const c = conc(v);
  const reasons = Array.isArray(c.completion?.reasons) ? (c.completion!.reasons as unknown[]).map(String) : [];
  if (isInvestigation(v)) return v.completeness === "complete" ? [] : reasons;
  return Array.isArray(c.not_verified) ? (c.not_verified as unknown[]).filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
}

export type Standing = {
  inUse: { v: V; approval: Approval; quality: Quality; label: string; open: string[] } | null;
  pending: { v: V; state: "running" | "awaiting_approval" | "stopped"; complete: boolean; kind: string | null; open: string[] } | null;
  history: V[];
  /** What this means for decisions, in one sentence. */
  decisions: string;
};

export function researchStanding(versions: V[]): Standing {
  const when = (v: V) => v.created_at ?? v.research_as_of;
  const cur = versions.find((v) => v.is_current) ?? null;
  const pendingV = versions
    .filter((v) => !v.is_current && isInvestigation(v) && ["running", "awaiting_approval"].includes(String(conc(v).review_state)))
    .filter((v) => !cur || when(v) > when(cur))
    .sort((a, b) => when(b).localeCompare(when(a)))[0] ?? null;
  const inUse = cur ? { v: cur, approval: approvalOf(cur), quality: qualityOf(cur), label: "", open: openItems(cur) } : null;
  if (inUse) inUse.label = `${QUALITY_LABEL[inUse.quality]}, ${APPROVAL_LABEL[inUse.approval]}`;
  const pending = pendingV ? {
    v: pendingV, state: (conc(pendingV).review_state === "awaiting_approval" ? "awaiting_approval" : "running") as "running" | "awaiting_approval",
    complete: pendingV.completeness === "complete", kind: conc(pendingV).completion?.kind ?? null, open: openItems(pendingV),
  } : null;
  const history = versions.filter((v) => v !== cur && v !== pendingV).sort((a, b) => when(b).localeCompare(when(a)));
  let decisions: string;
  if (!inUse) decisions = "No research is in use, so the app makes no recommendation for new money here.";
  else if (pending?.state === "awaiting_approval") decisions = "A newer investigation is waiting for your decision. Until you decide, decisions use the research in use, and no new money is suggested for this company.";
  else if (inUse.approval === "provisional") decisions = `The research in use was approved provisionally with ${inUse.open.length} open item${inUse.open.length === 1 ? "" : "s"}; no new money is suggested until they are resolved.`;
  else if (inUse.quality === "preliminary_ai" || inUse.quality === "partial") decisions = "The research in use is preliminary: decisions use it for comparison only, with its open questions shown.";
  else decisions = "Decisions use the research in use.";
  return { inUse, pending, history, decisions };
}
