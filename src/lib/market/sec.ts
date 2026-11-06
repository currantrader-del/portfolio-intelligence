import { FIXTURE, fixtureFilings, fixtureFundamentals } from "@/lib/dev/fixture";
import { classifyFiling, type FilingCategory } from "./filingClass";
export { classifyFiling };
/**
 * Layer 1: SEC EDGAR (free, official). Filings come from the submissions API and
 * fundamentals from XBRL company concepts. Every result carries its source URL and fetch time.
 * SEC asks automated clients to identify themselves: set SEC_USER_AGENT to "App name contact@example".
 */
const UA = process.env.SEC_USER_AGENT || "PortfolioIntelligence/1.0 (personal research app)";
const DAY = 86400;

export type Filing = {
  form: string;
  filed: string; // YYYY-MM-DD
  reportDate: string | null;
  description: string;
  items: string[];
  isEarnings: boolean;
  url: string;
  /** What the form type alone tells us. Never a conclusion about dilution or terms. */
  category: FilingCategory;
  /** What can and cannot be concluded before the document is read. */
  note: string;
  accession?: string;
};

export type { FilingCategory } from "./filingClass";

export type FilingsResult = { cik: string; company: string; filings: Filing[]; lastEarnings: Filing | null; nextEarningsEstimate: string | null; source: string; fetchedAt: string };

const FORMS = new Set([
  "10-K", "10-Q", "8-K", "8-K/A", "20-F", "6-K", "40-F", "10-K/A", "10-Q/A", "DEF 14A",
  "S-1", "S-1/A", "S-3", "S-3/A", "S-3ASR", "F-3", "424B2", "424B3", "424B4", "424B5", "424B7", "S-8", "D",
]);
const ITEM_LABEL: Record<string, string> = {
  "1.01": "Material agreement", "1.02": "Agreement ended", "2.01": "Acquisition or sale completed", "2.02": "Earnings results",
  "2.03": "New financial obligation", "2.05": "Restructuring costs", "2.06": "Impairment", "3.02": "Unregistered sale of equity securities", "5.02": "Executive or director change",
  "5.07": "Shareholder vote", "7.01": "Regulation FD disclosure", "8.01": "Other events", "9.01": "Exhibits",
};

export function padCik(cik: string | number): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

/** company_tickers.json: {"0": {"cik_str": 1, "ticker": "AAA", "title": "..."}, ...} */
export function findCik(body: unknown, symbol: string): { cik: string; title: string } | null {
  const want = symbol.toUpperCase().replace("-", ".");
  for (const row of Object.values((body ?? {}) as Record<string, { cik_str?: number; ticker?: string; title?: string }>)) {
    if (row?.ticker && row.ticker.toUpperCase().replace("-", ".") === want && row.cik_str) return { cik: padCik(row.cik_str), title: row.title ?? want };
  }
  return null;
}

function describe(form: string, items: string[], primaryDesc: string): string {
  if (form.startsWith("8-K") && items.length) {
    const named = items.filter((i) => i !== "9.01").map((i) => ITEM_LABEL[i] ?? `Item ${i}`);
    if (named.length) return named.join(", ");
  }
  const base: Record<string, string> = {
    "10-K": "Annual report", "10-Q": "Quarterly report", "20-F": "Annual report (foreign issuer)", "6-K": "Foreign issuer report", "40-F": "Annual report (Canadian issuer)",
    "DEF 14A": "Proxy statement", "S-1": "Registration statement", "S-3": "Shelf registration", "S-3ASR": "Automatic shelf registration", "F-3": "Shelf registration (foreign issuer)",
    "424B2": "Prospectus supplement", "424B3": "Prospectus supplement", "424B4": "Final prospectus", "424B5": "Prospectus supplement", "424B7": "Resale prospectus",
    "S-8": "Employee share plan registration", "D": "Exempt offering notice",
  };
  const key = form.replace("/A", "");
  return base[key] ? `${base[key]}${form.endsWith("/A") ? " (amended)" : ""}` : primaryDesc || form;
}

