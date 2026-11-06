/**
 * Event alerts from SEC filings: an earnings report coming up (estimated), results just out,
 * share offerings, and other material 8-Ks. Each is a prompt to review, never a trade.
 */
import type { Alert } from "@/lib/alerts/rules";
import { getFilings, type FilingsResult } from "@/lib/market/sec";
import { isEtf } from "@/lib/portfolio/classify";

export const EVENT_WINDOW = { upcomingDays: 10, recentDays: 5 };
const MATERIAL_ITEMS = new Set(["1.01", "1.02", "2.01", "2.03", "2.05", "2.06", "3.02", "5.02"]);
const OFFERING = new Set(["S-1", "S-3", "424B5"]);

export function eventAlerts(filings: Map<string, FilingsResult>, now: Date): Alert[] {
  const out: Alert[] = [];
  const day = 86400000;
  const today = now.toISOString().slice(0, 10);
  const recentCut = new Date(now.getTime() - EVENT_WINDOW.recentDays * day).toISOString().slice(0, 10);
  for (const [symbol, f] of filings) {
    const href = `/research/${symbol}`;
    const recent = f.filings.filter((x) => x.filed >= recentCut);
    const results = recent.find((x) => x.isEarnings || x.form === "10-Q" || x.form === "10-K");
    if (results) {
      out.push({ id: `ev-results-${symbol}`, severity: "medium", symbol, kind: "event", title: `${symbol} reported results`, detail: `${results.form} filed ${results.filed}: ${results.description}. Check whether it changes your research before acting.`, href });
    } else if (f.nextEarningsEstimate && f.nextEarningsEstimate >= today) {
      const d = Math.round((new Date(f.nextEarningsEstimate + "T12:00:00Z").getTime() - now.getTime()) / day);
      if (d <= EVENT_WINDOW.upcomingDays) out.push({ id: `ev-upcoming-${symbol}`, severity: "low", symbol, kind: "event", title: `${symbol} results expected around ${f.nextEarningsEstimate}`, detail: `Estimated from its last earnings filing (${f.lastEarnings?.filed}), not a confirmed date. Decide beforehand what result would change your view.`, href });
    }
    const offering = recent.find((x) => OFFERING.has(x.form) || x.items.includes("3.02"));
    if (offering) out.push({ id: `ev-offering-${symbol}`, severity: "high", symbol, kind: "event", title: `${symbol} filed for a share or debt offering`, detail: `${offering.form} on ${offering.filed}. New shares dilute existing holders; review the terms and your research.`, href });
    const material = recent.filter((x) => x.form.startsWith("8-K") && !x.isEarnings && x.items.some((i) => MATERIAL_ITEMS.has(i) && i !== "3.02"));
    for (const m of material.slice(0, 2)) out.push({ id: `ev-8k-${symbol}-${m.filed}`, severity: "medium", symbol, kind: "event", title: `${symbol}: ${m.description}`, detail: `8-K filed ${m.filed}. Read it to see whether it affects your thesis.`, href });
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
