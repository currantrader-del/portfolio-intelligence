/**
 * The 30-minute market-hours check. Code does the checking (existing alert rules, SEC filings, price
 * bands for researched ideas); the AI is only asked for a one-line "why it matters" when something new
 * fires, so a quiet day costs nothing. Every run is stored, so the Alerts page shows what was sent.
 */
import { automatedAllowed } from "@/lib/costs/spend";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Alert } from "@/lib/alerts/rules";
import { loadEventAlerts } from "@/lib/alerts/events";
import { isMarketOpen } from "@/lib/market/hours";
import { getQuotes } from "@/lib/market/quotes";
import { buildWorkspace } from "@/lib/workspace-core";
import { save } from "@/lib/intel/jobs";
import { DAILY_CAP, spentToday } from "@/lib/intel/start";
import { WATCH_VERSION, formatPush, ideaAlerts, selectNew } from "./watch";
import { checkTrades, describeIdea, type Trade } from "@/lib/trades/job";

export type WatchSettings = { topic: string | null; enabled: boolean };
export type WatchRun = {
  version: string; at: string; trigger: "schedule" | "manual" | "test";
  checked: number; sent: { key: string; alert: Alert }[]; summary: string | null;
  pushed: boolean; error: string | null; costUsd: number; skipped?: string;
};

const SUMMARY_MODEL = { id: "claude-haiku-5-5", inPerM: 1, outPerM: 5 };

export async function watchSettings(db: SupabaseClient): Promise<WatchSettings> {
  const { data } = await db.from("model_runs").select("outputs").eq("kind", "watch_settings").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const o = (data?.outputs ?? {}) as Partial<WatchSettings>;
  return { topic: o.topic ?? null, enabled: !!o.enabled && !!o.topic };
}

export async function saveWatchSettings(db: SupabaseClient, s: WatchSettings) {
  return save(db, "watch_settings", WATCH_VERSION, {}, s);
}

/** Recent runs, newest first. */
export async function watchRuns(db: SupabaseClient, days = 8): Promise<(WatchRun & { id: string })[]> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data } = await db.from("model_runs").select("id, outputs").eq("kind", "watch_run").gte("computed_at", since).order("computed_at", { ascending: false }).limit(1000);
  return ((data ?? []) as { id: string; outputs: WatchRun }[]).map((r) => ({ ...r.outputs, id: r.id }));
}

/** Sends one notification through ntfy (free, no account; the app on the phone subscribes to the topic). */
export async function pushNtfy(topic: string, msg: { title: string; body: string; priority: "high" | "default"; click?: string }) {
  const res = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, title: msg.title, message: msg.body, priority: msg.priority === "high" ? 4 : 3, click: msg.click, tags: ["chart_with_upwards_trend"] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

const etDay = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);

/** One sentence on why the new alerts matter, from the research on file. Small model, a fraction of a cent. */
async function summarize(items: Alert[], theses: Map<string, string>): Promise<{ text: string | null; costUsd: number }> {
  const facts = items.map((a) => `- ${a.title}. ${a.detail}${a.symbol && theses.get(a.symbol) ? ` Thesis on file: ${theses.get(a.symbol)!.slice(0, 400)}` : ""}`).join("\n");
  const res = await new Anthropic().messages.create({
    model: SUMMARY_MODEL.id, max_tokens: 200,
    system: "You write the body of a phone notification for a long-term individual investor. One or two plain sentences, at most 220 characters: what happened and whether it touches the thesis on file. No advice to trade, no hype, no emojis. If the facts do not say why, say what to check.",
    messages: [{ role: "user", content: facts }],
  });
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim() || null;
  const costUsd = (res.usage.input_tokens * SUMMARY_MODEL.inPerM + res.usage.output_tokens * SUMMARY_MODEL.outPerM) / 1e6;
  return { text: text?.slice(0, 300) ?? null, costUsd };
}

/**
 * One check. Outside market hours it does nothing unless forced ("Check now" on the Alerts page).
 * Each alert is sent once (filings once ever, the rest once per day).
 */
