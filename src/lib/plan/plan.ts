/**
 * The portfolio plan: one view that turns the stored research, holdings, cash, policy and the latest
 * market briefing into a target and an action for every holding and researched idea. Pure: the
 * instructions and the checks. The job lives in job.ts. The plan proposes; the investor decides.
 */
export const PLAN_VERSION = "plan@2";
export const PLAN_LIMITS = { turns: 10, searches: 2, ms: 6 * 60_000, maxTokens: 12000 };

export const PLAN_SYSTEM = `You are the portfolio planner inside Portfolio Intelligence, working for one private investor whose portfolio, accounts, cash, protected reserve, policy limits, stored research and latest market briefing are given below. Write their portfolio plan: one page that turns everything already researched into an action for each position, and a plan for cash.

How to work:
- Use the stored material first: get_portfolio, get_policy, get_briefing, get_pipeline, and get_research for each holding and each researched idea. Use simulate_new_capital for the cash plan. Search the web only if something essential is missing.
- Research is the authority for each company's view; do not invent a new valuation. If research is stale, partial, or the price has moved far from its reference, say the action is "Refresh research first" and put it in "stale".
- Allocation ranges (company, bucket and the deployable-cash range) are guidelines and risk ceilings, never targets to fill. Being below a range, or below 5% cash, is never by itself a reason to buy, sell, or delay investing; being above a normal range is a reason to review, not to sell. A maximum is a ceiling new money may not cross.
- The protected savings reserve (get_policy) is a firm restriction: never invest it or count it as buying power. Deployable cash above it is flexible: compare every use, including leaving it uninvested.
- Use only the policy in force today (get_policy "subjects" and "in_use"). Rules marked "imported" are archive guidelines the investor has not approved: call them guidelines, never restrictions. "retired" items (fixed ETF-return assumptions, return hurdles, risk-margin factors, freshness days) no longer exist: never mention or apply a hurdle. Only mention a limit conflict if get_policy lists it under "conflicts" today.
- Compare each stock with diversified ETFs (VOO, VXUS, AVUV), Treasuries and cash on the same horizon: the research's scenarios re-priced at today's price against VOO's published forecasts (a range and a point, shown separately, over 10-15 years). A 2-4 year stock case and a 10-15 year forecast are not like for like: say so, and treat forecasts as uncertain, never as a precise requirement. Include downside and concentration (simulate_new_capital and get_exposure give both).
- Holdings and buying power are estimates unless get_portfolio shows them verified by a recent statement or the investor's own check: say "estimated" and what to confirm. Trades recorded since an older statement are not a reconciliation.
- target_pct is the weight you expect after this plan's actions: today's weight for a hold. It is never a level to fill to. Broad ETFs need no company research; VOO is the main diversified alternative, compared with other ETFs, Treasuries and cash; it is never an automatic destination.
- A price drop is never a reason to buy by itself; room under a limit is never a reason to add; new cash does not have to be invested now. Holding cash is a valid plan.
- Research authority: only research the investor APPROVED is an investment model. get_research says which records are approved; a preliminary screen, an older record or an investigation awaiting approval is context only. For a company without approved research, do not set a target above today's weight, do not give a buy-below price and say plainly that no approved research exists.
- Opportunities: the companies at the "Ready for decision" stage (named in the question) are the shortlist for new cash. Rank them against simply buying VOO with the same money. For each, say "Buy now", "Wait for price" or "Not yet", with a buy-below price, a dollar amount within the deployable cash and the policy limits, the expected return from its research versus VOO's, and why. If none beats VOO today, say so in the cash plan.
- Companies the investor marked "Passed" are decided: leave them out of positions and opportunities.
- Prefer few, clear actions. Priority 1 is the most important.

Reply with exactly one JSON object in a \`\`\`json fenced block and nothing else. Percentages are numbers like 4.5 (meaning 4.5%). Shape:
{
  "summary": string,                                  // 2-4 sentences: the plan in plain words
  "market": { "stance": "Constructive" | "Neutral" | "Cautious", "short_term": string, "long_term": string },
  "positions": [{ "symbol": string, "status": "held" | "idea", "target_pct": number | null, "action": string, "priority": 1 | 2 | 3, "reason": string }],
  "opportunities": [{ "symbol": string, "verdict": "Buy now" | "Wait for price" | "Not yet", "buy_below": number | null, "amount_usd": number | null, "expected_return": string, "vs_voo": string, "reason": string }],   // best first
  "cash": { "now": string, "wait_for": string },
  "stale": [{ "symbol": string, "why": string }],
  "next_actions": string[]                            // at most 5, most important first
}`;

