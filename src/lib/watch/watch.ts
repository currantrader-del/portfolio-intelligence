/**
 * "Watch for me": which alerts are worth a phone notification, and what the notification says.
 * Pure. The checks themselves are the app's existing alert rules (src/lib/alerts) plus price bands
 * for researched ideas; this decides what is new since the last notification and formats it.
 */
import { moveCaveat, type Alert, type Severity } from "@/lib/alerts/rules";
import type { ResearchRecord } from "@/lib/research/records";
import { zoneFor } from "@/lib/research/valuation";
import type { Quote } from "@/lib/market/quotes";

export const WATCH_VERSION = "watch@1";

/** Kinds worth interrupting the investor for. Staleness and data gaps wait for the morning brief. */
const PUSH_KINDS = new Set<Alert["kind"]>(["big_move", "price_zone", "over_limit", "review", "event"]);
const PUSH_SEVERITY = new Set<Severity>(["high", "medium"]);

/** Price-band crossings and big moves for companies researched but not held. */
export function ideaAlerts(research: ResearchRecord[], held: Set<string>, quotes: Map<string, Quote>): Alert[] {
  const out: Alert[] = [];
  for (const r of research) {
    if (held.has(r.symbol) || !r.current) continue;
    const q = quotes.get(r.symbol);
    if (!q) continue;
    const p = r.current.parsed;
    const z = zoneFor(p.zones, q.price);
    const ref = p.referencePrice ? zoneFor(p.zones, p.referencePrice) : null;
    // A buy band only alerts when it comes from research you approved; unapproved bands are context, not prompts.
    if (r.authoritative !== false && z && ref && z.label !== ref.label && /add|buy/i.test(z.action)) {
      out.push({ id: `idea-zone:${r.symbol}:${z.label}`, severity: "medium", symbol: r.symbol, kind: "price_zone", title: `${r.symbol} at $${q.price.toFixed(2)} reached your "${z.label}" band`, detail: `Research action for this band: ${z.action}. Set at $${p.referencePrice} on ${p.referenceDate}.`, href: `/research/${r.symbol}` });
    }
    const day = q.prevClose ? q.price / q.prevClose - 1 : null;
    if (day !== null && Math.abs(day) >= 0.07) {
      out.push({ id: `idea-move:${r.symbol}`, severity: "medium", symbol: r.symbol, kind: "big_move", title: `${r.symbol} ${day > 0 ? "+" : ""}${(day * 100).toFixed(1)}% today`, detail: `A company you researched moved sharply. ${moveCaveat(day)}`, href: `/research/${r.symbol}` });
    }
  }
  return out;
}

/**
 * The key that decides "already told you": filings once ever, price bands once per band per day,
 * moves and limits once per day.
 */
export function alertKey(a: Alert, etDay: string): string {
  if (a.kind === "event") return `event|${a.id}`;
  return `${etDay}|${a.id}`;
}

export function selectNew(alerts: Alert[], sent: Set<string>, etDay: string): { alert: Alert; key: string }[] {
  const seen = new Set<string>();
  return alerts
    .filter((a) => PUSH_KINDS.has(a.kind) && PUSH_SEVERITY.has(a.severity) && (a.kind !== "event" || a.timing === "recent"))
    .map((alert) => ({ alert, key: alertKey(alert, etDay) }))
    .filter(({ key }) => !sent.has(key) && !seen.has(key) && seen.add(key));
}

/** The phone notification: a title, a short body (the AI's one-liner when there is one) and a priority. */
export function formatPush(items: Alert[], summary: string | null): { title: string; body: string; priority: "high" | "default" } {
  const high = items.some((a) => a.severity === "high");
  const title = items.length === 1 ? items[0].title : `${items.length} things need a look: ${[...new Set(items.map((a) => a.symbol).filter(Boolean))].slice(0, 4).join(", ")}`;
  const lines = items.slice(0, 5).map((a) => `• ${a.title}`);
  const body = [summary?.trim(), items.length > 1 || !summary ? lines.join("\n") : null].filter(Boolean).join("\n\n").slice(0, 900);
  return { title: title.slice(0, 120), body, priority: high ? "high" : "default" };
}

/** A topic name nobody can guess: anyone who knows it can read the notifications. */
export function newTopic(rand: () => number = Math.random): string {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  return `pi-${Array.from({ length: 20 }, () => abc[Math.floor(rand() * abc.length)]).join("")}`;
}
