import type { Workspace } from "@/lib/workspace";
import { researchAgeDays } from "@/lib/research/records";
import type { PortfolioContext } from "./synthesis";

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** What the briefing is told about the portfolio: weights, labels and limits, never invented values. */
export function portfolioContext(ws: Workspace): PortfolioContext {
  const p = ws.portfolio;
  const holdings = p.holdings.map((h) => {
    const r = ws.research.find((x) => x.symbol === h.symbol);
    const v = r?.current ?? r?.latest;
    const age = r ? researchAgeDays(r, ws.now) : null;
    // A newer version than the one in use (a refresh in progress) must never be hidden behind it.
    const newer = r?.current && r.latest && r.latest.id !== r.current.id && r.latest.research_as_of > r.current.research_as_of ? r.latest : null;
    const lim = ws.policy?.companies[h.symbol];
    const limit = lim?.hardMax != null
      ? `${lim.provisional ? "provisional " : ""}max ${pct(lim.hardMax)}${lim.normal ? `, normal ${pct(lim.normal.low)}-${pct(lim.normal.high)}` : ""}${lim.status && lim.status !== "approved" ? ` (${lim.status})` : ""}`
      : null;
    return {
      symbol: h.symbol, weight: h.weight, bucket: h.bucket,
      research: v
        ? `${r?.current ? "in use" : "not in use"}: ${v.completeness}, dated ${v.research_as_of}${age != null ? ` (${age} days old)` : ""}${v.parsed.action ? `, last call ${v.parsed.action}` : ""}${newer ? `; NEWER VERSION IN PROGRESS dated ${newer.research_as_of} (${newer.completeness}${newer.parsed.action ? `, status ${newer.parsed.action}` : ""}): the call in use may change` : ""}`
        : "none on file",
      limit,
    };
  }).sort((a, b) => b.weight - a.weight);
  const c = p.cashDetail;
  const cashNote = `Cash: brokerage ${Math.round(c.brokerage)}; savings ${c.savings == null ? "not entered" : Math.round(c.savings)}; savings are outside every percentage; there is no protected reserve.`;
  const upcoming = ws.alerts.filter((a) => a.kind === "event").map((a) => `${a.title} (${a.timing === "upcoming" ? "estimated date" : "filed"})`).slice(0, 10);
  return { quality: p.quality.status === "verified" ? "verified holdings" : `${p.quality.headline}; values are estimates`, holdings, cashNote, upcoming };
}

export function watchlist(ws: Workspace) {
  const held = new Set(ws.portfolio.holdings.map((h) => h.symbol));
  return ws.research.filter((r) => !held.has(r.symbol) && r.pipeline.stage !== "passed").map((r) => r.symbol);
}
