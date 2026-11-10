/**
 * Monitoring rules. Each alert is a decision prompt with a reason, never a trade.
 * Pure: takes the portfolio, research and benchmarks, returns ranked alerts.
 */
import type { PortfolioView } from "@/lib/portfolio/engine";
import type { ResearchRecord } from "@/lib/research/records";
import { researchAgeDays } from "@/lib/research/records";
import { repriceCheck, zoneFor } from "@/lib/research/valuation";
import type { Policy } from "@/lib/policy/limits";

export type Severity = "high" | "medium" | "low";
export type Alert = {
  id: string;
  severity: Severity;
  symbol: string | null;
  kind: "price_zone" | "big_move" | "over_limit" | "bucket" | "research_stale" | "research_missing" | "holdings_stale" | "review" | "policy_conflict" | "data_missing" | "event";
  title: string;
  detail: string;
  href: string;
  /** Events only: "upcoming" is a future date (estimated unless confirmed); "recent" is already filed. */
  timing?: "upcoming" | "recent";
  /** Events only: the filing this came from. */
  source?: { form: string; filed: string; url: string };
};

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const STOCK_BUCKETS = new Set(["Quality/growth individual stocks", "Asymmetric/high-risk growth sleeve"]);

/** The caveat under a big move, worded for its direction: neither a drop nor a jump is a signal by itself. */
export function moveCaveat(dayPct: number): string {
  return dayPct < 0
    ? "A drop is not a buy signal by itself; check filings and news first."
    : "A jump is not a reason to buy or sell by itself; check filings and news first.";
}

