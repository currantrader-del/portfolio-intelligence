"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { newTopic } from "@/lib/watch/watch";
import { runWatch, saveWatchSettings, sendTest, watchSettings } from "@/lib/watch/job";
import { saveFeedback, type Verdict } from "@/lib/eval/log";

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
  done(r.error ? `error:${r.error}` : r.sent.length ? `sent:${r.sent.length}` : "quiet");
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
