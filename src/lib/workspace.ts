import "server-only";
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { BENCHMARKS, dayChangePct, getQuotes, type Quote } from "@/lib/market/quotes";
import { isMarketOpen } from "@/lib/market/hours";
import { buildPortfolio, type LedgerEntry, type PortfolioView, type SnapshotInput } from "@/lib/portfolio/engine";
import { readPolicy, type Policy } from "@/lib/policy/limits";
import { policyFromRules, type PolicyRuleRow } from "@/lib/policy/rules";
import { toResearchRecord, type ResearchRecord, type VersionRow } from "@/lib/research/records";
import { evaluateAlerts, type Alert } from "@/lib/alerts/rules";

export type Workspace = {
  now: Date;
  marketOpen: boolean;
  quotes: Map<string, Quote>;
  benchmarks: { symbol: string; label: string; dayPct: number | null }[];
  portfolio: PortfolioView;
  research: ResearchRecord[];
  policy: Policy | null;
  alerts: Alert[];
  userId: string | null;
  ledger: LedgerEntry[];
};

/** Latest snapshot per account, with positions. */
export async function loadSnapshots(db: SupabaseClient): Promise<SnapshotInput[]> {
  const { data: accounts } = await db.from("accounts").select("id, name, account_role");
  const out: SnapshotInput[] = [];
  for (const a of accounts ?? []) {
    const { data: snaps } = await db
      .from("holding_snapshots")
      .select("id, as_of, source_kind, total_value, cash_value, positions(symbol, quantity, price, market_value, cost_basis)")
      .eq("account_id", a.id)
      .order("as_of", { ascending: false })
      .limit(1);
    const s = snaps?.[0];
    if (!s) continue;
    out.push({
      accountId: a.id,
      accountName: a.name,
      accountRole: a.account_role,
      asOf: s.as_of,
      sourceKind: s.source_kind,
      totalValue: num(s.total_value),
      cashValue: num(s.cash_value),
      positions: (s.positions ?? []).map((p: Record<string, unknown>) => ({
        symbol: String(p.symbol),
        quantity: num(p.quantity),
        price: num(p.price),
        marketValue: num(p.market_value),
        costBasis: num(p.cost_basis),
      })),
    });
  }
  return out;
}

export async function loadResearch(db: SupabaseClient): Promise<ResearchRecord[]> {
  const { data } = await db
    .from("companies")
    .select("symbol, name, watchlist_status, research_versions(id, research_as_of, completeness, origin, is_current, conclusion)")
    .order("symbol");
  return (data ?? []).map((c) => toResearchRecord(c.symbol, c.name, c.watchlist_status, (c.research_versions ?? []) as VersionRow[]));
}

/**
 * The policy the engines use. Versioned rules (policy_rules) win when they exist; the imported
 * policy document still supplies each company's role, which decides its bucket.
 */
export async function loadPolicy(db: SupabaseClient): Promise<Policy | null> {
  const [{ data: docs }, { data: rules }] = await Promise.all([
    db.from("policies").select("version, rules").eq("is_current", true).limit(1),
    db.from("policy_rules").select("*").order("created_at"),
  ]);
  const doc = docs?.[0];
  const legacy = doc ? readPolicy(doc.version, doc.rules as Record<string, unknown>) : null;
  if (!rules?.length) return legacy;
  const p = policyFromRules(rules as PolicyRuleRow[], legacy ? `${legacy.version}, versioned rules` : "Versioned rules");
  for (const [sym, c] of Object.entries(p.companies)) c.role = legacy?.companies[sym]?.role ?? null;
  for (const [sym, c] of Object.entries(legacy?.companies ?? {})) if (!p.companies[sym]) p.companies[sym] = { ...c, hardMax: null, status: "none" };
  return p;
}

export async function loadLedger(db: SupabaseClient): Promise<LedgerEntry[]> {
  const { data } = await db.from("transactions").select("account_id, trade_date, kind, symbol, quantity, price, amount").order("trade_date");
  return (data ?? []).map((t) => ({
    accountId: t.account_id, tradeDate: t.trade_date, kind: t.kind, symbol: t.symbol,
    quantity: num(t.quantity), price: num(t.price), amount: num(t.amount) ?? 0,
  }));
}

export async function buildWorkspace(db: SupabaseClient, now = new Date()): Promise<Workspace> {
  const [{ data: auth }, snapshots, research, policy, ledger] = await Promise.all([db.auth.getUser(), loadSnapshots(db), loadResearch(db), loadPolicy(db), loadLedger(db)]);
  const symbols = [...new Set([...snapshots.flatMap((s) => s.positions.map((p) => p.symbol.toUpperCase())), ...ledger.filter((t) => t.symbol).map((t) => t.symbol!.toUpperCase())])];
  const quotes = await getQuotes([...symbols, ...BENCHMARKS.map((b) => b.symbol)]);
  const roles: Record<string, string | null> = Object.fromEntries(Object.values(policy?.companies ?? {}).map((c) => [c.symbol, c.role]));
  const classifications = { ...roles, ...Object.fromEntries(research.filter((r) => r.current?.parsed.classification).map((r) => [r.symbol, r.current!.parsed.classification])) };
  const portfolio = buildPortfolio(snapshots, quotes, policy, classifications, ledger, now);
  const benchmarks = BENCHMARKS.map((b) => ({ ...b, dayPct: dayChangePct(quotes.get(b.symbol)) }));
  const alerts = evaluateAlerts({ portfolio, research, marketDayPct: benchmarks[0].dayPct, now, freshnessDays: policy?.researchFreshnessDays, policy });
  return { now, marketOpen: isMarketOpen(now), quotes, benchmarks, portfolio, research, policy, alerts, userId: auth.user?.id ?? null, ledger };
}

/** One workspace per request, shared by the layout and the page. */
export const getWorkspace = cache(async () => buildWorkspace(await createClient()));

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
