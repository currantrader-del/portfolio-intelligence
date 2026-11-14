/**
 * Logs the morning's recommendation with the data it was based on, so the evaluation can check later
 * what the app said, what it knew at that moment and whether it was right. Code only; no AI cost.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildWorkspace } from "@/lib/workspace-core";
import { loadDecisionFilings } from "@/lib/alerts/events";
import { currentDecisionFor } from "@/lib/decision/currentPortfolio";
import { save } from "@/lib/intel/jobs";
import { EVAL_VERSION } from "./log";

export async function logRecommendation(db: SupabaseClient, ctx: { trigger: string; answerId?: string | null; briefingId?: string | null }) {
  const ws = await buildWorkspace(db);
  const filings = await loadDecisionFilings(ws).catch(() => new Map());
  const d = currentDecisionFor(ws, filings);
  const cd = ws.portfolio.cashDetail;
  const out = {
    at: ws.now.toISOString(), trigger: ctx.trigger, answerId: ctx.answerId ?? null, briefingId: ctx.briefingId ?? null,
    headline: d.headline, why: d.why, allocations: d.allocations, funding: d.funding,
    alternatives: d.alternatives.map((a) => ({ key: a.key, symbol: a.symbol, title: a.title, status: a.status })),
    capital: { schwabCash: cd.spendableNow, schwabCashConfirmed: cd.investingAccount?.confirmed ?? false, transferable: d.money.transferable.amount, savings: cd.savings, savingsAsOf: cd.savingsAsOf },
    holdingsAsOf: ws.portfolio.oldestHoldingsAsOf, holdingsQuality: ws.portfolio.quality.status,
    research: ws.research.filter((r) => r.current).map((r) => ({ symbol: r.symbol, versionId: r.current!.id, asOf: r.current!.research_as_of, grade: r.authoritative ? (r.approval === "provisional" ? "open_questions" : "complete") : "preliminary", action: r.current!.parsed.action })),
    prices: Object.fromEntries([...ws.quotes].map(([s, q]) => [s, { price: q.price, asOf: q.asOf }])),
  };
  return save(db, "eval_recommendation", EVAL_VERSION, { trigger: ctx.trigger, day: out.at.slice(0, 10) }, out);
}
