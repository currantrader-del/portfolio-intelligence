/**
 * Builds the reading list for an investigation from SEC EDGAR and downloads the documents in full:
 * HTML and PDF are turned into text and filings are split into their items, so each material
 * section can be read completely. Download results are kept per invocation only; the state keeps
 * each document's size and hash, so later steps can download it again and confirm it is unchanged.
 */
import { getFilingHistory, SEC_USER_AGENT, type Filing } from "@/lib/market/sec";
import { htmlText } from "@/lib/intel/verify";
import { parseFilingIndex, partsOf, sha256, splitSections, type Section } from "./text";
import type { DocKind, InvDoc, ResearchType } from "./types";

export type DocText = { text: string; sections: Section[]; contentType: string };
const cache = new Map<string, DocText>();

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 PortfolioIntelligence/1.0";

/** Downloads a document and returns its full text (no length cap). */
export async function fetchDocText(url: string, form?: string | null): Promise<DocText | { error: string }> {
  const hit = cache.get(url);
  if (hit) return hit;
  let u: URL;
  try { u = new URL(url); } catch { return { error: "Not a valid URL" }; }
  const sec = /(^|\.)sec\.gov$/.test(u.hostname);
  try {
    const res = await fetch(url, { headers: { "User-Agent": sec ? SEC_USER_AGENT : BROWSER_UA, Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,*/*" }, redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(45000) });
    if (!res.ok) return { error: `HTTP ${res.status} from ${u.hostname}` };
    const type = res.headers.get("content-type") ?? "";
    let text: string;
    if (/pdf/i.test(type) || /\.pdf($|\?)/i.test(u.pathname)) {
      const buf = new Uint8Array(await res.arrayBuffer());
      const { extractText } = await import("unpdf");
      const out = await extractText(buf, { mergePages: true });
      text = String(Array.isArray(out.text) ? out.text.join("\n") : out.text).replace(/\s+/g, " ").trim();
    } else {
      const raw = await res.text();
      text = /html|xml/i.test(type) || /<html|<body|<div/i.test(raw.slice(0, 5000)) ? htmlText(raw) : raw.replace(/\s+/g, " ");
    }
    text = text.trim();
    if (text.length < 300) return { error: `Only ${text.length} characters of text (the page may need a browser or be a login wall)` };
    const out: DocText = { text, sections: splitSections(text, form ?? ""), contentType: type || "unknown" };
    cache.set(url, out);
    return out;
  } catch (e) {
    return { error: (e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message.slice(0, 120) };
  }
}

/** Records the download on the inventory entry: size, hash and sections. */
export async function attachText(d: InvDoc, t: DocText) {
  const prior = new Map((d.sections ?? []).map((s) => [s.key, s]));
  d.fetched = { chars: t.text.length, sha256: await sha256(t.text), at: new Date().toISOString(), contentType: t.contentType };
  d.sections = t.sections.map((s) => {
    const parts = partsOf(s.end - s.start).length;
    const p = prior.get(s.key);
    return { key: s.key, label: s.label, chars: s.end - s.start, material: s.material, parts, reviewedParts: p && p.parts === parts ? p.reviewedParts : [] };
  });
  if (d.status !== "reviewed_earlier") d.status = "retrieved";
  d.unavailable_reason = null;
}

export function sectionText(t: DocText, key: string): string | null {
  const s = t.sections.find((x) => x.key === key);
  return s ? t.text.slice(s.start, s.end) : null;
}

async function filingIndex(f: Filing): Promise<ReturnType<typeof parseFilingIndex>> {
  if (!f.accession) return [];
  const m = f.url.match(/^(https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18})\//);
  if (!m) return [];
  const url = `${m[1]}/${f.accession}-index.htm`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT }, cache: "no-store", signal: AbortSignal.timeout(20000) });
    return res.ok ? parseFilingIndex(await res.text(), url) : [];
  } catch { return []; }
}

const isFinancing = (f: Filing) => /^424B|^S-3|^S-1|^F-3/.test(f.form) || (f.form.startsWith("8-K") && f.items.some((i) => ["1.01", "2.03", "3.02"].includes(i)));
const monthsBefore = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };

/**
 * The reading list. Full investigation: the latest annual report, every quarterly report since, the
 * latest earnings release with its exhibits, financing filings and executive changes of the last
 * 12 months, the latest proxy, and placeholders for the earnings call transcript and the investor
 * presentation (found later from the company's website). Refresh: only what was filed after `since`.
 */
