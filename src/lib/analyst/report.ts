/**
 * Analyst reports you upload (Morningstar, Schwab, CFRA, a bank's note...), read once by the AI and compared with
 * the app's own research (2026-11-11, from the ChatGPT NOW review: analyst comparison, valuation reconciliation,
 * consensus estimate history).
 *
 * What is kept: who wrote it and when, the rating, the price target or fair value (and its basis), the estimates
 * by year with the page they are on, the main points and risks, and a reconciliation with the research in use:
 * where they agree, where they differ and why, and what the app's research does not cover.
 * The reports are licensed to you: they stay private in the app and are never put in a shared research PDF.
 * An analyst view is an input to weigh, never a reason on its own. Pure functions here; job.ts reads and stores.
 */
import type { ParsedConclusion } from "@/lib/research/valuation";

export const ANALYST_VERSION = "analyst-report@1";
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export type Estimate = { metric: string; period: string; value: number; unit: string; page: number | null };
export type AnalystReport = {
  symbol: string; publisher: string | null; analyst: string | null; reportDate: string | null;
  rating: string | null; priceTarget: number | null; fairValue: number | null; valueBasis: string | null; horizon: string | null;
  priceAtReport: number | null; uncertainty: string | null; moat: string | null;
  estimates: Estimate[]; points: string[]; risks: string[];
  comparison: { agree: string[]; differ: string[]; notInResearch: string[]; summary: string };
  /** Whether the report holds information that should change the app's conclusion (missing on reports read before 2026-11-13). */
  bearing?: { changesView: "yes" | "maybe" | "no"; why: string } | null;
  fileName: string; documentId: string | null; pages: number | null;
  costUsd: number; model: string; at: string;
};

const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v.replace(/[$,]/g, ""))) ? Number(v.replace(/[$,]/g, "")) : null);
const list = (v: unknown, n: number, each = 300) => (Array.isArray(v) ? v : []).map((x) => str(x, each)).filter((x): x is string => !!x).slice(0, n);

/** What the app's research in use says, for the comparison. */
export function researchFacts(symbol: string, p: ParsedConclusion | null, asOf: string | null, price: number | null): string {
  if (!p) return `${symbol}: no research on file in the app. Compare only with the current price${price ? ` ($${price.toFixed(2)})` : ""}.`;
  return [
    `${symbol} research in use (dated ${asOf ?? "unknown"}): action ${p.action ?? "—"}, confidence ${p.confidence ?? "—"}.`,
    p.thesis ? `Thesis: ${p.thesis.slice(0, 800)}` : null,
    p.scenarios.length ? `Scenario values${p.horizonDate ? ` by ${p.horizonDate}` : ""}: ${p.scenarios.map((s) => `${s.name} $${s.value} (${Math.round(s.probability * 100)}%)`).join(", ")}${p.weightedValue ? `; weighted $${p.weightedValue}` : ""}. These are future prices at the horizon date, not today's fair value.` : null,
    p.referencePrice ? `Price when researched: $${p.referencePrice}${p.referenceDate ? ` (${p.referenceDate})` : ""}.` : null,
    price ? `Price now: $${price.toFixed(2)}.` : null,
  ].filter(Boolean).join("\n");
}

