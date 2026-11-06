/**
 * Layer 2: a deterministic first-pass screen from as-reported SEC data and a quote.
 * It answers one question: is this company worth full research? It never produces a buy signal,
 * an allocation or an expected return. Thresholds are screening defaults, not investment policy.
 */
import type { FilingsResult, Fundamentals, Metric } from "@/lib/market/sec";

export const SCREEN_VERSION = "screen@1";

export type CheckStatus = "pass" | "watch" | "fail" | "unknown" | "info";
export type ScreenCheck = { key: string; label: string; status: CheckStatus; value: string; detail: string };
export type ScreenVerdict = "Worth researching" | "Mixed" | "Weak on screen" | "Not enough data";
export type ScreenResult = {
  symbol: string;
  verdict: ScreenVerdict;
  checks: ScreenCheck[];
  toVerify: string[];
  price: number | null;
  priceAsOf: string | null;
  dataThrough: string | null; // latest period end used
  computedAt: string;
  codeVersion: string;
  thresholds: typeof THRESHOLDS;
};

export const THRESHOLDS = {
  growthPass: 0.1, // revenue up 10%+ on the same quarter last year
  dilutionPass: 0.02,
  dilutionFail: 0.08,
  debtToCashWatch: 3,
  psWatch: 10,
  psFail: 25,
  earningsSoonDays: 14,
  offeringLookbackDays: 180,
};

const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(0)}%`;
const money = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(0)}M` : `${a.toFixed(0)}`;
  return `${n < 0 ? "−" : ""}$${s}`;
};

function trailing(m: Metric | undefined): number | null {
  if (!m) return null;
  return m.ttm ?? m.latestAnnual?.value ?? null;
}

