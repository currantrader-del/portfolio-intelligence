/**
 * Checks a desk's claims against the pages they cite, by code: the cited page is fetched and the
 * figures in a "verified" item (or the date of a calendar event) must appear in its text. A page
 * that cannot be read is reported as such, never counted as a confirmation. Calendar events are
 * "confirmed" only when an official source (the company's investor-relations site or newswire
 * release, an SEC filing, or the agency that publishes the data) shows the date.
 */
import type { CalendarEvent, Item, Source } from "./desks";

/** matched = the page supports the claim (quote found, figures found); primary = read from the official record itself (SEC). */
export type CheckStatus = "matched" | "primary" | "partial" | "unsupported" | "not_found" | "unreachable" | "not_checked";
export type ClaimCheck = { status: CheckStatus; url: string | null; found: string[]; missing: string[]; note: string; quote?: string | null; retrievedAt?: string | null; support?: Support | null };
export type Support = "supported" | "partial" | "unsupported" | "insufficient";
export type EventCheck = { official: boolean; dateFound: boolean | null; url: string | null; note: string; retrievedAt?: string };

// ---------- figures ----------

const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, tn: 1e12, trillion: 1e12 };
const NUM = /(\$|€|£)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(%|bps?\b|basis points|k\b|thousand|mn\b|m\b|million|bn\b|b\b|billion|tn\b|t\b|trillion))?(?!\d)/gi;

/** Numeric values a token can stand for, e.g. "165,000" -> 165000; "$3.45B" -> 3.45 and 3.45e9. */
function values(intPart: string, frac: string | undefined, unit: string | undefined) {
  const raw = Number(intPart.replace(/,/g, "") + (frac ?? ""));
  const m = unit ? MULT[unit.toLowerCase()] : undefined;
  return m ? [raw, raw * m] : [raw];
}

/** Figures worth checking in a claim: amounts, percentages, decimals and numbers of 3+ digits, but not years or dates. */
export function claimFigures(text: string): { label: string; values: number[] }[] {
  const out: { label: string; values: number[] }[] = [];
  const clean = text.replace(/\b(19|20)\d{2}-\d{2}-\d{2}\b/g, " ").replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b/gi, " ");
  for (const m of clean.matchAll(NUM)) {
    const [label, cur, int, frac, unit] = m;
    const n = Number(int.replace(/,/g, ""));
    const isYear = !frac && !unit && !cur && n >= 1990 && n <= 2040;
    const meaningful = !!frac || !!unit || !!cur || int.includes(",") || int.length >= 3;
    if (isYear || !meaningful) continue;
    out.push({ label: label.trim(), values: values(int, frac, unit) });
  }
  const seen = new Set<string>();
  return out.filter((f) => (seen.has(f.label) ? false : (seen.add(f.label), true))).slice(0, 8);
}

/** Every numeric value on the page, in the same forms. */
export function pageValues(text: string): Set<number> {
  const set = new Set<number>();
  for (const m of text.matchAll(NUM)) for (const v of values(m[2], m[3], m[4])) set.add(Math.round(v * 1e6) / 1e6);
  return set;
}

export function matchFigures(figs: { label: string; values: number[] }[], page: Set<number>) {
  const found: string[] = [], missing: string[] = [];
  for (const f of figs) (f.values.some((v) => page.has(Math.round(v * 1e6) / 1e6)) ? found : missing).push(f.label);
  return { found, missing };
}

/** Readable text from HTML: scripts, styles and tags removed, entities decoded. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#36;|&dollar;/g, "$").replace(/&#8217;|&rsquo;/g, "'").replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ");
}

// ---------- dates ----------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Whether the page text shows this date in a common form ("November 17, 2026", "Nov. 17", "11/17/2026", "2026-11-17", "17 November"). */
export function dateOnPage(iso: string, text: string): boolean {
  const [y, mo, d] = iso.split("-").map(Number);
  const full = MONTHS[mo - 1], short = full.slice(0, 3);
  const pats = [
    `${full}\\s+${d}(?:st|nd|rd|th)?\\b`, `${short}\\.?\\s+${d}(?:st|nd|rd|th)?\\b`, `\\b${d}(?:st|nd|rd|th)?\\s+(?:${full}|${short})\\b`,
    `\\b0?${mo}/0?${d}/(?:${y}|${String(y).slice(2)})\\b`, `\\b${iso}\\b`,
  ];
  return pats.some((p) => new RegExp(p, "i").test(text));
}

// ---------- official sources ----------

