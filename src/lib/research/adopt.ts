/**
 * Putting a research record in use. The investor's standing rule (2026-11-11): the most recent, complete and
 * most in-depth research is the one used. So a finished investigation is put in use on its own when it is at
 * least as deep as the record in use:
 *  - complete            → in use in full;
 *  - incomplete only because of an outside event the research cannot settle (kind "material_uncertainty")
 *                        → in use with its open items listed, unless the record in use is itself a complete
 *                          investigation (a newer partial never pushes out completed in-depth work);
 *  - work left undone (budget, unread documents) → stays waiting; the newer record is shown beside the one in use.
 * The record it replaces stays on file unchanged (only its "current" flag moves), and every change is logged
 * (model_runs "research_adoption") with what it replaced.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { save } from "@/lib/intel/jobs";
import { provisionalItems } from "./review";
import type { ValidationReport } from "./validate";

export type AdoptMode = "full" | "provisional";
type Conclusion = Record<string, unknown> & { research_type?: string; review_state?: string; completion?: { kind?: string; reasons?: unknown[] } };
export type ResearchRef = { completeness: string; conclusion: Conclusion | null };

const isInvestigation = (c: Conclusion | null | undefined) => c?.research_type === "full_investigation" || c?.research_type === "material_event_refresh";

/** Whether a finished investigation should go into use without waiting, and how. Pure, for tests. */
export function autoAdoptMode(next: ResearchRef, current: ResearchRef | null): AdoptMode | null {
  if (next.conclusion?.review_state !== "awaiting_approval") return null;
  if (next.completeness === "complete") return "full";
  if (next.conclusion?.completion?.kind !== "material_uncertainty") return null;
  const currentIsCompleteInvestigation = !!current && current.completeness === "complete" && isInvestigation(current.conclusion);
  return currentIsCompleteInvestigation ? null : "provisional";
}

/** The open items a record carries when it goes into use: its own completion reasons plus the code checks that did not pass. */
export function openItemsFor(c: Conclusion, validation: ValidationReport | null, mode: AdoptMode): string[] {
  const own = Array.isArray(c.completion?.reasons) ? c.completion!.reasons!.map(String) : [];
  if (mode === "full") return own;
  const all = [...own, ...provisionalItems(validation)];
  return all.length ? all : ["In use with open questions, pending your own review."];
}

export type AdoptResult = { ok: true; mode: AdoptMode; replaced: string | null } | { ok: false; error: string };

/** Puts one record in use. `by` says who decided: the investor's tap, or the standing rule above. */
export async function adoptVersion(db: SupabaseClient, versionId: string, mode: AdoptMode, by: "investor" | "standing_rule", symbol: string): Promise<AdoptResult> {
  const { data: v } = await db.from("research_versions").select("id, company_id, conclusion, completeness, is_current").eq("id", versionId).maybeSingle();
  if (!v) return { ok: false, error: "That research record was not found." };
  if (v.is_current) return { ok: false, error: "This research is already the one in use." };
  const c = (v.conclusion ?? {}) as Conclusion;
  const { data: val } = await db.from("model_runs").select("outputs").eq("kind", "research_validation").eq("inputs->>version_id", v.id).order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const open = openItemsFor(c, (val?.outputs ?? null) as ValidationReport | null, mode);
  const { data: prior } = await db.from("research_versions").select("id, research_as_of").eq("company_id", v.company_id).eq("is_current", true).maybeSingle();
  const at = new Date().toISOString();
  const { error: e1 } = await db.from("research_versions").update({ is_current: false }).eq("company_id", v.company_id).eq("is_current", true);
  if (e1) return { ok: false, error: `Could not retire the research in use: ${e1.message}` };
  const { error: e2 } = await db.from("research_versions").update({
    is_current: true,
    conclusion: { ...c, review_state: mode === "full" ? "adopted" : "adopted_provisional", adopted_at: at, adoption: { mode, at, by, open_items: open, replaced: prior?.id ?? null, recommendation_approved: false } },
  }).eq("id", v.id);
  if (e2) {
    // Put the earlier record back in use rather than leave the company with none.
    if (prior) await db.from("research_versions").update({ is_current: true }).eq("id", prior.id);
    return { ok: false, error: `Could not put it in use: ${e2.message}` };
  }
  await save(db, "research_adoption", "adoption@2", { symbol, version_id: v.id, mode, by, at }, { replaced: prior ? { id: prior.id, research_as_of: prior.research_as_of } : null, open_items: open, action: c.action ?? null }).catch(() => null);
  return { ok: true, mode, replaced: prior?.id ?? null };
}

/** After an investigation finishes: put it in use if the standing rule says so. Returns what happened, for the run log. */
export async function autoAdopt(db: SupabaseClient, versionId: string, symbol: string): Promise<string> {
  const { data: v } = await db.from("research_versions").select("id, company_id, completeness, conclusion").eq("id", versionId).maybeSingle();
  if (!v) return "not found";
  const { data: cur } = await db.from("research_versions").select("completeness, conclusion").eq("company_id", v.company_id).eq("is_current", true).maybeSingle();
  const mode = autoAdoptMode(v as ResearchRef, (cur ?? null) as ResearchRef | null);
  if (!mode) return "left waiting beside the research in use";
  const r = await adoptVersion(db, versionId, mode, "standing_rule", symbol);
  return r.ok ? `put in use (${mode === "full" ? "complete" : "with open items"})` : r.error;
}
