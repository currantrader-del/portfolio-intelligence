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
import { resumeIfStalled, runInvestigationStep, stalledInvestigations } from "../../src/lib/research/investigate/run";
import { runPlanJob, startPlan } from "../../src/lib/plan/job";
import { automatedAllowed, loadSpend } from "../../src/lib/costs/spend";
import { runMorning } from "../../src/lib/intel/start";
import { pushTradeNews, runWatch, watchSettings } from "../../src/lib/watch/job";
import { runTradeScan } from "../../src/lib/trades/job";
import { runExposureReview } from "../../src/lib/exposure/reviewJob";
import { runImprovementJob } from "../../src/lib/shadow/proposals";
import { runCalibrationJob } from "../../src/lib/recovery/job";
import { runRadar } from "../../src/lib/radar/job";

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

/** Starts the next background step, retrying: a lost hand-off silently stops a chained investigation. */
async function dispatchWithRetry(origin: string, body: Parameters<typeof dispatchJob>[1]) {
  let last: unknown = null;
  for (const wait of [0, 2000, 5000, 15000, 30000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try { return await dispatchJob(origin, body); } catch (e) { last = e; console.error(`dispatch ${body.job} failed (will retry): ${(e as Error).message}`); }
  }
  throw last;
}

export default async (req: Request) => {
  const body = (await req.json().catch(() => null)) as { job?: string; snapshotId?: string; requestId?: string; desk?: string; token?: string; secret?: string } | null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (body?.job === "morning" || body?.job === "watch" || body?.job === "investigate_sweep") {
    const job = body.job;
    const secret = process.env.CRON_SECRET;
    const given = Buffer.from(String(body.secret ?? "")), want = Buffer.from(secret ?? "");
    if (!secret || given.length !== want.length || !timingSafeEqual(given, want) || !url || !key) { console.error(`${job}: ${!secret ? "CRON_SECRET is not set" : "secret did not match"}`); return; }
    try {
      const token = await ownerToken(url, key);
      const db = createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
      const origin = new URL(req.url).origin;
      if (job === "investigate_sweep") {
        // Scheduled safety net: restarts investigations whose chain of steps stopped (capped per run).
        // Restarting a stopped run spends research money, so it waits for you when the research budget is used up.
        const month = await loadSpend(db).catch(() => null);
        if (!month || month.classes.research.over) { console.log(`investigate_sweep: skipped, ${month ? `research budget used ($${month.classes.research.spent.toFixed(2)} of $${month.classes.research.budget})` : "spending could not be read"}; stopped runs stay stopped until you resume them`); return; }
        const stalled = await stalledInvestigations(db);
        for (const r of stalled) {
          const ok = await resumeIfStalled(db, r.requestId, () => dispatchWithRetry(origin, { job: "investigate", requestId: r.requestId, token })).catch((e) => { console.error(`sweep ${r.symbol}: ${(e as Error).message}`); return false; });
          console.log(`investigate_sweep: ${r.symbol} ${ok ? "restarted" : "left stopped (restart limit)"}`);
        }
        return;
      }
      const r = job === "morning" ? await runMorning(db, token, origin, (id) => runAskJob(db, id)) : await runWatch(db, origin);
      console.log(`${job}: ${JSON.stringify(r).slice(0, 2000)}`);
    } catch (e) {
      console.error(`${job} failed: ${(e as Error).message}`);
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
      const room = await automatedAllowed(db, "portfolio_plan");
      if (!room.ok) console.log(`intel job: plan rebuild ${room.reason}`);
      else if ((r as { ok?: string } | null)?.ok === "true") await startPlan(db, origin, body.token, "research").catch((e) => console.error(`intel job: plan did not start: ${(e as Error).message}`));
    } else if (body.job === "investigate" && body.requestId) {
      // One step of a research investigation; the next step is started as a new invocation, so no
      // single invocation runs into the 15-minute limit. A token close to expiry is replaced with a
      // fresh session for the same owner (the app has one user).
      const r = await runInvestigationStep(db, body.requestId);
      console.log(`intel job: investigation ${body.requestId} step ${r.step} -> ${r.status}`);
      if (r.more) {
        let token = body.token;
        const exp = (() => { try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp as number; } catch { return 0; } })();
        if (exp * 1000 - Date.now() < 20 * 60_000) {
          const fresh = await ownerToken(url, key).catch((e) => { console.error(`investigation: could not refresh the session: ${(e as Error).message}`); return null; });
          const { data: who } = fresh ? await db.auth.getUser(fresh) : { data: { user: null } };
          if (fresh && who.user?.id === data.user.id) token = fresh;
        }
        await dispatchWithRetry(origin, { job: "investigate", requestId: body.requestId, token });
        console.log(`intel job: investigation ${body.requestId} next step started`);
      }
    } else if (body.job === "trades" && body.requestId) {
      const id = await runTradeScan(db, body.requestId, async (made) => {
        const s = await watchSettings(db);
        if (s.enabled && s.topic) await pushTradeNews(s.topic, origin, made, "new");
      });
      console.log(`intel job: trade scan saved ${id}`);
    } else if (body.job === "exposure" && body.requestId) {
      const id = await runExposureReview(db, body.requestId);
      console.log(`intel job: exposure review saved ${id}`);
    } else if (body.job === "recovery" && body.requestId) {
      const r = await runCalibrationJob(db);
      console.log(`intel job: recovery calibration ${r.passed ? "passed" : "failed"} (${r.cases} cases, gap ${r.byKind.touch.meanGap})`);
    } else if (body.job === "radar" && body.requestId) {
      const id = await runRadar(db, body.requestId);
      console.log(`intel job: radar saved ${id}`);
    } else if (body.job === "improve" && body.requestId) {
      const r = await runImprovementJob(db);
      console.log(`intel job: improvement check: ${r.outcome}`);
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
