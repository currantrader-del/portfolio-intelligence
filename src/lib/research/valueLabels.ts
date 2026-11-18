/**
 * Plain labels for a research valuation, so a future price is never read as today's value.
 *  - The weighted value is a price forecast for the research's horizon date (for NOW, Dec 2029), not a fair value today.
 *  - "Value today" discounts that forecast back at the top of VOO's published forecast range: the price at which
 *    owning the stock is expected to do as well as the best VOO forecast. Above it, VOO is expected to do better.
 *  - The company view looks only at the stock at today's price. Funding, cash and limits belong to the separate
 *    portfolio question ("should you add?"), never to whether the company is attractive.
 */
import { VOO_SPAN } from "@/lib/policy/evidence";

const YEAR_MS = 365.25 * 864e5;

export function yearsTo(horizonDate: string, now: Date): number {
  return Math.max(0, (Date.parse(horizonDate + (horizonDate.length === 10 ? "T00:00:00Z" : "")) - now.getTime()) / YEAR_MS);
}

/** The price today that would earn `rate` a year to reach the forecast by the horizon. */
export function valueToday(forecast: number, horizonDate: string, now: Date, rate = VOO_SPAN.high): number {
  return Math.round((forecast / Math.pow(1 + rate, yearsTo(horizonDate, now))) * 100) / 100;
}

/** "Dec 2029" from "2029-12-31". */
export function monthYear(iso: string): string {
  const d = new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * The market day a research reference price belongs to. Research dated on a weekend used the last close
 * before it (for NOW, research dated Sun Nov 8 used Fri Nov 6). Exchange holidays are not modelled.
 */
export function marketDayOf(referenceDate: string): { date: string; moved: boolean } {
  const d = new Date(referenceDate + "T12:00:00Z");
  const back = d.getUTCDay() === 0 ? 2 : d.getUTCDay() === 6 ? 1 : 0;
  d.setUTCDate(d.getUTCDate() - back);
  return { date: d.toISOString().slice(0, 10), moved: back > 0 };
}

export type CompanyView = "Attractive at this price" | "Fairly priced" | "Not attractive at this price";

/** The company question alone: expected return at today's price vs VOO's published forecasts. */
export function companyView(judgment: "favourable" | "unfavourable" | "mixed" | null | undefined): CompanyView | null {
  if (!judgment) return null;
  return judgment === "favourable" ? "Attractive at this price" : judgment === "unfavourable" ? "Not attractive at this price" : "Fairly priced";
}