const AGGREGATORS = /(^|\.)(earningswhispers|wallstreethorizon|tipranks|zacks|marketbeat|benzinga|seekingalpha|investing|fool|marketwatch|barchart|nasdaq|finance\.yahoo|yahoo|cnbc|reuters|bloomberg|stocktitan|stockanalysis|marketchameleon|earningshub|alphaspread|macrotrends|financecharts|fedratecalc|cmelitegroup|forexfactory|fxstreet|tradingeconomics|investopedia)\./i;
const NEWSWIRES = /(^|\.)(businesswire|globenewswire|prnewswire|accessnewswire|accesswire|newsfilecorp|newswire)\.(com|ca)$/i;
const AGENCIES = /(^|\.)(bls\.gov|bea\.gov|census\.gov|federalreserve\.gov|newyorkfed\.org|treasury\.gov|treasurydirect\.gov|dol\.gov|fiscal\.treasury\.gov|sca\.isr\.umich\.edu|conference-board\.org|ismworld\.org|nyse\.com|sifma\.org|opm\.gov|whitehouse\.gov|sec\.gov)$/i;

/** Whether a source is official for this kind of event. Aggregators and news sites never are. */
export function officialFor(type: CalendarEvent["type"], url: string, companies: string[] = []): boolean {
  let host = "", path = "";
  try { const u = new URL(url); host = u.hostname.replace(/^www\./, ""); path = u.pathname.toLowerCase(); } catch { return false; }
  if (AGGREGATORS.test(`${host}.`)) return false;
  if (type === "earnings") {
    return NEWSWIRES.test(host) || /(^|\.)sec\.gov$/i.test(host) || /^(ir|investors?|investor-relations|investorrelations)\./i.test(host) || /\/(investors?|investor-relations|ir)(\/|$)/.test(path) || companyDomain(host, companies);
  }
  return AGENCIES.test(host);
}

/** The company's own site: its registrable domain is the company's first name word (nvidianews.nvidia.com for NVIDIA, iren.com for IREN). */
export function companyDomain(host: string, companies: string[]): boolean {
  const labels = host.toLowerCase().split(".");
  if (labels.length < 2) return false;
  const sld = labels[labels.length - 2];
  return companies.some((name) => {
    const word = name.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).find((w) => w.length >= 3);
    return !!word && (sld === word || sld === `${word}corp` || sld === `${word}inc`);
  });
}

// ---------- page fetching ----------

export type PageFetch = { ok: boolean; status: number | null; ms: number; text: string; error: string | null };
export type Fetcher = (url: string) => Promise<PageFetch>;

