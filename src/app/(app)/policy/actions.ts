"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { save } from "@/lib/intel/jobs";

/**
 * Makes one rule the approved rule for its subject. Every other live rule for that subject becomes
 * superseded (kept, never deleted), with a note saying why.
 */
export async function approveRule(formData: FormData) {
  const id = String(formData.get("rule_id") ?? "");
  const note = String(formData.get("note") ?? "").trim().slice(0, 500);
  const db = await createClient();
  const { data: rule, error } = await db.from("policy_rules").select("id, scope, subject, source_label").eq("id", id).single();
  if (error || !rule) throw new Error("Rule not found");
  const when = new Date().toISOString();
  const sup = await db.from("policy_rules")
    .update({ approval: "superseded", approval_note: `Replaced on ${when.slice(0, 10)} when you chose "${rule.source_label}".` })
    .eq("scope", rule.scope).eq("subject", rule.subject).neq("id", id).in("approval", ["approved", "unresolved", "proposed"]);
  if (sup.error) throw sup.error;
  const ok = await db.from("policy_rules")
    .update({ approval: "approved", approved_at: when, approval_note: `Chosen by you in the app on ${when.slice(0, 10)}.${note ? ` ${note}` : ""}` })
    .eq("id", id);
  if (ok.error) throw ok.error;
  revalidatePath("/", "layout");
  redirect(`/policy?saved=${encodeURIComponent(rule.subject)}`);
}

const pct = (v: FormDataEntryValue | null) => {
  const s = String(v ?? "").replace(/[%\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("Percentages must be between 0 and 100");
  return Math.round(n * 100) / 10000;
};

/** A controlled change: a new rule you write, approved now, with the old one kept as superseded. */
export async function addRule(formData: FormData) {
  const scope = String(formData.get("scope") ?? "");
  const subject = String(formData.get("subject") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 500);
  if (!["company", "bucket", "generic_company", "assumption"].includes(scope) || !subject) throw new Error("Choose what the rule applies to");
  if (!reason) throw new Error("Say why the rule is changing");
  const db = await createClient();
  const row: Record<string, unknown> = { scope, subject: scope === "company" ? subject.toUpperCase() : subject, source_label: "Your change in the app", source_date: new Date().toISOString().slice(0, 10), source_status: "user_entry", conditions: reason, approval: "proposed" };
  if (scope === "assumption") {
    const raw = String(formData.get("value") ?? "").replace(/[%\s]/g, "");
    const n = Number(raw);
    if (!raw || !Number.isFinite(n)) throw new Error("Enter a value");
    row.value = subject === "research_freshness_days" ? Math.round(n) : n / 100;
  } else {
    row.normal_low = pct(formData.get("normal_low"));
    row.normal_high = pct(formData.get("normal_high"));
    row.high_conviction_low = pct(formData.get("hc_low"));
    row.high_conviction_high = pct(formData.get("hc_high"));
    row.hard_max = pct(formData.get("hard_max"));
    if (row.hard_max === null && row.normal_high === null) throw new Error("Enter at least a maximum or a normal range");
  }
  const { data, error } = await db.from("policy_rules").insert(row).select("id").single();
  if (error) throw error;
  const fd = new FormData();
  fd.set("rule_id", data.id);
  fd.set("note", reason);
  return approveRule(fd);
}

/** Saves the investor's profile as a new version (earlier versions are kept). */
export async function saveProfile(formData: FormData) {
  const text = String(formData.get("text") ?? "").trim().slice(0, 3000);
  const db = await createClient();
  await save(db, "investor_profile", "profile@1", {}, { text });
  revalidatePath("/policy");
  redirect("/policy?saved=profile#profile");
}
