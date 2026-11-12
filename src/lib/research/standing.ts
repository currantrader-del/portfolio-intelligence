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
  approved_full: "Completed investigation",
  approved_provisional: "Completed investigation with open questions",
  awaiting_approval: "Completed investigation",
  running: "Investigation running",
  historical: "Older research",
  preliminary_screen: "Preliminary screen",
  stopped: "Stopped run (incomplete)",
};

/**
 * Which record the app uses, decided automatically from the evidence (2026-11-09 direction: approval is no
 * longer a barrier). A finished investigation outranks any quick screen or imported note whatever their dates,
 * so a newer preliminary summary never overrides a completed dossier; within a tier the newest wins. Runs
 * that are still working, stopped, failed or that the investor set aside are never used. Nothing stored changes.
 */
export function evidenceTier(v: V, now: Date = new Date()): 0 | 1 | 2 | 3 {
  const a = authorityOf(v, now);
  if (a === "running" || a === "stopped") return 0;
  if (String(conc(v).review_state ?? "") === "set_aside") return 0;
  if (isInvestigation(v)) return 3;
  return v.completeness === "complete" ? 2 : 1;
}

export function selectInUse<T extends V>(versions: T[], now: Date = new Date()): T | null {
  const when = (v: V) => v.created_at ?? v.research_as_of;
  return versions
    .map((v) => ({ v, t: evidenceTier(v, now) }))
    .filter((x) => x.t > 0)
    .sort((a, b) => b.t - a.t || b.v.research_as_of.localeCompare(a.v.research_as_of) || String(when(b.v)).localeCompare(String(when(a.v))))[0]?.v ?? null;
}

/** The authority of the record in use, from its evidence: a finished investigation is a decision basis. */
export function effectiveAuthority(v: V, now: Date): Authority {
  if (evidenceTier(v, now) === 3) return openItems(v).length ? "approved_provisional" : "approved_full";
  return authorityOf(v, now);
}

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

/** How strong the evidence of a record is: a completed investigation, one with open questions, or preliminary. */
export function approvalOf(v: V): Approval {
  if (isInvestigation(v) && !String(conc(v).review_state ?? "").match(/^(running|failed|set_aside)$/) && v.completeness !== "in_progress") return openItems(v).length ? "provisional" : "approved";
  return legacyApprovalOf(v);
}

/** How the record came to be marked current in the database (kept for history pages). */
export function legacyApprovalOf(v: V): Approval {
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
  approved: "evidence complete",
  provisional: "open questions remain",
  automatic: "preliminary",
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
  const cur = selectInUse(versions, now);
  // Only a run still working is "pending"; a finished investigation is simply used.
  const pendingV = versions
    .filter((v) => v !== cur && isInvestigation(v) && authorityOf(v, now) === "running")
    .filter((v) => !cur || when(v) > when(cur))
    .sort((a, b) => when(b).localeCompare(when(a)))[0] ?? null;
  const inUse = cur ? { v: cur, approval: approvalOf(cur), quality: qualityOf(cur), authority: effectiveAuthority(cur, now), label: "", open: openItems(cur) } : null;
  if (inUse) inUse.label = isAuthoritative(inUse.authority) ? `${QUALITY_LABEL[inUse.quality]}, ${APPROVAL_LABEL[inUse.approval]}` : `${AUTHORITY_LABEL[inUse.authority]}: enough for monitoring and Hold or No Add, not for a buy range or new money`;
  const authoritative = !!inUse && isAuthoritative(inUse.authority);
  const pending = pendingV ? {
    v: pendingV, state: (conc(pendingV).review_state === "awaiting_approval" ? "awaiting_approval" : "running") as "running" | "awaiting_approval",
    complete: pendingV.completeness === "complete", kind: conc(pendingV).completion?.kind ?? null, open: openItems(pendingV),
  } : null;
  const history = versions.filter((v) => v !== cur && v !== pendingV).sort((a, b) => when(b).localeCompare(when(a)));
  let decisions: string;
  if (!inUse) decisions = "No usable research on file, so the app makes no recommendation here; a research task is listed instead.";
  else if (!authoritative) decisions = `Preliminary research only (${AUTHORITY_LABEL[inUse.authority].toLowerCase()}, ${inUse.v.research_as_of}). It supports monitoring and Hold or No Add; no buy range or new money until a targeted investigation is done.${pending ? " An investigation is running." : ""}`;
  else if (inUse.approval === "provisional") decisions = `The completed investigation (${inUse.v.research_as_of}) has ${inUse.open.length} open question${inUse.open.length === 1 ? "" : "s"}; it supports Hold, No Add and Trim, but no new money until a targeted update resolves them.`;
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
  const used = selectInUse(versions, now);
  if (used && evidenceTier(used, now) === 3) return { v: used, authority: effectiveAuthority(used, now) };
  const inv = sorted.find((v) => isInv(v) && ["awaiting_approval", "approved_full", "approved_provisional"].includes(authorityOf(v, now)));
  return inv ? { v: inv, authority: authorityOf(inv, now) } : null;
}