export async function buildInventory(a: { symbol: string; type: ResearchType; today: string; since: string | null }): Promise<{ cik: string; company: string; docs: InvDoc[]; notes: string[] } | { error: string }> {
  const h = await getFilingHistory(a.symbol, 400);
  if ("error" in h) return h;
  const notes: string[] = [];
  const docs: InvDoc[] = [];
  let n = 0;
  const add = (x: Omit<InvDoc, "id" | "status">) => { if (docs.some((d) => d.url === x.url && x.url)) return; docs.push({ ...x, id: `D${++n}`, status: "retrieved" }); };
  const fromFiling = (f: Filing, kind: DocKind, required: boolean, phases: number[], why: string, url = f.url, title?: string): Omit<InvDoc, "id" | "status"> =>
    ({ kind, title: title ?? `${f.form} filed ${f.filed}${f.description ? ` (${f.description})` : ""}`, url, form: f.form, filed: f.filed, accession: f.accession ?? null, required, phases, why, origin: "sec" });

  const fl = h.filings;
  const refresh = a.type === "material_event_refresh";
  const since = refresh ? a.since ?? monthsBefore(a.today, 4) : null;
  const tenK = fl.find((f) => /^(10-K|20-F|40-F)$/.test(f.form));
  const window12 = monthsBefore(a.today, 12);

  const earnings8k = (list: Filing[]) => list.filter((f) => f.form.startsWith("8-K") && f.items.includes("2.02"));
  const addExhibits = async (f: Filing, kindFirst: DocKind, required: boolean, phases: number[], why: string) => {
    const idx = await filingIndex(f);
    const ex = idx.filter((d) => /^EX-99/i.test(d.type) && /\.(htm|html|pdf|txt)$/i.test(d.document));
    if (!ex.length) { add(fromFiling(f, kindFirst, required, phases, why)); return; }
    ex.forEach((d, i) => add(fromFiling(f, i === 0 ? kindFirst : "earnings_exhibit", required, phases, why, d.url, `${f.form} ${f.filed} ${d.type}${d.description ? `: ${d.description}` : ""}`)));
  };

  if (!refresh) {
    if (tenK) add(fromFiling(tenK, tenK.form === "20-F" ? "20-F" : "10-K", true, [1, 2, 4], "Latest annual report: business, risks, MD&A, financial statements and notes"));
    else notes.push("No annual report (10-K/20-F) found in EDGAR.");
    for (const q of fl.filter((f) => f.form === "10-Q" && (!tenK || f.filed > tenK.filed))) add(fromFiling(q, "10-Q", true, [2, 4], "Quarterly report filed since the annual report"));
    const e = earnings8k(fl)[0];
    if (e) await addExhibits(e, "earnings_release", true, [2], "Latest earnings release and its exhibits");
    else notes.push("No earnings 8-K (item 2.02) found; the company may report results only in its 10-Q/10-K.");
    for (const f of fl.filter((x) => isFinancing(x) && x.filed >= window12).slice(0, 8)) add(fromFiling(f, "financing", true, [3], "Financing or material agreement in the last 12 months: terms, dilution, obligations"));
    const extra = fl.filter((x) => isFinancing(x) && x.filed >= window12).length - 8;
    if (extra > 0) notes.push(`${extra} older financing filings in the last 12 months were not put on the reading list (the 8 most recent were).`);
    const proxy = fl.find((f) => f.form === "DEF 14A" && f.filed >= monthsBefore(a.today, 15));
    if (proxy) add(fromFiling(proxy, "proxy", true, [3], "Latest proxy: management pay, incentives, board, related parties"));
    for (const f of fl.filter((x) => x.form.startsWith("8-K") && x.items.includes("5.02") && x.filed >= window12).slice(0, 4)) add(fromFiling(f, "material_8k", true, [3], "Executive or director change"));
    for (const f of fl.filter((x) => x.form.startsWith("8-K") && !x.items.includes("2.02") && !isFinancing(x) && !x.items.includes("5.02") && x.filed >= monthsBefore(a.today, 6)).slice(0, 6)) add(fromFiling(f, "material_8k", false, [4], "Other recent company event"));
  } else {
    const after = fl.filter((f) => f.filed > since!);
    for (const q of after.filter((f) => /^(10-Q|10-K|20-F)$/.test(f.form))) add(fromFiling(q, q.form === "10-Q" ? "10-Q" : q.form === "20-F" ? "20-F" : "10-K", true, [2], "New financial report since the earlier research"));
    for (const e of earnings8k(after)) await addExhibits(e, "earnings_release", true, [2], "New earnings release since the earlier research");
    for (const f of after.filter(isFinancing).slice(0, 8)) add(fromFiling(f, "financing", true, [2], "New financing or material agreement since the earlier research"));
    for (const f of after.filter((x) => x.form.startsWith("8-K") && x.items.includes("5.02")).slice(0, 4)) add(fromFiling(f, "material_8k", true, [2], "Executive or director change since the earlier research"));
    for (const f of after.filter((x) => x.form.startsWith("8-K") && !x.items.includes("2.02") && !isFinancing(x) && !x.items.includes("5.02")).slice(0, 8)) add(fromFiling(f, "material_8k", true, [2], "Other company event since the earlier research"));
    if (!docs.length) notes.push(`Nothing new filed with the SEC since ${since}.`);
  }
  const hadEarnings = refresh ? earnings8k(fl.filter((f) => f.filed > since!)).length > 0 : true;
  const phT = refresh ? [2] : [2, 3];
  const phP = refresh ? [2] : [1, 2];
  if (hadEarnings) {
    docs.push({ id: `D${++n}`, kind: "transcript", title: "Latest earnings call transcript, including Q&A", url: "", required: true, phases: phT, why: "Management's explanation of results and guidance, and the analyst Q&A", origin: "company", status: "unavailable", unavailable_reason: "Not searched yet", attempts: [] });
    docs.push({ id: `D${++n}`, kind: "presentation", title: "Latest investor or earnings presentation", url: "", required: true, phases: phP, why: "How management frames the business, segments and targets", origin: "company", status: "unavailable", unavailable_reason: "Not searched yet", attempts: [] });
  }
  return { cik: h.cik, company: h.company, docs, notes };
}
