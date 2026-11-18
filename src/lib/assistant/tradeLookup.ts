/**
 * "I bought VOO today, was that recorded?" answered from the app's own records, with no AI call and no charge
 * (2026-11-18: Brendan was charged $0.08 for a wrong "no trade recorded" when Schwab had synced both buys).
 * Pure: reads the ledger (manual, CSV and Schwab-synced trades) and the holdings the app already loaded.
 */
import type { LedgerEntry, PortfolioView } from "@/lib/portfolio/engine";

const TRADE = /\b(bought|sold|buy|sell|sale|purchas\w*|trade[sd]?|order(ed)?)\b/i;
const RECORDED = /\b(record\w*|show(s|ed|ing)? up|sync\w*|in the app|logged|register\w*|picked up|went through|go through|reflect\w*|see (it|them|that)|captured|count(ed)?|track\w*)\b/i;

/** A short question asking whether a trade made it into the app. Anything longer or analytical goes to the assistant. */
export function isTradeRecordQuestion(q: string): boolean {
  const t = q.trim();
  return t.length > 0 && t.length <= 200 && TRADE.test(t) && RECORDED.test(t) && !/\bshould\b|\bwhy\b|\bwhat if\b/i.test(t);
}

const etDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const SOURCE: Record<string, string> = { schwab_api: "synced from Schwab", manual: "entered by you", csv_import: "imported from a file", statement: "from a statement" };
const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shares = (n: number) => `${Number(n.toFixed(4))} share${n === 1 ? "" : "s"}`;
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function tradeRecordAnswer(q: string, ledger: LedgerEntry[], p: PortfolioView, now: Date): string {
  const today = etDay(now);
  const yesterday = etDay(new Date(now.getTime() - 864e5));
  const day = /\byesterday\b/i.test(q) ? yesterday : /\btoday\b|\bthis (morning|afternoon)\b/i.test(q) ? today : null;
  const from = day ?? etDay(new Date(now.getTime() - 7 * 864e5));
  const known = new Set([...p.holdings.map((h) => h.symbol), ...ledger.map((l) => l.symbol ?? "")].filter(Boolean));
  const asked = [...new Set((q.toUpperCase().match(/\b[A-Z]{1,5}\b/g) ?? []).filter((s) => known.has(s)))];
  const trades = ledger.filter((l) => (l.kind === "buy" || l.kind === "sell") && l.tradeDate >= from && (!day || l.tradeDate === day)).sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
  const when = day === today ? "today" : day === yesterday ? "yesterday" : "in the last 7 days";
  const schwab = p.accounts.filter((a) => a.sourceKind === "schwab_api").sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
  const synced = schwab ? `${schwab.name} last synced ${new Date(schwab.asOf).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET` : null;
  const line = (t: LedgerEntry) => `- ${t.kind === "buy" ? "Bought" : "Sold"} ${shares(t.quantity ?? 0)} of ${t.symbol}${t.price ? ` at ${money(t.price)}` : ""} (${money(t.amount)}), ${dayLabel(t.tradeDate)}, ${SOURCE[t.source ?? ""] ?? "recorded"}`;
  const found = asked.filter((s) => trades.some((t) => t.symbol === s));
  const missing = asked.filter((s) => !found.includes(s));
  const out: string[] = [];
  if (!trades.length) {
    out.push(`I don't see any trade recorded ${when}${asked.length ? ` for ${asked.join(" or ")}` : ""}.`);
    out.push(synced ? `${synced}. A trade placed after that shows up at the next sync (it runs during market hours and after the close), or you can add it on Portfolio > Reconcile.` : "Schwab isn't connected, so trades show up only when you add them on Portfolio > Reconcile or upload a statement.");
  } else {
    out.push(missing.length && !found.length ? `I don't see ${missing.join(" or ")} ${when}, but these trades are recorded:` : `Yes${missing.length ? `, partly` : ""}. Recorded ${when}:`);
    out.push(...trades.slice(0, 8).map(line));
    if (missing.length && found.length) out.push(`Not found ${when}: ${missing.join(", ")}.${synced ? ` ${synced}; a later trade shows up at the next sync.` : ""}`);
    const synced2 = trades.some((t) => t.source === "schwab_api");
    if (synced2) out.push(`Synced trades are already in your holdings and cash${synced ? ` (${synced})` : ""}.`);
  }
  const now2 = (found.length ? found : asked).map((s) => p.holdings.find((h) => h.symbol === s)).filter((h): h is NonNullable<typeof h> => !!h);
  if (now2.length) out.push(`You now hold ${now2.map((h) => `${shares(h.quantity)} of ${h.symbol} (${money(h.value)})`).join(" and ")}, all accounts.`);
  out.push("Answered from your records, no AI used, no charge.");
  return out.join("\n");
}
