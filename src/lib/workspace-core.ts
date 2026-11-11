/** The investor's workspace, built from the database. No Next-only imports, so background jobs can use it too. */
import { loadReviews, withReviews, type ReviewAnnotations } from "@/lib/research/review";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BENCHMARKS, dayChangePct, getQuotes, type Quote } from "@/lib/market/quotes";
import { isMarketOpen } from "@/lib/market/hours";
import { withSchwabQuotes } from "@/lib/schwab/market";
import { buildPortfolio, type CashConfirmation, type LedgerEntry, type PlannedTransfer, type PortfolioView, type SnapshotInput } from "@/lib/portfolio/engine";
import { readPolicy, type Policy , AGE_REMINDER_DAYS } from "@/lib/policy/limits";
import { policyFromRules, type PolicyRuleRow } from "@/lib/policy/rules";
import { toResearchRecord, type FilingCheckInfo, type ResearchRecord, type VersionRow } from "@/lib/research/records";
import { evaluateAlerts, type Alert } from "@/lib/alerts/rules";
import { computeExposure, type ExposureReport } from "@/lib/exposure/engine";
import { checkLimits, type LimitCheck } from "@/lib/exposure/limits";
import { preferenceFromRow, type CapitalPreference } from "@/lib/decision/currentPortfolio";

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
  /** Latest 2- and 10-year Treasury yields (FRED, from the last market snapshot): the risk-free alternative. */
  yields: Yields;
  /** Transfers between your accounts you recorded as planned and have not cancelled. */
  transfers: PlannedTransfer[];
  /** Your standing limit for moving savings to the brokerage when an opportunity justifies it (null when not set). */
  capitalPreference: CapitalPreference | null;
  /** Sector, industry, country and theme exposure with ETF look-through, and the exposure limits checked against it. */
  exposure: ExposureReport;
  exposureLimits: LimitCheck[];
};

export type Yields = { y2: { value: number; date: string } | null; y10: { value: number; date: string } | null };

export async function loadYields(db: SupabaseClient): Promise<Yields> {
  const { data } = await db.from("model_runs").select("outputs, computed_at").eq("kind", "market_snapshot").order("computed_at", { ascending: false }).limit(1);
  const macro = (data?.[0]?.outputs as { macro?: { id: string; value: number | null; date: string }[] } | undefined)?.macro ?? [];
  const pick = (id: string) => {
    const m = Array.isArray(macro) ? macro.find((x) => x.id === id) : undefined;
    return m && typeof m.value === "number" ? { value: m.value, date: m.date } : null;
  };
  return { y2: pick("DGS2"), y10: pick("DGS10") };
}

