/** Runs the exposure market analysis as a background job and stores the result (insert-only). */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildWorkspace } from "@/lib/workspace-core";
import { save } from "@/lib/intel/jobs";
import { runAgent } from "@/lib/assistant/agent";
import { extractJson } from "@/lib/research/aiResearch";
import { materialExposures, REVIEW_KIND, REVIEW_LIMITS, REVIEW_SYSTEM, REVIEW_VERSION, reviewQuestion, validateReview, type Material, type ReviewReport } from "./review";

export type ReviewResult = {
  ok: boolean; error?: string; report?: ReviewReport; problems?: string[]; exposures: Material[];
  costUsd: number; ms: number; searches: number; turns: number; model: string | null;
};

export const RUNNING_WINDOW_MIN = 15;

export async function runExposureReview(db: SupabaseClient, requestId: string): Promise<string> {
  const ws = await buildWorkspace(db);
  const items = materialExposures(ws.exposure, ws.exposureLimits);
  const done = (r: Omit<ReviewResult, "exposures">) => save(db, REVIEW_KIND.result, REVIEW_VERSION, { request_id: requestId }, { ...r, exposures: items } satisfies ReviewResult);
  const empty = { costUsd: 0, ms: 0, searches: 0, turns: 0, model: null };
  if (!items.length) return done({ ok: false, error: "No material exposures to analyse.", ...empty });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(ws.now);
  try {
    const ans = await runAgent(db, ws, { question: reviewQuestion(items, today), system: REVIEW_SYSTEM, limits: REVIEW_LIMITS, page: "/portfolio/exposure" });
    const meta = { costUsd: ans.costUsd, ms: ans.ms, searches: ans.searches, turns: ans.turns, model: ans.model };
    const v = validateReview(extractJson(ans.answer));
    if ("error" in v) return done({ ok: false, error: `${v.error}${ans.stopped ? ` (stopped: ${ans.stopped})` : ""}`, ...meta });
    return done({ ok: true, report: v.report, problems: v.problems, ...meta });
  } catch (e) {
    return done({ ok: false, error: (e as Error).message.slice(0, 300), ...empty });
  }
}
