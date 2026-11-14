"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { saveMyAction, type ActionSubject, type MyAction } from "@/lib/eval/log";
import { getQuotes } from "@/lib/market/quotes";
import { fail, type ActionResult } from "@/lib/action-result";

const SUBJECTS: ActionSubject[] = ["recommendation", "alert", "radar"];

/** One tap: "I did this" or "I passed" on a recommendation, alert or Radar idea. Records only; never trades. */
export async function recordMyAction(formData: FormData): Promise<ActionResult> {
  const subject = String(formData.get("subject") ?? "") as ActionSubject;
  const action = String(formData.get("action") ?? "") as MyAction;
  const ref = String(formData.get("ref") ?? "").slice(0, 200);
  if (!SUBJECTS.includes(subject) || !["did", "passed"].includes(action) || !ref) return fail("Something was missing; reload the page and tap again.");
  const symbol = String(formData.get("symbol") ?? "").trim().toUpperCase().slice(0, 12) || null;
  const summary = String(formData.get("summary") ?? "").slice(0, 400);
  const note = String(formData.get("note") ?? "").trim().slice(0, 300) || null;
  const q = await getQuotes([...(symbol ? [symbol] : []), "VOO"]).catch(() => new Map());
  const db = await createClient();
  await saveMyAction(db, { subject, ref, symbol, summary, action, note, price: symbol ? q.get(symbol)?.price ?? null : null, vooPrice: q.get("VOO")?.price ?? null });
  revalidatePath(String(formData.get("path") ?? "/") || "/");
}
