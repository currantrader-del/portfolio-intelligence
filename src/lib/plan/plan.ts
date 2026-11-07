/**
 * The portfolio plan: one view that turns the stored research, holdings, cash, policy and the latest
 * market briefing into a target and an action for every holding and researched idea. Pure: the
 * instructions and the checks. The job lives in job.ts. The plan proposes; the investor decides.
 */
export const PLAN_VERSION = "plan@1";
export const PLAN_LIMITS = { turns: 10, searches: 2, ms: 6 * 60_000, maxTokens: 12000 };

export const PLAN_SYSTEM = `You are the portfolio planner inside Portfolio Intelligence, working for one private investor whose portfolio, accounts, cash, protected reserve, policy limits, stored research and latest market briefing are given below. Write their portfolio plan: one page that turns everything already researched into a target and an action for each position, and a plan for cash.

How to work:
- Use the stored material first: get_portfolio, get_policy, get_briefing, get_pipeline, and get_research for each holding and each researched idea. Use simulate_new_capital for the cash plan. Search the web only if something essential is missing.
- Research is the authority for each company's view; do not invent a new valuation. If research is stale, partial, or the price has moved far from its reference, say the action is "Refresh research first" and put it in "stale".
- Targets stay within the policy: never above a company's maximum, buckets within their ranges, the protected reserve never invested. Broad ETFs need no company research; they are the default home for cash when no stock passes.
- A price drop is never a reason to buy by itself; room under a limit is never a reason to add; new cash does not have to be invested now. Holding cash is a valid plan.
- Prefer few, clear actions. Priority 1 is the most important.

Reply with exactly one JSON object in a \`\`\`json fenced block and nothing else. Percentages are numbers like 4.5 (meaning 4.5%). Shape:
{
  "summary": string,                                  // 2-4 sentences: the plan in plain words
  "market": { "stance": "Constructive" | "Neutral" | "Cautious", "short_term": string, "long_term": string },
  "positions": [{ "symbol": string, "status": "held" | "idea", "target_pct": number | null, "action": string, "priority": 1 | 2 | 3, "reason": string }],
  "cash": { "now": string, "wait_for": string },
  "stale": [{ "symbol": string, "why": string }],
  "next_actions": string[]                            // at most 5, most important first
}`;

export function planQuestion(today: string) {
  return `Write my portfolio plan as of ${today}. Cover every holding and every company with research on file, then the cash plan.`;
}

export type PlanPosition = {
  symbol: string; status: "held" | "idea"; currentPct: number | null; targetPct: number | null; maxPct: number | null;
  action: string; priority: 1 | 2 | 3; reason: string; researchAsOf: string | null; flags: string[];
};
export type Plan = {
  summary: string;
  market: { stance: string; shortTerm: string; longTerm: string };
  positions: PlanPosition[];
  cash: { deployable: number | null; now: string; waitFor: string };
  stale: { symbol: string; why: string }[];
  nextActions: string[];
  problems: string[];
};

export type PlanFacts = {
  holdings: { symbol: string; weight: number }[];         // weight as a fraction
  researched: { symbol: string; asOf: string | null }[];
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
  for (const x of f.researched) known.set(x.symbol, { held: known.get(x.symbol)?.held ?? false, asOf: x.asOf });

  const seen = new Set<string>();
  const positions: PlanPosition[] = [];
  for (const p of Array.isArray(r.positions) ? (r.positions as Record<string, unknown>[]) : []) {
    const symbol = str(p?.symbol, 12).toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    const k = known.get(symbol);
    if (!k) { problems.push(`${symbol} is not a holding or a researched company, so it was left out`); continue; }
    seen.add(symbol);
    const flags: string[] = [];
    const current = f.holdings.find((h) => h.symbol === symbol)?.weight ?? (k.held ? null : 0);
    const max = f.maxFor(symbol);
    let target = num(p.target_pct);
    if (target !== null && (target < 0 || target > 100)) { flags.push("target out of range, ignored"); target = null; }
    if (target !== null && max !== null && target / 100 > max + 1e-9) { flags.push(`target ${r1(target)}% capped at the ${r1(max * 100)}% policy maximum`); target = r1(max * 100); }
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

  const m = (r.market ?? {}) as Record<string, unknown>;
  const c = (r.cash ?? {}) as Record<string, unknown>;
  const summary = str(r.summary, 1500);
  if (!summary) problems.push("No summary");
  return {
    summary,
    market: { stance: ["Constructive", "Neutral", "Cautious"].includes(String(m.stance)) ? String(m.stance) : "Neutral", shortTerm: str(m.short_term, 800), longTerm: str(m.long_term, 800) },
    positions: positions.sort((a, b) => a.priority - b.priority || (b.currentPct ?? 0) - (a.currentPct ?? 0)),
    cash: { deployable: f.deployable, now: str(c.now, 800), waitFor: str(c.wait_for, 800) },
    stale: (Array.isArray(r.stale) ? (r.stale as Record<string, unknown>[]) : []).map((s) => ({ symbol: str(s?.symbol, 12).toUpperCase(), why: str(s?.why, 400) })).filter((s) => s.symbol).slice(0, 20),
    nextActions: (Array.isArray(r.next_actions) ? (r.next_actions as unknown[]) : []).map((x) => str(x, 300)).filter(Boolean).slice(0, 5),
    problems,
  };
}