export const ANALYST_SYSTEM = `You read one analyst research report (a PDF the investor is licensed to use) for a private long-term investor, and compare it with the app's own research. Use only what the report says; never fill a gap from memory. Give the page number for each estimate. Keep the reply short enough to finish: at most 20 estimates, chosen as revenue, EPS, free cash flow and operating margin for the next three fiscal years first; never copy whole financial tables.

Reply with exactly one JSON object in a \`\`\`json fenced block and nothing else:
{
  "symbol": string,                    // the ticker the report covers
  "publisher": string | null,          // e.g. "Morningstar", "CFRA", "Argus"
  "analyst": string | null,
  "report_date": "YYYY-MM-DD" | null,
  "rating": string | null,             // as the report states it, e.g. "4 stars", "Buy", "Outperform"
  "price_target": number | null,       // a price target, if the report gives one
  "fair_value": number | null,         // a fair value estimate (today's intrinsic value), if it gives one
  "value_basis": string | null,        // how the target or fair value is set (DCF, multiple, ...), one sentence
  "horizon": string | null,            // e.g. "12 months" for a target
  "price_at_report": number | null,
  "uncertainty": string | null,        // e.g. Morningstar "High"
  "moat": string | null,               // e.g. Morningstar "Wide"
  "estimates": [{ "metric": "revenue" | "eps" | "free_cash_flow" | "operating_margin" | "other: <name>", "period": "FY2026" | "Q4 FY2026" | ..., "value": number, "unit": "USD bn" | "USD" | "%" | ..., "page": number | null }],
  "points": string[],                  // the report's main reasons, at most 5
  "risks": string[],                   // its main risks, at most 5
  "comparison": {
    "agree": string[],                 // where the report and the app's research agree
    "differ": string[],                // where they differ, with the numbers on both sides and the likely reason (different horizon, growth or margin assumption, discount rate...)
    "not_in_research": string[],       // facts or risks in the report that the app's research does not cover
    "summary": string                  // 2-3 sentences: how the report's value compares with the app's, after putting them on the same basis (a 12-month target or today's fair value is not a price several years out)
  },
  "bearing": {
    "changes_view": "yes" | "maybe" | "no", // should the app's research conclusion (action, scenario values or weights, price levels) change because of FACTS in this report it does not have? A different opinion, rating, discount rate or longer horizon alone is "no".
    "why": string                      // one or two sentences: which facts, and what they would change; or why the conclusion stands
  }
}`;

/** Checks and shapes the model's reply. Pure. Returns null when there is nothing usable. */
export function parseReport(raw: unknown, ctx: { symbol: string; fileName: string; documentId: string | null; costUsd: number; model: string; now: Date }): AnalystReport | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const c = (r.comparison ?? {}) as Record<string, unknown>;
  const estimates = (Array.isArray(r.estimates) ? r.estimates : []).flatMap((e) => {
    const x = (e ?? {}) as Record<string, unknown>;
    const value = num(x.value), metric = str(x.metric, 60), period = str(x.period, 30);
    if (value === null || !metric || !period) return [];
    return [{ metric: metric.toLowerCase(), period: period.toUpperCase().replace(/\s+/g, " "), value, unit: str(x.unit, 20) ?? "", page: num(x.page) }];
  }).slice(0, 25);
  const date = str(r.report_date, 10);
  const out: AnalystReport = {
    symbol: (str(r.symbol, 10) ?? ctx.symbol).toUpperCase(),
    publisher: str(r.publisher, 80), analyst: str(r.analyst, 120), reportDate: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    rating: str(r.rating, 60), priceTarget: num(r.price_target), fairValue: num(r.fair_value), valueBasis: str(r.value_basis, 300), horizon: str(r.horizon, 40),
    priceAtReport: num(r.price_at_report), uncertainty: str(r.uncertainty, 40), moat: str(r.moat, 40),
    estimates, points: list(r.points, 5), risks: list(r.risks, 5),
    comparison: { agree: list(c.agree, 6), differ: list(c.differ, 6, 500), notInResearch: list(c.not_in_research, 6), summary: str(c.summary, 900) ?? "" },
    bearing: (() => { const b = (r.bearing ?? {}) as Record<string, unknown>; const v = str(b.changes_view, 8)?.toLowerCase(); return v === "yes" || v === "maybe" || v === "no" ? { changesView: v, why: str(b.why, 500) ?? "" } : null; })(),
    fileName: ctx.fileName, documentId: ctx.documentId, pages: null, costUsd: ctx.costUsd, model: ctx.model, at: ctx.now.toISOString(),
  };
  if (!out.rating && out.priceTarget === null && out.fairValue === null && !out.estimates.length && !out.points.length) return null;
  return out;
}

/**
 * Estimate history: the same metric and period across your reports, oldest first, so a raised or cut estimate shows.
 * Only numbers in the same unit are lined up. Pure.
 */
