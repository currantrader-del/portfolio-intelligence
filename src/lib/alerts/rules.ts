/**
 * Monitoring rules. Each alert is a decision prompt with a reason, never a trade.
 * Pure: takes the portfolio, research and benchmarks, returns ranked alerts.
 */
import type { PortfolioView } from "@/lib/portfolio/engine";
import type { ResearchRecord } from "@/lib/research/records";
import { researchAgeDays } from "@/lib/research/records";
import { expectedReturnAt, zoneFor } from "@/lib/research/valuation";

export type Severity = "high" | "medium" | "low";
export type Alert = {
  id: string;
  severity: Severity;
  symbol: string | null;
  kind: "price_zone" | "big_move" | "over_limit" | "bucket" | "research_stale" | "research_missing" | "holdings_stale";
  title: string;
  detail: string;
  href: string;
};

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const STOCK_BUCKETS = new Set(["Quality/growth individual stocks", "Asymmetric/high-risk growth sleeve"]);

export function evaluateAlerts(args: {
  portfolio: PortfolioView;
  research: ResearchRecord[];
  marketDayPct: number | null;
  now: Date;
  freshnessDays?: number;
}): Alert[] {
  const { portfolio, research, marketDayPct, now } = args;
  const freshDays = args.freshnessDays ?? 120;
  const out: Alert[] = [];

  for (const h of portfolio.holdings) {
    const r = research.find((x) => x.symbol === h.symbol);
    const v = r?.current;

    if (h.dayPct !== null && Math.abs(h.dayPct) >= 0.05) {
      const rel = marketDayPct !== null ? h.dayPct - marketDayPct : null;
      out.push({
        id: `move:${h.symbol}`,
        severity: Math.abs(h.dayPct) >= 0.08 ? "high" : "medium",
        symbol: h.symbol,
        kind: "big_move",
        title: `${h.symbol} ${signed(h.dayPct)} today`,
        detail: rel !== null ? `${signed(rel)} versus the S&P 500. Check filings and news before acting.` : "Check filings and news before acting.",
        href: `/decisions/review/${h.symbol}`,
      });
    }

    if (v && h.priceSource === "quote") {
      const z = zoneFor(v.parsed.zones, h.price);
      const refZone = v.parsed.referencePrice ? zoneFor(v.parsed.zones, v.parsed.referencePrice) : null;
      if (z && refZone && z.label !== refZone.label) {
        const er = expectedReturnAt(v.parsed, h.price, now);
        const severity: Severity = /strong/i.test(z.action) ? "high" : /add|trim/i.test(z.action) ? "medium" : "low";
        out.push({
          id: `zone:${h.symbol}:${z.label}`,
          severity,
          symbol: h.symbol,
          kind: "price_zone",
          title: `${h.symbol} at $${h.price.toFixed(2)} is in your "${z.label}" band`,
          detail:
            `Research action for this band: ${z.action}.` +
            (er !== null ? ` Expected return at this price is about ${(er * 100).toFixed(1)}% a year.` : "") +
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
        out.push({ id: `stale:${h.symbol}`, severity: "low", symbol: h.symbol, kind: "research_stale", title: `${h.symbol} research is ${age} days old`, detail: `Older than your ${freshDays}-day freshness rule.`, href: `/research/${h.symbol}` });
      }
    }
  }

  if (portfolio.oldestHoldingsAsOf) {
    const days = Math.floor((now.getTime() - new Date(portfolio.oldestHoldingsAsOf).getTime()) / 86_400_000);
    if (days > 3) {
      out.push({ id: "holdings", severity: "low", symbol: null, kind: "holdings_stale", title: `Holdings are from statements up to ${days} days old`, detail: "Trades since then are not counted. Upload new statements or connect Schwab.", href: "/portfolio" });
    }
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

export function signed(n: number) {
  return `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(1)}%`;
}
