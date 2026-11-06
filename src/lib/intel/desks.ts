/**
 * Research desks for the daily briefing. Each desk is one Claude call with web search, asked for
 * dated, sourced items. The parsing and checking here is pure and tested: every source a desk
 * cites is checked against the pages its own searches actually returned, and an item with no
 * checked source is kept but marked unsourced, never presented as verified.
 */
import type { ClaimCheck, EventCheck } from "./verify";
import type { Snapshot } from "./snapshot";

export const DESK_VERSION = "desk@3";
export type DeskKey = "world" | "us" | "markets" | "events" | "holdings";
export const DESKS: { key: DeskKey; title: string; brief: string }[] = [
  {
    key: "world",
    title: "World and geopolitics",
    brief: `Cover the last 24-72 hours: wars and conflicts, relations between major powers, trade policy and tariffs, sanctions, energy markets (oil, gas, OPEC+), and economic news from Europe, China, Japan and emerging markets that matters to US investors. Explain how each development connects to markets, if it does.`,
  },
  {
    key: "us",
    title: "US economy and policy",
    brief: `Cover the last 24-72 hours and what is scheduled next: the Federal Reserve (decisions, speeches, minutes, balance sheet), inflation, jobs, growth and consumer data, fiscal policy and Treasury issuance, government announcements, credit conditions and liquidity, and financial regulation. For each data release give the actual figure, the prior figure and the consensus expectation when a source states one.`,
  },
  {
    key: "markets",
    title: "Markets, sectors and catalysts",
    brief: `Cover the last 1-5 sessions: which US sectors and industries led and lagged and what sources say drove it, earnings season results and guidance, estimate revisions, analyst sentiment, positioning and risk appetite (fund flows, surveys, options activity) where a source reports it, and news on the companies listed in the portfolio context. Leave the calendar empty; another desk builds it.`,
  },
  {
    // Split from the markets desk: one desk doing both ran past the hosting time limit (2026-11-06).
    key: "events",
    title: "Upcoming events",
    brief: `The app has already read the official BLS, BEA and Federal Reserve calendars (listed below); do not repeat those events. Your job: find confirmed earnings dates for the companies in the portfolio context (holdings first, then watchlist) within the next 15 trading days, plus any other important scheduled catalysts the official list lacks (Treasury auctions that sources flag as important, major policy deadlines). For earnings, search for the company's own announcement ("<company> to report / sets date / conference call") and cite its investor-relations or newsroom page or its release on a newswire; cite an earnings-calendar site only when nothing official exists, and mark that "estimated". Build only the calendar of scheduled catalysts for the next 15 trading days: US economic releases (with the consensus when a source states one), Federal Reserve meetings, minutes and major speeches, Treasury auctions that sources flag as important, market holidays, and earnings dates for the companies listed in the portfolio context (confirmed by the company or estimated). Each date is shown as "confirmed" only if the app can find it on an official page, so cite the official page itself: the agency's release schedule (bls.gov/schedule, bea.gov/news/schedule, census.gov economic indicators calendar, federalreserve.gov/monetarypolicy/fomccalendars.htm, treasurydirect.gov auctions), and for earnings the company's own investor-relations page or its press release on businesswire.com, globenewswire.com or prnewswire.com (search "<company> announces date of earnings release"). If only an earnings-calendar site or news article gives a date, cite it and mark the event "estimated". Return items only for a scheduling change that is itself news.`,
  },
  {
    // Built by code, not searched: SEC filings, research records and filing checks (holdings.ts).
    key: "holdings",
    title: "Holdings: filings and research",
    brief: "",
  },
];
/** Desks that are web research (one Claude call each); the holdings desk is read by code. */
export const SEARCH_DESKS: DeskKey[] = ["world", "us", "markets", "events"];

/** "verified" survives only a content check against the source; otherwise it becomes "reported". */
export type Kind = "verified" | "reported" | "company_claim" | "statistical" | "calculation" | "interpretation" | "speculation";
export type Source = { url: string; title: string; publisher: string | null; published: string | null; checked: boolean };
export type Item = { headline: string; detail: string; kind: Kind; significance: "high" | "medium" | "low"; sources: Source[]; portfolio: string | null; unsourced: boolean; check?: ClaimCheck; period?: string | null; claimedKind?: Kind };
export type CalendarEvent = { date: string; time: string | null; event: string; type: "economic" | "fed" | "earnings" | "policy" | "auction" | "other"; status: "confirmed" | "estimated"; expectation: string | null; why: string; symbols: string[]; source: Source | null; check?: EventCheck };
export type DeskResult = {
  version: string; desk: DeskKey; title: string; generatedAt: string; model: string;
  items: Item[]; calendar: CalendarEvent[]; uncertainties: string[];
  searches: number; pagesReturned: number; problems: string[];
  usage: { input: number; output: number; searches: number };
  /** Added 2026-11-06 (desk@2): job outcome, timing and request log. */
  status?: "ok" | "failed";
  error?: string | null;
  startedAt?: string;
  ms?: number;
  requests?: { kind: "model" | "page"; ms: number; detail: string; ok: boolean }[];
};