export function planQuestion(today: string, stages: { ready: string[]; passed: string[] } = { ready: [], passed: [] }) {
  return `Write my portfolio plan as of ${today}. Cover every holding and every company with research on file, then the opportunities and the cash plan.
Ready for decision (the shortlist for new cash): ${stages.ready.join(", ") || "none yet"}.
Passed (leave out): ${stages.passed.join(", ") || "none"}.`;
}

export type PlanPosition = {
  symbol: string; status: "held" | "idea"; currentPct: number | null; targetPct: number | null; maxPct: number | null;
  action: string; priority: 1 | 2 | 3; reason: string; researchAsOf: string | null; flags: string[];
};
export type Opportunity = { symbol: string; verdict: "Buy now" | "Wait for price" | "Not yet"; buyBelow: number | null; amountUsd: number | null; expectedReturn: string; vsVoo: string; reason: string };
export type Plan = {
  summary: string;
  market: { stance: string; shortTerm: string; longTerm: string };
  positions: PlanPosition[];
  opportunities: Opportunity[];
  cash: { deployable: number | null; now: string; waitFor: string };
  stale: { symbol: string; why: string }[];
  nextActions: string[];
  problems: string[];
};

export type PlanFacts = {
  holdings: { symbol: string; weight: number }[];         // weight as a fraction
  researched: { symbol: string; asOf: string | null; stage?: string; approved?: boolean }[];
  maxFor: (symbol: string) => number | null;               // fraction
  deployable: number | null;
};

const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Checks the planner's report against the app's own numbers. Current weights come from the app, never the
 * model. A target above the policy maximum is capped and flagged; unknown symbols are dropped and reported.
 */
