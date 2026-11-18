/**
 * Removes the owner's private financial information from saved research text before it is shared.
 *
 * Nothing is rewritten by AI. Text is checked sentence by sentence (and clause by clause inside a
 * sentence) against two things:
 *   1. patterns for portfolio-specific wording: share counts, cost basis, deployable cash, the reserve,
 *      savings, account names, personal limits and policies, exposure percentages, personal trade sizes;
 *   2. a fingerprint of the owner's actual numbers loaded from the database at export time (position
 *      quantities, values and cost basis, account balances, account names).
 * A matching clause or sentence is replaced with a visible marker, so the reader can see where something
 * was removed. Research about the company itself (including company share counts in the millions) is kept.
 */

export type PrivateFingerprint = {
  /** Dollar amounts that belong to the owner: position values, cost basis, gains, balances. */
  amounts: number[];
  /** Words that identify the owner's accounts (account names, institutions, reference hints). */
  terms: string[];
};

export const EMPTY_FINGERPRINT: PrivateFingerprint = { amounts: [], terms: [] };

export const MARK_SENTENCE = "[Personal portfolio detail removed]";
export const MARK_CLAUSE = "[personal portfolio condition removed]";

/** Wording that only appears when the text is about the owner's own portfolio, money or policy. */
const PATTERNS: { re: RegExp; why: string }[] = [
  // Share counts the owner holds or would trade: small numbers followed by "shares", never company totals
  // ("39,699,102 shares", "1.07B shares", "24,100 shares millions").
  { re: /(?<![\d,.$])(?:~|about |roughly |approximately )?\d{1,4}(?:\.\d+)?\s+(?:of\s+(?:the\s+|your\s+)?\d{1,4}\s+)?(?:existing\s+|remaining\s+)?shares\b(?!\s+(?:outstanding|millions?|billions?|of common|were|have been))/i, why: "share count held or traded" },
  { re: /\b\d{1,4}\s*x\s*[\d,]{9,}\s+shares\b/i, why: "position arithmetic" },
  { re: /\b(?:sell|buy|trim|add|keep|hold)(?:ing)?\s+(?:about\s+|roughly\s+|~)?\d{1,4}\b(?!\s*(?:%|bp|basis|x\b|years?|months?|days?|quarters?))/i, why: "personal trade size" },
  { re: /\bcost basis\b/i, why: "cost basis" },
  { re: /\bunrealized\s+(?:loss|gain)\b(?!s)(?!\s+on\b)|\bunrealized\s+[-–−]?\$/i, why: "unrealized gain or loss" },
  { re: /\b(?:wash[- ]sale|tax[- ]loss|tax asset|harvest(?:ing)?\s+(?:the\s+)?loss|realiz(?:e|es|ing)\s+(?:roughly\s+|about\s+|the\s+)?(?:~)?\$?[\d,]*\s*(?:of\s+)?loss)/i, why: "personal tax position" },
  { re: /\b(?:schwab|acorns|usaa|thinkorswim|roth\b|taxable[_ ](?:account|brokerage)|taxable account|brokerage account|retirement account|\bIRA\b)/i, why: "account" },
  { re: /\bsavings (?:account|balance)s?\b|\b(?:your|my|personal|usaa) savings\b/i, why: "savings" },
  { re: /\bbuying power\b/i, why: "buying power" },
  { re: /\b(?:deployable|investable|free|spare|surplus|idle) cash\b(?!\s+flow)/i, why: "cash balance" },
  { re: /\binvestable capital\b|\binvestable\b|\d%\s+of\s+(?:investable\s+)?(?:capital|stocks|equities|the portfolio|portfolio|net worth)\b/i, why: "portfolio weight" },
  { re: /\b(?:the|a|protected|cash|emergency|approved)\s+(?:\$[\d,.]+[kK]?\s+)?(?:usaa\s+)?reserve\b(?!s)|\$[\d,.]+[kK]?\s+(?:protected\s+)?reserve\b|\breserve is\b|\breserve stays\b|never the reserve\b/i, why: "cash reserve" },
  { re: /\b(?:headroom|what-if|look-through|review zone|review level|review threshold)\b/i, why: "personal exposure" },
  { re: /\bportfolio (?:fit|check|weight|exposure|limit|policy|and policy|reasoning|concentration|context)\b|\b(?:the|your|my|current|investor's|owner's|whole|existing) portfolio\b|\bin the portfolio\b/i, why: "portfolio" },
  { re: /\b(?:company|approved|policy|exposure|position|hard|bucket|sector|theme|single-stock|stock) (?:limit|max|maximum|cap|band|ceiling|floor|range)s?\b/i, why: "personal limit" },
  { re: /\b[A-Z]{2,5} (?:limit|maximum|cap|band|ceiling|exposure)s?\b/, why: "personal limit" },
  { re: /\bexposure (?:below|above|under|over|near|at) \d+(?:\.\d+)?\s?%|\byou approved\b|\bapproved in the app\b|\d+(?:\.\d+)?\s?% high[- ]conviction\b|\bdeployable\b|\bsuggest(?:s|ed)? (?:a )?(?:small )?(?:one )?(?:of )?(?:about )?\d+(?:\.\d+)?\s?(?:[-–]\s?\d+(?:\.\d+)?\s?)?%/i, why: "personal limit" },
  { re: /\blimits? (?:is|are|was|were|be|gets?) approved\b|\bno approved\b|\bapproves? an? [A-Z]{2,5}\b|\bapproved (?:by )?(?:the )?investor\b|\binvestor[- ]approved\b|\bnot (?:investor[- ])?approved by the investor\b/i, why: "personal policy approval" },
  { re: /\b(?:under|by|blocked by|per|in) (?:the |my |your )?(?:investor's )?polic(?:y|ies)\b|\bpolicy (?:says|blocks|limits?|maximums?|range|ceilings?|floors?|bands?|and cash)\b|\b(?:investor|owner|personal|your|my)(?:'s)? polic(?:y|ies)\b|\bimported, (?:not|unconfirmed)\b/i, why: "personal policy" },
  { re: /\bhigh[- ]conviction (?:band|range)\b|\bnormal (?:range|band|floor)\b|\b\d+(?:\.\d+)?\s?% (?:floor|maximum|max|target|ceiling|hard max|normal|band)\b|\b\d+(?:\.\d+)?\s?[-–]\s?\d+(?:\.\d+)?\s?% (?:band|normal)\b|\bthe \d+(?:\.\d+)?% (?:floor|maximum|max|ceiling)\b/i, why: "personal limit" },
  { re: /\bthe investor(?:'s)?\b|\byour\b|\byou (?:own|hold|have|bought|paid)\b|\bmy (?:position|shares|holdings?|portfolio|account)\b/i, why: "addressed to the owner" },
  { re: /\b(?:new |planned |monthly |from )contributions?\b/i, why: "personal funding" },
  { re: /\b(?:funded|funding|fund it|funds it|fund the add|financed)\s+(?:comes\s+)?from\b|\bfunding \(/i, why: "personal funding" },
  { re: /\b(?:the|your|this|existing|current|whole)\s+(?:[A-Z]{2,5}\s+)?(?:position|holding|stake)\b(?!\s+in the (?:market|industry))|\bposition (?:is|was|value|size is)\b/, why: "the owner's position" },
  { re: /\ba \$[\d,.]+[kK]? (?:add|starter|purchase|buy|position|what-if|trim|sale)\b|\bstarter (?:size|position)?\s*\(\$|\b(?:about|roughly|~)\s*\$[\d,]+\s*\)?\s*(?:now|of loss)\b/i, why: "personal trade amount" },
  { re: /(?<!capital )(?<!asset-)\ballocation (?:is|of|target|note|stays|until)\b|\btarget allocation\b|\b(?:target|max)_pct\b|\b\d+(?:\.\d+)?% target\b/i, why: "personal allocation" },
  { re: /\b(?:inside|within|above|below|in|outside) (?:the |its )?(?:approved )?(?:\d+(?:\.\d+)?\s?[-–]\s?\d+(?:\.\d+)?% )?(?:normal )?band\b|\bband floor\b|\b(?:asymmetric|high-risk|core|speculative|growth) sleeve\b|\bsleeve is\b/i, why: "personal limit" },
  { re: /\btrim(?:s|med|ming)?\b[^.;:]{0,25}?\d+(?:\.\d+)?\s?%|\b(?:hold|keep|stay|sit)(?:s|ing)? (?:at|near|around) (?:about |~)?\d+(?:\.\d+)?\s?%|\b(?:add|reduce|cut|raise)(?:ing)? (?:back )?(?:to|toward|towards) (?:about |~)?\d+(?:\.\d+)?\s?%/i, why: "personal weight target" },
  { re: /\bunder (?:the )?(?:approved )?(?:[A-Z]{2,5} )?polic(?:y|ies)\b|\b[A-Z]{2,5} polic(?:y|ies)\b/, why: "personal policy" },
  { re: /(?<![\d,.])\d{1,4}\s+sh\b|\d%\s+of\s+equity\b(?!\s+value)|\breview (?:at )?\d+(?:\.\d+)?\s?%|\b(?:theme|sector) concentration\b/i, why: "portfolio weight" },
  { re: /\b(?:reconcile|reconciled) (?:holdings|positions)\b|\bholdings? (?:snapshot|statement)\b/i, why: "holdings" },
];

const ABBREV = /(?:(?:^|[\s.(])[A-Z]\.|\b(?:vs|e\.g|i\.e|etc|approx|est|Inc|Corp|Co|Ltd|No|Nos|Fig|U\.S|U\.K|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mr|Ms|Dr|St|al|cf|p|pp)\.)$/;

/** Splits text into sentences without breaking decimals or common abbreviations. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?](?:["”')\]]*)\s+(?=["“(\[*A-Z0-9$~-])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].trimEnd().length;
    const piece = text.slice(start, end);
    if (ABBREV.test(piece.trimEnd().replace(/["”')\]]+$/, ""))) continue;
    out.push(piece);
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push(text.slice(start));
  return out.filter((s) => s.trim().length > 0);
}

function amountsIn(text: string): { v: number; k: boolean }[] {
  const out: { v: number; k: boolean }[] = [];
  const re = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*([kK]\b|thousand)?(?![\d,.]*\s*(?:[mMbBT]\b|million|billion|bn|trillion))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let v = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(v)) continue;
    if (m[2]) v *= 1000;
    out.push({ v, k: !!m[2] });
  }
  return out;
}

export type Redactor = {
  /** Plain text: returns the text with private sentences or clauses replaced by markers. */
  text: (s: string | null | undefined) => string;
  /** Markdown (phase bodies): also removes whole sections and paragraphs headed as portfolio content. */
  markdown: (s: string | null | undefined) => string;
  /** Why a piece of text is private, or null. Used by tests and the final leak check. */
  privateReason: (s: string) => string | null;
  /** How many sentences, clauses and sections were removed, by reason. */
  log: Map<string, number>;
};

export function makeRedactor(fp: PrivateFingerprint = EMPTY_FINGERPRINT): Redactor {
  // Only amounts of $1,000 or more: smaller ones could equal a share price in the research. Smaller
  // personal amounts (cash, headroom) are caught by the wording patterns instead.
  const amounts = fp.amounts.filter((a) => Number.isFinite(a) && Math.abs(a) >= 1000).map((a) => Math.abs(a));
  const terms = fp.terms.map((t) => t.trim()).filter((t) => t.length >= 4);
  const termRe = terms.length ? new RegExp(`(?<![\\w])(?:${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w])`, "i") : null;
  const log = new Map<string, number>();
  const note = (why: string) => log.set(why, (log.get(why) ?? 0) + 1);

  const privateReason = (s: string): string | null => {
    for (const p of PATTERNS) if (p.re.test(s)) return p.why;
    if (termRe && termRe.test(s)) return "account";
    for (const { v, k } of amountsIn(s)) {
      // The owner's own amounts, also rounded ($1,500 for 1,500.37; $40.0K for 39,980).
      if (amounts.some((a) => Math.abs(a - v) <= (k ? 50 : 1))) return "owner's dollar amount";
    }
    return null;
  };

  const CONDITIONAL = /\s(?:and\s+)?(?:only\s+)?(?:if|after|once|until|unless|provided(?:\s+that)?|when|while|with (?:an? )?(?:approved|investor)|funded|so)\s/gi;

  /** One sentence: keep it, trim the private clauses, or replace it. */
  const sentence = (s: string): string => {
    const why = privateReason(s);
    if (!why) return s;
    const lead = s.match(/^\s*/)?.[0] ?? "";
    const trail = /[.!?]["”')\]]*\s*$/.test(s) ? s.match(/[.!?]["”')\]]*\s*$/)![0] : "";
    const body = s.slice(lead.length, s.length - trail.length);
    // Clauses split on , ; : and parentheses, keeping the separators.
    const parts = body.split(/(\s*[,;:]\s+|\s*\(|\)\s*|\s+—\s+|\s+-\s+)/);
    let kept = 0;
    let removed = false;
    const out = parts.map((p, i) => {
      if (i % 2 === 1) return p; // separator
      if (!p.trim()) return p;
      if (!privateReason(p)) { if (p.replace(/[*_'"“”‘’]/g, "").trim().split(/\s+/).length >= 4) kept++; return p; }
      removed = true;
      // Keep the clause's head when only its condition is private ("consider a small starter | only if ...").
      // The longest head that is clean wins, so the cut lands where the private wording starts.
      let best = -1;
      for (const c of p.matchAll(CONDITIONAL)) {
        const at = c.index ?? -1;
        if (at > 0 && !privateReason(p.slice(0, at)) && p.slice(0, at).trim().split(/\s+/).length >= 2) best = at;
      }
      if (best > 0) { kept++; return `${p.slice(0, best)} ${MARK_CLAUSE}`; }
      return "\u0000";
    });
    if (!removed || kept === 0) {
      note(why);
      return `${lead}${MARK_SENTENCE}${trail ? (trail.trim().startsWith(".") ? "" : "") : ""}${/\s$/.test(s) ? " " : ""}`;
    }
    note(why);
    // Short numeric fragments next to a removed clause ("roughly $216", "up to 37%") go with it.
    for (let i = 0; i < out.length; i += 2) {
      const seg = out[i];
      if (seg === "\u0000" || seg.includes(MARK_CLAUSE)) continue;
      const near = out[i - 2] === "\u0000" || out[i + 2] === "\u0000";
      if (near && /\d/.test(seg) && seg.trim().split(/\s+/).length < 4) out[i] = "\u0000";
    }
    if (!out.some((x, i) => i % 2 === 0 && x !== "\u0000" && x.trim() && x.replace(/[*_'"“”‘’]/g, "").trim().split(/\s+/).length >= 4)) {
      return `${lead}${MARK_SENTENCE}${/\s$/.test(s) ? " " : ""}`;
    }
    // Rebuild: drop removed clauses with their separators, mark each gap once.
    let res = "";
    let pendingMark = false;
    for (let i = 0; i < out.length; i += 2) {
      const seg = out[i];
      const sep = out[i + 1] ?? "";
      if (seg === "\u0000") { pendingMark = true; continue; }
      if (!seg.trim()) { res += sep; continue; }
      if (pendingMark) { res = res ? res.replace(/[\s,;:(—-]*$/, "") + ` ${MARK_CLAUSE}, ` : `${MARK_CLAUSE}, `; pendingMark = false; }
      res += seg + sep;
    }
    if (pendingMark) res = res.replace(/[\s,;:(—-]*$/, "") + `, ${MARK_CLAUSE}`;
    res = balanceParens(res.replace(/\s{2,}/g, " ").replace(/\s+([,.;:)])/g, "$1"));
    // A trimmed sentence that still trips a pattern is removed whole.
    if (privateReason(res.split(MARK_CLAUSE).join(" "))) return `${lead}${MARK_SENTENCE}${/\s$/.test(s) ? " " : ""}`;
    return `${lead}${res}${trail}`;
  };

  const text = (s: string | null | undefined): string => {
    if (!s) return "";
    const out = sentences(s).map(sentence).join(" ").replace(/\s+/g, " ").trim();
    return collapse(out);
  };

  const HEADING_PRIVATE = /\b(?:portfolio|policy|policies|allocation|funding|position siz|sizing|your position|my position|cash and reserve|exposure|limits?)\b/i;

  const markdown = (s: string | null | undefined): string => {
    if (!s) return "";
    const lines = s.replace(/\r/g, "").split("\n");
    const out: string[] = [];
    let skipHeadingLevel = 0; // inside a "### Portfolio fit" section until the next heading of the same or higher level
    let skipPara = false; // inside a paragraph headed "**Portfolio fit.**"
    for (const raw of lines) {
      const h = raw.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        skipPara = false;
        if (skipHeadingLevel && h[1].length > skipHeadingLevel) continue;
        skipHeadingLevel = 0;
        if (HEADING_PRIVATE.test(h[2])) { skipHeadingLevel = h[1].length; note("portfolio section"); out.push(`${h[1]} ${MARK_SECTION(h[2])}`); continue; }
        out.push(`${h[1]} ${text(h[2])}`);
        continue;
      }
      if (skipHeadingLevel) continue;
      if (!raw.trim()) { skipPara = false; out.push(raw); continue; }
      if (skipPara) continue;
      // A paragraph or bullet led by a bold label: "**Portfolio fit.** ..." or "- **Portfolio:** ...".
      const lab = raw.match(/^(\s*(?:[-*•]\s+|\d+[.)]\s+)?)\*\*([^*]{1,60})\*\*/);
      if (lab && HEADING_PRIVATE.test(lab[2]) && !/^\s*[-*•]|\d+[.)]/.test(raw)) { skipPara = true; note("portfolio section"); out.push(`*${MARK_SECTION(lab[2])}*`); continue; }
      if (lab && HEADING_PRIVATE.test(lab[2])) { note("portfolio section"); out.push(`${lab[1]}*${MARK_SECTION(lab[2])}*`); continue; }
      // Table rows: filter each cell.
      if (/^\s*\|.*\|\s*$/.test(raw)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) { out.push(raw); continue; }
        const cells = raw.trim().replace(/^\||\|$/g, "").split("|");
        out.push(`| ${cells.map((c) => text(c.trim()) || " ").join(" | ")} |`);
        continue;
      }
      const prefix = raw.match(/^(\s*(?:[-*•]\s+|\d+[.)]\s+)?)/)?.[0] ?? "";
      let line = text(raw.slice(prefix.length));
      // A removed clause can leave bold markers unpaired; drop them rather than print stray asterisks.
      if ((line.match(/\*\*/g) ?? []).length % 2 === 1) line = line.replace(/\*\*/g, "");
      out.push(prefix + line);
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n");
  };

  return { text, markdown, privateReason, log };
}

const MARK_SECTION = (label: string) => `[Section removed: “${label.replace(/[.:]+$/, "").trim()}” described the owner's own portfolio, cash or limits]`;

/** Several markers in a row read as one. */
function collapse(s: string): string {
  const m = MARK_SENTENCE.replace(/[[\]]/g, "\\$&");
  return s.replace(new RegExp(`(?:${m}\\s*){2,}`, "g"), `${MARK_SENTENCE} `).trim();
}

function balanceParens(s: string): string {
  let open = 0;
  for (const ch of s) { if (ch === "(") open++; else if (ch === ")") open = Math.max(0, open - 1); }
  let r = s;
  if (open > 0) r = r + ")".repeat(open);
  // Drop a dangling ")" with no opener.
  let depth = 0;
  let res = "";
  for (const ch of r) {
    if (ch === "(") depth++;
    if (ch === ")") { if (depth === 0) continue; depth--; }
    res += ch;
  }
  return res;
}

/**
 * The last check before a report leaves the app: any text that still looks private. Markers are
 * ignored. Returns the offending snippets (empty when clean).
 */
export function findLeaks(r: Redactor, texts: string[]): string[] {
  const leaks: string[] = [];
  for (const t of texts) {
    for (const s of sentences(t.split(MARK_SENTENCE).join(" ").split(MARK_CLAUSE).join(" "))) {
      if (/\[Section removed:/.test(s)) continue;
      const why = r.privateReason(s);
      if (why) leaks.push(`${why}: ${s.slice(0, 120)}`);
    }
  }
  return leaks;
}
