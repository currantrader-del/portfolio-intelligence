"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { newTopic } from "@/lib/watch/watch";
import { runWatch, saveWatchSettings, sendTest, watchSettings } from "@/lib/watch/job";
import { saveFeedback, type Verdict } from "@/lib/eval/log";
import { prefsFrom, saveAlertPrefs } from "@/lib/watch/priceMoves";

async function origin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  return `${h.get("x-forwarded-proto") ?? "https"}://${host}`;
}

function done(msg: string): never {
  revalidatePath("/alerts");
  redirect(`/alerts?msg=${encodeURIComponent(msg)}`);
}

/** Turns phone alerts on (making a private topic the first time) or off. */
export async function setEnabled(formData: FormData) {
  const db = await createClient();
  const s = await watchSettings(db);
  const on = formData.get("on") === "1";
  await saveWatchSettings(db, { topic: s.topic ?? newTopic(), enabled: on });
  done(on ? "on" : "off");
}

/** A new topic, for when the old one may have been seen by someone else. */
export async function resetTopic() {
  const db = await createClient();
  const s = await watchSettings(db);
  await saveWatchSettings(db, { topic: newTopic(), enabled: s.enabled || !!s.topic });
  done("newtopic");
}

export async function test() {
  const db = await createClient();
  try { await sendTest(db, await origin()); } catch (e) { done(`error:${(e as Error).message.slice(0, 160)}`); }
  done("test");
}

/** Runs one check now, even outside market hours. Anything already sent is not sent again. */
export async function checkNow() {
  const db = await createClient();
  let r: Awaited<ReturnType<typeof runWatch>>;
  try { r = await runWatch(db, await origin(), { force: true }); } catch (e) { done(`error:${(e as Error).message.slice(0, 160)}`); }
  if ("skipped" in r) done(`error:${r.skipped}`);
  const n = r.sent.length + (r.moves ?? []).filter((m) => m.pushed || m.queued).length;
  done(r.error ? `error:${r.error}` : n ? `sent:${n}` : "quiet");
}

/** Your verdict on one alert, for the 30-day evaluation (a later click replaces an earlier one). */
export async function feedback(formData: FormData) {
  const verdict = String(formData.get("verdict") ?? "");
  if (!["useful", "false", "repetitive"].includes(verdict)) done("error:Choose useful, false or repetitive.");
  const db = await createClient();
  await saveFeedback(db, { verdict: verdict as Verdict, runId: String(formData.get("runId") ?? "") || null, alertId: String(formData.get("alertId") ?? "") || null, symbol: String(formData.get("symbol") ?? "") || null, note: null });
  done("feedback");
}

/** An event the app should have alerted on and did not. */
export async function reportMissed(formData: FormData) {
  const note = String(formData.get("note") ?? "").trim().slice(0, 500);
  const symbol = String(formData.get("symbol") ?? "").trim().toUpperCase().slice(0, 12) || null;
  if (!note) done("error:Say briefly what was missed.");
  const db = await createClient();
  await saveFeedback(db, { verdict: "missed", runId: null, alertId: null, symbol, note });
  done("missed");
}

/** Your alert preferences: thresholds by kind of holding, per-stock kinds, which alerts, and immediate or daily. */
export async function saveAlertPreferences(formData: FormData) {
  const num = (k: string) => Number(String(formData.get(k) ?? "").replace(/[^0-9.]/g, ""));
  const thresholds = { broad_etf: num("t_broad_etf"), stock: num("t_stock"), speculative: num("t_speculative") };
  if (Object.values(thresholds).some((v) => !(v >= 0.5 && v <= 50))) done("error:Thresholds: enter 0.5% to 50%.");
  const classOverrides: Record<string, string> = {};
  for (const part of String(formData.get("overrides") ?? "").split(/[,\n]/)) {
    const m = part.trim().match(/^([A-Za-z.\-]{1,10})\s*[=:]\s*(broad_etf|etf|stock|speculative)$/i);
    if (m) classOverrides[m[1].toUpperCase()] = m[2].toLowerCase() === "etf" ? "broad_etf" : m[2].toLowerCase();
    else if (part.trim()) done(`error:Could not read "${part.trim().slice(0, 30)}". Use SYMBOL=etf, stock or speculative.`);
  }
  const on = (k: string) => formData.get(k) === "on";
  const prefs = prefsFrom({
    thresholds, classOverrides, priceMoves: on("priceMoves"), watchlistMoves: on("watchlistMoves"), intelligence: on("intelligence"),
    priceDelivery: formData.get("priceDelivery"), intelligenceDelivery: formData.get("intelligenceDelivery"),
  });
  const db = await createClient();
  await saveAlertPrefs(db, prefs);
  done("prefs");
}