export function estimateHistory(reports: Pick<AnalystReport, "publisher" | "reportDate" | "at" | "estimates">[]): { key: string; metric: string; period: string; unit: string; points: { date: string; publisher: string | null; value: number }[] }[] {
  const m = new Map<string, { metric: string; period: string; unit: string; points: { date: string; publisher: string | null; value: number }[] }>();
  for (const r of reports) for (const e of r.estimates) {
    const key = `${e.metric}|${e.period}|${e.unit}`;
    const row = m.get(key) ?? { metric: e.metric, period: e.period, unit: e.unit, points: [] };
    row.points.push({ date: r.reportDate ?? r.at.slice(0, 10), publisher: r.publisher, value: e.value });
    m.set(key, row);
  }
  return [...m.entries()].map(([key, v]) => ({ key, ...v, points: v.points.sort((a, b) => a.date.localeCompare(b.date)) }))
    .sort((a, b) => b.points.length - a.points.length || a.metric.localeCompare(b.metric) || a.period.localeCompare(b.period));
}

/** The analyst reports as context for a research run: secondary views to weigh, never verified facts. */
export function analystContext(reports: AnalystReport[], since: string | null): string {
  const use = reports.filter((r) => !since || (r.reportDate ?? r.at.slice(0, 10)) >= since).slice(0, 3);
  if (!use.length) return "";
  return use.map((r) => [
    `${r.publisher ?? "Analyst"}${r.reportDate ? ` (${r.reportDate})` : ""}: ${[r.rating, r.fairValue !== null ? `fair value $${r.fairValue}` : null, r.priceTarget !== null ? `target $${r.priceTarget}${r.horizon ? ` (${r.horizon})` : ""}` : null, r.valueBasis].filter(Boolean).join("; ")}`,
    r.points.length ? `Main points: ${r.points.join(" | ")}` : null,
    r.risks.length ? `Risks: ${r.risks.join(" | ")}` : null,
    r.comparison.notInResearch.length ? `Facts in the report the earlier research lacked: ${r.comparison.notInResearch.join(" | ")}` : null,
    r.comparison.differ.length ? `Where it differs from the earlier research: ${r.comparison.differ.join(" | ")}` : null,
  ].filter(Boolean).join("\n")).join("\n\n").slice(0, 6000);
}

/** True when the report was uploaded after the research was saved, so that research has not read it. */
export function uploadedAfter(r: AnalystReport, researchSavedAt: string | null): boolean {
  if (!researchSavedAt) return true;
  const t = Date.parse(researchSavedAt.replace(" ", "T").replace(/\+00$/, "Z"));
  return !Number.isFinite(t) || Date.parse(r.at) > t;
}

/** Reports uploaded after the research was saved whose facts may change the conclusion: these make an update worthwhile.
 *  The upload time counts, not the report's own date: a report dated before the research but uploaded after it was never read. */
export function analystEvidence(reports: AnalystReport[], researchSavedAt: string): { label: string; filed: string; category: string }[] {
  return reports
    .map((r) => ({ r, b: bearingOf(r) }))
    .filter(({ r, b }) => uploadedAfter(r, researchSavedAt) && b && b.changesView !== "no")
    .map(({ r, b }) => ({ label: `Analyst report: ${r.publisher ?? r.fileName}${b!.why ? ` (${b!.why.slice(0, 160)})` : ""}`, filed: r.at.slice(0, 10), category: "analyst" }));
}

/** The report's bearing on the conclusion. Reports read before the bearing question existed count as "maybe" when they list facts the research lacked. */
export function bearingOf(r: AnalystReport): { changesView: "yes" | "maybe" | "no"; why: string } | null {
  if (r.bearing) return r.bearing;
  const n = r.comparison.notInResearch;
  return n.length ? { changesView: "maybe", why: `it has ${n.length} fact${n.length === 1 ? "" : "s"} the research lacked, e.g. ${n[0].replace(/\s*\(p\.[^)]*\)/g, "").slice(0, 120)}` } : null;
}
