"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { newTopic } from "@/lib/watch/watch";
import { runWatch, saveWatchSettings, sendTest, watchSettings } from "@/lib/watch/job";

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
