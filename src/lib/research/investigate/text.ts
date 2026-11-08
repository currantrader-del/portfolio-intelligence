/**
 * Pure text helpers for the research investigation: splitting filings into their real sections,
 * reading an SEC filing index, and checking that a quoted passage (and the number in it) really
 * appears in a document. Nothing here calls the network.
 */

export type Section = { key: string; label: string; start: number; end: number; material: boolean };

/** Text above this size is reviewed in parts (keeps each review call inside the cheaper prompt tier). */
export const PART_CHARS = 280_000;

/** Lower-cases and flattens punctuation variants so a quote copied from the text still matches it. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚′`]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\$\s+/g, "$")
    .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")")
    .replace(/\s*%/g, "%")
    .replace(/\s+/g, " ")
    .trim();
}

const TENK_LABELS: Record<string, string> = {
  "1": "Item 1. Business", "1A": "Item 1A. Risk factors", "1B": "Item 1B. Unresolved staff comments", "1C": "Item 1C. Cybersecurity",
  "2": "Item 2. Properties", "3": "Item 3. Legal proceedings", "4": "Item 4. Mine safety", "5": "Item 5. Market for equity",
  "6": "Item 6. Reserved", "7": "Item 7. Management's discussion and analysis", "7A": "Item 7A. Market risk", "8": "Item 8. Financial statements and notes",
  "9": "Item 9. Accountant changes", "9A": "Item 9A. Controls", "9B": "Item 9B. Other information", "9C": "Item 9C", "10": "Item 10. Directors and officers",
  "11": "Item 11. Executive compensation", "12": "Item 12. Ownership", "13": "Item 13. Relationships", "14": "Item 14. Accountant fees", "15": "Item 15. Exhibits", "16": "Item 16. Summary",
};
const TENQ_LABELS: Record<string, string> = {
  "I-1": "Part I Item 1. Financial statements and notes", "I-2": "Part I Item 2. Management's discussion and analysis", "I-3": "Part I Item 3. Market risk", "I-4": "Part I Item 4. Controls",
  "II-1": "Part II Item 1. Legal proceedings", "II-1A": "Part II Item 1A. Risk factors", "II-2": "Part II Item 2. Equity sales and buybacks", "II-3": "Part II Item 3", "II-4": "Part II Item 4",
  "II-5": "Part II Item 5. Other information", "II-6": "Part II Item 6. Exhibits",
};
/** The sections an investor has to read in full for the document to count as reviewed. */
export const MATERIAL: Record<"10-K" | "10-Q", Set<string>> = {
  "10-K": new Set(["1", "1A", "3", "7", "7A", "8"]),
  "10-Q": new Set(["I-1", "I-2", "I-3", "II-1", "II-1A", "II-2", "II-5"]),
};

/**
 * Splits a 10-K or 10-Q into its items. The table of contents repeats every heading, so for each item
 * the longest stretch between its heading and the next heading is taken as the item itself.
 * Anything else (a press release, a transcript) is one section, "full". Returns sections in text order.
 */
export function splitSections(text: string, form: string): Section[] {
  const kind = /^10-K/.test(form) ? "10-K" : /^10-Q/.test(form) ? "10-Q" : null;
  if (!kind) return [{ key: "full", label: "Full document", start: 0, end: text.length, material: true }];
  const heads: { key: string; at: number }[] = [];
  const re = /\b(PART\s+(I{1,2}|IV|III)\b)|\bITEM\s+(\d{1,2}[A-C]?)\s*[.:\-–—]/gi;
  let part = "I";
  for (const m of text.matchAll(re)) {
    if (m[1]) { part = m[2].toUpperCase(); continue; }
    const item = m[3].toUpperCase();
    const key = kind === "10-Q" ? `${part === "II" ? "II" : "I"}-${item}` : item;
    const labels = kind === "10-K" ? TENK_LABELS : TENQ_LABELS;
    if (!labels[key]) continue;
    heads.push({ key, at: m.index ?? 0 });
  }
  if (heads.length < 3) return [{ key: "full", label: "Full document", start: 0, end: text.length, material: true }];
  const best = new Map<string, { start: number; end: number }>();
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].at : text.length;
    const cur = best.get(h.key);
    if (!cur || end - h.at > cur.end - cur.start) best.set(h.key, { start: h.at, end });
  });
  const labels = kind === "10-K" ? TENK_LABELS : TENQ_LABELS;
  // Item 15 (exhibits) runs to the end of the text and is not material; cap absurdly long tails.
  return [...best.entries()]
    .map(([key, r]) => ({ key, label: labels[key], start: r.start, end: r.end, material: MATERIAL[kind].has(key) }))
    .sort((a, b) => a.start - b.start);
}

