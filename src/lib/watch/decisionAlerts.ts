/**
 * Phone alerts that matter to a decision (2026-11-09 direction). Pure: takes the research, holdings, quotes,
 * exposures and recent filings the watch job already loads, and returns at most one alert per company.
 *
 * Pushed:
 *   buy_opportunity   a company with a completed investigation (no open questions) is inside its researched buy
 *                     range, the research is current at this price, no unread filing is pending and there is room
 *                     under its limit
 *   approaching       within 5% of a researched buy range, or inside it but not yet actionable (and why)
 *   thesis_change     results, a periodic report or a financing filing for a company you own or researched
 *   urgent_risk       a held stock falls 10% or more against the market, or 7% with a filing the same day
 *   position_review   a held stock reaches the trim range of its completed investigation
 * Not pushed: plain daily moves, policy-limit reminders, stale-research reminders (the morning brief covers them).
 * Every alert says what changed, why it matters, the supported action, what is uncertain and when it was verified.
 */
import type { Alert } from "@/lib/alerts/rules";
import type { ResearchRecord } from "@/lib/research/records";
import { repriceCheck, zoneFor, type PriceZone } from "@/lib/research/valuation";
import { researchAgeDays } from "@/lib/research/records";
import { unresolvedFiling } from "@/lib/research/status";

export type PushCategory = "buy_opportunity" | "approaching" | "thesis_change" | "urgent_risk" | "position_review";
export const CATEGORY_LABEL: Record<PushCategory, string> = {
  urgent_risk: "Urgent risk",
  buy_opportunity: "Buy opportunity",
  thesis_change: "Material development",
  position_review: "Trim review",
  approaching: "Opportunity approaching",
};
const RANK: Record<PushCategory, number> = { urgent_risk: 0, buy_opportunity: 1, thesis_change: 2, position_review: 3, approaching: 4 };

export type DecisionAlert = {
  id: string; category: PushCategory; symbol: string; title: string;
  changed: string; why: string; action: string; uncertain: string; verified: string;
  href: string; priority: "high" | "default";
  /** How long a repeat of the same alert is held back, in days (0 = only once ever). */
  repeatAfterDays: number;
};

export type DecisionInputs = {
  research: ResearchRecord[];
  holdings: { symbol: string; price: number; priceSource: "quote" | "statement"; dayPct: number | null; weight: number }[];
  quotes: Map<string, { price: number; prevClose: number | null; asOf: string }>;
  headroom: Map<string, number>; // dollars of room under each company limit (missing = no limit set)
  marketDayPct: number | null;
  events: Alert[]; // "event" alerts from SEC filings (timing recent)
  now: Date;
};