/** Parses data.sec.gov/submissions/CIK##########.json into the most recent relevant filings. */
export function parseSubmissions(body: unknown, limit = 25): { company: string; filings: Filing[] } {
  const b = body as { name?: string; cik?: string; filings?: { recent?: Record<string, string[]> } };
  const r = b?.filings?.recent ?? {};
  const cik = String(Number(b?.cik ?? 0));
  const out: Filing[] = [];
  const n = r.form?.length ?? 0;
  for (let i = 0; i < n && out.length < limit; i++) {
    const form = r.form[i];
    if (!FORMS.has(form)) continue;
    const items = (r.items?.[i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const acc = (r.accessionNumber?.[i] ?? "").replace(/-/g, "");
    const doc = r.primaryDocument?.[i] ?? "";
    out.push({
      form,
      filed: r.filingDate?.[i] ?? "",
      reportDate: r.reportDate?.[i] || null,
      description: describe(form, items, r.primaryDocDescription?.[i] ?? ""),
      items,
      isEarnings: form.startsWith("8-K") ? items.includes("2.02") : form === "6-K" ? /result|earn|quarter/i.test(r.primaryDocDescription?.[i] ?? "") : false,
      ...classifyFiling(form, items),
      accession: r.accessionNumber?.[i] || undefined,
      url: acc && doc ? `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${doc}` : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`,
    });
  }
  return { company: b?.name ?? "", filings: out };
}

/** A rough next-report date: last earnings filing + 91 days. Always labelled an estimate. */
export function estimateNextEarnings(last: Filing | null, now = new Date()): string | null {
  if (!last?.filed) return null;
  let t = new Date(`${last.filed}T00:00:00Z`).getTime();
  const step = 91 * DAY * 1000;
  do t += step; while (t < now.getTime() - 7 * DAY * 1000);
  return new Date(t).toISOString().slice(0, 10);
}

// ---------- Fundamentals (XBRL company concepts) ----------

type Fact = { start?: string; end: string; val: number; fy?: number; fp?: string; form?: string; filed?: string };
export type Period = { start: string | null; end: string; value: number; form: string | null; filed: string | null };
export type Metric = { key: string; label: string; unit: "USD" | "USD/share" | "shares"; tag: string; latestQuarter: Period | null; yearAgoQuarter: Period | null; yoy: number | null; latestAnnual: Period | null; ttm: number | null; latest: Period | null };

const days = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / (DAY * 1000);

function dedupe(facts: Fact[]): Fact[] {
  const seen = new Map<string, Fact>();
  for (const f of facts) {
    const k = `${f.start ?? ""}|${f.end}`;
    const prev = seen.get(k);
    if (!prev || (f.filed ?? "") > (prev.filed ?? "")) seen.set(k, f);
  }
  return [...seen.values()].sort((a, b) => a.end.localeCompare(b.end));
}

const asPeriod = (f: Fact | undefined): Period | null => (f ? { start: f.start ?? null, end: f.end, value: f.val, form: f.form ?? null, filed: f.filed ?? null } : null);

/** Picks the latest quarter, the same quarter a year earlier, the latest fiscal year and a trailing-12-month sum. */
export function summariseFacts(facts: Fact[], kind: "flow" | "instant"): Pick<Metric, "latestQuarter" | "yearAgoQuarter" | "yoy" | "latestAnnual" | "ttm" | "latest"> {
  const all = dedupe(facts.filter((f) => Number.isFinite(f.val) && f.end));
  if (kind === "instant") {
    const pts = all.filter((f) => !f.start);
    const latest = pts.at(-1) ?? all.at(-1);
    const prior = latest ? pts.find((x) => Math.abs(days(x.end, latest.end) - 365) <= 45) : undefined;
    const yoy = latest && prior && prior.val !== 0 ? (latest.val - prior.val) / Math.abs(prior.val) : null;
    return { latestQuarter: null, yearAgoQuarter: asPeriod(prior), yoy, latestAnnual: null, ttm: null, latest: asPeriod(latest) };
  }
  const quarters = all.filter((f) => f.start && days(f.start, f.end) >= 80 && days(f.start, f.end) <= 100);
  const annuals = all.filter((f) => f.start && days(f.start, f.end) >= 350 && days(f.start, f.end) <= 380);
  const q = quarters.at(-1);
  const yearAgo = q ? quarters.find((x) => Math.abs(days(x.end, q.end) - 365) <= 15) : undefined;
  const yoy = q && yearAgo && yearAgo.val !== 0 ? (q.val - yearAgo.val) / Math.abs(yearAgo.val) : null;
  const a = annuals.at(-1);
  let ttm: number | null = null;
  if (q) {
    const last4 = quarters.filter((x) => days(x.end, q.end) >= 0 && days(x.end, q.end) < 350);
    if (last4.length === 4) ttm = last4.reduce((s, x) => s + x.val, 0);
    // A 10-K usually omits Q4 as its own fact: derive TTM from the annual plus later quarters minus their year-ago quarters.
    else if (a && a.end <= q.end) {
      const after = quarters.filter((x) => x.end > a.end && x.end <= q.end);
      const prior = after.map((x) => quarters.find((y) => Math.abs(days(y.end, x.end) - 365) <= 15));
      if (prior.every(Boolean)) ttm = a.val + after.reduce((s, x) => s + x.val, 0) - prior.reduce((s, x) => s + x!.val, 0);
    }
  }
  const latest = [q, a].filter(Boolean).sort((x, y) => x!.end.localeCompare(y!.end)).at(-1);
  return { latestQuarter: asPeriod(q), yearAgoQuarter: asPeriod(yearAgo), yoy, latestAnnual: asPeriod(a), ttm, latest: asPeriod(latest) };
}

export const METRICS: { key: string; label: string; kind: "flow" | "instant"; unit: "USD" | "USD/share" | "shares"; tags: string[] }[] = [
  { key: "revenue", label: "Revenue", kind: "flow", unit: "USD", tags: ["us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax", "us-gaap/Revenues", "us-gaap/SalesRevenueNet", "ifrs-full/Revenue"] },
  { key: "operating_income", label: "Operating income", kind: "flow", unit: "USD", tags: ["us-gaap/OperatingIncomeLoss", "ifrs-full/ProfitLossFromOperatingActivities"] },
  { key: "net_income", label: "Net income", kind: "flow", unit: "USD", tags: ["us-gaap/NetIncomeLoss", "ifrs-full/ProfitLoss"] },
  { key: "eps_diluted", label: "Diluted EPS", kind: "flow", unit: "USD/share", tags: ["us-gaap/EarningsPerShareDiluted", "ifrs-full/DilutedEarningsLossPerShare"] },
  { key: "operating_cash_flow", label: "Operating cash flow", kind: "flow", unit: "USD", tags: ["us-gaap/NetCashProvidedByUsedInOperatingActivities", "ifrs-full/CashFlowsFromUsedInOperatingActivities"] },
  { key: "capex", label: "Capital spending", kind: "flow", unit: "USD", tags: ["us-gaap/PaymentsToAcquirePropertyPlantAndEquipment", "ifrs-full/PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"] },
  { key: "cash", label: "Cash and equivalents", kind: "instant", unit: "USD", tags: ["us-gaap/CashAndCashEquivalentsAtCarryingValue", "us-gaap/CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "ifrs-full/CashAndCashEquivalents"] },
  { key: "long_term_debt", label: "Long-term debt", kind: "instant", unit: "USD", tags: ["us-gaap/LongTermDebtNoncurrent", "us-gaap/LongTermDebt", "us-gaap/ConvertibleNotesPayable", "ifrs-full/NoncurrentPortionOfNoncurrentBorrowings"] },
  { key: "shares_outstanding", label: "Shares outstanding", kind: "instant", unit: "shares", tags: ["dei/EntityCommonStockSharesOutstanding"] },
];

/** Reads a company-concept body: {units: {USD: [...]}} or {units: {"USD/shares": [...]}} or {units: {shares: [...]}}. */
export function factsFromConcept(body: unknown): Fact[] {
  const units = (body as { units?: Record<string, Fact[]> })?.units ?? {};
  return units.USD ?? units["USD/shares"] ?? units.shares ?? Object.values(units)[0] ?? [];
}

// ---------- Fetchers (cached by Next; failures return null so pages still render) ----------

async function secJson(url: string, revalidate: number): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, next: { revalidate } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function lookupCik(symbol: string): Promise<{ cik: string; title: string } | null> {
  const body = await secJson("https://www.sec.gov/files/company_tickers.json", 7 * DAY);
  return body ? findCik(body, symbol) : null;
}

export async function getFilings(symbol: string, now = new Date()): Promise<FilingsResult | { error: string }> {
  if (FIXTURE) return fixtureFilings(symbol.toUpperCase());
  const id = await lookupCik(symbol);
  if (!id) return { error: `${symbol} was not found in SEC EDGAR (it may be an ETF, a fund, or SEC could not be reached).` };
  const src = `https://data.sec.gov/submissions/CIK${id.cik}.json`;
  const body = await secJson(src, 3 * 3600);
  if (!body) return { error: "SEC EDGAR could not be reached." };
  const { company, filings } = parseSubmissions(body);
  const lastEarnings = filings.find((f) => f.isEarnings) ?? null;
  return { cik: id.cik, company: company || id.title, filings, lastEarnings, nextEarningsEstimate: estimateNextEarnings(lastEarnings, now), source: src, fetchedAt: new Date().toISOString() };
}

export type Fundamentals = { cik: string; company: string; metrics: Metric[]; missing: string[]; source: string; fetchedAt: string };

export async function getFundamentals(symbol: string): Promise<Fundamentals | { error: string }> {
  if (FIXTURE) return fixtureFundamentals(symbol.toUpperCase());
  const id = await lookupCik(symbol);
  if (!id) return { error: `${symbol} was not found in SEC EDGAR (it may be an ETF, a fund, or SEC could not be reached).` };
  const results = await Promise.all(
    METRICS.map(async (m) => {
      for (const tag of m.tags) {
        const body = await secJson(`https://data.sec.gov/api/xbrl/companyconcept/CIK${id.cik}/${tag}.json`, DAY);
        const facts = body ? factsFromConcept(body) : [];
        if (facts.length) {
          const s = summariseFacts(facts, m.kind);
          // Skip tags the company stopped using years ago.
          if (s.latest && days(s.latest.end, new Date().toISOString()) < 550) return { key: m.key, label: m.label, unit: m.unit, tag, ...s } as Metric;
        }
      }
      return null;
    }),
  );
  const metrics = results.filter(Boolean) as Metric[];
  return {
    cik: id.cik,
    company: id.title,
    metrics,
    missing: METRICS.filter((m) => !metrics.some((x) => x.key === m.key)).map((m) => m.label),
    source: `https://data.sec.gov/api/xbrl/companyconcept/CIK${id.cik}/`,
    fetchedAt: new Date().toISOString(),
  };
}
