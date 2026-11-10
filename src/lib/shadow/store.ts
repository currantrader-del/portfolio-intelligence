/**
 * Shadow tests in the database (model_runs, no new tables):
 *   shadow_test   the test as created: your portfolio at that moment, the proposed trades, the reason. Never edited.
 *   shadow_start  the start-close prices, written once by the morning run after that close (so later dividend or
 *                 split adjustments in the price feed can never change what the trades cost)
 *   shadow_close  you stopped tracking a test; it stays as history
 * Code only: no AI cost.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { save } from "@/lib/intel/jobs";
import { getHistories, type Bar } from "@/lib/market/history";
import type { Workspace } from "@/lib/workspace-core";
import {
  COST_RATE, SHADOW_VERSION, TAX_RATE, shadowReport, startDateFor, startFromHistory, symbolsOf,
  type ShadowClose, type ShadowReport, type ShadowStart, type ShadowTest,
} from "./shadow";

export type ShadowEntry = { test: ShadowTest; start: ShadowStart | null; close: ShadowClose | null };

export async function loadShadowTests(db: SupabaseClient): Promise<ShadowEntry[]> {
  const { data } = await db.from("model_runs").select("id, kind, computed_at, outputs").in("kind", ["shadow_test", "shadow_start", "shadow_close"]).order("computed_at", { ascending: true }).limit(500);
  const rows = (data ?? []) as { id: string; kind: string; computed_at: string; outputs: Record<string, unknown> }[];
  const starts = new Map<string, ShadowStart>(), closes = new Map<string, ShadowClose>();
  for (const r of rows) {
    if (r.kind === "shadow_start" && !starts.has(String(r.outputs.testId))) starts.set(String(r.outputs.testId), r.outputs as ShadowStart);
    if (r.kind === "shadow_close" && !closes.has(String(r.outputs.testId))) closes.set(String(r.outputs.testId), r.outputs as ShadowClose);
  }
  return rows.filter((r) => r.kind === "shadow_test").map((r) => {
    const test = { ...(r.outputs as Omit<ShadowTest, "id">), id: r.id } as ShadowTest;
    return { test, start: starts.get(r.id) ?? null, close: closes.get(r.id) ?? null };
  }).reverse();
}

/** Your portfolio as it is now: the frozen base every test starts from. */
export function baseFrom(ws: Workspace): ShadowTest["base"] {
  const brokers = ws.portfolio.accounts.filter((a) => a.role !== "cash" && a.role !== "protected_savings");
  return {
    holdings: ws.portfolio.holdings.map((h) => ({ symbol: h.symbol, qty: h.quantity, avgCost: h.costBasis !== null && h.quantity > 0 ? h.costBasis / h.quantity : null, price: h.price })),
    cash: ws.portfolio.cash,
    accountIds: brokers.map((a) => a.id),
    holdingsAsOf: ws.portfolio.oldestHoldingsAsOf,
    estimated: ws.portfolio.quality.status !== "verified",
  };
}

export async function createShadowTest(db: SupabaseClient, ws: Workspace, t: Omit<ShadowTest, "id" | "createdAt" | "startDate" | "base" | "assumptions">): Promise<string> {
  const test: Omit<ShadowTest, "id"> = { ...t, createdAt: ws.now.toISOString(), startDate: startDateFor(ws.now), base: baseFrom(ws), assumptions: { costRate: COST_RATE, taxRate: TAX_RATE } };
  return save(db, "shadow_test", SHADOW_VERSION, { origin: t.origin, symbols: t.trades.map((x) => x.symbol), plan_at: t.source.planAt }, test);
}

export async function closeShadowTest(db: SupabaseClient, testId: string, reason: string, now = new Date()) {
  const endDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  return save(db, "shadow_close", SHADOW_VERSION, { test_id: testId }, { testId, at: now.toISOString(), endDate, reason } satisfies ShadowClose);
}

const rangeFor = (startDate: string, now: Date) => {
  const days = (now.getTime() - Date.parse(`${startDate}T12:00:00Z`)) / 86_400_000;
  return days < 80 ? "3mo" : days < 170 ? "6mo" : days < 350 ? "1y" : days < 700 ? "2y" : "5y";
};

export async function historiesFor(entries: ShadowEntry[], now: Date): Promise<Map<string, Bar[]>> {
  if (!entries.length) return new Map();
  const oldest = entries.reduce((a, e) => (e.test.startDate < a ? e.test.startDate : a), entries[0].test.startDate);
  const h = await getHistories([...new Set(entries.flatMap((e) => symbolsOf(e.test)))], rangeFor(oldest, now));
  return new Map([...h].map(([s, x]) => [s, x.bars]));
}

/** Writes the start prices of every test whose start close has happened (the morning run calls this). */
export async function settleShadowStarts(db: SupabaseClient, now = new Date()): Promise<number> {
  const pending = (await loadShadowTests(db)).filter((e) => !e.start && !e.close);
  if (!pending.length) return 0;
  const hist = await historiesFor(pending, now);
  let n = 0;
  for (const e of pending) {
    const s = startFromHistory(e.test, hist, now);
    if (!s) continue;
    await save(db, "shadow_start", SHADOW_VERSION, { test_id: e.test.id }, s);
    n++;
  }
  return n;
}

/** Every test with its report. Before the morning run settles a start, the start is read from the price history. */
export async function shadowReports(db: SupabaseClient, ws: Workspace): Promise<(ShadowEntry & { report: ShadowReport })[]> {
  const entries = await loadShadowTests(db);
  const hist = await historiesFor(entries, ws.now);
  return entries.map((e) => ({ ...e, report: shadowReport(e.test, e.start ?? startFromHistory(e.test, hist, ws.now), ws.ledger, hist, e.close) }));
}