export function evaluateAlerts(args: {
  portfolio: PortfolioView;
  research: ResearchRecord[];
  marketDayPct: number | null;
  now: Date;
  freshnessDays?: number;
  policy?: Policy | null;
}): Alert[] {
  const { portfolio, research, marketDayPct, now } = args;
  const freshDays = args.freshnessDays ?? 120;
  const out: Alert[] = [];

  for (const h of portfolio.holdings) {
    const r = research.find((x) => x.symbol === h.symbol);
    const v = r?.current;

    if (h.dayPct !== null && Math.abs(h.dayPct) >= 0.05) {
      const rel = marketDayPct !== null ? h.dayPct - marketDayPct : null;
      // A move that mostly tracks the market is context, not a decision.
      const withMarket = rel !== null && Math.abs(rel) < 0.03;
      out.push({
        id: `move:${h.symbol}`,
        severity: withMarket ? "low" : Math.abs(h.dayPct) >= 0.08 ? "high" : "medium",
        symbol: h.symbol,
        kind: "big_move",
        title: `${h.symbol} ${signed(h.dayPct)} today`,
        detail: rel !== null ? `${signed(rel)} versus the S&P 500${withMarket ? ", so mostly a market move" : ""}. ${moveCaveat(h.dayPct)}` : moveCaveat(h.dayPct),
        href: `/decisions/review/${h.symbol}`,
      });
    }

    if (v && h.priceSource === "quote") {
      const z = zoneFor(v.parsed.zones, h.price);
      const refZone = v.parsed.referencePrice ? zoneFor(v.parsed.zones, v.parsed.referencePrice) : null;
      if (z && refZone && z.label !== refZone.label) {
        const check = repriceCheck(v.parsed, h.price, researchAgeDays(r!, now), freshDays);
        const severity: Severity = /strong/i.test(z.action) ? "high" : /add|trim/i.test(z.action) ? "medium" : "low";
        out.push({
          id: `zone:${h.symbol}:${z.label}`,
          severity,
          symbol: h.symbol,
          kind: "price_zone",
          title: `${h.symbol} at $${h.price.toFixed(2)} is in your "${z.label}" band`,
          detail:
            `Research action for this band: ${z.action}.` +
            (check.ok ? "" : ` ${check.reason}`) +
            ` The research was set at $${v.parsed.referencePrice} on ${v.parsed.referenceDate}.`,
          href: `/decisions/review/${h.symbol}`,
        });
      }
    }
  }

  for (const e of portfolio.exposures) {
    if (e.total > e.max) {
      out.push({
        id: `limit:${e.symbol}`,
        severity: "medium",
        symbol: e.symbol,
        kind: "over_limit",
        title: `${e.symbol} is ${(e.total * 100).toFixed(1)}% including ETFs, above its ${(e.max * 100).toFixed(0)}% maximum`,
        detail: "Policy: a position above its maximum because of appreciation triggers a review, not an automatic sale.",
        href: `/decisions/review/${e.symbol}`,
      });
    }
  }

  for (const b of portfolio.buckets) {
    if (b.status === "over_max") {
      out.push({
        id: `bucket:${b.bucket}`,
        severity: "medium",
        symbol: null,
        kind: "bucket",
        title: `${b.bucket} is ${(b.weight * 100).toFixed(1)}%, above its ${((b.hardMax ?? 0) * 100).toFixed(0)}% maximum`,
        detail: "Direct new cash elsewhere, or review.",
        href: "/portfolio",
      });
    }
  }

  for (const h of portfolio.holdings) {
    if (!STOCK_BUCKETS.has(h.bucket)) continue;
    const r = research.find((x) => x.symbol === h.symbol);
    if (!r || (!r.current && !r.conflict)) {
      out.push({ id: `nores:${h.symbol}`, severity: "low", symbol: h.symbol, kind: "research_missing", title: `${h.symbol}: no stored research`, detail: `You hold ${(h.weight * 100).toFixed(1)}% in ${h.symbol} with no research on file.`, href: `/research/${h.symbol}` });
    } else if (r.conflict) {
      out.push({ id: `conflict:${h.symbol}`, severity: "low", symbol: h.symbol, kind: "research_missing", title: `${h.symbol}: research records conflict`, detail: `${r.versions} dated records and none marked current. A targeted refresh is needed before any advice.`, href: `/research/${h.symbol}` });
    } else {
      const age = researchAgeDays(r, now);
      if (age !== null && age > freshDays) {
        out.push({ id: `stale:${h.symbol}`, severity: "low", symbol: h.symbol, kind: "research_stale", title: `${h.symbol}: ${age} days since research`, detail: `A reminder to check filings and news since then. Age alone doesn't make the research wrong; new results or financings do.`, href: `/research/${h.symbol}` });
      }
    }
  }

  const conflicts = args.policy?.audit?.conflicts ?? [];
  if (conflicts.length) {
    out.push({
      id: "policy-conflict", severity: "medium", symbol: null, kind: "policy_conflict",
      title: `Your sources disagree on limits for ${conflicts.map((c) => c.subject).join(", ")}`,
      detail: "Until you choose, the app uses the stricter limit and will not size purchases above it.",
      href: "/policy",
    });
  }
  if (portfolio.cashDetail.savings === null) {
    out.push({ id: "savings-missing", severity: "medium", symbol: null, kind: "data_missing", title: "Savings balance not entered", detail: "Without it the app cannot count the capital you could transfer to Schwab.", href: "/portfolio/reconcile" });
  }

  if (portfolio.oldestHoldingsAsOf) {
    const days = Math.floor((now.getTime() - new Date(portfolio.oldestHoldingsAsOf).getTime()) / 86_400_000);
    if (days > 3) {
      out.push({ id: "holdings", severity: "low", symbol: null, kind: "holdings_stale", title: `Holdings are from statements up to ${days} days old`, detail: "Trades since then are not counted unless you record them. Record trades or load a new statement.", href: "/portfolio/reconcile" });
    }
  }

  return consolidate(out).sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** One review per company: a big drop that also lands in a research band is one decision, not two. */
export function consolidate(alerts: Alert[]): Alert[] {
  const perSymbol = new Map<string, Alert[]>();
  const rest: Alert[] = [];
  for (const a of alerts) {
    if (a.symbol && (a.kind === "big_move" || a.kind === "price_zone" || a.kind === "over_limit")) perSymbol.set(a.symbol, [...(perSymbol.get(a.symbol) ?? []), a]);
    else rest.push(a);
  }
  for (const [symbol, group] of perSymbol) {
    if (group.length === 1) { rest.push(group[0]); continue; }
    const severity = group.map((g) => g.severity).sort((x, y) => RANK[x] - RANK[y])[0];
    rest.push({
      id: `review:${symbol}`, severity, symbol, kind: "review",
      title: `Review ${symbol}: ${group.map((g) => g.title.replace(new RegExp(`^${symbol}\\s*`), "")).join("; ")}`,
      detail: group.map((g) => g.detail).join(" "),
      href: `/decisions/review/${symbol}`,
    });
  }
  return rest;
}

export function signed(n: number) {
  return `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(1)}%`;
}
