import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_ESTIMATES, measuredRange, type UpdatePlan } from "./updatePlan";

/** What past investigations and updates actually cost (summed per run from their saved steps), as ranges. */
export async function measuredEstimates(db: SupabaseClient, now = new Date()): Promise<UpdatePlan["estimates"]> {
  const since = new Date(now.getTime() - 120 * 86_400_000).toISOString();
  const [{ data: reqs }, { data: steps }] = await Promise.all([
    db.from("model_runs").select("id, type:inputs->>type").eq("kind", "investigation_request").gte("computed_at", since).limit(200),
    db.from("model_runs").select("req:inputs->>request_id, cost:outputs->>costUsd, status:outputs->>status").eq("kind", "investigation_step").gte("computed_at", since).limit(2000),
  ]);
  const total = new Map<string, number>();
  const finished = new Set<string>();
  for (const s of (steps ?? []) as { req: string | null; cost: string | null; status: string | null }[]) {
    if (!s.req) continue;
    total.set(s.req, (total.get(s.req) ?? 0) + (Number(s.cost) || 0));
    if (s.status === "finished") finished.add(s.req);
  }
  const of = (type: string) => ((reqs ?? []) as { id: string; type: string | null }[]).filter((r) => r.type === type && finished.has(r.id)).map((r) => total.get(r.id) ?? 0);
  return { update: measuredRange(of("material_event_refresh"), { ...DEFAULT_ESTIMATES.update }), full: measuredRange(of("full_investigation"), { ...DEFAULT_ESTIMATES.full }) };
}
