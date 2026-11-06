/**
 * Reads facts from a filing's own XBRL instance (the *_htm.xml file EDGAR extracts from an inline
 * XBRL 10-Q or 10-K). Pure: no network. Only non-dimensional facts are used for headline values,
 * so a segment or class breakdown is never mistaken for a company total.
 */
export type XbrlFact = {
  concept: string; // "us-gaap:CashAndCashEquivalentsAtCarryingValue"
  value: number;
  unit: string | null;
  decimals: string | null;
  instant: string | null; // YYYY-MM-DD
  start: string | null;
  end: string | null;
  dimensional: boolean;
  contextId: string;
};

type Ctx = { instant: string | null; start: string | null; end: string | null; dimensional: boolean };

const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");

function parseContexts(xml: string): Map<string, Ctx> {
  const out = new Map<string, Ctx>();
  const re = /<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g;
  for (let m; (m = re.exec(xml)); ) {
    const body = m[2];
    const instant = body.match(/<(?:xbrli:)?instant>\s*([\d-]{10})/)?.[1] ?? null;
    const start = body.match(/<(?:xbrli:)?startDate>\s*([\d-]{10})/)?.[1] ?? null;
    const end = body.match(/<(?:xbrli:)?endDate>\s*([\d-]{10})/)?.[1] ?? null;
    out.set(m[1], { instant, start, end, dimensional: /<(?:xbrli:)?segment\b|explicitMember|typedMember/.test(body) });
  }
  return out;
}

export function parseXbrlInstance(raw: string): XbrlFact[] {
  const xml = strip(raw);
  const ctx = parseContexts(xml);
  const facts: XbrlFact[] = [];
  // Numeric facts are elements with a contextRef and a unitRef; text blocks have no unitRef.
  const re = /<([A-Za-z][\w.-]*:[A-Za-z][\w.-]*)\b([^>]*)>\s*([-+]?\d[\d.]*(?:[eE][-+]?\d+)?)\s*<\/\1>/g;
  for (let m; (m = re.exec(xml)); ) {
    const attrs = m[2];
    const contextId = attrs.match(/\bcontextRef="([^"]+)"/)?.[1];
    const unit = attrs.match(/\bunitRef="([^"]+)"/)?.[1] ?? null;
    if (!contextId || !unit || /\bxsi:nil="true"/.test(attrs)) continue;
    const c = ctx.get(contextId);
    if (!c) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    facts.push({ concept: m[1], value, unit, decimals: attrs.match(/\bdecimals="([^"]+)"/)?.[1] ?? null, instant: c.instant, start: c.start, end: c.end, dimensional: c.dimensional, contextId });
  }
  return facts;
}

/** The single non-dimensional value of a concept at an instant, or over a period ending on a date. */
export function factAt(facts: XbrlFact[], concept: string, date: string, kind: "instant" | "duration", minDays = 0, maxDays = 400): XbrlFact | null {
  const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;
  const hits = facts.filter((f) => f.concept === concept && !f.dimensional && (kind === "instant"
    ? f.instant === date
    : f.end === date && f.start !== null && days(f.start, f.end) >= minDays && days(f.start, f.end) <= maxDays));
  if (!hits.length) return null;
  // Duplicates of the same fact are common in inline XBRL; they must agree.
  return new Set(hits.map((h) => h.value)).size === 1 ? hits[0] : null;
}

/** Report period from the instance's own document-type facts (dei:DocumentPeriodEndDate is text, so read it separately). */
export function documentPeriodEnd(raw: string): string | null {
  const m = strip(raw).match(/<dei:DocumentPeriodEndDate\b[^>]*>\s*([^<]+?)\s*<\/dei:DocumentPeriodEndDate>/);
  if (!m) return null;
  const iso = m[1].match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  const t = Date.parse(m[1] + " UTC");
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}
