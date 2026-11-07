/**
 * Full company research written by the assistant, on request from a company page.
 * This file is pure: the instructions, reading the model's report, and checking it. Saving happens in
 * aiResearchJob.ts. A report that fails a check is still saved, but as "partial", with the problems listed,
 * so it never silently becomes the research the decision rules rely on.
 */
import { parseZone } from "./valuation";

export const RESEARCH_VERSION = "ai-research@2";

/** Cost controls for one company (more room than a question, still bounded). */
export const RESEARCH_LIMITS = { turns: 22, searches: 10, ms: 11 * 60_000, maxTokens: 16000 };

export const PHASES = [
  { n: 1, title: "Business and thesis" },
  { n: 2, title: "Financials and filings" },
  { n: 3, title: "Competition, management and capital allocation" },
  { n: 4, title: "Risks and catalysts" },
  { n: 5, title: "Valuation: bear, base and bull" },
  { n: 6, title: "Conclusion and what would change it" },
] as const;

export const RESEARCH_SYSTEM = `You are the research analyst inside Portfolio Intelligence, working for one private investor whose portfolio, policy limits, cash, reserve and stored research are given below. You are writing the company's research record: the document the app's decision rules will rely on until it is refreshed. Accuracy matters more than confidence.

How to work:
- Gather evidence before concluding. Use get_fundamentals and get_filings first, then read_document on the latest 10-Q or 10-K and the latest earnings release (8-K exhibit 99.1). Use get_quote and get_technicals for price. Use web_search for guidance, consensus estimates, competitors, management and recent news. Use get_research for any earlier research on file, which is historical: compare it with what you find and say what changed.
- Be economical but thorough: do not repeat a lookup you already have, and spend searches on what filings do not cover. A normal company takes about 4-8 searches and 3-6 documents. Read the latest earnings press release itself (if one exhibit fails, open the filing's other documents), and check any stock split, offering or acquisition you rely on in its filing.
- Before writing the report, list to yourself what you could not verify. If budget remains and a gap affects the valuation or the conclusion (share count, free cash flow, guidance, consensus estimates, the cause of a big price move), close it first. Only gaps you truly could not close go in "not_verified".
- Every number in the report comes from a source you retrieved (name it with its date) or is your calculation (show the inputs briefly) or is labeled as your estimate. Never invent figures, quotes or price targets.
- Valuation: three scenarios (bear, base, bull) with a per-share value at a stated horizon date 1-5 years out, probabilities that sum to 1, and the method (for example revenue x margin x multiple, or a simple discounted cash flow). Account for dilution, debt and converts where they matter.
- Conclusion: an action such as "Research more", "Watch", "Buy below $X", "Hold", "Trim above $X" or "Avoid". A price drop is never a reason to buy by itself, room under a policy limit is never a reason to add, and the protected reserve is never invested. Size any position within the investor's policy limits. Say what would change the call and what you could not verify.
- Write plainly, in short paragraphs. Each phase should be thorough but readable: roughly 150-450 words.

When done, reply with exactly one JSON object in a \`\`\`json fenced block and nothing else. Shape:
{
  "summary": string,                       // 2-4 sentences: the conclusion and why
  "action": string,
  "classification": string,                // e.g. "Quality compounder", "Speculative growth", "Cyclical"
  "confidence": "Low" | "Moderate" | "High",
  "thesis": string,                        // 2-4 sentences
  "reference_price": number,               // the price your valuation was compared with
  "valuation": { "bear_value": number, "bear_probability": number, "base_value": number, "base_probability": number, "bull_value": number, "bull_probability": number, "terminal_date": "YYYY-MM-DD", "method": string },
  "price_framework": [{ "price_zone": "< $35" | "$35–$50" | "> $50", "action": string }],
  "allocation": { "target_pct": number | null, "max_pct": number | null, "note": string },
  "would_change": string[],
  "not_verified": string[],
  "phases": [{ "number": 1-6, "title": string, "body_markdown": string }],   // all six: ${PHASES.map((p) => `${p.n} ${p.title}`).join("; ")}
  "sources": [{ "title": string, "url": string, "date": "YYYY-MM-DD" | null }]
}`;

