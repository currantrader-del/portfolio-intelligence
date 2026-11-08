/**
 * Market analysis for the portfolio's material exposures, written by the assistant on request
 * (button on the Exposure page). One run covers the few sectors, industries, themes and markets that
 * matter most for this portfolio, connects each to the portfolio's actual exposure, and says whether
 * the portfolio's risk has changed. Pure here: the prompt, picking exposures, and checking the report.
 * The job (reviewJob.ts) runs it and stores the result as a model_runs row (insert-only).
 */
import type { ExposureReport } from "./engine";
import type { LimitCheck } from "./limits";

export const REVIEW_VERSION = "exposure-review@1";
export const REVIEW_LIMITS = { turns: 18, searches: 10, ms: 10 * 60_000, maxTokens: 14000 };
export const REVIEW_KIND = { request: "exposure_review_request", result: "exposure_review" } as const;

export type Material = { dimension: string; key: string; pctOfInvestable: number; upperPct: number | null; direct: number; indirect: number; why: string };

/** The exposures worth analysing: the largest of each kind, plus any near a limit. At most 6. */
export function materialExposures(r: ExposureReport, limits: LimitCheck[]): Material[] {
  const inv = (v: number) => (r.investable ? v / r.investable : 0);
  const out: Material[] = [];
  const push = (dimension: keyof ExposureReport["dims"], key: string, why: string) => {
    const l = r.dims[dimension].lines.find((x) => x.key === key);
    if (!l || out.some((m) => m.key === key)) return;
    out.push({ dimension, key, pctOfInvestable: inv(l.value), upperPct: l.upper !== undefined ? inv(l.upper) : null, direct: l.direct, indirect: l.indirect, why });
  };
  for (const c of limits) if (c.state !== "within" && c.state !== "below_normal") { const [, d, ...k] = c.subject.split(":"); push(d as keyof ExposureReport["dims"], k.join(":"), `near or over a ${c.status} limit`); }
  const top = (d: keyof ExposureReport["dims"], n: number, min: number, why: string) => r.dims[d].lines.slice(0, n).filter((l) => inv(l.value) >= min).forEach((l) => push(d, l.key, why));
  top("industry", 2, 0.06, "largest industry");
  top("theme", 1, 0.08, "largest theme");
  top("sector", 2, 0.1, "largest sector");
  top("market", 2, 0.05, "largest market");
  return out.slice(0, 6);
}

export const REVIEW_SYSTEM = `You are the market analyst inside Portfolio Intelligence, working for one private investor whose portfolio, policy and research are below. You are analysing the investment environment of the sectors, industries, themes and markets the portfolio is most exposed to, and connecting it to their actual exposure. Accuracy matters more than confidence.

How to work:
- Call get_exposure first (dimension "all") for the portfolio's numbers, then get_briefing for today's market context.
- For each exposure you are given, gather current evidence with web_search (about 1-2 searches each; reuse results that cover several): earnings growth and estimate revisions, valuation versus its own history and versus the broad market, supply/demand and competition, the capital-spending cycle, interest-rate and economic sensitivity, relative strength and momentum (use get_technicals on a representative ETF such as SMH, XLK, VXUS, EEM, EWT, FXI, EWJ), policy, regulation and geopolitics, and the next important catalysts. Cite each fact with its source and date. Keep supporting and contradicting evidence separate.
- Then connect it to the portfolio: how much they hold (direct and through funds), which holdings carry it, and whether their risk has meaningfully changed. Use what_if in get_exposure if you suggest a change.
- Recommend one of: maintain, review (a deliberate decision is due), reduce, or research further. Never say to buy something only because the portfolio holds little of it; an under-represented sector is an opportunity only when its own evidence is strong. Room under a limit is never a reason to add.
- Label estimates as estimates. No invented numbers.

When done, reply with exactly one JSON object in a \`\`\`json fenced block and nothing else. Shape:
{
  "headline": string,                        // one sentence: the most important conclusion for this portfolio
  "exposures": [{
    "exposure": string,                      // as given
    "portfolio": string,                     // their exposure in one sentence (numbers from get_exposure)
    "condition": "favorable" | "mixed" | "deteriorating" | "unclear",
    "short_term": string,                    // next 1-3 months, one or two sentences
    "long_term": string,                     // 1-5 years
    "supporting": [string],                  // evidence for the current exposure, each with source and date
    "contradicting": [string],               // evidence against
    "risk_change": "higher" | "unchanged" | "lower" | "unclear",
    "recommendation": "maintain" | "review" | "reduce" | "research",
    "reasoning": string,                     // 2-4 sentences connecting the evidence to their holdings
    "catalysts": [string]                    // dated where possible
  }],
  "opportunities": [{ "area": string, "evidence": string, "next_step": string }],   // only if evidence supports it; may be empty
  "sources": [{ "title": string, "url": string, "date": string | null }]
}`;