export async function runWatch(db: SupabaseClient, origin: string, opts: { force?: boolean; now?: Date } = {}): Promise<WatchRun | { skipped: string }> {
  const now = opts.now ?? new Date();
  if (!opts.force && !isMarketOpen(now)) return { skipped: "market closed" };
  // Paper trades are tracked whether or not phone alerts are on.
  const closed = await checkTrades(db, now).catch((e) => { console.error(`watch: trade check failed: ${(e as Error).message}`); return []; });
  const settings = await watchSettings(db);
  if (closed.length && settings.enabled && settings.topic) await pushTradeNews(settings.topic, origin, closed, "closed").catch((e) => console.error(`watch: trade push failed: ${(e as Error).message}`));
  if (!settings.enabled || !settings.topic) return { skipped: "phone alerts are off" };

  const ws = await buildWorkspace(db, now);
  const held = new Set(ws.portfolio.holdings.map((h) => h.symbol));
  const ideas = ws.research.filter((r) => !held.has(r.symbol) && r.current).map((r) => r.symbol);
  const [events, ideaQuotes, past] = await Promise.all([
    loadEventAlerts([...held, ...ideas], now).catch(() => ({ alerts: [] as Alert[] })),
    ideas.length ? getQuotes(ideas) : Promise.resolve(new Map()),
    watchRuns(db),
  ]);
  const all = [...ws.alerts, ...events.alerts, ...ideaAlerts(ws.research, held, ideaQuotes)];
  const sentKeys = new Set(past.flatMap((r) => (r.pushed ? r.sent.map((s) => s.key) : [])));
  const fresh = selectNew(all, sentKeys, etDay(now));

  const run: WatchRun = { version: WATCH_VERSION, at: now.toISOString(), trigger: opts.force ? "manual" : "schedule", checked: all.length, sent: fresh, summary: null, pushed: false, error: null, costUsd: 0 };
  if (fresh.length) {
    const items = fresh.map((f) => f.alert);
    const spent = await spentToday(db, now);
    // The one-line summary is the only paid part; without budget room the alert is still sent, unsummarized.
    if (spent.total < DAILY_CAP.total && (await automatedAllowed(db, "watch_run", now)).ok) {
      const theses = new Map(ws.research.filter((r) => r.current?.parsed.thesis).map((r) => [r.symbol, r.current!.parsed.thesis!]));
      const s = await summarize(items, theses).catch((e) => { console.error(`watch: summary failed: ${(e as Error).message}`); return { text: null, costUsd: 0 }; });
      run.summary = s.text; run.costUsd = s.costUsd;
    }
    const msg = formatPush(items, run.summary);
    const click = items.length === 1 ? `${origin}${items[0].href}` : `${origin}/alerts`;
    try { await pushNtfy(settings.topic, { ...msg, click }); run.pushed = true; } catch (e) { run.error = (e as Error).message; }
  }
  // Quiet runs are stored too (they are small), so the page can say when the last check ran.
  await save(db, "watch_run", WATCH_VERSION, { day: etDay(now), force: !!opts.force }, run);
  return run;
}

export async function sendTest(db: SupabaseClient, origin: string) {
  const s = await watchSettings(db);
  if (!s.topic) throw new Error("Turn phone alerts on first");
  await pushNtfy(s.topic, { title: "Portfolio Intelligence is connected", body: "This is a test. Real alerts arrive here during market hours, only when something needs a look.", priority: "default", click: `${origin}/alerts` });
}

const pct = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const STATUS = { target: "hit its target", stop: "hit its stop", ended: "reached its end date", open: "is open" } as const;

/** Notifications for paper trades: a new idea, or one that closed. */
export async function pushTradeNews(topic: string, origin: string, trades: Trade[], what: "new" | "closed") {
  for (const t of trades.slice(0, 3)) {
    const r = t.close?.result;
    const title = what === "new" ? `Trade idea: ${t.idea.symbol} ${t.idea.option ? `${t.idea.option.type}` : "stock"} (${t.idea.confidence} confidence)` : `Paper trade ${t.idea.symbol} ${STATUS[r!.status]}: ${pct(r!.returnPct)} vs VOO ${pct(r!.vooPct)}`;
    const body = what === "new" ? `${describeIdea(t.idea)}. ${t.idea.whyNow}`.slice(0, 600) : `${describeIdea(t.idea)}. ${r!.edgePct !== null ? `${r!.edgePct >= 0 ? "Beat" : "Trailed"} VOO by ${pct(Math.abs(r!.edgePct)).replace("+", "")}.` : ""}`;
    await pushNtfy(topic, { title, body, priority: what === "new" ? "high" : "default", click: `${origin}/trades` });
  }
}