const BUY = /\b(add|adds|buy|starter)\b/i;
const NOT_BUY = /\bno add\b|no new money|not a reason to add|\bhold the\b|\bwatch\b\.?$/i;
const TRIM = /\b(trim|exit|sell)\b/i;
export const isBuyZone = (z: PriceZone) => BUY.test(z.action) && !NOT_BUY.test(z.action);
export const isTrimZone = (z: PriceZone) => TRIM.test(z.action) && !isBuyZone(z);

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`;
const et = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
const short = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A quote older than this is not a basis for an actionable alert. */
export const QUOTE_FRESH_MIN = 45;

export function decisionAlerts(a: DecisionInputs): DecisionAlert[] {
  const out: DecisionAlert[] = [];
  const held = new Map(a.holdings.map((h) => [h.symbol, h]));
  const bySymbol = new Map(a.research.map((r) => [r.symbol, r]));

  // ---- Price against the research: buy, approaching, trim (completed investigations only) ----
  for (const r of a.research) {
    const v = r.current;
    if (!v || !r.authoritative) continue; // preliminary research never sets a buy or trim range
    const q = a.quotes.get(r.symbol);
    const h = held.get(r.symbol);
    const price = q?.price ?? (h?.priceSource === "quote" ? h.price : null);
    if (!price) continue;
    const quoteAt = q?.asOf ?? null;
    const fresh = !!quoteAt && a.now.getTime() - Date.parse(quoteAt) <= QUOTE_FRESH_MIN * 60_000;
    const verified = quoteAt ? `Price ${money(price)}, delayed quote ${et(quoteAt)}; research ${v.research_as_of}` : `Price ${money(price)}; research ${v.research_as_of}`;
    const zones = v.parsed.zones;
    const z = zoneFor(zones, price);
    const href = h ? `/decisions/review/${r.symbol}` : `/research/${r.symbol}`;
    if (z && isBuyZone(z)) {
      const blockers: string[] = [];
      if (r.approval === "provisional") blockers.push("the investigation still has open questions");
      const check = repriceCheck(v.parsed, price, researchAgeDays(r, a.now));
      if (!check.ok) blockers.push("the price is far from the research reference, so the valuation needs a refresh");
      const pending = unresolvedFiling(v.research_as_of, r.filingCheck);
      if (pending) blockers.push(`a filing has not been read into the research (${pending})`);
      const room = a.headroom.get(r.symbol);
      if (room === undefined) blockers.push("no position limit is set for it");
      else if (room <= 0) blockers.push("it is already at its limit");
      if (!fresh) blockers.push("the quote is not current");
      const ok = blockers.length === 0;
      out.push({
        id: `buy:${r.symbol}:${z.label}`, category: ok ? "buy_opportunity" : "approaching", symbol: r.symbol, href, priority: ok ? "high" : "default", repeatAfterDays: 7,
        title: ok ? `${r.symbol} is in its researched buy range (${z.label})` : `${r.symbol} is in its buy range (${z.label}), not yet actionable`,
        changed: `${r.symbol} trades at ${money(price)}, inside the ${z.label} range set by the ${v.research_as_of} investigation.`,
        why: `The research's action for this range: ${short(z.action, 220)}`,
        action: ok ? `Buy or add is supported, up to ${money(room!)} of room under its limit; see Decisions for the amount.` : `No buy yet: ${blockers.join("; ")}.`,
        uncertain: "Prices are delayed; the research's own conditions for this range still need checking before you act.",
        verified,
      });
      continue;
    }
    if (z && isTrimZone(z) && h) {
      out.push({
        id: `trim:${r.symbol}:${z.label}`, category: "position_review", symbol: r.symbol, href, priority: "default", repeatAfterDays: 7,
        title: `${r.symbol} reached its research trim range (${z.label})`,
        changed: `${r.symbol} trades at ${money(price)}, inside the ${z.label} range of the ${v.research_as_of} investigation.`,
        why: `The research's action for this range: ${short(z.action, 220)}`,
        action: "Review a trim; it is a prompt, not an order. Check taxes and the position's weight first.",
        uncertain: r.approval === "provisional" ? "The investigation still has open questions." : "Valuation ranges are estimates.",
        verified,
      });
      continue;
    }
    // Approaching: within 5% above the top of a buy range.
    const near = zones.filter(isBuyZone).filter((x) => Number.isFinite(x.high) && price >= x.high && price <= x.high * 1.05).sort((x, y) => y.high - x.high)[0];
    if (near) {
      out.push({
        id: `near:${r.symbol}:${near.label}`, category: "approaching", symbol: r.symbol, href, priority: "default", repeatAfterDays: 7,
        title: `${r.symbol} is ${((price / near.high - 1) * 100).toFixed(1)}% above its buy range (${near.label})`,
        changed: `${r.symbol} at ${money(price)} is within 5% of the ${near.label} range.`,
        why: `In that range the research says: ${short(near.action, 200)}`,
        action: "Nothing to do yet. Check the research's conditions so you are ready if it gets there.",
        uncertain: r.approval === "provisional" ? "The investigation still has open questions, so even inside the range new money waits for a targeted update." : "Prices can move through a range quickly; delayed quotes.",
        verified,
      });
    }
  }

  // ---- Urgent risk: a large fall against the market ----
  const filedToday = new Set(a.events.filter((e) => e.source?.filed === a.now.toISOString().slice(0, 10)).map((e) => e.symbol));
  for (const h of a.holdings) {
    if (h.dayPct === null || a.marketDayPct === null) continue;
    const rel = h.dayPct - a.marketDayPct;
    if (!(rel <= -0.10 || (rel <= -0.07 && filedToday.has(h.symbol)))) continue;
    const r = bySymbol.get(h.symbol);
    const q = a.quotes.get(h.symbol);
    out.push({
      id: `risk:${h.symbol}`, category: "urgent_risk", symbol: h.symbol, href: `/decisions/review/${h.symbol}`, priority: "high", repeatAfterDays: 1,
      title: `${h.symbol} ${pct(h.dayPct)} today, ${pct(rel)} against the market`,
      changed: `${h.symbol} fell ${pct(h.dayPct)} while the S&P 500 moved ${pct(a.marketDayPct)}.${filedToday.has(h.symbol) ? " It filed with the SEC today." : ""}`,
      why: `A fall this large against the market can mean the thesis changed. It is ${(h.weight * 100).toFixed(1)}% of your invested portfolio.${r?.current?.parsed.thesis ? ` Thesis on file: ${short(r.current.parsed.thesis, 160)}` : ""}`,
      action: "Review now: find the cause before doing anything. A fall alone is not a reason to sell or to buy.",
      uncertain: filedToday.has(h.symbol) ? "The filing has not been read yet." : "The cause is not verified; no filing today.",
      verified: q ? `Delayed quote ${et(q.asOf)}` : "Delayed quote",
    });
  }

  // ---- Material developments from filings ----
  for (const e of a.events) {
    if (e.kind !== "event" || e.timing !== "recent" || !e.symbol || e.severity === "low") continue;
    const r = bySymbol.get(e.symbol);
    const h = held.get(e.symbol);
    if (!h && !r?.current) continue;
    out.push({
      id: `filing:${e.id}`, category: "thesis_change", symbol: e.symbol, href: e.href, priority: "default", repeatAfterDays: 0,
      title: e.title,
      changed: `${e.detail}`,
      why: `${h ? `You hold ${e.symbol} (${(h.weight * 100).toFixed(1)}%).` : `${e.symbol} is on your researched watchlist.`} Results, reports and financings are where a thesis usually changes.${r?.current?.parsed.thesis ? ` Thesis on file: ${short(r.current.parsed.thesis, 160)}` : ""}`,
      action: "Review the filing against the thesis (Events page). No trade is supported until it is read.",
      uncertain: "The filing has not been read by the app; its terms and impact are unknown.",
      verified: e.source ? `SEC ${e.source.form} filed ${e.source.filed}` : "SEC filing",
    });
  }

  // One alert per company: the most important one.
  const best = new Map<string, DecisionAlert>();
  for (const x of out) {
    const cur = best.get(x.symbol);
    if (!cur || RANK[x.category] < RANK[cur.category]) best.set(x.symbol, x);
  }
  return [...best.values()].sort((x, y) => RANK[x.category] - RANK[y.category]);
}