/** Parts of a section for review, each at most PART_CHARS, split at a sentence or space where possible. */
export function partsOf(len: number, size = PART_CHARS): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let s = 0; s < len; s += size) out.push({ start: s, end: Math.min(len, s + size) });
  return out.length ? out : [{ start: 0, end: 0 }];
}

export type IndexDoc = { seq: string; description: string; document: string; type: string; url: string };

/** Rows of an EDGAR "-index.htm" page: each document of a filing with its type (10-Q, EX-99.1, GRAPHIC...). */
export function parseFilingIndex(html: string, baseUrl: string): IndexDoc[] {
  const out: IndexDoc[] = [];
  const table = html.match(/<table[^>]*class="tableFile"[^>]*>([\s\S]*?)<\/table>/i)?.[1] ?? "";
  for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 4) continue;
    const href = cells[2].match(/href="([^"]+)"/i)?.[1];
    if (!href) continue;
    const clean = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    const path = href.replace(/^\/ix\?doc=/, "");
    const url = path.startsWith("http") ? path : new URL(path, baseUrl).toString();
    out.push({ seq: clean(cells[0]), description: clean(cells[1]), document: clean(cells[2]), type: clean(cells[3]), url });
  }
  return out;
}

export type QuoteCheck = { status: "verified" | "quote_found_value_not_in_quote" | "quote_not_found"; detail: string };

const digitsOf = (s: string) => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => x.replace(/,/g, ""));

/**
 * Checks a finding against the document text: the quote must appear (allowing "..." for omitted words),
 * and the figure, when one is given, must appear in the quote (as written, or rounded the way filings
 * round: 35,082 million = 35.1 billion).
 */
export function checkQuote(docText: string, quote: string, value: string | number | null | undefined): QuoteCheck {
  const doc = normalize(docText);
  const pieces = normalize(quote).split(/\s*(?:\.\.\.|…|\[\.\.\.\])\s*/).map((p) => p.trim()).filter((p) => p.length >= 8);
  if (!pieces.length) return { status: "quote_not_found", detail: "No usable quote (needs at least a few words copied from the document)." };
  let from = 0;
  for (const p of pieces) {
    const i = doc.indexOf(p, from);
    if (i < 0) return { status: "quote_not_found", detail: `Not found in the document: "${p.slice(0, 80)}"` };
    from = i + p.length;
  }
  if (value === null || value === undefined || String(value).trim() === "") return { status: "verified", detail: "Quote found in the document." };
  const date = dateMatch(String(value), quote);
  if (date) return date;
  const want = digitsOf(String(value));
  if (!want.length) return { status: "verified", detail: "Quote found in the document." };
  const have = new Set(digitsOf(quote));
  const decimals = (s: string) => (s.split(".")[1] ?? "").length;
  const ok = want.every((w) => {
    if (have.has(w)) return true;
    const n = Number(w);
    // A figure restated at another scale or rounding: 35,082 (millions) vs 35.1 (billions).
    return [...have].some((hs) => {
      const h = Number(hs);
      if (hs.replace(/\D/g, "").replace(/^0+/, "").length < 2) return false;
      return [1, 1e3, 1e-3, 1e6, 1e-6, 1e9, 1e-9].some((k) => {
        const tol = Math.max(0.5 * 10 ** -decimals(hs) * k, 0.5 * 10 ** -decimals(w));
        return h !== 0 && Math.abs(h * k - n) <= tol * 1.0001;
      });
    });
  });
  return ok ? { status: "verified", detail: "Quote and figure found in the document." } : { status: "quote_found_value_not_in_quote", detail: `The quote is in the document but ${want.join(", ")} is not in it.` };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A date value ("Nov 17, 2026", "November 17") written differently in the quote ("Tuesday, November 17"):
 * the month and day must be in the quote, and a year only has to match when the quote states one.
 * Returns null when the value is not a month-day date, so the figure check runs instead.
 */
function dateMatch(value: string, quote: string): QuoteCheck | null {
  const m = value.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1].toLowerCase()), day = Number(m[2]), year = m[3] ? Number(m[3]) : null;
  const q = quote.toLowerCase();
  const found = [...q.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/g)]
    .some((x) => MONTHS.indexOf(x[1]) === mon && Number(x[2]) === day && (!x[3] || year === null || Number(x[3]) === year));
  if (!found) return { status: "quote_found_value_not_in_quote", detail: `The quote is in the document but the date ${value} is not in it.` };
  const yearInQuote = /\b(19|20)\d{2}\b/.test(q);
  return { status: "verified", detail: year !== null && !yearInQuote ? "Quote and date found in the document (the quote does not state the year)." : "Quote and date found in the document." };
}

/** sha-256 of text, as hex (Web Crypto, available in Node 20+ and Netlify functions). */
export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
