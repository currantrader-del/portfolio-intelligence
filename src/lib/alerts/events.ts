/**
 * Event alerts from SEC filings: filings already made (to review) and results expected soon
 * (estimated dates). Each is a prompt to review, never a trade or a conclusion.
 */
import type { Alert } from "@/lib/alerts/rules";
import { getFilings, type Filing, type FilingCategory, type FilingsResult } from "@/lib/market/sec";
import { isEtf } from "@/lib/portfolio/classify";

export const EVENT_WINDOW = { upcomingDays: 14, recentDays: 7 };

const TITLE: Partial<Record<FilingCategory, (sym: string, f: Filing) => string>> = {
  periodic: (s, f) => `${s} filed its ${f.form === "10-K" || f.form === "20-F" ? "annual" : "quarterly"} report`,
  results: (s) => `${s} announced results`,
  financing: (s, f) => `${s} filed ${f.form.startsWith("8-K") ? `an 8-K: ${f.description}` : `a ${f.description.toLowerCase()}`}`,
  material_event: (s, f) => `${s}: ${f.description}`,
  registration: (s, f) => `${s} filed a ${f.description.toLowerCase()}`,
  resale: (s) => `${s} filed a resale prospectus`,
};

/**
 * Splits filings into what has already been filed (to review) and what is expected (future,
 * estimated). Form type and item codes say what kind of document it is; they are never treated
 * as proof of dilution, financing terms or impact. Nothing here is above medium severity.
 */
export function eventAlerts(filings: Map<string, FilingsResult>, now: Date): Alert[] {
  const out: Alert[] = [];
  const day = 86400000;
  const today = now.toISOString().slice(0, 10);
  const recentCut = new Date(now.getTime() - EVENT_WINDOW.recentDays * day).toISOString().slice(0, 10);
  for (const [symbol, f] of filings) {
    const href = `/research/${symbol}`;
    const recent = f.filings.filter((x) => x.filed >= recentCut && x.filed <= today);
    for (const x of recent) {
      const title = TITLE[x.category]?.(symbol, x);
      if (!title) continue;
      out.push({
        id: `ev-${x.category}-${symbol}-${x.accession ?? x.filed}`,
        severity: x.category === "periodic" || x.category === "results" || x.category === "financing" ? "medium" : "low",
        symbol, kind: "event", timing: "recent", title,
        detail: `${x.form} filed ${x.filed}. ${x.note}`,
        href, source: { form: x.form, filed: x.filed, url: x.url },
      });
    }
    const hasResults = recent.some((x) => x.category === "periodic" || x.category === "results");
    if (!hasResults && f.nextEarningsEstimate && f.nextEarningsEstimate >= today) {
      const d = Math.round((new Date(f.nextEarningsEstimate + "T12:00:00Z").getTime() - now.getTime()) / day);
      if (d <= EVENT_WINDOW.upcomingDays) out.push({ id: `ev-upcoming-${symbol}`, severity: "low", symbol, kind: "event", timing: "upcoming", title: `${symbol} results expected around ${f.nextEarningsEstimate} (estimated)`, detail: `Estimated as about 91 days after its last results filing (${f.lastEarnings?.filed}); not a confirmed date. Decide beforehand what result would change your view.`, href });
    }
  }
  return out;
}

/** Fetches filings for directly held stocks (not ETFs) and returns event alerts. */
export async function loadEventAlerts(symbols: string[], now: Date): Promise<{ alerts: Alert[]; filings: Map<string, FilingsResult> }> {
  const stocks = [...new Set(symbols)].filter((s) => !isEtf(s)).slice(0, 15);
  const res = await Promise.all(stocks.map(async (s) => [s, await getFilings(s, now)] as const));
  const filings = new Map(res.filter((r): r is readonly [string, FilingsResult] => !("error" in r[1])));
  return { alerts: eventAlerts(filings, now), filings };
}

/**
 * Filings for every stock the decision engine may rank: held stocks plus researched names not yet owned.
 * A symbol whose filings fail to load is simply absent, which the engine reads as "could not check".
 */
export async function loadDecisionFilings(ws: { portfolio: { holdings: { symbol: string }[] }; research: { symbol: string; current: unknown }[]; now: Date }): Promise<Map<string, FilingsResult>> {
  const symbols = [...new Set([...ws.portfolio.holdings.map((h) => h.symbol), ...ws.research.filter((r) => r.current).map((r) => r.symbol)])].filter((s) => !isEtf(s)).slice(0, 20);
  const res = await Promise.all(symbols.map(async (s) => [s, await getFilings(s, ws.now).catch((e: Error) => ({ error: e.message }))] as const));
  return new Map(res.filter((r): r is readonly [string, FilingsResult] => !("error" in r[1])));
}