export function screenCompany(args: {
  symbol: string;
  fundamentals: Fundamentals | { error: string };
  filings: FilingsResult | { error: string } | null;
  price: number | null;
  priceAsOf?: string | null;
  now?: Date;
}): ScreenResult {
  const now = args.now ?? new Date();
  const T = THRESHOLDS;
  const checks: ScreenCheck[] = [];
  const f = "error" in args.fundamentals ? null : args.fundamentals;
  const get = (k: string) => f?.metrics.find((m) => m.key === k);
  const revenue = get("revenue");
  const opInc = get("operating_income");
  const ocf = get("operating_cash_flow");
  const capex = get("capex");
  const cash = get("cash");
  const debt = get("long_term_debt");
  const shares = get("shares_outstanding");

  // 1. Growth
  if (revenue?.yoy != null) {
    const s: CheckStatus = revenue.yoy >= T.growthPass ? "pass" : revenue.yoy >= 0 ? "watch" : "fail";
    checks.push({ key: "growth", label: "Revenue growth", status: s, value: pct(revenue.yoy), detail: `Quarter ended ${revenue.latestQuarter?.end} vs the same quarter a year earlier` });
  } else checks.push({ key: "growth", label: "Revenue growth", status: "unknown", value: "—", detail: "No comparable quarterly revenue in SEC data" });

  // 2. Profitability
  const op = trailing(opInc);
  if (op != null) checks.push({ key: "profit", label: "Operating profit", status: op > 0 ? "pass" : "fail", value: money(op), detail: opInc?.ttm != null ? "Last 12 months" : `Fiscal year ended ${opInc?.latestAnnual?.end}` });
  else checks.push({ key: "profit", label: "Operating profit", status: "unknown", value: "—", detail: "Not reported in SEC data" });

  // 3. Free cash flow
  const o = trailing(ocf);
  const c = trailing(capex);
  if (o != null) {
    const fcf = o - Math.abs(c ?? 0);
    checks.push({ key: "fcf", label: "Free cash flow", status: fcf > 0 ? "pass" : "fail", value: money(fcf), detail: c == null ? "Operating cash flow only; capital spending not found" : "Operating cash flow minus capital spending" });
  } else checks.push({ key: "fcf", label: "Free cash flow", status: "unknown", value: "—", detail: "Cash flow not reported in SEC data" });

  // 4. Balance sheet
  const cv = cash?.latest?.value ?? null;
  const dv = debt?.latest?.value ?? null;
  if (cv != null && dv != null) {
    const ratio = cv > 0 ? dv / cv : Infinity;
    checks.push({ key: "balance", label: "Debt vs cash", status: dv <= cv ? "pass" : ratio <= T.debtToCashWatch ? "watch" : "fail", value: `${money(dv)} debt / ${money(cv)} cash`, detail: `As of ${debt?.latest?.end}` });
  } else if (cv != null) checks.push({ key: "balance", label: "Debt vs cash", status: "unknown", value: `${money(cv)} cash`, detail: "Long-term debt not found; check the balance sheet" });
  else checks.push({ key: "balance", label: "Debt vs cash", status: "unknown", value: "—", detail: "Balance sheet not found in SEC data" });

  // 5. Dilution
  const fl = args.filings && !("error" in args.filings) ? args.filings : null;
  const cutoff = new Date(now.getTime() - T.offeringLookbackDays * 86400000).toISOString().slice(0, 10);
  const offerings = (fl?.filings ?? []).filter((x) => ["S-1", "S-3", "424B5"].includes(x.form) && x.filed >= cutoff);
  if (shares?.yoy != null) {
    const s: CheckStatus = shares.yoy <= T.dilutionPass ? "pass" : shares.yoy <= T.dilutionFail ? "watch" : "fail";
    checks.push({ key: "dilution", label: "Share count change", status: offerings.length && s === "pass" ? "watch" : s, value: pct(shares.yoy), detail: `Over about a year to ${shares.latest?.end}${offerings.length ? `; ${offerings.length} offering filing${offerings.length > 1 ? "s" : ""} since ${cutoff}` : ""}` });
  } else checks.push({ key: "dilution", label: "Share count change", status: offerings.length ? "watch" : "unknown", value: "—", detail: offerings.length ? `${offerings.length} offering filing(s) since ${cutoff}; share history not found` : "Share history not found" });

  // 6. Valuation (price to sales)
  const rev = trailing(revenue);
  const sh = shares?.latest?.value ?? null;
  if (args.price != null && rev != null && rev > 0 && sh != null) {
    const ps = (args.price * sh) / rev;
    checks.push({ key: "valuation", label: "Price to sales", status: ps <= T.psWatch ? "pass" : ps <= T.psFail ? "watch" : "fail", value: `${ps.toFixed(1)}×`, detail: `Market value ${money(args.price * sh)} on revenue ${money(rev)}` });
  } else checks.push({ key: "valuation", label: "Price to sales", status: "unknown", value: "—", detail: args.price == null ? "No price" : "Revenue or share count missing" });

  // 7. Upcoming report (information only)
  if (fl?.nextEarningsEstimate) {
    const d = Math.round((new Date(fl.nextEarningsEstimate).getTime() - now.getTime()) / 86400000);
    checks.push({ key: "earnings", label: "Next report", status: "info", value: `~${fl.nextEarningsEstimate}`, detail: d <= T.earningsSoonDays ? `Estimated within ${Math.max(d, 0)} days; results could change the picture` : "Estimated from the last earnings filing" });
  }

  const scored = checks.filter((x) => x.status !== "info");
  const fails = scored.filter((x) => x.status === "fail").length;
  const watches = scored.filter((x) => x.status === "watch").length;
  const unknowns = scored.filter((x) => x.status === "unknown").length;
  const verdict: ScreenVerdict = unknowns >= 3 ? "Not enough data" : fails >= 2 ? "Weak on screen" : fails === 0 && watches <= 1 ? "Worth researching" : "Mixed";

  const toVerify = scored.filter((x) => x.status !== "pass").map((x) => {
    switch (x.key) {
      case "growth": return x.status === "unknown" ? "Find revenue for the latest quarter and a year earlier" : "Why growth slowed or turned negative, and management's outlook";
      case "profit": return x.status === "unknown" ? "Operating profit from the latest 10-Q or 10-K" : "Path to operating profit and how long cash lasts";
      case "fcf": return x.status === "unknown" ? "Cash flow statement from the latest filing" : "What the cash burn funds and how it is financed";
      case "balance": return "Debt terms, maturities and any convertible notes";
      case "dilution": return "Recent share issuance, offerings and stock-based pay";
      case "valuation": return x.status === "unknown" ? "Market value and revenue to judge valuation" : "What growth the price already assumes";
      default: return x.detail;
    }
  });
  if (!f) toVerify.unshift("SEC data could not be loaded; screen again later or check the filings directly");

  const ends = (f?.metrics ?? []).map((m) => m.latest?.end).filter(Boolean) as string[];
  return {
    symbol: args.symbol,
    verdict,
    checks,
    toVerify,
    price: args.price,
    priceAsOf: args.priceAsOf ?? null,
    dataThrough: ends.sort().at(-1) ?? null,
    computedAt: now.toISOString(),
    codeVersion: SCREEN_VERSION,
    thresholds: T,
  };
}

export const STAGES = [
  { key: "idea", label: "Idea", hint: "Added, not screened" },
  { key: "screening", label: "Screening", hint: "Checking the basics" },
  { key: "researching", label: "Researching", hint: "Full research under way or on file" },
  { key: "ready", label: "Ready for decision", hint: "Research current; can be compared for new money" },
  { key: "owned", label: "Owned", hint: "In your portfolio" },
  { key: "passed", label: "Passed", hint: "Decided against, with a reason" },
] as const;
export type Stage = (typeof STAGES)[number]["key"];
export const isStage = (s: string): s is Stage => STAGES.some((x) => x.key === s);
