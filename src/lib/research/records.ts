import { parseConclusion, type ParsedConclusion } from "./valuation";
import type { ScreenResult, Stage } from "./screen";

export type PipelineInfo = { stage: Stage; note: string | null; stageUpdatedAt: string | null; screen: ScreenResult | null; screenedAt: string | null };

export type VersionRow = {
  id: string; research_as_of: string; completeness: string; origin: string; is_current: boolean; conclusion: Record<string, unknown>;
};
export type ResearchRecord = {
  symbol: string;
  name: string | null;
  watchlistStatus: string;
  current: (VersionRow & { parsed: ParsedConclusion }) | null;
  latest: (VersionRow & { parsed: ParsedConclusion }) | null;
  conflict: boolean; // more than one dated record and none marked current
  versions: number;
  pipeline: PipelineInfo;
};

const NO_PIPELINE: PipelineInfo = { stage: "idea", note: null, stageUpdatedAt: null, screen: null, screenedAt: null };

export function toResearchRecord(symbol: string, name: string | null, watchlistStatus: string, versions: VersionRow[], pipeline: PipelineInfo = NO_PIPELINE): ResearchRecord {
  const sorted = [...versions].sort((a, b) => b.research_as_of.localeCompare(a.research_as_of));
  const cur = sorted.find((v) => v.is_current) ?? null;
  const latest = sorted[0] ?? null;
  return {
    symbol,
    name,
    watchlistStatus,
    current: cur ? { ...cur, parsed: parseConclusion(cur.conclusion) } : null,
    latest: latest ? { ...latest, parsed: parseConclusion(latest.conclusion) } : null,
    conflict: !cur && sorted.length > 0,
    versions: sorted.length,
    pipeline,
  };
}

export function researchAgeDays(r: ResearchRecord, now: Date): number | null {
  const v = r.current ?? r.latest;
  if (!v) return null;
  return Math.floor((now.getTime() - new Date(v.research_as_of + "T00:00:00Z").getTime()) / 86_400_000);
}
