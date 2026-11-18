/**
 * The investor's own words about who they are and what they want (age, situation, goals, how they
 * like to trade). Kept in the database, not in code, and given to every AI run as context.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type Profile = { text: string; updatedAt: string | null };

export async function loadProfile(db: SupabaseClient): Promise<Profile> {
  const { data } = await db.from("model_runs").select("computed_at, outputs").eq("kind", "investor_profile").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const o = (data?.outputs ?? {}) as { text?: string };
  return { text: (o.text ?? "").trim(), updatedAt: (data as { computed_at?: string } | null)?.computed_at ?? null };
}