const KINDS: Kind[] = ["verified", "reported", "company_claim", "statistical", "calculation", "interpretation", "speculation"];

export function deskSystem() {
  return `You are a research desk for a private investor's daily market briefing. You search the web and report what happened, with sources. You do not give buy or sell advice.

Rules:
- Use web search. Prefer primary sources (federalreserve.gov, bls.gov, bea.gov, treasury.gov, sec.gov, company releases) and established news organizations (Reuters, AP, Bloomberg, WSJ, FT, CNBC, MarketWatch). Note the publication date of every source.
- Report only what a source you found states. Never invent a figure, a quote, an expectation or a date. If sources disagree, say so.
- Label every item with one kind:
  "verified" = a fact (an event, a decision, a data release) that the cited page itself states; the app re-reads the page and downgrades it to "reported" if the page does not support it;
  "company_claim" = what a company says about itself (results commentary, guidance, projections), attributed to the company;
  "statistical" = a market or data observation (a move, a level, a reading);
  "calculation" = a figure you derived from stated numbers; show the inputs;
  "interpretation" = an explanation a source or you put forward for why something happened or matters; say whose it is;
  "speculation" = a possibility, rumor or forecast that is not established.
- Do not explain a market move unless a source links the cause to the move. Otherwise say the cause is not established.
- Market numbers in the snapshot below come from the app's data feed and are authoritative for levels and moves; do not restate different numbers for the same instruments.
- Keep each item short: one headline, then two to four plain sentences.
- Finish with ONLY a JSON object in a \`\`\`json fenced block, nothing after it, shaped like:
{"items":[{"headline":"...","detail":"...","kind":"verified|company_claim|statistical|calculation|interpretation|speculation","significance":"high|medium|low","period":"the reporting period the figures cover, e.g. October 2026 or Q1 FY2027, or null","portfolio":"why it matters to the listed holdings, or null","sources":[{"url":"https://...","title":"...","publisher":"...","published":"YYYY-MM-DD or null"}]}],
 "calendar":[{"date":"YYYY-MM-DD","time":"HH:MM ET or null","event":"...","type":"economic|fed|earnings|policy|auction|other","status":"confirmed|estimated","expectation":"consensus or guidance as a source states it, or null","why":"what it could change","symbols":["IREN"],"source":{"url":"https://...","title":"...","publisher":"...","published":"YYYY-MM-DD or null"}}],
 "uncertainties":["what you could not confirm or find"]}
Use an empty calendar list unless your brief asks for one. Every item needs at least one source URL that your searches returned.`;
}

export type DeskContext = { now: Date; snapshot: Snapshot; holdings: string[]; watch: string[]; names?: Record<string, string>; extra?: string };

export function deskPrompt(desk: (typeof DESKS)[number], ctx: DeskContext) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ctx.now);
  const rows = ctx.snapshot.rows.map((r) => `${r.label}: ${r.kind === "yield" ? `${r.last.toFixed(2)}%` : r.last.toFixed(2)}, day ${fmtChange(r.day, r.kind)}, 1m ${fmtChange(r.month, r.kind)} (${r.freshness}, ${r.marketTime})`).join("\n");
  return `Now: ${day} (New York).
Desk: ${desk.title}.
${desk.brief}

Portfolio context: holdings ${ctx.holdings.map((h) => (ctx.names?.[h] ? `${h} (${ctx.names[h]})` : h)).join(", ") || "none on file"}; watchlist ${ctx.watch.slice(0, 15).join(", ") || "none"}.
${ctx.extra ? `\n${ctx.extra}\n` : ""}
App market snapshot (authoritative numbers):
${rows}`;
}

export function fmtChange(v: number | null, kind: "price" | "yield") {
  if (v === null) return "n/a";
  return kind === "yield" ? `${v >= 0 ? "+" : ""}${Math.round(v)}bp` : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}

