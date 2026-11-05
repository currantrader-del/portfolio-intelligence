/**
 * Freshness rules. Every number shown in the app carries one of these states.
 * Pure and deterministic so the UI and the AI layer agree on what "stale" means.
 */
export type DataKind = "quote" | "holdings" | "research" | "statement";
export type Freshness = "live" | "delayed" | "stale" | "missing";

export const LIMITS = {
  quoteLiveMinutes: 2,
  quoteDelayedMinutes: 15,
  holdingsTradingDays: 1,
  researchDays: 120,
  statementDays: 40,
} as const;

const MIN = 60_000;
const DAY = 86_400_000;

export function freshness(kind: DataKind, asOf: Date | null, now: Date, opts: { marketOpen?: boolean } = {}): Freshness {
  if (!asOf) return "missing";
  const age = now.getTime() - asOf.getTime();
  if (age < 0) return "live";
  switch (kind) {
    case "quote":
      if (!opts.marketOpen) return age <= 4 * DAY ? "live" : "stale"; // last close is current when market is shut
      if (age <= LIMITS.quoteLiveMinutes * MIN) return "live";
      if (age <= LIMITS.quoteDelayedMinutes * MIN) return "delayed";
      return "stale";
    case "holdings":
      return tradingDaysBetween(asOf, now) <= LIMITS.holdingsTradingDays ? "live" : "stale";
    case "research":
      return age <= LIMITS.researchDays * DAY ? "live" : "stale";
    case "statement":
      return age <= LIMITS.statementDays * DAY ? "live" : "stale";
  }
}

/** Weekdays strictly after `from` up to and including `to` (US holidays not yet modeled). */
export function tradingDaysBetween(from: Date, to: Date): number {
  let n = 0;
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (d.getTime() < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

export function ageLabel(asOf: Date | null, now: Date): string {
  if (!asOf) return "no data";
  const days = Math.floor((now.getTime() - asOf.getTime()) / DAY);
  if (days < 1) return "today";
  if (days === 1) return "1 day old";
  return `${days} days old`;
}
