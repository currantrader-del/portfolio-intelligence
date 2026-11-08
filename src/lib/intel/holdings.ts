/**
 * The holdings desk: what is new for the companies actually held, read by code from the records
 * themselves, with no web search and no model call:
 *   - SEC EDGAR filings in the last 14 days (primary source: the filing index itself);
 *   - the company research records: the approved current version AND any newer version, so a
 *     refresh in progress is never hidden behind the older approved record;
 *   - the latest stored filing check (research_filing_check) and its refresh decision.
 * Read only: nothing here writes research, and nothing here is a buy or sell signal. A new filing
 * or a large price move can only ever ask for a research review.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getFilings, type Filing } from "../market/sec";
import type { DeskResult, Item, Source } from "./desks";
import { DESK_VERSION } from "./desks";
import { usableVersion } from "../research/records";
import { AUTHORITY_LABEL, authorityOf, isAuthoritative } from "../research/standing";
import type { PortfolioContext } from "./synthesis";

export const FILING_WINDOW_DAYS = 14;
/** Buckets that hold single companies (the rest are funds, which have no company filings). */
const COMPANY_BUCKETS = /individual stocks|growth sleeve|single compan/i;

export function companySymbols(p: PortfolioContext): string[] {
  return p.holdings.filter((h) => COMPANY_BUCKETS.test(h.bucket)).map((h) => h.symbol);
}

type Version = { id: string; research_as_of: string; completeness: string; origin: string; is_current: boolean; conclusion: Record<string, unknown> | null };
export type ResearchState = {
  symbol: string; name: string | null;
  current: Version | null; newer: Version[]; versions?: number;
  filingCheck: { id: string; at: string; status: string; reason: string; document: { form: string; filed: string; periodEnd: string | null; indexUrl: string } | null; material: string[]; refreshLevel: string | null } | null;
};

const action = (v: Version | null) => (v?.conclusion && typeof v.conclusion.action === "string" ? (v.conclusion.action as string) : null);
const reason = (v: Version | null) => (v?.conclusion && typeof v.conclusion.status_reason === "string" ? (v.conclusion.status_reason as string) : null);
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const NOT_A_SIGNAL = "This is not a buy or sell signal; at most it calls for a research review.";

