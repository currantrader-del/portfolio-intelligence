/**
 * The one plain action at today's price, with its reason and the price levels that would change it.
 * (Investor, 2026-11-12: "The app should tell me: buy more at this price, hold until price hits X, sell because of X.")
 * Pure and code-only: it reads the price levels the research in use already set (its price framework), the
 * position against its limits, and whether anything has been filed since that the research has not read.
 * It never invents a level: a company without researched levels says so.
 */
import { annualized, zoneFor, type ParsedConclusion, type PriceZone } from "@/lib/research/valuation";
import { zoneKind } from "@/lib/policy/evidence";

export type ActionVerb = "Buy more" | "Hold" | "Trim" | "Reassess first";
export type ActionNow = {
  verb: ActionVerb;
  /** One sentence: the action and its reason. */
  headline: string;
  /** "Hold while $135–$170. Below $135: … Above $170: …" */
  levels: string | null;
  zones: { label: string; action: string; current: boolean }[];
  /** What the research says would change its view (thesis-breakers), as written. */
  watch: string[];
  /** "Is this a good price to buy?": the return the research's scenarios give from today's price, and from its buy level. */
  priceAnswer: string | null;
  /** Why it could go lower: the bear case's value and weight, and the research's main risks. */
  downside: string | null;
  risks: string[];
};

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (s: string, n = 140) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const CONDITIONAL = /\bonly (after|if|when)\b|\bconsider\b|\breview point\b|\bnot a buy signal\b|\bno add by default\b/i;

export function actionNow(a: {
  symbol: string;
  price: number | null;
  research: { pc: ParsedConclusion; asOf: string; openQuestions: number } | null;
  /** A material filing since the research that it has not read (e.g. "8-K filed 2026-11-12"). */
  unreadFiling: string | null;
  /** The position is above the level the research or your limit says to trim back to. */
  trim: { dollars: number; toPct: number; why: string } | null;
  held: boolean;
  now?: Date;
  /** Only preliminary research is on file: its bands are context, never buy or sell levels. */
  preliminary?: boolean;
}): ActionNow {
  const { symbol, price } = a;
  const pc = a.research?.pc ?? null;
  const zones = (pc?.zones ?? []).slice().sort((x, y) => x.low - y.low);
  const z = price && zones.length ? zoneFor(zones, price) : null;
  const watch = (pc?.wouldChange ?? []).slice(0, 3).map((x) => short(x, 220));
  const zoneRows = zones.map((x) => ({ label: x.label, action: short(x.action, 200), current: x === z }));
  const pm = pc ? priceMath(pc, price, zones, a.now ?? new Date()) : { priceAnswer: null, downside: null, risks: [] };

  if ((!pc || !zones.length) && a.preliminary) {
    return { verb: "Hold", headline: `${a.held ? "Hold" : "No action"}: ${symbol} has only preliminary research. Its price bands are context, not buy or sell levels; a finished investigation sets those.`, levels: null, zones: [], watch, priceAnswer: null, downside: null, risks: [] };
  }
  if (!pc || !zones.length) {
    return { verb: "Hold", headline: `${a.held ? "Hold" : "No action"}: ${symbol} has no researched price levels yet, so there is no buy or sell price to act on. A finished investigation sets them.`, levels: null, zones: [], watch, priceAnswer: null, downside: null, risks: [] };
  }

  const levels = levelText(zones, z, price);
  const at = price ? ` at ${money(price)}` : "";
  const research = `the ${a.research!.asOf} research`;

  if (a.unreadFiling) {
    return {
      verb: "Reassess first",
      headline: `Reassess first, and ${a.held ? "hold" : "don't buy"} until it is done: ${a.unreadFiling} has not been read into ${research}. A targeted update reads it. Until then the levels below still stand${a.trim ? `, including the ${a.trim.toPct.toFixed(0)}% weight rule` : ""}.`,
      levels, zones: zoneRows, watch, ...pm,
    };
  }
  if (a.trim && a.trim.dollars >= 1) {
    return { verb: "Trim", headline: `Trim about $${Math.round(a.trim.dollars).toLocaleString("en-US")}${at}: ${a.trim.why}`, levels, zones: zoneRows, watch, ...pm };
  }
  if (!z) return { verb: "Hold", headline: `Hold${at}: the price is outside the levels ${research} set, so its plan doesn't cover this price. Reassess before acting.`, levels, zones: zoneRows, watch, ...pm };

  const kind = zoneKind(z.action);
  if (kind === "trim") return { verb: "Trim", headline: `Trim${at}: ${research} says for ${z.label}: ${lc(short(z.action, 200))}`, levels, zones: zoneRows, watch, ...pm };
  if (kind === "buy" && !CONDITIONAL.test(z.action)) {
    if (a.research!.openQuestions > 0) return { verb: "Hold", headline: `Hold${at} for now: this is the research's buy range (${z.label}), but ${a.research!.openQuestions} open question${a.research!.openQuestions === 1 ? "" : "s"} must be answered before new money goes in.`, levels, zones: zoneRows, watch, ...pm };
    return { verb: "Buy more", headline: `Buy more${at}: it is inside the research's buy range (${z.label}): ${lc(short(z.action, 200))}. See Decisions for the amount your limits allow.`, levels, zones: zoneRows, watch, ...pm };
  }
  return { verb: "Hold", headline: `Hold${at}: ${research} says for ${z.label}: ${lc(short(z.action, 200))}`, levels, zones: zoneRows, watch, ...pm };
}

