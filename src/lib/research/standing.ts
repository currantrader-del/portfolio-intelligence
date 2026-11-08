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

/**
 * Research authority: which records may act as your investment model. Only research you approved
 * (in full or provisionally) is authoritative. Everything else is kept and shown, but is context only.
 *   approved_full         a complete investigation you approved
 *   approved_provisional  you approved it with open items acknowledged (no new money until resolved)
 *   awaiting_approval     a finished investigation waiting for your decision
 *   running               an investigation still working
 *   historical            completed research that is not approved: imported archives, older or set-aside records
 *   preliminary_screen    the 1-minute automated research (never an investment model)
 *   stopped               a run that stopped before finishing
 */
export type Authority = "approved_full" | "approved_provisional" | "awaiting_approval" | "running" | "historical" | "preliminary_screen" | "stopped";

export const AUTHORITY_LABEL: Record<Authority, string> = {
  approved_full: "Approved full research",
  approved_provisional: "Approved provisionally",
  awaiting_approval: "Investigation awaiting your approval",
  running: "Investigation running",
  historical: "Historical research (not approved)",
  preliminary_screen: "Preliminary screen (not approved)",
  stopped: "Stopped run (incomplete)",
};

/** A run with no progress for this long is treated as stopped (the restart logic gives up well before). */
export const STALE_RUN_MS = 3 * 3600_000;

export function authorityOf(v: V, now: Date = new Date()): Authority {
  const c = conc(v) as C & { generated_by?: unknown };
  const rs = String(c.review_state ?? "");
  if (rs === "adopted") return v.completeness === "complete" ? "approved_full" : "approved_provisional";
  if (rs === "adopted_provisional") return "approved_provisional";
  if (rs === "awaiting_approval") return "awaiting_approval";
  if (rs === "running") {
    const at = Date.parse(v.created_at ?? `${v.research_as_of}T00:00:00Z`);
    return Number.isFinite(at) && now.getTime() - at > STALE_RUN_MS ? "stopped" : "running";
  }
  if (rs === "failed") return "stopped";
  if (rs === "set_aside") return "historical";
  if (c.research_type === "preliminary_screen" || /^ai-research@/.test(String(c.generated_by ?? "")) || (v.origin === "claude_full" && !isInvestigation(v))) return "preliminary_screen";
  if (v.completeness === "in_progress") return "stopped";
  return "historical";
}

export const isAuthoritative = (a: Authority | null | undefined) => a === "approved_full" || a === "approved_provisional";

export const isInvestigation = (v: Pick<V, "conclusion">) => ["full_investigation", "material_event_refresh"].includes(String(conc(v as V).research_type ?? ""));

/** How a record in use came to be in use: approved by you (in full or provisionally), or set automatically before approvals existed. */
export function approvalOf(v: V): Approval {
  const rs = conc(v).review_state;
  if (rs === "adopted") return v.completeness === "complete" ? "approved" : "provisional";
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
  // Items you acknowledged when approving provisionally (a complete record can carry reviewer caveats).
  const acknowledged = (c as { adoption?: { mode?: string; open_items?: unknown[] } }).adoption;
  if (acknowledged?.mode === "provisional" && Array.isArray(acknowledged.open_items) && acknowledged.open_items.length) return acknowledged.open_items.map(String);
  if (isInvestigation(v)) return v.completeness === "complete" ? [] : reasons;
  return Array.isArray(c.not_verified) ? (c.not_verified as unknown[]).filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
}

export type Standing = {
  inUse: { v: V; approval: Approval; quality: Quality; authority: Authority; label: string; open: string[] } | null;
  /** True only when the record in use is research you approved. */
  authoritative: boolean;
  pending: { v: V; state: "running" | "awaiting_approval" | "stopped"; complete: boolean; kind: string | null; open: string[] } | null;
  history: V[];
  /** What this means for decisions, in one sentence. */
  decisions: string;
};

export function researchStanding(versions: V[], now: Date = new Date()): Standing {
  const when = (v: V) => v.created_at ?? v.research_as_of;
  const cur = versions.find((v) => v.is_current) ?? null;
  const pendingV = versions
    .filter((v) => !v.is_current && isInvestigation(v) && ["running", "awaiting_approval"].includes(authorityOf(v, now)))
    .filter((v) => !cur || when(v) > when(cur))
    .sort((a, b) => when(b).localeCompare(when(a)))[0] ?? null;
  const inUse = cur ? { v: cur, approval: approvalOf(cur), quality: qualityOf(cur), authority: authorityOf(cur, now), label: "", open: openItems(cur) } : null;
  if (inUse) inUse.label = isAuthoritative(inUse.authority) ? `${QUALITY_LABEL[inUse.quality]}, ${APPROVAL_LABEL[inUse.approval]}` : `${AUTHORITY_LABEL[inUse.authority]}: set automatically before approvals existed`;
  const authoritative = !!inUse && isAuthoritative(inUse.authority);
  const pending = pendingV ? {
    v: pendingV, state: (conc(pendingV).review_state === "awaiting_approval" ? "awaiting_approval" : "running") as "running" | "awaiting_approval",
    complete: pendingV.completeness === "complete", kind: conc(pendingV).completion?.kind ?? null, open: openItems(pendingV),
  } : null;
  const history = versions.filter((v) => v !== cur && v !== pendingV).sort((a, b) => when(b).localeCompare(when(a)));
  let decisions: string;
  if (!inUse) decisions = "No research is in use, so the app makes no recommendation for new money here.";
  else if (!authoritative) decisions = `No approved research. The record on file (${AUTHORITY_LABEL[inUse.authority].toLowerCase()}) is shown for context only: no new money, buy zones or research-based targets until you approve research.${pending?.state === "awaiting_approval" ? " A finished investigation is waiting for your decision." : ""}`;
  else if (pending?.state === "awaiting_approval") decisions = "A newer investigation is waiting for your decision. Until you decide, decisions use the research in use, and no new money is suggested for this company.";
  else if (inUse.approval === "provisional") decisions = `The research in use was approved provisionally with ${inUse.open.length} open item${inUse.open.length === 1 ? "" : "s"}; no new money is suggested until they are resolved.`;
  else if (inUse.quality === "preliminary_ai" || inUse.quality === "partial") decisions = "The research in use is preliminary: decisions use it for comparison only, with its open questions shown.";
  else decisions = "Decisions use the research in use.";
  return { inUse, authoritative, pending, history, decisions };
}

/**
 * What an update builds on: the research you approved, or else the latest finished investigation (which,
 * like anything built on it, still waits for your approval). A quick screen or imported note is never a
 * foundation: the answer is null, and only a full investigation makes sense.
 */
export function updateFoundation<T extends V>(versions: T[], now: Date = new Date()): { v: T; authority: Authority } | null {
  const sorted = [...versions].sort((a, b) => String(b.created_at ?? b.research_as_of).localeCompare(String(a.created_at ?? a.research_as_of)));
  const isInv = (v: T) => { const t = conc(v).research_type; return t === "full_investigation" || t === "material_event_refresh"; };
  const approved = sorted.find((v) => v.is_current && isAuthoritative(authorityOf(v, now)));
  if (approved) return { v: approved, authority: authorityOf(approved, now) };
  const inv = sorted.find((v) => isInv(v) && ["awaiting_approval", "approved_full", "approved_provisional"].includes(authorityOf(v, now)));
  return inv ? { v: inv, authority: authorityOf(inv, now) } : null;
}