export function researchQuestion(a: { symbol: string; name: string | null; today: string; price: number | null; earlier: string | null }) {
  return `Research ${a.symbol}${a.name ? ` (${a.name})` : ""} from scratch for the research record. Today is ${a.today}.${a.price ? ` The app's latest (delayed) price is $${a.price}.` : " The app has no current price; get one with get_quote."}
${a.earlier ? `Earlier research on file (historical, may be stale): ${a.earlier}` : "There is no earlier research on file."}
Work through all six phases, then give the JSON report.`;
}

/** The JSON object in the model's final reply (fenced or bare). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

export type ResearchReport = {
  conclusion: Record<string, unknown>;
  phases: { phase_number: number; title: string; body_markdown: string }[];
  sources: { title: string; url: string; document_date: string | null }[];
  summary: string;
  completeness: "complete" | "partial";
  problems: string[];
};

const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/**
 * Checks the report and turns it into the app's research record. The app's own price, when it has one,
 * becomes the reference price (the model's figure is kept for comparison), so the record is re-priced
 * against data the app can check.
 */
export function validateReport(raw: unknown, ctx: { today: string; appPrice: number | null }): ResearchReport | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "The research did not end with a readable report." };
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];

  const phases = PHASES.map((p) => {
    const got = Array.isArray(r.phases) ? (r.phases as Record<string, unknown>[]).find((x) => Number(x?.number) === p.n) : undefined;
    const body = str(got?.body_markdown, 12000);
    if (body.length < 200) problems.push(`Phase ${p.n} (${p.title}) is missing or too thin`);
    return { phase_number: p.n, title: str(got?.title, 120) || p.title, body_markdown: body };
  }).filter((p) => p.body_markdown);

  const v = (r.valuation ?? {}) as Record<string, unknown>;
  const sc = (["bear", "base", "bull"] as const).map((k) => ({ k, value: num(v[`${k}_value`]), p: num(v[`${k}_probability`]) }));
  if (sc.some((s) => s.value === null || s.value <= 0 || s.p === null || s.p < 0)) problems.push("Valuation scenarios are incomplete");
  else {
    const sum = sc.reduce((a, s) => a + s.p!, 0);
    if (Math.abs(sum - 1) > 0.02) problems.push(`Scenario probabilities add up to ${sum.toFixed(2)}, not 1`);
    if (!(sc[0].value! <= sc[1].value! && sc[1].value! <= sc[2].value!)) problems.push("Scenario values are not ordered bear ≤ base ≤ bull");
  }
  if (!isDate(v.terminal_date) || v.terminal_date <= ctx.today) problems.push("Valuation has no future horizon date");

  const zones = Array.isArray(r.price_framework) ? (r.price_framework as Record<string, unknown>[]).map((z) => ({ price_zone: str(z?.price_zone, 40), action: str(z?.action, 200) })).filter((z) => z.price_zone && z.action) : [];
  const parsedZones = zones.filter((z) => parseZone(z.price_zone, z.action));
  if (!parsedZones.length) problems.push("No usable price bands");

  const sources = Array.isArray(r.sources)
    ? (r.sources as Record<string, unknown>[]).map((s) => ({ title: str(s?.title, 300) || str(s?.url, 300), url: str(s?.url, 1000), document_date: isDate(s?.date) ? (s!.date as string) : null })).filter((s) => /^https?:\/\//.test(s.url)).slice(0, 60)
    : [];
  if (sources.length < 3) problems.push(`Only ${sources.length} usable source link${sources.length === 1 ? "" : "s"}`);

  const action = str(r.action, 200), thesis = str(r.thesis, 2000), summary = str(r.summary, 2000);
  if (!action) problems.push("No action");
  if (!thesis) problems.push("No thesis");

  const modelPrice = num(r.reference_price);
  const referencePrice = ctx.appPrice ?? modelPrice;
  if (!referencePrice) problems.push("No reference price");

  const conclusion: Record<string, unknown> = {
    action: action || null,
    classification: str(r.classification, 120) || null,
    confidence: ["Low", "Moderate", "High"].includes(String(r.confidence)) ? r.confidence : null,
    thesis: thesis || null,
    summary: summary || null,
    reference_price: referencePrice,
    reference_date: ctx.today,
    reference_price_source: ctx.appPrice ? "app quote (delayed)" : "the research's own figure",
    model_reference_price: modelPrice,
    valuation: {
      ...Object.fromEntries(sc.flatMap((s) => [[`${s.k}_value`, s.value], [`${s.k}_probability`, s.p]])),
      terminal_date: isDate(v.terminal_date) ? v.terminal_date : null,
      method: str(v.method, 1500) || null,
    },
    price_framework: parsedZones,
    allocation: r.allocation && typeof r.allocation === "object" ? r.allocation : null,
    would_change: Array.isArray(r.would_change) ? (r.would_change as unknown[]).map((x) => str(x, 400)).filter(Boolean).slice(0, 10) : [],
    not_verified: Array.isArray(r.not_verified) ? (r.not_verified as unknown[]).map((x) => str(x, 400)).filter(Boolean).slice(0, 12) : [],
    problems,
  };
  return { conclusion, phases, sources, summary, completeness: problems.length ? "partial" : "complete", problems };
}