export function reviewQuestion(items: Material[], today: string): string {
  const p = (x: number) => `${(x * 100).toFixed(1)}%`;
  return `Today is ${today}. Analyse the investment environment for these exposures of my portfolio and connect each to what I hold:\n${items.map((m, i) => `${i + 1}. ${m.key} (${m.dimension}): ${p(m.pctOfInvestable)} of investable capital${m.upperPct ? `, up to ${p(m.upperPct)}` : ""}; $${Math.round(m.direct)} direct, $${Math.round(m.indirect)} through funds (${m.why}).`).join("\n")}\nAlso say, briefly, whether any sector I hold little of has strong enough evidence of its own to be worth researching.`;
}

export type ReviewReport = {
  headline: string;
  exposures: { exposure: string; portfolio: string; condition: string; short_term: string; long_term: string; supporting: string[]; contradicting: string[]; risk_change: string; recommendation: string; reasoning: string; catalysts: string[] }[];
  opportunities: { area: string; evidence: string; next_step: string }[];
  sources: { title: string; url: string; date: string | null }[];
};

const s = (v: unknown, max = 1200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const arr = (v: unknown, max = 8) => (Array.isArray(v) ? v.map((x) => s(x, 500)).filter(Boolean).slice(0, max) : []);
const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);

/** Reads and checks the model's JSON. Returns problems instead of throwing so a weak report is still visible as such. */
export function validateReview(raw: unknown): { report: ReviewReport; problems: string[] } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "The analysis did not return a readable report." };
  const o = raw as Record<string, unknown>;
  const problems: string[] = [];
  const exposures = (Array.isArray(o.exposures) ? o.exposures : []).slice(0, 8).map((e) => {
    const x = (e ?? {}) as Record<string, unknown>;
    const item = {
      exposure: s(x.exposure, 120), portfolio: s(x.portfolio, 400),
      condition: oneOf(x.condition, ["favorable", "mixed", "deteriorating", "unclear"] as const, "unclear"),
      short_term: s(x.short_term, 600), long_term: s(x.long_term, 600),
      supporting: arr(x.supporting), contradicting: arr(x.contradicting),
      risk_change: oneOf(x.risk_change, ["higher", "unchanged", "lower", "unclear"] as const, "unclear"),
      recommendation: oneOf(x.recommendation, ["maintain", "review", "reduce", "research"] as const, "research"),
      reasoning: s(x.reasoning, 1200), catalysts: arr(x.catalysts, 6),
    };
    if (!item.supporting.length && !item.contradicting.length) problems.push(`${item.exposure || "An exposure"} has no cited evidence`);
    return item;
  }).filter((e) => e.exposure);
  if (!exposures.length) return { error: "The analysis covered no exposures." };
  const sources = (Array.isArray(o.sources) ? o.sources : []).map((x) => { const r = (x ?? {}) as Record<string, unknown>; return { title: s(r.title, 200), url: s(r.url, 500), date: s(r.date, 20) || null }; }).filter((x) => /^https?:\/\//.test(x.url)).slice(0, 30);
  if (!sources.length) problems.push("No sources were listed");
  const opportunities = (Array.isArray(o.opportunities) ? o.opportunities : []).map((x) => { const r = (x ?? {}) as Record<string, unknown>; return { area: s(r.area, 120), evidence: s(r.evidence, 600), next_step: s(r.next_step, 300) }; }).filter((x) => x.area).slice(0, 3);
  return { report: { headline: s(o.headline, 400) || "Market analysis of your exposures", exposures, opportunities, sources }, problems };
}