/** "Hold while $135–$170. Below $135: review an add (…). Above $170: trim back to 15%." */
function levelText(zones: PriceZone[], z: PriceZone | null, price: number | null): string {
  if (!z) return zones.map((x) => `${x.label}: ${lc(short(x.action, 110))}`).join(" ");
  const below = zones.filter((x) => x.high <= z.low + 1e-9).pop();
  const above = zones.find((x) => x.low >= z.high - 1e-9);
  const k = zoneKind(z.action);
  const parts = [`${k === "hold" ? "Hold while" : "Now"} ${z.label}${price ? ` (price ${money(price)})` : ""}.`];
  if (below && Number.isFinite(z.low)) parts.push(`Below $${z.low}: ${lc(short(below.action, 120))}`);
  if (above && Number.isFinite(z.high)) parts.push(`Above $${z.high}: ${lc(short(above.action, 120))}`);
  return parts.join(" ");
}

/** The research's own numbers at today's price: expected yearly return, the buy level's return, and the bear case. */
export function priceMath(pc: ParsedConclusion, price: number | null, zones: PriceZone[], now: Date): { priceAnswer: string | null; downside: string | null; risks: string[] } {
  const risks = (pc.risks ?? []).slice(0, 3).map((x) => short(x.replace(/\s*\((?:[FDQ]\d+[^)]*)\)/g, ""), 160));
  if (!price || !pc.weightedValue || !pc.horizonDate) return { priceAnswer: null, downside: null, risks };
  const pctY = (p: number) => annualized(p, pc.weightedValue!, pc.horizonDate!, now);
  const yr = pc.horizonDate.slice(0, 4);
  const at = pctY(price);
  const buy = zones.find((x) => zoneKind(x.action) === "buy" && Number.isFinite(x.high) && x.high < price);
  const f = (x: number) => `${x >= 0 ? "" : "−"}${Math.abs(x * 100).toFixed(1)}% a year`;
  const priceAnswer = `From ${money(price)}, the research's weighted value of ${money(pc.weightedValue)} by ${yr} works out to about ${f(at)}.${buy ? ` From $${buy.high} (where it starts to review an add) it would be about ${f(pctY(buy.high))}.` : ""}`;
  const bear = pc.scenarios.find((s) => s.name === "bear");
  const downside = bear ? `Its bear case is ${money(bear.value)} (${Math.round((bear.value / price - 1) * 100)}% from here), given a ${Math.round(bear.probability * 100)}% chance.` : null;
  return { priceAnswer, downside, risks };
}
