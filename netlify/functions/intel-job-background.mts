/**
 * Background job for the daily briefing (Netlify runs "-background" functions for up to 15 minutes
 * and answers the caller with 202 at once). It acts as the signed-in user: the caller passes the
 * user's access token, which is verified before anything runs, and row-level security applies.
 */
import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { desksSettled, dispatchJob, runDeskJob, runSynthesisJob } from "../../src/lib/intel/jobs";
import { DESKS, type DeskKey } from "../../src/lib/intel/desks";
import { runAskJob } from "../../src/lib/assistant/jobs";
import { runResearchJob } from "../../src/lib/research/aiResearchJob";
import { runPlanJob, startPlan } from "../../src/lib/plan/job";
import { runMorning } from "../../src/lib/intel/start";

/**
 * The owner's session for the scheduled morning run, which has no browser. The service key (server-only,
 * set in Netlify) issues a one-time sign-in link for the app's single user, and that link is exchanged
 * for an ordinary session, so the run then works exactly like the signed-in user, under row-level security.
 */
async function ownerToken(url: string, key: string) {
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!service) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: list, error } = await admin.auth.admin.listUsers({ perPage: 10 });
  if (error) throw new Error(`listUsers: ${error.message}`);
  const owner = process.env.OWNER_USER_ID ? list.users.find((u) => u.id === process.env.OWNER_USER_ID) : list.users.length === 1 ? list.users[0] : null;
  if (!owner?.email) throw new Error("Could not tell which user owns the app (set OWNER_USER_ID)");
  const { data: link, error: e2 } = await admin.auth.admin.generateLink({ type: "magiclink", email: owner.email });
  if (e2 || !link.properties?.hashed_token) throw new Error(`generateLink: ${e2?.message ?? "no token"}`);
  const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s, error: e3 } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "magiclink" });
  if (e3 || !s.session) throw new Error(`verifyOtp: ${e3?.message ?? "no session"}`);
  return s.session.access_token;
}

export default async (req: Request) => {
  const body = (await req.json().catch(() => null)) as { job?: string; snapshotId?: string; requestId?: string; desk?: string; token?: string; secret?: string } | null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (body?.job === "morning") {
    const secret = process.env.CRON_SECRET;
    const given = Buffer.from(String(body.secret ?? "")), want = Buffer.from(secret ?? "");
    if (!secret || given.length !== want.length || !timingSafeEqual(given, want) || !url || !key) { console.error(`morning: ${!secret ? "CRON_SECRET is not set" : "secret did not match"}`); return; }
    try {
      const token = await ownerToken(url, key);
      const db = createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
      const r = await runMorning(db, token, new URL(req.url).origin, (id) => runAskJob(db, id));
      console.log(`morning: ${JSON.stringify(r)}`);
    } catch (e) {
      console.error(`morning failed: ${(e as Error).message}`);
    }
    return;
  }
  if (!body?.token || !(body.snapshotId || body.requestId) || !url || !key) { console.error("intel job: missing input or environment"); return; }
  const db = createClient(url, key, { global: { headers: { Authorization: `Bearer ${body.token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data } = await db.auth.getUser(body.token);
  if (!data.user) { console.error("intel job: token rejected"); return; }
  const origin = new URL(req.url).origin;
  try {
    if (body.job === "ask" && body.requestId) {
      const id = await runAskJob(db, body.requestId);
      console.log(`intel job: answer saved ${id}`);
    } else if (body.job === "research" && body.requestId) {
      const id = await runResearchJob(db, body.requestId);
      console.log(`intel job: research result saved ${id}`);
      // New research changes the plan: rebuild it (skipped when a rebuild is already running).
      const { data: r } = await db.from("model_runs").select("outputs->>ok").eq("id", id).maybeSingle();
      if ((r as { ok?: string } | null)?.ok === "true") await startPlan(db, origin, body.token, "research").catch((e) => console.error(`intel job: plan did not start: ${(e as Error).message}`));
    } else if (body.job === "plan" && body.requestId) {
      const id = await runPlanJob(db, body.requestId);
      console.log(`intel job: plan saved ${id}`);
    } else if (body.job === "desk" && body.snapshotId && DESKS.some((d) => d.key === body.desk)) {
      const id = await runDeskJob(db, body.snapshotId, body.desk as DeskKey);
      console.log(`intel job: desk ${body.desk} saved ${id}`);
      if (await desksSettled(db, body.snapshotId)) await dispatchJob(origin, { job: "synthesize", snapshotId: body.snapshotId, token: body.token });
    } else if (body.job === "synthesize" && body.snapshotId) {
      const id = await runSynthesisJob(db, body.snapshotId);
      console.log(`intel job: briefing ${id ?? "already written"}`);
    }
  } catch (e) {
    console.error(`intel job ${body.job} failed: ${(e as Error).message}`);
  }
};
