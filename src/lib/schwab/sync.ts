/**
 * Copies your Schwab balances and positions into the portfolio as a new snapshot (source "schwab_api").
 * Earlier statements and snapshots stay as they are; the newest snapshot wins, and trades you recorded
 * before it no longer roll forward on top of it. Every sync is logged (model_runs kind "schwab_sync").
 * Full account numbers are never stored: an account is matched by its last four digits.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { save } from "@/lib/intel/jobs";
import { SCHWAB_VERSION, connection, schwabGet } from "./client";

type SchwabPosition = { longQuantity?: number; shortQuantity?: number; averagePrice?: number; marketValue?: number; instrument?: { symbol?: string; assetType?: string } };
type SchwabAccount = { securitiesAccount?: { accountNumber?: string; type?: string; positions?: SchwabPosition[]; currentBalances?: { cashBalance?: number; liquidationValue?: number } } };

export type MappedAccount = {
  last4: string; total: number | null; cash: number;
  positions: { symbol: string; quantity: number; price: number | null; marketValue: number; costBasis: number | null }[];
  skipped: string[];
};

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Pure: Schwab's account list to snapshots. Money-market and other cash equivalents count as cash. Short positions are skipped and reported. */
export function mapAccounts(body: unknown): MappedAccount[] {
  return (Array.isArray(body) ? (body as SchwabAccount[]) : []).flatMap((a) => {
    const s = a.securitiesAccount;
    if (!s?.accountNumber) return [];
    let cash = n(s.currentBalances?.cashBalance) ?? 0;
    const skipped: string[] = [];
    const positions: MappedAccount["positions"] = [];
    for (const p of s.positions ?? []) {
      const symbol = (p.instrument?.symbol ?? "").replace(/\s+/g, "").toUpperCase();
      const mv = n(p.marketValue) ?? 0;
      if (p.instrument?.assetType === "CASH_EQUIVALENT") { cash += mv; continue; }
      if ((n(p.shortQuantity) ?? 0) > 0) { skipped.push(`${symbol} (short position)`); continue; }
      const q = n(p.longQuantity) ?? 0;
      if (!symbol || q <= 0) continue;
      const avg = n(p.averagePrice);
      positions.push({ symbol, quantity: q, price: q ? r2(mv / q) : null, marketValue: r2(mv), costBasis: avg !== null ? r2(avg * q) : null });
    }
    return [{ last4: s.accountNumber.slice(-4), total: n(s.currentBalances?.liquidationValue), cash: r2(cash), positions, skipped }];
  });
}

export type SyncResult = { ok: boolean; at: string; synced: { account: string; positions: number; total: number | null; cash: number }[]; unmatched: number; skipped: string[]; error: string | null };

/**
 * Matches each Schwab account to one of your brokerage accounts: by its last four digits when the account
 * has them on file, otherwise the only Schwab brokerage account you have. Anything unmatched is reported, not guessed.
 */
export async function syncSchwab(db: SupabaseClient, now = new Date()): Promise<SyncResult> {
  const out: SyncResult = { ok: false, at: now.toISOString(), synced: [], unmatched: 0, skipped: [], error: null };
  try {
    const conn = await connection(db, now);
    if (!conn.connected) throw new Error(conn.configured ? "Schwab is not connected (or the weekly sign-in expired)" : "Schwab is not set up yet");
    const mapped = mapAccounts(await schwabGet(db, "/trader/v1/accounts?fields=positions"));
    const { data: accts } = await db.from("accounts").select("id, name, institution, account_role, external_ref_hint");
    const brokers = ((accts ?? []) as { id: string; name: string; institution: string; account_role: string; external_ref_hint: string | null }[])
      .filter((a) => a.account_role === "taxable_brokerage" && /schwab|thinkorswim/i.test(`${a.institution} ${a.name}`));
    for (const m of mapped) {
      const byHint = brokers.filter((a) => (a.external_ref_hint ?? "").replace(/\D/g, "").slice(-4) === m.last4);
      const target = byHint.length === 1 ? byHint[0] : mapped.length === 1 && brokers.length === 1 ? brokers[0] : null;
      if (!target) { out.unmatched++; continue; }
      const ins = await db.from("holding_snapshots").insert({ account_id: target.id, as_of: now.toISOString(), source_kind: "schwab_api", total_value: m.total, cash_value: m.cash }).select("id").single();
      if (ins.error) throw new Error(`Could not save the snapshot: ${ins.error.message}`);
      if (m.positions.length) {
        const { error } = await db.from("positions").insert(m.positions.map((p) => ({ snapshot_id: ins.data.id, symbol: p.symbol, quantity: p.quantity, price: p.price, market_value: p.marketValue, cost_basis: p.costBasis })));
        if (error) throw new Error(`Could not save positions: ${error.message}`);
      }
      out.synced.push({ account: target.name, positions: m.positions.length, total: m.total, cash: m.cash });
      out.skipped.push(...m.skipped);
    }
    out.ok = out.synced.length > 0;
    if (!out.ok) out.error = mapped.length ? "No Schwab account matched one of your brokerage accounts" : "Schwab returned no accounts";
  } catch (e) {
    out.error = (e as Error).message.slice(0, 300);
  }
  await save(db, "schwab_sync", SCHWAB_VERSION, { trigger: "sync" }, out).catch(() => null);
  return out;
}

export async function lastSync(db: SupabaseClient): Promise<SyncResult | null> {
  const { data } = await db.from("model_runs").select("outputs").eq("kind", "schwab_sync").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  return (data?.outputs as SyncResult | undefined) ?? null;
}