/** Latest snapshot per account, with positions. */
export async function loadSnapshots(db: SupabaseClient): Promise<SnapshotInput[]> {
  const { data: accounts } = await db.from("accounts").select("id, name, account_role");
  // One query per account, run together rather than one after another.
  const latest = await Promise.all(
    (accounts ?? []).map(async (a) => {
      const { data: snaps } = await db
        .from("holding_snapshots")
        .select("id, as_of, source_kind, total_value, cash_value, positions(symbol, quantity, price, market_value, cost_basis)")
        .eq("account_id", a.id)
        .order("as_of", { ascending: false })
        .limit(1);
      return { a, s: snaps?.[0] };
    }),
  );
  const out: SnapshotInput[] = [];
  for (const { a, s } of latest) {
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
  const [{ data }, checks] = await Promise.all([
    db.from("companies")
      .select("symbol, name, watchlist_status, pipeline_stage, pipeline_note, stage_updated_at, screen, screened_at, research_versions(id, research_as_of, created_at, completeness, origin, is_current, conclusion)")
      .order("symbol"),
    loadFilingChecks(db).catch(() => new Map<string, FilingCheckInfo>()),
  ]);
  const reviews = await loadReviews(db).catch(() => new Map<string, ReviewAnnotations>());
  return (data ?? []).map((c) =>
    toResearchRecord(c.symbol, c.name, c.watchlist_status, withReviews((c.research_versions ?? []) as VersionRow[], reviews), {
      stage: c.pipeline_stage ?? "idea", note: c.pipeline_note ?? null, stageUpdatedAt: c.stage_updated_at ?? null, screen: c.screen ?? null, screenedAt: c.screened_at ?? null,
    }, checks.get(c.symbol) ?? null),
  );
}

/** Latest SEC filing check per company, so research labels can say whether new filings were read. */
export async function loadFilingChecks(db: SupabaseClient): Promise<Map<string, FilingCheckInfo>> {
  const { data } = await db.from("model_runs").select("computed_at, inputs, outputs").eq("kind", "research_filing_check").order("computed_at", { ascending: false }).limit(200);
  const out = new Map<string, FilingCheckInfo>();
  for (const row of data ?? []) {
    const sym = String((row.inputs as { symbol?: string })?.symbol ?? "").toUpperCase();
    if (!sym || out.has(sym)) continue;
    const o = row.outputs as { status?: string; statusReason?: string; document?: { form: string; filed: string } | null; findings?: { material: boolean; text: string }[] } | null;
    out.set(sym, { at: row.computed_at as string, status: o?.status ?? "unknown", reason: o?.statusReason ?? "", document: o?.document ? { form: o.document.form, filed: o.document.filed } : null, material: (o?.findings ?? []).filter((f) => f.material).map((f) => f.text) });
  }
  return out;
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

/** Planned transfers (model_runs kind "planned_transfer"), minus any you cancelled ("planned_transfer_cancel"). */
export async function loadTransfers(db: SupabaseClient): Promise<PlannedTransfer[]> {
  const { data } = await db.from("model_runs").select("id, kind, inputs, computed_at").in("kind", ["planned_transfer", "planned_transfer_cancel"]).order("computed_at");
  const rows = (data ?? []) as { id: string; kind: string; inputs: Record<string, unknown>; computed_at: string }[];
  const cancelled = new Set(rows.filter((r) => r.kind === "planned_transfer_cancel").map((r) => String(r.inputs?.transfer_id ?? "")));
  return rows.filter((r) => r.kind === "planned_transfer" && !cancelled.has(r.id)).map((r) => ({
    id: r.id, fromAccountId: String(r.inputs.from_account_id ?? ""), toAccountId: String(r.inputs.to_account_id ?? ""),
    amount: Number(r.inputs.amount) || 0, date: String(r.inputs.date ?? r.computed_at.slice(0, 10)), note: (r.inputs.note as string | null) ?? null, createdAt: r.computed_at,
  })).filter((t) => t.amount > 0 && t.fromAccountId && t.toAccountId);
}

/** Cash balances you confirmed for an account (model_runs kind "cash_confirmation"), newest first. */
export async function loadCashConfirmations(db: SupabaseClient): Promise<CashConfirmation[]> {
  const { data } = await db.from("model_runs").select("outputs, computed_at").eq("kind", "cash_confirmation").order("computed_at", { ascending: false }).limit(50);
  return ((data ?? []) as { outputs: { account_id?: string; cash?: number; at?: string }; computed_at: string }[])
    .map((r) => ({ accountId: String(r.outputs?.account_id ?? ""), cash: Number(r.outputs?.cash), at: r.outputs?.at ?? r.computed_at }))
    .filter((c) => c.accountId && Number.isFinite(c.cash));
}

/** The newest standing capital preference (model_runs kind "capital_preference"). */
export async function loadCapitalPreference(db: SupabaseClient): Promise<CapitalPreference | null> {
  const { data } = await db.from("model_runs").select("outputs, computed_at").eq("kind", "capital_preference").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  return preferenceFromRow(data);
}

/** `liveQuotes`: overlay Schwab's real-time quotes when Schwab is connected (the alert checks); pages use the free quotes. */
export async function buildWorkspace(db: SupabaseClient, now = new Date(), opts: { liveQuotes?: boolean } = {}): Promise<Workspace> {
  const [{ data: auth }, snapshots, research, policy, ledger, yields, transfers, capitalPreference, cashConfirmations] = await Promise.all([db.auth.getClaims(), loadSnapshots(db), loadResearch(db), loadPolicy(db), loadLedger(db), loadYields(db).catch(() => ({ y2: null, y10: null })), loadTransfers(db).catch(() => []), loadCapitalPreference(db).catch(() => null), loadCashConfirmations(db).catch(() => [])]);
  const symbols = [...new Set([...snapshots.flatMap((s) => s.positions.map((p) => p.symbol.toUpperCase())), ...ledger.filter((t) => t.symbol).map((t) => t.symbol!.toUpperCase())])];
  const free = await getQuotes([...symbols, ...BENCHMARKS.map((b) => b.symbol)]);
  const quotes = opts.liveQuotes ? await withSchwabQuotes(db, free, [...symbols, ...BENCHMARKS.map((b) => b.symbol)]) : free;
  const roles: Record<string, string | null> = Object.fromEntries(Object.values(policy?.companies ?? {}).map((c) => [c.symbol, c.role]));
  const classifications = { ...roles, ...Object.fromEntries(research.filter((r) => r.current?.parsed.classification).map((r) => [r.symbol, r.current!.parsed.classification])) };
  const portfolio = buildPortfolio(snapshots, quotes, policy, classifications, ledger, now, cashConfirmations, capitalPreference?.maxTransfer ?? null);
  const benchmarks = BENCHMARKS.map((b) => ({ ...b, dayPct: dayChangePct(quotes.get(b.symbol)) }));
  const exposure = computeExposure(portfolio.holdings.map((h) => ({ symbol: h.symbol, value: h.value })), portfolio.cash, now);
  const exposureLimits = checkLimits(exposure, policy?.audit?.subjects.flatMap((s) => [...(s.approvedRow ? [s.approvedRow] : []), ...s.candidates]) ?? []);
  const alerts = [...evaluateAlerts({ portfolio, research, marketDayPct: benchmarks[0].dayPct, now, freshnessDays: AGE_REMINDER_DAYS, policy }), ...exposureAlerts(exposureLimits)];
  return { now, marketOpen: isMarketOpen(now), quotes, benchmarks, portfolio, research, policy, alerts, userId: auth?.claims?.sub ?? null, ledger, yields, transfers, capitalPreference, exposure, exposureLimits };
}

/** Alerts for APPROVED exposure limits only: a proposal is not policy yet, so it never raises an alert. */
export function exposureAlerts(checks: LimitCheck[]): Alert[] {
  return checks.filter((c) => c.status === "approved" && (c.state === "over_ceiling" || c.state === "review")).map((c) => ({
    id: `exposure-${c.subject}`, severity: c.state === "over_ceiling" ? ("high" as const) : ("medium" as const), symbol: null, kind: "over_limit" as const,
    title: `${c.label} ${c.state === "over_ceiling" ? "is over its ceiling" : "is above its review level"}`, detail: c.message, href: "/portfolio/exposure",
  }));
}


function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