export function pageFetcher(timeoutMs = 8000, userAgent = "Mozilla/5.0 (compatible; PortfolioIntelligence/1.0; source check)"): Fetcher & { log: { url: string; status: number | null; ms: number; ok: boolean; error: string | null }[] } {
  const cache = new Map<string, Promise<PageFetch>>();
  const log: { url: string; status: number | null; ms: number; ok: boolean; error: string | null }[] = [];
  const f = (url: string) => {
    if (!cache.has(url)) cache.set(url, (async () => {
      const t0 = Date.now();
      try {
        const res = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml,text/plain" }, redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
        const body = res.ok ? (await res.text()).slice(0, 2_000_000) : "";
        const r = { ok: res.ok && body.length > 200, status: res.status, ms: Date.now() - t0, text: res.ok ? htmlText(body) : "", error: res.ok ? (body.length > 200 ? null : "empty page") : `HTTP ${res.status}` };
        log.push({ url, status: r.status, ms: r.ms, ok: r.ok, error: r.error });
        return r;
      } catch (e) {
        const r = { ok: false, status: null, ms: Date.now() - t0, text: "", error: (e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message.slice(0, 80) };
        log.push({ url, status: null, ms: r.ms, ok: false, error: r.error });
        return r;
      }
    })());
    return cache.get(url)!;
  };
  return Object.assign(f, { log });
}

// ---------- checks ----------

export async function checkItem(item: Item, fetchPage: Fetcher): Promise<ClaimCheck> {
  if (item.kind !== "verified" && item.kind !== "company_claim") return { status: "not_checked", url: null, found: [], missing: [], note: `${item.kind} items are not checked against pages` };
  const figs = claimFigures(`${item.headline}. ${item.detail}`);
  const sources = item.sources.filter((s) => s.checked).slice(0, 3);
  if (!sources.length) return { status: "not_checked", url: null, found: [], missing: figs.map((f) => f.label), note: "no source returned by the search" };
  let best: ClaimCheck | null = null;
  for (const s of sources) {
    const p = await fetchPage(s.url);
    if (!p.ok) { best ??= { status: "unreachable", url: s.url, found: [], missing: figs.map((f) => f.label), note: `the page could not be read (${p.error})` }; continue; }
    if (!figs.length) return { status: "matched", url: s.url, found: [], missing: [], note: "page read; the claim has no figures to compare" };
    const { found, missing } = matchFigures(figs, pageValues(p.text));
    const c: ClaimCheck = { status: !missing.length ? "matched" : found.length ? "partial" : "not_found", url: s.url, found, missing, note: !missing.length ? "every figure appears on the page" : `not on the page: ${missing.join(", ")}` };
    if (c.status === "matched") return c;
    if (!best || best.status === "unreachable" || (c.status === "partial" && best.status === "not_found")) best = c;
  }
  return best!;
}

export async function checkEvent(ev: CalendarEvent, fetchPage: Fetcher, names: Record<string, string> = {}): Promise<{ status: CalendarEvent["status"]; check: EventCheck }> {
  const src: Source | null = ev.source;
  if (!src) return { status: "estimated", check: { official: false, dateFound: null, url: null, note: "no source" } };
  const official = officialFor(ev.type, src.url, ev.symbols.map((s) => names[s]).filter(Boolean));
  if (!official) return { status: "estimated", check: { official: false, dateFound: null, url: src.url, note: ev.type === "earnings" ? "not confirmed by the company (source is not its investor-relations site or release)" : "source is not the official publisher" } };
  const p = await fetchPage(src.url);
  if (!p.ok) return { status: "estimated", check: { official, dateFound: null, url: src.url, note: `official page could not be read (${p.error})` } };
  const found = dateOnPage(ev.date, p.text);
  const retrievedAt = new Date().toISOString();
  return { status: found ? "confirmed" : "estimated", check: { official, dateFound: found, url: src.url, note: found ? "date shown on the official page" : "official page read, but this date is not on it", retrievedAt } };
}

// ---------- content support ----------

const norm = (t: string) => t.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();

/** The sentences of a page most related to a claim (shared figures and words), for the content check. */
export function excerptFor(claim: string, text: string, max = 1800): string {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 30 && s.length < 600);
  const figs = new Set(claimFigures(claim).flatMap((f) => f.values.map((v) => Math.round(v * 1e6) / 1e6)));
  const words = new Set(norm(claim).split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const scored = sentences.map((s, i) => {
    const vals = pageValues(s);
    const f = [...vals].filter((v) => figs.has(v)).length;
    const w = norm(s).split(/[^a-z0-9]+/).filter((x) => words.has(x)).length;
    return { i, s, score: f * 3 + w };
  }).filter((x) => x.score > 1).sort((a, b) => b.score - a.score);
  const picked: typeof scored = [];
  let len = 0;
  for (const x of scored) { if (len + x.s.length > max) break; picked.push(x); len += x.s.length; }
  return picked.sort((a, b) => a.i - b.i).map((x) => x.s).join(" … ");
}

/** A quote counts only if it is really on the page (after whitespace and quote-mark normalisation). */
export function quoteOnPage(quote: string | null | undefined, text: string): boolean {
  if (!quote || quote.trim().length < 20) return false;
  return norm(text).includes(norm(quote).replace(/^"|"$/g, ""));
}

/** Combines the figure check and the content judgement into the final status and kind. */
export function finalCheck(item: Item, figure: ClaimCheck, judged: { support: Support; quote: string | null } | null, pageText: string | null, retrievedAt: string): { check: ClaimCheck; kind: Item["kind"] } {
  const base = { ...figure, retrievedAt };
  if (figure.status === "not_checked" || figure.status === "unreachable" || pageText === null) {
    return { check: base, kind: item.kind === "verified" ? "reported" : item.kind };
  }
  const quoteOk = quoteOnPage(judged?.quote, pageText);
  const support = judged ? (judged.support === "supported" && !quoteOk ? "insufficient" : judged.support) : "insufficient";
  const figuresOk = figure.missing.length === 0;
  let status: CheckStatus;
  let note: string;
  if (support === "supported" && figuresOk) { status = "matched"; note = figure.found.length ? "the page states this; every figure appears on it" : "the page states this"; }
  else if (support === "unsupported") { status = "unsupported"; note = "the cited page does not support this claim"; }
  else if (support === "supported" || support === "partial") { status = "partial"; note = figure.missing.length ? `partly supported; not on the page: ${figure.missing.join(", ")}` : "the page supports only part of this claim"; }
  else { status = figure.found.length && figuresOk ? "partial" : "not_found"; note = quoteOk ? "no supporting passage confirmed" : "no supporting passage found on the page"; }
  const check: ClaimCheck = { ...base, status, note, quote: quoteOk ? judged!.quote : null, support };
  const kind = status === "matched" ? item.kind : item.kind === "verified" ? "reported" : item.kind;
  return { check, kind };
}
