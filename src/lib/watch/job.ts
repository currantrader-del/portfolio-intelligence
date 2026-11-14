/**
 * The 30-minute market-hours check. Code does the checking (existing alert rules, SEC filings, price
 * bands for researched ideas); the AI is only asked for a one-line "why it matters" when something new
 * fires, so a quiet day costs nothing. Every run is stored, so the Alerts page shows what was sent.
 */
import { automatedAllowed, loadSpend } from "@/lib/costs/spend";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Alert } from "@/lib/alerts/rules";
import { loadEventAlerts, researchDates } from "@/lib/alerts/events";
import { loadReviewState } from "@/lib/alerts/review";
import { filingsToPush } from "./filingFilter";
import { addFilingReads } from "./filingRead";
import { isMarketOpen } from "@/lib/market/hours";
import { getQuotes } from "@/lib/market/quotes";
import { withSchwabQuotes } from "@/lib/schwab/market";
import { buildWorkspace } from "@/lib/workspace-core";
import { save } from "@/lib/intel/jobs";
import { DAILY_CAP, spentToday } from "@/lib/intel/start";
import { WATCH_VERSION } from "./watch";
import { recordPaperDecisions } from "@/lib/eval/log";
import { CATEGORY_LABEL, decisionAlerts, formatDecisionPush, selectDecisionAlerts, type DecisionAlert } from "./decisionAlerts";
import { checkTrades, describeIdea, type Trade } from "@/lib/trades/job";
import { DAILY_SUMMARY_AT_MIN, DEFAULT_ALERT_PREFS, bucketOf, formatMovePush, loadAlertPrefs, priceMoveAlerts, type AlertPrefs, type MoveAlert, type MoveItem } from "./priceMoves";