export function validatePlan(raw: unknown, f: PlanFacts): Plan | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "The planner did not return a readable plan." };
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  const known = new Map<string, { held: boolean; asOf: string | null }>();
  for (const h of f.holdings) known.set(h.symbol, { held: true, asOf: null });
  const passed = new Set(f.researched.filter((x) => x.stage === "passed" && !f.holdings.some((h) => h.symbol === x.symbol)).map((x) => x.symbol));
  // Only companies with research you approved can be a shortlist for new cash.
  const ready = new Set(f.researched.filter((x) => x.stage === "ready" && x.approved !== false).map((x) => x.symbol));
  const unapproved = new Set(f.researched.filter((x) => x.approved === false).map((x) => x.symbol));
  for (const x of f.researched) if (!passed.has(x.symbol)) known.set(x.symbol, { held: known.get(x.symbol)?.held ?? false, asOf: x.asOf });

  const seen = new Set<string>();
  const positions: PlanPosition[] = [];
  for (const p of Array.isArray(r.positions) ? (r.positions as Record<string, unknown>[]) : []) {
    const symbol = str(p?.symbol, 12).toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    const k = known.get(symbol);
    if (passed.has(symbol)) continue;
    if (!k) { problems.push(`${symbol} is not a holding or a researched company, so it was left out`); continue; }
    seen.add(symbol);
    const flags: string[] = [];
    const current = f.holdings.find((h) => h.symbol === symbol)?.weight ?? (k.held ? null : 0);
    const max = f.maxFor(symbol);
    let target = num(p.target_pct);
    if (target !== null && (target < 0 || target > 100)) { flags.push("target out of range, ignored"); target = null; }
    if (target !== null && max !== null && target / 100 > max + 1e-9) { flags.push(`target ${r1(target)}% capped at the ${r1(max * 100)}% policy maximum`); target = r1(max * 100); }
    // An unapproved thesis cannot set a target above today's weight (that would be a research-based add).
    if (unapproved.has(symbol) && target !== null && current !== null && target > r1(current * 100) + 0.05) {
      flags.push(`target ${r1(target)}% not used: the research is not approved, so no research-based increase`); target = r1(current * 100);
    }
    const pr = Number(p.priority);
    positions.push({
      symbol, status: k.held ? "held" : "idea", currentPct: current === null ? null : r1(current * 100), targetPct: target, maxPct: max === null ? null : r1(max * 100),
      action: str(p.action, 200) || "No action given", priority: pr === 1 || pr === 2 || pr === 3 ? pr : 3, reason: str(p.reason, 1200), researchAsOf: k.asOf, flags,
    });
  }
  for (const h of f.holdings) if (!seen.has(h.symbol)) problems.push(`${h.symbol} is held but the plan did not cover it`);
  const targetSum = positions.reduce((a, p) => a + (p.targetPct ?? 0), 0);
  if (targetSum > 100.5) problems.push(`Targets add up to ${r1(targetSum)}%, more than 100%`);
  for (const p of positions) if (p.flags.some((x) => x.includes("capped"))) problems.push(`${p.symbol}: ${p.flags.find((x) => x.includes("capped"))}`);

  // Opportunities: only Ready-for-decision companies, amounts within the deployable cash.
  const opportunities: Opportunity[] = [];
  let committed = 0;
  for (const o of Array.isArray(r.opportunities) ? (r.opportunities as Record<string, unknown>[]) : []) {
    const symbol = str(o?.symbol, 12).toUpperCase();
    if (!symbol || opportunities.some((x) => x.symbol === symbol)) continue;
    if (!ready.has(symbol)) { if (!passed.has(symbol)) problems.push(unapproved.has(symbol) ? `${symbol} was suggested as an opportunity but its research is not approved, so it was left out` : `${symbol} was suggested as an opportunity but is not Ready for decision, so it was left out`); continue; }
    const verdict = (["Buy now", "Wait for price", "Not yet"] as const).find((v) => v === o.verdict) ?? "Not yet";
    let amountUsd = num(o.amount_usd);
    if (amountUsd !== null && amountUsd <= 0) amountUsd = null;
    if (verdict === "Buy now" && amountUsd !== null && f.deployable !== null && committed + amountUsd > f.deployable + 1) {
      problems.push(`${symbol}: $${Math.round(amountUsd)} is more than the deployable cash left, so it was cut`);
      amountUsd = Math.max(0, Math.round(f.deployable - committed)) || null;
    }
    if (verdict === "Buy now" && amountUsd) committed += amountUsd;
    const buyBelow = num(o.buy_below);
    opportunities.push({ symbol, verdict, buyBelow: buyBelow && buyBelow > 0 ? buyBelow : null, amountUsd, expectedReturn: str(o.expected_return, 200), vsVoo: str(o.vs_voo, 300), reason: str(o.reason, 800) });
  }
  for (const s of ready) if (!opportunities.some((o) => o.symbol === s) && !f.holdings.some((h) => h.symbol === s)) problems.push(`${s} is Ready for decision but the plan did not rank it`);

  const m = (r.market ?? {}) as Record<string, unknown>;
  const c = (r.cash ?? {}) as Record<string, unknown>;
  const summary = str(r.summary, 1500);
  if (!summary) problems.push("No summary");
  return {
    summary,
    market: { stance: ["Constructive", "Neutral", "Cautious"].includes(String(m.stance)) ? String(m.stance) : "Neutral", shortTerm: str(m.short_term, 800), longTerm: str(m.long_term, 800) },
    positions: positions.sort((a, b) => a.priority - b.priority || (b.currentPct ?? 0) - (a.currentPct ?? 0)),
    opportunities,
    cash: { deployable: f.deployable, now: str(c.now, 800), waitFor: str(c.wait_for, 800) },
    stale: (Array.isArray(r.stale) ? (r.stale as Record<string, unknown>[]) : []).map((s) => ({ symbol: str(s?.symbol, 12).toUpperCase(), why: str(s?.why, 400) })).filter((s) => s.symbol).slice(0, 20),
    nextActions: (Array.isArray(r.next_actions) ? (r.next_actions as unknown[]) : []).map((x) => str(x, 300)).filter(Boolean).slice(0, 5),
    problems,
  };
}
