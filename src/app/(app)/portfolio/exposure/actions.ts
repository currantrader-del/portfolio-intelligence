"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { proposalRows } from "@/lib/exposure/limits";

/**
 * Sends the drafted exposure limits to the Policy page as PROPOSED rules (one per subject, skipping any
 * subject that already has a live rule). Nothing is approved here: they control nothing until you approve them.
 */
export async function sendProposals() {
  const db = await createClient();
  const { data: existing, error } = await db.from("policy_rules").select("scope, subject, approval").eq("scope", "portfolio");
  if (error) redirect(`/portfolio/exposure?error=${encodeURIComponent("Could not read your policy. Nothing was sent.")}#limits`);
  const rows = proposalRows(existing ?? []);
  if (rows.length) {
    const ins = await db.from("policy_rules").insert(rows);
    if (ins.error) redirect(`/portfolio/exposure?error=${encodeURIComponent(`Not sent: ${ins.error.message}`)}#limits`);
  }
  revalidatePath("/", "layout");
  redirect(`/portfolio/exposure?sent=${rows.length}#limits`);
}
