import { parseConclusion, type ParsedConclusion } from "./valuation";
import type { ScreenResult, Stage } from "./screen";
import { researchStanding } from "./standing";

export type PipelineInfo = { stage: Stage; note: string | null; stageUpdatedAt: string | null; screen: ScreenResult | null; screenedAt: string | null };

export type VersionRow = {
  id: string; research_as_of: string; completeness: string; origin: string; is_current: boolean; conclusion: Record<string, unknown>; created_at?: string | null;
};
/** The latest SEC filing check the app ran for the company (model_runs "research_filing_check"). */
export type FilingCheckInfo = { at: string; status: string; reason: string; document: { form: string; filed: string } | null; material: string[] };

export type ResearchRecord = {
  symbol: string;
  name: string | null;
  watchlistStatus: string;
  current: (VersionRow & { parsed: ParsedConclusion }) | null;
  latest: (VersionRow & { parsed: ParsedConclusion }) | null;
  conflict: boolean; // more than one dated record and none marked current
  versions: number;
  pipeline: PipelineInfo;
  filingCheck?: FilingCheckInfo | null;
  /** How the record in use came to be in use (approved, approved provisionally, or set automatically). */
  approval?: "approved" | "provisional" | "automatic" | null;
  /** A newer investigation waiting for the investor's decision (not used for decisions until approved). */
  pendingReview?: { id: string; research_as_of: string; complete: boolean } | null;
};

const NO_PIPELINE: PipelineInfo = { stage: "idea", note: null, stageUpdatedAt: null, screen: null, screenedAt: null };

/**
 * Whether a version may inform decisions. A new investigation is saved while it runs and then waits
 * for the investor's approval; a preliminary screen is never an investment rating. Neither is used
 * until it is made current (approved), so they never replace or compete with the research in use.
 */
export function usableVersion(v: Pick<VersionRow, "is_current" | "conclusion">): boolean {
  if (v.is_current) return true;
  const c = (v.conclusion ?? {}) as { review_state?: unknown; research_type?: unknown };
  if (c.research_type === "preliminary_screen") return false;
  return !["running", "awaiting_approval", "failed", "set_aside"].includes(String(c.review_state ?? ""));
}

export function toResearchRecord(symbol: string, name: string | null, watchlistStatus: string, versions: VersionRow[], pipeline: PipelineInfo = NO_PIPELINE, filingCheck: FilingCheckInfo | null = null): ResearchRecord {
  const sorted = versions.filter(usableVersion).sort((a, b) => b.research_as_of.localeCompare(a.research_as_of));
  const cur = sorted.find((v) => v.is_current) ?? null;
  const latest = sorted[0] ?? null;
  const st = researchStanding(versions);
  return {
    symbol,
    name,
    watchlistStatus,
    current: cur ? { ...cur, parsed: parseConclusion(cur.conclusion) } : null,
    latest: latest ? { ...latest, parsed: parseConclusion(latest.conclusion) } : null,
    conflict: !cur && sorted.length > 0,
    versions: sorted.length,
    pipeline,
    filingCheck,
    approval: st.inUse?.approval ?? null,
    pendingReview: st.pending?.state === "awaiting_approval" ? { id: st.pending.v.id, research_as_of: st.pending.v.research_as_of, complete: st.pending.complete } : null,
  };
}

export function researchAgeDays(r: ResearchRecord, now: Date): number | null {
  const v = r.current ?? r.latest;
  if (!v) return null;
  return Math.floor((now.getTime() - new Date(v.research_as_of + "T00:00:00Z").getTime()) / 86_400_000);
}
