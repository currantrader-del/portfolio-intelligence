/**
 * The one "what to do with what you own" list (2026-11-18 audit: "one authoritative decision calculation that all
 * pages use"). Plan, Stocks & funds, Portfolio and the research page all read a holding's action from here, with the
 * same SEC filings, so the same portfolio and research state can never show two different trades.
 * Pure and code-only: it wraps the position review; it never trades.
 */
import type { Workspace } from "@/lib/workspace-core";
import type { FilingsResult } from "@/lib/market/sec";
import { isEtf } from "@/lib/portfolio/classify";
import { reviewPosition } from "./review";
import type { ActionNow } from "./actionNow";

export type HoldingAction = { symbol: string; value: number; weight: number; now: ActionNow };

/** Filings as loaded by `loadDecisionFilings`: a symbol missing from the map means SEC could not be checked. */
export type DecisionFilings = Map<string, FilingsResult>;

export function holdingAction(ws: Workspace, symbol: string, filings: DecisionFilings): HoldingAction | null {
  if (isEtf(symbol)) return null;
  const rv = reviewPosition(ws, symbol, filings.get(symbol) ?? null);
  return rv ? { symbol, value: rv.value, weight: rv.weight, now: rv.now } : null;
}

/** Every individual stock you own, largest first. */
export function holdingActions(ws: Workspace, filings: DecisionFilings): HoldingAction[] {
  return ws.portfolio.holdings.filter((h) => !isEtf(h.symbol)).sort((a, b) => b.value - a.value)
    .map((h) => holdingAction(ws, h.symbol, filings)).filter((x): x is HoldingAction => !!x);
}
