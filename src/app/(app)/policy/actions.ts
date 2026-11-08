"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { save } from "@/lib/intel/jobs";

/**
 * Policy changes. Nothing is ever deleted and no earlier note is overwritten: each change APPENDS to the
 * row's approval note, so the original provenance stays readable, and every decision is also logged as a
 * model_runs row ("policy_decision") with the rows before and after.
 */
const today = () => new Date().toISOString().slice(0, 10);
const appendNote = (old: string | null, add: string) => (old ? `${old} | ${add}` : add).slice(0, 2000);

type Row = { id: string; scope: string; subject: string; source_label: string; approval: string; approval_note: string | null; approved_at: string | null };

async function setRow(db: SupabaseClient, r: Row, patch: Record<string, unknown>, note: string) {
  const { error } = await db.from("policy_rules").update({ ...patch, approval_note: appendNote(r.approval_note, note) }).eq("id", r.id);
  if (error) throw error;
}

async function log(db: SupabaseClient, inputs: Record<string, unknown>, before: Row[], after: Row[]) {
  await save(db, "policy_decision", "policy-decision@1", inputs, { before, after }).catch(() => null);
}

/** Makes one rule the controlling rule for its subject. Other live rules for that subject become superseded (kept). */
export async function approveRule(formData: FormData) {
  const id = String(formData.get("rule_id") ?? "");
  const note = String(formData.get("note") ?? "").trim().slice(0, 500);
  const db = await createClient();
  const { data: rule, error } = await db.from("policy_rules").select("id, scope, subject, source_label, approval, approval_note, approved_at").eq("id", id).single();
  if (error || !rule) throw new Error("Rule not found");
  const { data: others } = await db.from("policy_rules").select("id, scope, subject, source_label, approval, approval_note, approved_at")
    .eq("scope", rule.scope).eq("subject", rule.subject).neq("id", id).in("approval", ["approved", "unresolved", "proposed"]);
  const when = new Date().toISOString();
  for (const o of (others ?? []) as Row[]) await setRow(db, o, { approval: "superseded" }, `Superseded ${today()}: you chose "${rule.source_label}".`);
  await setRow(db, rule as Row, { approval: "approved", approved_at: when }, `Approved by you in the app on ${today()}.${note ? ` ${note}` : ""}`);
  await log(db, { action: "approve", rule_id: id, scope: rule.scope, subject: rule.subject, note }, [rule as Row, ...((others ?? []) as Row[])], []);
  revalidatePath("/", "layout");
  redirect(`/policy?saved=${encodeURIComponent(`approved:${rule.subject}`)}`);
}

/** Rejects an open proposal. The row is kept (superseded, marked rejected); whatever controlled before still controls. */
export async function rejectRule(formData: FormData) {
  const id = String(formData.get("rule_id") ?? "");
  const note = String(formData.get("note") ?? "").trim().slice(0, 500);
  const db = await createClient();
  const { data: rule, error } = await db.from("policy_rules").select("id, scope, subject, source_label, approval, approval_note, approved_at").eq("id", id).single();
  if (error || !rule) throw new Error("Rule not found");
  if (rule.approval !== "unresolved" && rule.approval !== "proposed") throw new Error("Only an open proposal can be rejected");
  await setRow(db, rule as Row, { approval: "superseded" }, `Rejected by you on ${today()}.${note ? ` ${note}` : ""}`);
  await log(db, { action: "reject", rule_id: id, scope: rule.scope, subject: rule.subject, note }, [rule as Row], []);
  revalidatePath("/", "layout");
  redirect(`/policy?saved=${encodeURIComponent(`rejected:${rule.subject}`)}`);
}

/** Confirms the listed imported rules as your own (they were marked "approved" in the old archive, never by you). */
export async function confirmImported(formData: FormData) {
  const ids = formData.getAll("rule_id").map(String).filter(Boolean);
  if (!ids.length) throw new Error("Nothing to confirm");
  const db = await createClient();
  const { data: rows } = await db.from("policy_rules").select("id, scope, subject, source_label, approval, approval_note, approved_at").in("id", ids).eq("approval", "approved").is("approved_at", null);
  const when = new Date().toISOString();
  for (const r of (rows ?? []) as Row[]) await setRow(db, r, { approved_at: when }, `Confirmed by you in the app on ${today()} (imported from "${r.source_label}").`);
  await log(db, { action: "confirm_imported", ids }, (rows ?? []) as Row[], []);
  revalidatePath("/", "layout");
  redirect(`/policy?saved=${encodeURIComponent(`confirmed:${(rows ?? []).length}`)}`);
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
  if (!["company", "bucket"].includes(scope) || !subject) throw new Error("Choose what the rule applies to");
  if (!reason) throw new Error("Say why the rule is changing");
  const db = await createClient();
  const row: Record<string, unknown> = { scope, subject: scope === "company" ? subject.toUpperCase() : subject, source_label: "Your change in the app", source_date: today(), source_status: "user_entry", conditions: reason, approval: "proposed" };
  row.normal_low = pct(formData.get("normal_low"));
  row.normal_high = pct(formData.get("normal_high"));
  row.high_conviction_low = pct(formData.get("hc_low"));
  row.high_conviction_high = pct(formData.get("hc_high"));
  row.hard_max = pct(formData.get("hard_max"));
  if (row.hard_max === null && row.normal_high === null) throw new Error("Enter at least a maximum or a normal range");
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