/** Which alerts are new: never sent, or last sent longer ago than the alert's repeat window. */
export function selectDecisionAlerts(alerts: DecisionAlert[], lastSent: Map<string, string>, now: Date): DecisionAlert[] {
  return alerts.filter((x) => {
    const at = lastSent.get(x.id);
    if (!at) return true;
    if (x.repeatAfterDays === 0) return false;
    return now.getTime() - Date.parse(at) >= x.repeatAfterDays * 86_400_000 - 3_600_000;
  });
}

/** The phone notification: what changed, why it matters, the action, what is uncertain, when verified. */
export function formatDecisionPush(items: DecisionAlert[], summary: string | null = null): { title: string; body: string; priority: "high" | "default" } {
  const priority = items.some((x) => x.priority === "high") ? "high" : "default";
  if (items.length === 1) {
    const x = items[0];
    const body = [
      summary ? `${summary}` : null,
      `What changed: ${x.changed}`,
      `Why it matters: ${x.why}`,
      `Action: ${x.action}`,
      `Uncertain: ${x.uncertain}`,
      `Verified: ${x.verified}`,
    ].filter(Boolean).join("\n").slice(0, 1400);
    return { title: `${CATEGORY_LABEL[x.category]}: ${x.title}`.slice(0, 140), body, priority };
  }
  const title = `${items.length} alerts: ${items.slice(0, 4).map((x) => `${x.symbol} ${CATEGORY_LABEL[x.category].toLowerCase()}`).join(", ")}`;
  const body = items.slice(0, 5).map((x) => `• ${CATEGORY_LABEL[x.category]}: ${x.title}. ${x.action} (${x.verified})`).join("\n").slice(0, 1400);
  return { title: title.slice(0, 140), body: summary ? `${summary}\n\n${body}` : body, priority };
}
