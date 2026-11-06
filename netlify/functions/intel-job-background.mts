/**
 * Background job for the daily briefing (Netlify runs "-background" functions for up to 15 minutes
 * and answers the caller with 202 at once). It acts as the signed-in user: the caller passes the
 * user's access token, which is verified before anything runs, and row-level security applies.
 */
import { createClient } from "@supabase/supabase-js";
import { desksSettled, dispatchJob, runDeskJob, runSynthesisJob } from "../../src/lib/intel/jobs";
import { DESKS, type DeskKey } from "../../src/lib/intel/desks";

export default async (req: Request) => {
  const body = (await req.json().catch(() => null)) as { job?: string; snapshotId?: string; desk?: string; token?: string } | null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!body?.token || !body.snapshotId || !url || !key) { console.error("intel job: missing input or environment"); return; }
  const db = createClient(url, key, { global: { headers: { Authorization: `Bearer ${body.token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data } = await db.auth.getUser(body.token);
  if (!data.user) { console.error("intel job: token rejected"); return; }
  const origin = new URL(req.url).origin;
  try {
    if (body.job === "desk" && DESKS.some((d) => d.key === body.desk)) {
      const id = await runDeskJob(db, body.snapshotId, body.desk as DeskKey);
      console.log(`intel job: desk ${body.desk} saved ${id}`);
      if (await desksSettled(db, body.snapshotId)) await dispatchJob(origin, { job: "synthesize", snapshotId: body.snapshotId, token: body.token });
    } else if (body.job === "synthesize") {
      const id = await runSynthesisJob(db, body.snapshotId);
      console.log(`intel job: briefing ${id ?? "already written"}`);
    }
  } catch (e) {
    console.error(`intel job ${body.job} failed: ${(e as Error).message}`);
  }
};
