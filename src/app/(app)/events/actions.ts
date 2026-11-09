"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { save } from "@/lib/intel/jobs";
import { REVIEW_VERSION, accKey } from "@/lib/alerts/review";

/** "Reviewed, no change": saved (insert-only) so the item stops asking for attention. No AI. */
export async function markReviewed(formData: FormData) {
  const db = await createClient();
  const symbol = String(formData.get("symbol") ?? "").toUpperCase().slice(0, 12);
  const accessions = String(formData.get("accessions") ?? "").split(",").map((a) => accKey(a.trim())).filter((a) => /^\d{18}$/.test(a));
  const back = String(formData.get("back") ?? "/");
  if (symbol && accessions.length) await save(db, "filing_review", REVIEW_VERSION, { symbol, accessions }, { symbol, accessions, decision: "no_change", at: new Date().toISOString() });
  revalidatePath("/");
  revalidatePath("/brief");
  redirect(back.startsWith("/") && !back.startsWith("//") ? back : "/");
}
