/**
 * Market observations computed by code from the snapshot, so the outlooks rest on numbers anyone
 * can reproduce from the same data. Each observation has an id (O1...), the figures, and a reading
 * decided by a fixed, stated rule (supportive / adverse / neutral for risk assets). There are no
 * scores, weights or probabilities: the reading is a label for one rule, not a forecast.
 * Earnings revisions are not in the data feed, so they are reported as unavailable, never guessed.
 */
import type { Snapshot } from "./snapshot";

export const OBSERVATIONS_VERSION = "observations@1";
export type Reading = "supportive" | "adverse" | "neutral";
export type Observation = { id: string; area: "trend" | "breadth" | "rotation" | "credit" | "rates" | "volatility" | "dollar and oil" | "economy"; text: string; reading: Reading; rule: string; refs: string[] };

const p = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const bp = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x)}bp`;

export function computeObservations(s: Snapshot): { observations: Observation[]; unavailable: string[] } {
  const by = new Map(s.rows.map((r) => [r.symbol, r]));
  const out: Omit<Observation, "id">[] = [];
  const unavailable: string[] = ["Earnings estimate revisions: no reliable revisions data in the app's feeds"];

  for (const [sym, name] of [["^GSPC", "S&P 500"], ["^IXIC", "Nasdaq Composite"], ["^RUT", "Russell 2000"]] as const) {
    const r = by.get(sym);
    if (!r || r.vs50d == null || r.vs200d == null) { unavailable.push(`${name} trend: moving averages unavailable`); continue; }
    const reading: Reading = r.vs50d > 0 && r.vs200d > 0 ? "supportive" : r.vs50d < 0 && r.vs200d < 0 ? "adverse" : "neutral";
    out.push({ area: "trend", text: `${name} is ${p(r.vs50d)} vs its 50-day and ${p(r.vs200d)} vs its 200-day average${r.from52wHigh != null ? `, ${p(r.from52wHigh)} from its 52-week high` : ""}.`, reading, rule: "above both averages = supportive; below both = adverse; otherwise neutral", refs: [`S:${sym}`] });
  }

  const b = s.breadth;
  if (b && b.sectorsTotal) {
    const share = b.sectorsAbove50d / b.sectorsTotal;
    out.push({ area: "breadth", text: `${b.sectorsAbove50d} of ${b.sectorsTotal} sector funds are above their 50-day average and ${b.sectorsAbove200d} of ${b.sectorsTotal} above their 200-day.`, reading: share >= 2 / 3 ? "supportive" : share <= 1 / 3 ? "adverse" : "neutral", rule: "two-thirds or more above the 50-day = supportive; one-third or fewer = adverse", refs: [] });
    if (b.equalVsCapMonth != null) out.push({ area: "breadth", text: `Equal-weight S&P 500 minus cap-weight over 1 month: ${p(b.equalVsCapMonth)}.`, reading: b.equalVsCapMonth > 0.01 ? "supportive" : b.equalVsCapMonth < -0.02 ? "adverse" : "neutral", rule: "equal weight ahead by more than 1 point = broadening (supportive); behind by more than 2 points = narrow leadership (adverse)", refs: ["S:RSP", "S:SPY"] });
    if (b.smallVsLargeMonth != null) out.push({ area: "breadth", text: `Russell 2000 minus S&P 500 over 1 month: ${p(b.smallVsLargeMonth)}.`, reading: b.smallVsLargeMonth > 0.01 ? "supportive" : b.smallVsLargeMonth < -0.02 ? "adverse" : "neutral", rule: "small caps ahead by more than 1 point = supportive; behind by more than 2 points = adverse", refs: ["S:^RUT", "S:^GSPC"] });
  } else unavailable.push("Sector breadth: unavailable");

  const spy = by.get("SPY");
  const sectors = s.rows.filter((r) => r.group === "sector" && r.month != null);
  if (spy?.month != null && sectors.length >= 6) {
    const rel = sectors.map((r) => ({ r, d: r.month! - spy.month! })).sort((a, b) => b.d - a.d);
    const fmt = (xs: typeof rel) => xs.map((x) => `${x.r.label} ${p(x.d)}`).join(", ");
    out.push({ area: "rotation", text: `Sectors vs SPY over 1 month. Leading: ${fmt(rel.slice(0, 3))}. Lagging: ${fmt(rel.slice(-3).reverse())}.`, reading: "neutral", rule: "descriptive only", refs: [...rel.slice(0, 3), ...rel.slice(-3)].map((x) => `S:${x.r.symbol}`) });
    const avg = (syms: string[]) => { const xs = syms.map((x) => by.get(x)?.month).filter((v): v is number => v != null); return xs.length === syms.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null; };
    const def = avg(["XLU", "XLP", "XLV"]), cyc = avg(["XLK", "XLY", "XLI", "XLF"]);
    if (def != null && cyc != null) out.push({ area: "rotation", text: `Defensive sectors (utilities, staples, health care) minus cyclical sectors (technology, discretionary, industrials, financials) over 1 month: ${p(def - cyc)}.`, reading: def - cyc > 0.02 ? "adverse" : def - cyc < -0.02 ? "supportive" : "neutral", rule: "defensives ahead by more than 2 points = adverse; behind by more than 2 points = supportive", refs: ["S:XLU", "S:XLP", "S:XLV", "S:XLK", "S:XLY", "S:XLI", "S:XLF"] });
  } else unavailable.push("Sector relative performance: too few sectors loaded");

  const hy = s.macro.find((m) => m.id === "BAMLH0A0HYM2");
  if (hy) {
    const ch = hy.previous != null ? (hy.value - hy.previous) * 100 : null;
    out.push({ area: "credit", text: `High-yield option-adjusted spread ${hy.value.toFixed(2)}% (${hy.date})${ch != null ? `, ${bp(ch)} vs ${hy.previousDate}` : ""}.`, reading: hy.value < 3.5 ? "supportive" : hy.value > 5 ? "adverse" : "neutral", rule: "below 3.5% = supportive (tight); above 5% = adverse (stress); the level, not the one-day change, decides", refs: ["F:BAMLH0A0HYM2"] });
  } else unavailable.push("High-yield spread: FRED series unavailable");
  const hyg = by.get("HYG"), lqd = by.get("LQD");
  if (hyg?.month != null && lqd?.month != null) out.push({ area: "credit", text: `High-yield bonds (HYG) minus investment-grade (LQD) over 1 month: ${p(hyg.month - lqd.month)}.`, reading: hyg.month - lqd.month > 0.005 ? "supportive" : hyg.month - lqd.month < -0.01 ? "adverse" : "neutral", rule: "HYG ahead by more than 0.5 point = supportive; behind by more than 1 point = adverse", refs: ["S:HYG", "S:LQD"] });

  const tnx = by.get("^TNX");
  if (tnx) out.push({ area: "rates", text: `US 10-year yield ${tnx.last.toFixed(2)}%${tnx.month != null ? `, ${bp(tnx.month)} over 1 month` : ""}.`, reading: tnx.month != null && tnx.month > 35 ? "adverse" : "neutral", rule: "a rise of more than 35bp in a month = adverse (tightening financial conditions); otherwise neutral", refs: ["S:^TNX"] });
  const curve = s.macro.find((m) => m.id === "T10Y2Y");
  if (curve) out.push({ area: "rates", text: `10-year minus 2-year Treasury spread ${curve.value.toFixed(2)} points (${curve.date}).`, reading: "neutral", rule: "descriptive only (an inverted or re-steepening curve has no reliable short-term timing)", refs: ["F:T10Y2Y"] });

  const vix = by.get("^VIX");
  if (vix) out.push({ area: "volatility", text: `VIX ${vix.last.toFixed(1)}${vix.month != null ? ` (${p(vix.month)} over 1 month)` : ""}.`, reading: vix.last < 16 ? "supportive" : vix.last > 22 ? "adverse" : "neutral", rule: "below 16 = supportive; above 22 = adverse", refs: ["S:^VIX"] });
  else unavailable.push("VIX: unavailable");

  const dx = by.get("DX-Y.NYB"), oil = by.get("CL=F");
  if (dx?.month != null || oil?.month != null) out.push({ area: "dollar and oil", text: [dx?.month != null && `US dollar index ${p(dx.month)} over 1 month`, oil?.month != null && `WTI crude ${p(oil.month)} over 1 month (${oil.last.toFixed(2)})`].filter(Boolean).join("; ") + ".", reading: "neutral", rule: "descriptive only", refs: [dx && "S:DX-Y.NYB", oil && "S:CL=F"].filter(Boolean) as string[] });

  const nfci = s.macro.find((m) => m.id === "NFCI");
  if (nfci) out.push({ area: "economy", text: `Chicago Fed financial conditions index ${nfci.value.toFixed(2)} (${nfci.date}; negative means looser than average).`, reading: nfci.value < 0 ? "supportive" : nfci.value > 0.25 ? "adverse" : "neutral", rule: "below 0 = supportive; above 0.25 = adverse", refs: ["F:NFCI"] });
  const un = s.macro.find((m) => m.id === "UNRATE");
  if (un && un.previous != null) out.push({ area: "economy", text: `Unemployment rate ${un.value.toFixed(1)}% (${un.date}) vs ${un.previous.toFixed(1)}% (${un.previousDate}).`, reading: un.value - un.previous >= 0.2 ? "adverse" : "neutral", rule: "a rise of 0.2 point or more in one month = adverse", refs: ["F:UNRATE"] });
  const claims = s.macro.find((m) => m.id === "ICSA");
  if (claims && claims.previous != null) out.push({ area: "economy", text: `Initial jobless claims ${Math.round(claims.value)}k (${claims.date}) vs ${Math.round(claims.previous)}k (${claims.previousDate}).`, reading: "neutral", rule: "descriptive only (one week is noisy)", refs: ["F:ICSA"] });

  return { observations: out.map((o, i) => ({ id: `O${i + 1}`, ...o })), unavailable };
}

/** How many observations read each way, by area; a count, not a score. */
export function tally(obs: Observation[]) {
  return { supportive: obs.filter((o) => o.reading === "supportive").length, adverse: obs.filter((o) => o.reading === "adverse").length, neutral: obs.filter((o) => o.reading === "neutral").length };
}

