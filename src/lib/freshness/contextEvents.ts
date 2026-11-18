/**
 * Loads when each input of a saved analysis last changed, as ContextEvents for outdatedVerdict.
 * Read-only: it never touches the analyses themselves.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContextEvent } from "./outdated";

const SUBJECT_LABEL: Record<string, string> = { protected_reserve: "Protected reserve" };

export async function loadContextEvents(db: SupabaseClient, since: string): Promise<ContextEvent[]> {
  const [rules, snaps, txns, research] = await Promise.all([
    db.from("policy_rules").select("scope, subject, value, approved_at").gt("approved_at", since),
    db.from("holding_snapshots").select("as_of, imported_at, accounts(name, account_role)").gt("imported_at", since),
    db.from("transactions").select("created_at, accounts(name)").gt("created_at", since),
    db.from("research_versions").select("created_at, is_current, companies(symbol)").gt("created_at", since).eq("is_current", true),
  ]);
  const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
  const out: ContextEvent[] = [];
  for (const r of rules.data ?? []) {
    const name = SUBJECT_LABEL[r.subject as string] ?? String(r.subject);
    const value = r.subject === "protected_reserve" && r.value != null ? ` set to $${Number(r.value).toLocaleString("en-US")}` : " limit approved";
    out.push({ kind: "policy", at: r.approved_at as string, label: `${name}${value}` });
  }
  for (const s of snaps.data ?? []) {
    const a = one(s.accounts as { name: string; account_role: string } | { name: string; account_role: string }[] | null);
    const cash = a?.account_role === "cash" || a?.account_role === "protected_savings";
    out.push({ kind: cash ? "cash" : "holdings", at: s.imported_at as string, label: `${a?.name ?? "An account"}: ${cash ? "balance" : "statement"} as of ${String(s.as_of).slice(0, 10)} added` });
  }
  for (const t of txns.data ?? []) {
    const a = one(t.accounts as { name: string } | { name: string }[] | null);
    out.push({ kind: "transactions", at: t.created_at as string, label: `${a?.name ?? "An account"}: trades or deposits recorded` });
  }
  for (const v of research.data ?? []) {
    const c = one(v.companies as { symbol: string } | { symbol: string }[] | null);
    out.push({ kind: "research", at: v.created_at as string, label: `New research on ${c?.symbol ?? "a company"}` });
  }
  return out;
}