/** Every page the model's searches returned, found anywhere in the response content (search result blocks and citations). */
export function collectSearchPages(content: unknown): Map<string, { title: string; pageAge: string | null }> {
  const out = new Map<string, { title: string; pageAge: string | null }>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if ((o.type === "web_search_result" || o.type === "web_search_result_location") && typeof o.url === "string") {
      const prev = out.get(norm(o.url));
      out.set(norm(o.url), { title: String(o.title ?? prev?.title ?? ""), pageAge: (o.page_age as string | null) ?? prev?.pageAge ?? null });
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  walk(content);
  return out;
}

export const norm = (u: string) => u.trim().replace(/#.*$/, "").replace(/\/$/, "").replace(/^http:/, "https:").replace(/^https:\/\/www\./, "https://");

/** The last ```json block in the text, or the last {...} span when the fence is missing. */
export function extractJson(text: string): unknown | null {
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const candidates = fences.length ? [fences[fences.length - 1][1]] : [text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* next */ }
  }
  return null;
}

const str = (v: unknown, max = 600) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const isoDate = (v: unknown) => { const s = str(v, 40); const m = s?.match(/\d{4}-\d{2}-\d{2}/); return m ? m[0] : null; };

function source(raw: unknown, pages: Map<string, { title: string; pageAge: string | null }>): Source | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const url = str(o.url, 1000);
  if (!url || !/^https?:\/\//.test(url)) return null;
  const hit = pages.get(norm(url));
  let publisher = str(o.publisher, 80);
  if (!publisher) { try { publisher = new URL(url).hostname.replace(/^www\./, ""); } catch { publisher = null; } }
  return { url, title: str(o.title, 200) ?? hit?.title ?? url, publisher, published: isoDate(o.published) ?? isoDate(hit?.pageAge), checked: !!hit };
}

/** Turns a desk's JSON into checked items. Anything malformed is dropped and counted as a problem. */
export function validateDesk(raw: unknown, pages: Map<string, { title: string; pageAge: string | null }>, now: Date) {
  const problems: string[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  if (!raw) problems.push("The desk did not return readable JSON");
  const items: Item[] = [];
  for (const r of Array.isArray(o.items) ? o.items : []) {
    const x = r as Record<string, unknown>;
    const headline = str(x.headline, 200), detail = str(x.detail, 1200);
    if (!headline || !detail) { problems.push("Dropped an item without a headline or detail"); continue; }
    const sources = (Array.isArray(x.sources) ? x.sources : []).map((s) => source(s, pages)).filter((s): s is Source => !!s);
    const kind = KINDS.includes(x.kind as Kind) ? (x.kind as Kind) : "interpretation";
    const sig = x.significance === "high" || x.significance === "low" ? x.significance : "medium";
    const unsourced = !sources.some((s) => s.checked);
    // A "verified" label needs a source the search actually returned.
    items.push({ headline, detail, kind: unsourced && kind === "verified" ? "reported" : kind, claimedKind: kind, significance: sig, sources, portfolio: str(x.portfolio, 500), unsourced, period: str(x.period, 60) });
    if (unsourced) problems.push(`"${headline.slice(0, 60)}" has no source that the search returned`);
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const calendar: CalendarEvent[] = [];
  for (const r of Array.isArray(o.calendar) ? o.calendar : []) {
    const x = r as Record<string, unknown>;
    const date = isoDate(x.date), event = str(x.event, 200);
    if (!date || !event) continue;
    if (date < today) continue; // a calendar holds only dates still ahead
    const types = ["economic", "fed", "earnings", "policy", "auction", "other"] as const;
    const src = source(x.source, pages);
    calendar.push({
      date, time: str(x.time, 30), event, type: types.includes(x.type as (typeof types)[number]) ? (x.type as CalendarEvent["type"]) : "other",
      // "confirmed" needs a checked source; otherwise it is an estimate.
      status: x.status === "confirmed" && src?.checked ? "confirmed" : "estimated",
      expectation: str(x.expectation, 200), why: str(x.why, 400) ?? "", symbols: (Array.isArray(x.symbols) ? x.symbols : []).map((s) => String(s).toUpperCase().slice(0, 10)).slice(0, 8), source: src,
    });
  }
  calendar.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  const uncertainties = (Array.isArray(o.uncertainties) ? o.uncertainties : []).map((u) => str(u, 300)).filter((u): u is string => !!u);
  return { items, calendar, uncertainties, problems };
}