export type WatchSettings = { topic: string | null; enabled: boolean };
export type WatchRun = {
  version: string; at: string; trigger: "schedule" | "manual" | "test";
  checked: number; sent: { key: string; alert: Alert; decision?: DecisionAlert }[]; summary: string | null;
  /** Price-movement alerts found this run: pushed now, queued for the daily summary, or covered by an urgent-risk alert. */
  moves?: { alert: MoveAlert; covered: boolean; pushed: boolean; queued: boolean }[];
  /** Investment-intelligence alerts held for the daily summary instead of pushed now. */
  queued?: boolean;
  /** This run sent the end-of-day summary. */
  dailySummary?: boolean;
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
  // One closing check is allowed up to 4:10 PM ET, so the day's final moves and the daily summary are not missed.
  if (!opts.force && !isMarketOpen(now) && !isClosingCheck(now)) return { skipped: "market closed" };
  // Paper trades are tracked whether or not phone alerts are on.
  const closed = await checkTrades(db, now).catch((e) => { console.error(`watch: trade check failed: ${(e as Error).message}`); return []; });
  const settings = await watchSettings(db);
  if (closed.length && settings.enabled && settings.topic) await pushTradeNews(settings.topic, origin, closed, "closed").catch((e) => console.error(`watch: trade push failed: ${(e as Error).message}`));
  if (!settings.enabled || !settings.topic) return { skipped: "phone alerts are off" };

  // Schwab's real-time quotes when connected (free delayed quotes otherwise).
  const ws = await buildWorkspace(db, now, { liveQuotes: true });
  const held = new Set(ws.portfolio.holdings.map((h) => h.symbol));
  const ideas = ws.research.filter((r) => !held.has(r.symbol) && r.current).map((r) => r.symbol);
  const [events, ideaQuotes, past] = await Promise.all([
    loadEventAlerts([...held, ...ideas], now, researchDates(ws.research)).catch(() => ({ alerts: [] as Alert[] })),
    ideas.length ? getQuotes(ideas).then((free) => withSchwabQuotes(db, free, ideas)) : Promise.resolve(new Map()),
    watchRuns(db),
  ]);
  // Filings already read by research, marked reviewed, debt-only, or first seen days late stay on the Events page.
  const review = await loadReviewState(db, events.alerts).catch((e) => { console.error(`watch: filing review state failed: ${(e as Error).message}`); return null; });
  const pushable = review ? filingsToPush(events.alerts, review, now) : events.alerts;
  // Only what matters to a decision is pushed (decisionAlerts); plain moves and reminders wait for the brief.
  const quotes = new Map<string, { price: number; prevClose: number | null; asOf: string }>();
  for (const [s, q] of ws.quotes ?? new Map()) quotes.set(s, q);
  for (const [s, q] of ideaQuotes as Map<string, { price: number; prevClose: number | null; asOf: string }>) quotes.set(s, q);
  const all = decisionAlerts({
    research: ws.research,
    holdings: ws.portfolio.holdings.map((h) => ({ symbol: h.symbol, price: h.price, priceSource: h.priceSource, dayPct: h.dayPct, weight: h.weight })),
    quotes, headroom: new Map(ws.portfolio.exposures.filter((e) => e.hasLimit).map((e) => [e.symbol, e.headroomDollars])),
    marketDayPct: ws.benchmarks?.[0]?.dayPct ?? null, events: pushable, now,
  });
  const prefs = await loadAlertPrefs(db).catch(() => DEFAULT_ALERT_PREFS);
  const lastSent = new Map<string, string>();
  for (const r of [...past].reverse()) if (r.pushed || r.queued) for (const s of r.sent) if (s.decision) lastSent.set(s.decision.id, r.at);
  const freshAlerts = prefs.intelligence ? selectDecisionAlerts(all, lastSent, now) : [];
  // New filings get a two-line first read (a fraction of a cent each), within the daily and test budgets.
  let readCost = 0;
  if (freshAlerts.some((d) => d.category === "thesis_change")) {
    const room = (await spentToday(db, now)).total < DAILY_CAP.total && (await automatedAllowed(db, "watch_run", now)).ok;
    if (room) {
      const files = new Map(pushable.filter((e) => e.source).map((e) => [`filing:${e.id}`, { url: e.source!.url, form: e.source!.form }]));
      const theses = new Map(ws.research.filter((r) => r.current?.parsed.thesis).map((r) => [r.symbol, r.current!.parsed.thesis!]));
      readCost = await addFilingReads(db, freshAlerts, files, theses).catch((e) => { console.error(`watch: filing reads failed: ${(e as Error).message}`); return 0; });
    }
  }
  const fresh = freshAlerts.map((d) => ({ key: d.id, decision: d, alert: toAlert(d) }));

  // Price-movement alerts: code only, independent of research, one per threshold crossing per session.
  const today = etDay(now);
  const sentToday = new Map<string, number>();
  for (const r of past) if (r.at && etDay(new Date(r.at)) === today) for (const m of r.moves ?? []) {
    const k = `${m.alert.symbol}|${m.alert.dir}`;
    sentToday.set(k, Math.max(sentToday.get(k) ?? 0, m.alert.level));
  }
  const moveItems: MoveItem[] = [
    ...ws.portfolio.holdings.map((h) => ({ symbol: h.symbol, dayPct: h.dayPct, price: h.price, quoteAt: h.priceSource === "quote" ? quotes.get(h.symbol)?.asOf ?? null : null, held: true, bucket: h.bucket })),
    ...ideas.flatMap((s) => {
      const q = quotes.get(s);
      if (!q?.prevClose) return [];
      const cls = ws.research.find((r) => r.symbol === s)?.current?.parsed.classification ?? null;
      return [{ symbol: s, dayPct: q.price / q.prevClose - 1, price: q.price, quoteAt: q.asOf, held: false, bucket: bucketOf(s, cls) }];
    }),
  ];
  const moveAlerts = prefs.priceMoves ? priceMoveAlerts({ items: moveItems, prefs, marketDayPct: ws.benchmarks?.[0]?.dayPct ?? null, sentToday, now }) : [];
  // A fall already pushed as an urgent risk is not sent twice; it still counts as alerted for the day.
  const urgent = new Set(freshAlerts.filter((d) => d.category === "urgent_risk").map((d) => d.symbol));
  const moves = moveAlerts.map((m) => ({ alert: m, covered: urgent.has(m.symbol) && m.dir === "down", pushed: false, queued: false }));

  const run: WatchRun = { version: WATCH_VERSION, at: now.toISOString(), trigger: opts.force ? "manual" : "schedule", checked: all.length, sent: fresh, summary: null, pushed: false, error: null, costUsd: readCost, moves };
  const toPushMoves = moves.filter((m) => !m.covered);
  if (toPushMoves.length) {
    if (prefs.priceDelivery === "daily") toPushMoves.forEach((m) => { m.queued = true; });
    else {
      const msg = formatMovePush(toPushMoves.map((m) => m.alert));
      const click = toPushMoves.length === 1 ? `${origin}${toPushMoves[0].alert.href}` : `${origin}/alerts`;
      try { await pushNtfy(settings.topic, { ...msg, click }); toPushMoves.forEach((m) => { m.pushed = true; }); } catch (e) { run.error = (e as Error).message; }
    }
  }
  if (fresh.length && prefs.intelligenceDelivery === "daily") {
    // Held for the end-of-day summary; counted as sent so the repeat windows still apply.
    run.queued = true;
    await recordPaperDecisions(db, freshAlerts, { vooPrice: quotes.get("VOO")?.price ?? null, now }).catch((e) => console.error(`watch: paper decision failed: ${(e as Error).message}`));
  } else if (fresh.length) {
    const items = fresh.map((f) => f.alert);
    const spent = await spentToday(db, now);
    // The one-line summary is the only paid part; without budget room the alert is still sent, unsummarized.
    if (spent.total < DAILY_CAP.total && (await automatedAllowed(db, "watch_run", now)).ok) {
      const theses = new Map(ws.research.filter((r) => r.current?.parsed.thesis).map((r) => [r.symbol, r.current!.parsed.thesis!]));
      const s = await summarize(items, theses).catch((e) => { console.error(`watch: summary failed: ${(e as Error).message}`); return { text: null, costUsd: 0 }; });
      run.summary = s.text; run.costUsd += s.costUsd;
    }
    const msg = formatDecisionPush(freshAlerts, run.summary);
    const click = items.length === 1 ? `${origin}${items[0].href}` : `${origin}/alerts`;
    try { await pushNtfy(settings.topic, { ...msg, click }); run.pushed = true; } catch (e) { run.error = (e as Error).message; }
    // Evaluation log: a paper decision whenever an action plan's entry (or trim) criteria are met.
    await recordPaperDecisions(db, freshAlerts, { vooPrice: quotes.get("VOO")?.price ?? null, now }).catch((e) => console.error(`watch: paper decision failed: ${(e as Error).message}`));
  }
  await dailySummary(run, past, prefs, settings.topic, origin, now).catch((e) => console.error(`watch: daily summary failed: ${(e as Error).message}`));
  await warnCost(db, settings.topic, origin, now).catch((e) => console.error(`watch: cost warning failed: ${(e as Error).message}`));
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

/** The Alerts page's shape for a pushed decision alert (it lists what was sent). */
function toAlert(d: DecisionAlert): Alert {
  return {
    id: d.id, severity: d.priority === "high" ? "high" : "medium", symbol: d.symbol,
    kind: d.category === "thesis_change" ? "event" : d.category === "urgent_risk" ? "big_move" : "price_zone",
    title: `${CATEGORY_LABEL[d.category]}: ${d.title}`,
    detail: `${d.changed} Why it matters: ${d.why} Action: ${d.action} Uncertain: ${d.uncertain} Verified: ${d.verified}.`,
    href: d.href,
  };
}

/**
 * During the 30-day test: one phone warning when AI spending reaches the warning level ($15), and one
 * when it reaches the ceiling ($20, after which automated paid jobs stop). Each is sent once per test.
 */
export async function warnCost(db: SupabaseClient, topic: string, origin: string, now: Date): Promise<"warn" | "over" | null> {
  const s = await loadSpend(db, now);
  const e = s.evaluation;
  if (!e?.active || !e.warn) return null;
  const level = e.over ? "over" : "warn";
  const { data } = await db.from("model_runs").select("id").eq("kind", "cost_warning").eq("inputs->>start", e.start).eq("inputs->>level", level).limit(1);
  if ((data ?? []).length) return null;
  const top = [...e.byCategory].sort((a, b) => b.cost - a.cost).filter((c) => c.cost > 0).slice(0, 2).map((c) => `${c.label} $${c.cost.toFixed(2)}`).join(", ");
  const body = level === "over"
    ? `$${e.spent.toFixed(2)} spent on AI in the 30-day test (day ${e.day}), reaching the $${e.ceiling} ceiling. Scheduled paid jobs (briefing, morning answer, plan) now stop and say so; price and filing checks and alerts continue at no cost. Largest: ${top}.`
    : `$${e.spent.toFixed(2)} of the $${e.ceiling} test ceiling spent (day ${e.day}); at this pace about $${e.projected.toFixed(2)} by day 30. Largest: ${top}. Scheduled paid jobs stop at $${e.ceiling}.`;
  await pushNtfy(topic, { title: level === "over" ? "AI cost ceiling reached" : `AI cost warning: $${e.spent.toFixed(2)} of $${e.ceiling}`, body, priority: "default", click: `${origin}/costs` });
  await save(db, "cost_warning", WATCH_VERSION, { start: e.start, level }, { at: now.toISOString(), spent: e.spent, ceiling: e.ceiling, level });
  return level;
}

/**
 * The end-of-day summary for alert types you set to "daily summary": sent once, with the first check at or
 * after 3:45 PM ET, listing what was held back today (price moves and investment-intelligence alerts).
 */
async function dailySummary(run: WatchRun, past: WatchRun[], prefs: AlertPrefs, topic: string, origin: string, now: Date): Promise<void> {
  if (prefs.priceDelivery !== "daily" && prefs.intelligenceDelivery !== "daily") return;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
  const minutes = Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
  if (minutes < DAILY_SUMMARY_AT_MIN) return;
  const day = etDay(now);
  const todays = [...past.filter((r) => r.at && etDay(new Date(r.at)) === day), run];
  if (todays.some((r) => r.dailySummary)) return;
  const moves = todays.flatMap((r) => (r.moves ?? []).filter((m) => m.queued).map((m) => m.alert));
  // Only the highest level per symbol and direction.
  const top = new Map<string, MoveAlert>();
  for (const m of moves) { const k = `${m.symbol}|${m.dir}`; if (!top.has(k) || top.get(k)!.level < m.level) top.set(k, m); }
  const intel = todays.filter((r) => r.queued).flatMap((r) => r.sent.map((s) => s.decision).filter((d): d is DecisionAlert => !!d));
  if (!top.size && !intel.length) return;
  if (top.size) await pushNtfy(topic, { ...formatMovePush([...top.values()], true), click: `${origin}/alerts` });
  if (intel.length) {
    const msg = formatDecisionPush(intel);
    await pushNtfy(topic, { ...msg, title: `Today's investment alerts: ${msg.title}`, click: `${origin}/alerts` });
  }
  run.dailySummary = true;
}

/** Weekdays 4:00-4:10 PM ET: the closing check. */
export function isClosingCheck(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  if (get("weekday") === "Sat" || get("weekday") === "Sun") return false;
  const m = Number(get("hour")) * 60 + Number(get("minute"));
  return m >= 16 * 60 && m < 16 * 60 + 10;
}
