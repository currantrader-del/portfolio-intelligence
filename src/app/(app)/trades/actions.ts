"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { fail, type ActionResult } from "@/lib/action-result";
import { createClient } from "@/lib/supabase/server";
import { save } from "@/lib/intel/jobs";
import { TRADE_VERSION } from "@/lib/trades/trades";

/** Records that the investor actually made the trade (the paper record stays as it was). */
export async function markTaken(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("idea_id") ?? "");
  const n = (k: string) => { const v = Number(String(formData.get(k) ?? "").replace(/[$,]/g, "")); return Number.isFinite(v) && v > 0 ? v : null; };
  const db = await createClient();
  const { data } = await db.from("model_runs").select("id").eq("id", id).eq("kind", "trade_idea").maybeSingle();
  if (!data) return fail("This trade idea no longer exists. Reload the page.");
  await save(db, "trade_taken", TRADE_VERSION, { idea_id: id }, { price: n("price"), quantity: n("quantity"), note: String(formData.get("note") ?? "").trim().slice(0, 300) });
  revalidatePath("/trades");
  redirect("/trades?saved=1");
}
