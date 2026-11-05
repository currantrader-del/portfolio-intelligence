import "server-only";
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { BENCHMARKS, dayChangePct, getQuotes, type Quote } from "@/lib/market/quotes";
import { isMarketOpen } from "@/lib/market/hours";
import { buildPortfolio, type PortfolioView, type SnapshotInput } from "@/lib/portfolio/engine";
import { readPolicy, type Policy } from "@/lib/policy/limits";
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
};

/** Latest snapshot per account, with positions. */
export async function loadSnapshots(db: SupabaseClient): Promise<SnapshotInput[]> {
  const { data: accounts } = await db.from("accounts").select("id, name, account_role");
  const out: SnapshotInput[] = [];
  for (const a of accounts ?? []) {
    const { data: snaps } = await db
      .from("holding_snapshots")
      .select("id, as_of, total_value, cash_value, positions(symbol, quantity, price, market_value, cost_basis)")
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

export async function loadPolicy(db: SupabaseClient): Promise<Policy | null> {
  const { data } = await db.from("policies").select("version, rules").eq("is_current", true).limit(1);
  const p = data?.[0];
  return p ? readPolicy(p.version, p.rules as Record<string, unknown>) : null;
}

export async function buildWorkspace(db: SupabaseClient, now = new Date()): Promise<Workspace> {
  const [{ data: auth }, snapshots, research, policy] = await Promise.all([db.auth.getUser(), loadSnapshots(db), loadResearch(db), loadPolicy(db)]);
  const symbols = [...new Set(snapshots.flatMap((s) => s.positions.map((p) => p.symbol.toUpperCase())))];
  const quotes = await getQuotes([...symbols, ...BENCHMARKS.map((b) => b.symbol)]);
  const roles: Record<string, string | null> = Object.fromEntries(Object.values(policy?.companies ?? {}).map((c) => [c.symbol, c.role]));
  const classifications = { ...roles, ...Object.fromEntries(research.filter((r) => r.current?.parsed.classification).map((r) => [r.symbol, r.current!.parsed.classification])) };
  const portfolio = buildPortfolio(snapshots, quotes, policy, classifications);
  const benchmarks = BENCHMARKS.map((b) => ({ ...b, dayPct: dayChangePct(quotes.get(b.symbol)) }));
  const alerts = evaluateAlerts({ portfolio, research, marketDayPct: benchmarks[0].dayPct, now, freshnessDays: policy?.researchFreshnessDays });
  return { now, marketOpen: isMarketOpen(now), quotes, benchmarks, portfolio, research, policy, alerts, userId: auth.user?.id ?? null };
}

/** One workspace per request, shared by the layout and the page. */
export const getWorkspace = cache(async () => buildWorkspace(await createClient()));

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