/** Filing items: pure, tested. A filing is a primary source; its listing on EDGAR is the evidence. */
export function filingItems(symbol: string, company: string, filings: Filing[], now: Date, weight: number | null, retrievedAt: string, source: string): Item[] {
  const since = new Date(now.getTime() - FILING_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return filings.filter((f) => f.filed >= since).map((f) => {
    const what = f.isEarnings ? "earnings results" : f.description || f.category;
    const src: Source = { url: f.url, title: `${company} ${f.form} filed ${f.filed}`, publisher: "U.S. Securities and Exchange Commission (EDGAR)", published: f.filed, checked: true };
    const periodic = /^(10-Q|10-K|20-F|40-F)/.test(f.form);
    return {
      headline: `${symbol}: ${f.form} filed ${f.filed}${what ? ` (${what})` : ""}`,
      detail: `${company} filed a ${f.form} with the SEC on ${f.filed}${f.reportDate ? ` for the period ending ${f.reportDate}` : ""}.${f.items.length ? ` Items: ${f.items.join("; ")}.` : ""} ${f.note}`.trim(),
      kind: "verified",
      significance: f.isEarnings || periodic ? "high" : /financing|offering|registration/i.test(f.category) ? "high" : "medium",
      sources: [src],
      portfolio: `${weight != null ? `Held at ${pct(weight)} of the portfolio. ` : ""}${NOT_A_SIGNAL}`,
      unsourced: false,
      period: f.reportDate,
      check: { status: "primary", url: f.url, found: [], missing: [], note: `listed in SEC EDGAR submissions (${source})`, retrievedAt },
    } satisfies Item;
  });
}

/** Research-record items: the approved version, anything newer, and the latest filing check. Pure, tested. */
export function researchItems(r: ResearchState, weight: number | null, now: Date, freshDays = 120): Item[] {
  const out: Item[] = [];
  const page: Source = { url: `/research/${r.symbol}`, title: `${r.symbol} research record`, publisher: "Portfolio Intelligence research record", published: null, checked: true };
  const held = weight != null ? `Held at ${pct(weight)} of the portfolio. ` : "";
  const cur = r.current;
  const newest = r.newer[0] ?? null;
  const curAuthority = cur ? authorityOf({ ...cur, conclusion: cur.conclusion ?? {} }, now) : null;
  if (cur && !isAuthoritative(curAuthority)) {
    out.push({
      headline: `${r.symbol}: no approved research (the record in use is ${AUTHORITY_LABEL[curAuthority!].toLowerCase()}, dated ${cur.research_as_of})`,
      detail: `The record in use${action(cur) ? ` (${action(cur)})` : ""} was set automatically and the investor never approved it, so it is context only: no adds, buy zones or research-based targets come from it.${newest ? ` A newer version dated ${newest.research_as_of} (${newest.completeness}) is on file and also not approved yet.` : ""}`,
      kind: "verified", significance: "medium", sources: [{ ...page, published: cur.research_as_of }], portfolio: `${held}${NOT_A_SIGNAL}`, unsourced: false, period: cur.research_as_of,
      check: { status: "primary", url: page.url, found: [], missing: [], note: "read from the stored research versions", retrievedAt: now.toISOString() },
    });
  } else if (newest && !cur) {
    out.push({
      headline: `${r.symbol}: no approved research; latest version dated ${newest.research_as_of}${action(newest) ? ` (${action(newest)})` : ""}`,
      detail: `${r.versions ?? r.newer.length} research version(s) on file, none marked approved. The latest is ${newest.completeness}, dated ${newest.research_as_of}. Its conclusions are not an approved basis for decisions until one version is approved.`,
      kind: "verified", significance: "medium", sources: [{ ...page, published: newest.research_as_of }], portfolio: `${held}${NOT_A_SIGNAL}`, unsourced: false, period: newest.research_as_of,
      check: { status: "primary", url: page.url, found: [], missing: [], note: "read from the stored research versions", retrievedAt: now.toISOString() },
    });
  } else if (newest) {
    out.push({
      headline: `${r.symbol}: research update in progress, dated ${newest.research_as_of}${action(newest) ? ` (${action(newest)})` : ""}`,
      detail: `A newer research version (${newest.completeness}, ${newest.origin.replace(/_/g, " ")}, dated ${newest.research_as_of}) exists and is not yet approved. ${reason(newest) ?? ""} ${cur ? `The approved version is dated ${cur.research_as_of}${action(cur) ? ` with the call ${action(cur)}` : ""}; it stays on file unchanged, and its conclusions should be treated as under review until the update is finished.` : "No version is approved."}`.replace(/\s+/g, " ").trim(),
      kind: "verified", significance: "high", sources: [{ ...page, published: newest.research_as_of }], portfolio: `${held}${NOT_A_SIGNAL}`, unsourced: false, period: newest.research_as_of,
      check: { status: "primary", url: page.url, found: [], missing: [], note: "read from the stored research versions", retrievedAt: now.toISOString() },
    });
  } else if (cur) {
    const age = Math.floor((now.getTime() - new Date(`${cur.research_as_of}T00:00:00Z`).getTime()) / 86400000);
    if (age > freshDays) out.push({
      headline: `${r.symbol}: research is ${age} days old`,
      detail: `The approved research is dated ${cur.research_as_of}${action(cur) ? ` (${action(cur)})` : ""}, more than ${freshDays} days ago. A reminder to check what has been filed since, not a rule that it is wrong.`,
      kind: "verified", significance: "medium", sources: [{ ...page, published: cur.research_as_of }], portfolio: `${held}${NOT_A_SIGNAL}`, unsourced: false, period: cur.research_as_of,
      check: { status: "primary", url: page.url, found: [], missing: [], note: "read from the stored research versions", retrievedAt: now.toISOString() },
    });
  }
  const fc = r.filingCheck;
  if (fc) {
    const doc = fc.document;
    out.push({
      headline: `${r.symbol}: filing check ${fc.status}${doc ? ` against the ${doc.form} filed ${doc.filed}` : ""}`,
      detail: `${fc.reason}${fc.material.length ? ` Material changes found: ${fc.material.join(" ")}` : ""} Checked ${fc.at.slice(0, 10)}.`.trim(),
      kind: "calculation", significance: fc.status === "CURRENT" ? "low" : "high",
      sources: doc ? [{ url: doc.indexUrl, title: `${r.symbol} ${doc.form} (period ending ${doc.periodEnd ?? "unknown"})`, publisher: "U.S. Securities and Exchange Commission (EDGAR)", published: doc.filed, checked: true }] : [page],
      portfolio: `${held}${NOT_A_SIGNAL}`, unsourced: false, period: doc?.periodEnd ?? null,
      check: { status: "primary", url: doc?.indexUrl ?? page.url, found: [], missing: [], note: "figures read from the filing's XBRL by the stored filing check", retrievedAt: fc.at },
    });
  }
  return out;
}

export async function loadResearch(db: SupabaseClient, symbols: string[]): Promise<ResearchState[]> {
  if (!symbols.length) return [];
  const [{ data: cos }, { data: checks }] = await Promise.all([
    db.from("companies").select("symbol, name, research_versions(id, research_as_of, completeness, origin, is_current, conclusion)").in("symbol", symbols),
    db.from("model_runs").select("id, computed_at, inputs, outputs").eq("kind", "research_filing_check").in("inputs->>symbol", symbols).order("computed_at", { ascending: false }).limit(50),
  ]);
  return (cos ?? []).map((c) => {
    const versions = ((c.research_versions ?? []) as Version[]).filter((v) => usableVersion({ is_current: v.is_current, conclusion: v.conclusion ?? {} })).sort((a, b) => b.research_as_of.localeCompare(a.research_as_of));
    const current = versions.find((v) => v.is_current) ?? null;
    const newer = versions.filter((v) => !v.is_current && (!current || v.research_as_of > current.research_as_of));
    const row = (checks ?? []).find((k) => (k.inputs as { symbol?: string }).symbol === c.symbol);
    const o = row?.outputs as { status: string; statusReason: string; document: NonNullable<ResearchState["filingCheck"]>["document"]; findings?: { material: boolean; text: string }[]; refresh?: { level: string } } | undefined;
    return {
      symbol: c.symbol as string, name: (c.name as string | null) ?? null, current, newer, versions: versions.length,
      filingCheck: row && o ? { id: row.id as string, at: row.computed_at as string, status: o.status, reason: o.statusReason, document: o.document ?? null, material: (o.findings ?? []).filter((f) => f.material).map((f) => f.text), refreshLevel: o.refresh?.level ?? null } : null,
    };
  });
}

export async function runHoldingsDesk(db: SupabaseClient, portfolio: PortfolioContext, now: Date): Promise<DeskResult> {
  const t0 = Date.now();
  const symbols = companySymbols(portfolio);
  const weight = new Map(portfolio.holdings.map((h) => [h.symbol, h.weight]));
  const requests: NonNullable<DeskResult["requests"]> = [];
  const problems: string[] = [];
  const items: Item[] = [];
  const research = await loadResearch(db, symbols);
  requests.push({ kind: "page", ms: Date.now() - t0, detail: `research records and filing checks for ${symbols.join(", ")}`, ok: true });
  await Promise.all(symbols.map(async (sym) => {
    const s0 = Date.now();
    const f = await getFilings(sym, now);
    const ok = !("error" in f);
    requests.push({ kind: "page", ms: Date.now() - s0, detail: `SEC EDGAR filings for ${sym}${ok ? "" : `: ${f.error}`}`, ok });
    if (!ok) { problems.push(`${sym}: ${f.error}`); return; }
    items.push(...filingItems(sym, f.company, f.filings, now, weight.get(sym) ?? null, f.fetchedAt, f.source));
  }));
  for (const r of research) items.push(...researchItems(r, weight.get(r.symbol) ?? null, now));
  const order = new Map(symbols.map((s, i) => [s, i]));
  const rank = { high: 0, medium: 1, low: 2 } as const;
  items.sort((a, b) => rank[a.significance] - rank[b.significance] || (order.get(a.headline.split(":")[0]) ?? 99) - (order.get(b.headline.split(":")[0]) ?? 99));
  return {
    version: DESK_VERSION, desk: "holdings", title: "Holdings: filings and research", generatedAt: new Date().toISOString(), model: "",
    items, calendar: [], uncertainties: problems.length ? [`Filings could not be read for: ${problems.map((p) => p.split(":")[0]).join(", ")}`] : [],
    searches: 0, pagesReturned: 0, problems, usage: { input: 0, output: 0, searches: 0 },
    status: "ok", error: null, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, requests,
  };
}
