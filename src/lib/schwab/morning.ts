/** The morning Schwab step (code only, no AI cost): sync, and a phone reminder before the weekly sign-in expires. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { save } from "@/lib/intel/jobs";
import { pushNtfy, watchSettings } from "@/lib/watch/job";
import { SCHWAB_VERSION, configured, connection } from "./client";
import { syncSchwab } from "./sync";

/** Remind on the last day (and once a day after it expires). */
export const needsReminder = (daysLeft: number | null, connectedBefore: boolean) => connectedBefore && daysLeft !== null && daysLeft <= 1.2;

export async function morningSchwab(db: SupabaseClient, origin: string, now = new Date()): Promise<string> {
  if (!configured()) return "schwab not set up";
  const c = await connection(db, now);
  if (!c.refreshIssuedAt || c.disconnected) return "schwab not connected";
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  if (needsReminder(c.daysLeft, true)) {
    const { data } = await db.from("model_runs").select("id").eq("kind", "schwab_reminder").eq("inputs->>day", day).limit(1);
    const s = await watchSettings(db);
    if (!data?.length && s.enabled && s.topic) {
      await pushNtfy(s.topic, {
        title: c.connected ? "Schwab sign-in expires today" : "Schwab sign-in expired",
        body: "Schwab asks you to sign in again every 7 days. Open Portfolio and tap Sign in again, so holdings keep syncing.",
        priority: "default", click: `${origin}/portfolio`,
      }).catch(() => null);
      await save(db, "schwab_reminder", SCHWAB_VERSION, { day }, { at: now.toISOString(), daysLeft: c.daysLeft });
    }
  }
  if (!c.connected) return "schwab sign-in expired";
  const r = await syncSchwab(db, now);
  return r.ok ? `schwab synced ${r.synced.map((x) => `${x.account} (${x.positions})`).join(", ")}` : `schwab sync failed: ${r.error}`;
}
