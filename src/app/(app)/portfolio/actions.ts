"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const money = (v: FormDataEntryValue | null) => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};
const isoDate = (v: FormDataEntryValue | null) => {
  const s = String(v ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/** Records today's savings balance as a dated manual entry. Earlier entries stay as history. */
export async function saveSavings(formData: FormData) {
  const balance = money(formData.get("balance"));
  const date = isoDate(formData.get("as_of"));
  const name = String(formData.get("name") ?? "Savings").trim().slice(0, 80) || "Savings";
  if (!(balance >= 0) || !date) throw new Error("Enter a balance and a date");
  const db = await createClient();
  let { data: acct } = await db.from("accounts").select("id").eq("account_role", "cash").eq("name", name).maybeSingle();
  if (!acct) {
    const ins = await db.from("accounts").insert({ name, institution: "Bank (entered by you)", account_role: "cash" }).select("id").single();
    if (ins.error) throw ins.error;
    acct = ins.data;
  }
  const { error } = await db.from("holding_snapshots").insert({
    account_id: acct!.id, as_of: `${date}T23:59:00Z`, source_kind: "manual", total_value: balance, cash_value: balance,
  });
  if (error) throw error;
  revalidatePath("/", "layout");
  redirect("/portfolio/reconcile?saved=savings");
}

const KINDS = ["buy", "sell", "deposit", "withdrawal", "dividend", "interest", "fee", "transfer_in", "transfer_out"] as const;

/** Adds one trade or cash flow after a statement, so holdings roll forward. */
export async function recordTransaction(formData: FormData) {
  const kind = String(formData.get("kind")) as (typeof KINDS)[number];
  const accountId = String(formData.get("account_id") ?? "");
  const date = isoDate(formData.get("trade_date"));
  if (!KINDS.includes(kind) || !accountId || !date) throw new Error("Choose an account, a type and a date");
  const symbol = String(formData.get("symbol") ?? "").trim().toUpperCase() || null;
  const quantity = money(formData.get("quantity"));
  const price = money(formData.get("price"));
  const note = String(formData.get("note") ?? "").slice(0, 500) || null;
  let amount: number;
  if (kind === "buy" || kind === "sell") {
    if (!symbol || !(quantity > 0) || !(price >= 0)) throw new Error("A trade needs a symbol, quantity and price");
    amount = (kind === "buy" ? -1 : 1) * Math.round(quantity * price * 100) / 100;
  } else {
    const raw = Math.abs(money(formData.get("amount")));
    if (!(raw > 0)) throw new Error("Enter an amount");
    amount = ["withdrawal", "fee", "transfer_out"].includes(kind) ? -raw : raw;
  }
  const db = await createClient();
  const { error } = await db.from("transactions").insert({
    account_id: accountId, trade_date: date, kind, symbol, quantity: kind === "buy" || kind === "sell" ? quantity : null,
    price: kind === "buy" || kind === "sell" ? price : null, amount, source_kind: "manual", note,
  });
  if (error) throw error;
  revalidatePath("/", "layout");
  redirect("/portfolio/reconcile?saved=trade");
}