/**
 * The five things the investor asked to see kept apart (audit 2026-11-11), from one record, so Research,
 * Decisions, Plan, Today and the assistant can say the same thing:
 *   finished     whether the investigation ran all its phases, and how many items it left open
 *   approved     whether YOU approved it (never inferred; approval is not required for use since 2026-11-09)
 *   inUse        whether it is the record decisions use, and what it supports
 *   reassess     whether something material happened since (filings, price zone), from the caller's check
 *   open         the unresolved items, listed
 */
export type StatusFields = {
  finished: { ok: boolean; text: string };
  approved: { ok: boolean; text: string };
  inUse: { ok: boolean; text: string };
  reassess: { needed: boolean; text: string };
  open: string[];
};

export function statusFields(s: Standing, reassess: { status: "current" | "refresh" | "unverified"; triggers: { kind: string; detail: string }[] } | null): StatusFields | null {
  if (!s.inUse) return null;
  const v = s.inUse.v;
  const c = conc(v);
  const inv = isInvestigation(v);
  const open = s.inUse.open;
  const finished = inv
    ? { ok: v.completeness === "complete", text: v.completeness === "complete" ? "Finished, nothing left open" : `Finished all its phases, with ${open.length || "some"} item${open.length === 1 ? "" : "s"} left open${c.completion?.kind === "material_uncertainty" ? " (a material question with no reliable answer yet)" : ""}` }
    : { ok: v.completeness === "complete", text: `${QUALITY_LABEL[qualityOf(v)]}, not a full investigation` };
  const rs = String(c.review_state ?? "");
  const approved = rs === "adopted" || rs === "adopted_provisional"
    ? { ok: true, text: rs === "adopted" ? "Yes, you approved it" : "Yes, you approved it provisionally, with its open items" }
    : { ok: false, text: "No. Since your Nov 9 direction approval is not required: the app uses a finished investigation on its evidence" };
  const inUse = { ok: true, text: `Yes, the record decisions use (${shortDay(v.research_as_of)}). ${s.decisions}` };
  const real = reassess ? reassess.triggers.filter((t) => t.kind !== "unverified") : [];
  const r = !reassess ? { needed: false, text: "Not checked on this page" }
    : reassess.status === "refresh" ? { needed: true, text: `Yes: ${real.map((t) => t.detail).join("; ")}. A targeted update, not a full rerun` }
    : reassess.status === "unverified" ? { needed: false, text: `Not confirmed: ${reassess.triggers.map((t) => t.detail).join("; ")}` }
    : { needed: false, text: "No: no new results, financing, material filing or price-zone change since the research" };
  return { finished, approved, inUse, reassess: r, open };
}

const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Stored run summaries written before approval stopped being a gate say "Awaiting your approval…": shown with a note, never rewritten. */
export function displaySummary(text: string | null, inUse: boolean): { text: string | null; note: string | null } {
  if (!text) return { text, note: null };
  const stale = /Awaiting your approval before it is used\.?|Not yet reviewed or approved\.?/i;
  if (!stale.test(text)) return { text, note: null };
  return { text: text.replace(stale, "").trim(), note: inUse ? "The run's saved summary said it was awaiting your approval; approval is no longer required, and it is the record in use." : "The run's saved summary said it was awaiting approval; approval is no longer required." };
}
