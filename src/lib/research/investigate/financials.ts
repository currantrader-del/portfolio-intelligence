/**
 * Multi-year reported financials from SEC XBRL (companyfacts), with derived figures computed here:
 * free cash flow = operating cash flow - capital spending, margins, trailing twelve months. Every
 * figure keeps its tag, period, form and filing date, so it counts as verified primary data.
 * buildFinancials is pure; getFinancials fetches.
 */
import { padCik, SEC_USER_AGENT } from "@/lib/market/sec";

type XFact = { start?: string; end: string; val: number; accn?: string; fy?: number; fp?: string; form?: string; filed?: string };
export type Fig = { value: number; start: string | null; end: string; form: string | null; filed: string | null; tag: string };
export type Period = { label: string; end: string; values: Record<string, Fig | null> };
export type Financials = {
  source: string;
  company: string;
  fetchedAt: string;
  annual: Period[]; // newest first, up to 4 fiscal years
  ytd: { current: Period; prior: Period | null } | null;
  ttm: Period | null;
  latestQuarter: Period | null;
  balance: { end: string | null; values: Record<string, Fig | null> };
  derived: { label: string; value: number | null; formula: string }[];
  notes: string[];
};

const FLOW: { key: string; label: string; unit: "USD" | "USD/shares" | "shares"; tags: string[] }[] = [
  { key: "revenue", label: "Revenue", unit: "USD", tags: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"] },
  { key: "grossProfit", label: "Gross profit", unit: "USD", tags: ["GrossProfit"] },
  { key: "rnd", label: "Research and development", unit: "USD", tags: ["ResearchAndDevelopmentExpense", "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost"] },
  { key: "operatingIncome", label: "Operating income", unit: "USD", tags: ["OperatingIncomeLoss"] },
  { key: "netIncome", label: "Net income", unit: "USD", tags: ["NetIncomeLoss", "ProfitLoss"] },
  { key: "epsDiluted", label: "Diluted EPS", unit: "USD/shares", tags: ["EarningsPerShareDiluted"] },
  { key: "dilutedShares", label: "Diluted weighted shares", unit: "shares", tags: ["WeightedAverageNumberOfDilutedSharesOutstanding"] },
  { key: "ocf", label: "Operating cash flow", unit: "USD", tags: ["NetCashProvidedByUsedInOperatingActivities"] },
  { key: "capex", label: "Capital spending", unit: "USD", tags: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsToAcquirePropertyPlantAndEquipmentAndIntangibleAssets", "PaymentsForProceedsFromProductiveAssets"] },
  { key: "sbc", label: "Stock-based compensation", unit: "USD", tags: ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"] },
  { key: "buybacks", label: "Share repurchases", unit: "USD", tags: ["PaymentsForRepurchaseOfCommonStock"] },
  { key: "dividends", label: "Dividends paid", unit: "USD", tags: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"] },
  { key: "depreciation", label: "Depreciation and amortization", unit: "USD", tags: ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "Depreciation"] },
];
const INSTANT: { key: string; label: string; tags: string[]; unit: "USD" | "shares" }[] = [
  { key: "cash", label: "Cash and equivalents", unit: "USD", tags: ["CashAndCashEquivalentsAtCarryingValue"] },
  { key: "securities", label: "Marketable securities (current)", unit: "USD", tags: ["MarketableSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecuritiesCurrent", "ShortTermInvestments"] },
  { key: "debtCurrent", label: "Debt, current", unit: "USD", tags: ["LongTermDebtCurrent", "DebtCurrent", "ConvertibleNotesPayableCurrent"] },
  { key: "debtNoncurrent", label: "Debt, non-current", unit: "USD", tags: ["LongTermDebtNoncurrent", "ConvertibleLongTermNotesPayable", "ConvertibleNotesPayableNoncurrent", "LongTermDebt"] },
  { key: "totalAssets", label: "Total assets", unit: "USD", tags: ["Assets"] },
  { key: "equity", label: "Shareholders' equity", unit: "USD", tags: ["StockholdersEquity"] },
  { key: "sharesOutstanding", label: "Shares outstanding (balance sheet)", unit: "shares", tags: ["CommonStockSharesOutstanding"] },
];

const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
const isAnnualForm = (f?: string) => !!f && /^(10-K|20-F|40-F)/.test(f);

function unitFacts(facts: Record<string, Record<string, { units?: Record<string, XFact[]> }>>, tag: string, unit: string): XFact[] {
  for (const ns of ["us-gaap", "ifrs-full", "dei"]) {
    const t = facts[ns]?.[tag];
    if (t?.units?.[unit]) return t.units[unit];
  }
  return [];
}

/** The tag (of the candidates) with the most recent data. */
function pickTag(facts: Parameters<typeof unitFacts>[0], tags: string[], unit: string): { tag: string; facts: XFact[] } | null {
  let best: { tag: string; facts: XFact[]; end: string } | null = null;
  for (const tag of tags) {
    const f = unitFacts(facts, tag, unit);
    if (!f.length) continue;
    const end = f.reduce((m, x) => (x.end > m ? x.end : m), "");
    if (!best || end > best.end) best = { tag, facts: f, end };
  }
  return best ? { tag: best.tag, facts: best.facts } : null;
}

/** Newest filing's value for a period (restated figures win). */
function latestFiled(fs: XFact[]): XFact | null {
  return fs.reduce<XFact | null>((m, x) => (!m || (x.filed ?? "") > (m.filed ?? "") ? x : m), null);
}
const fig = (x: XFact | null, tag: string): Fig | null => (x ? { value: x.val, start: x.start ?? null, end: x.end, form: x.form ?? null, filed: x.filed ?? null, tag } : null);

export function buildFinancials(body: unknown, now = new Date()): Financials | { error: string } {
  const b = body as { entityName?: string; cik?: number; facts?: Parameters<typeof unitFacts>[0] };
  if (!b?.facts) return { error: "No XBRL facts in the SEC response" };
  const facts = b.facts;
  const notes: string[] = [];
  const picked = Object.fromEntries(FLOW.map((m) => [m.key, pickTag(facts, m.tags, m.unit)]));
  // Fiscal-year ends from revenue (or net income) in annual reports.
  const anchor = picked.revenue ?? picked.netIncome;
  if (!anchor) return { error: "No revenue or net income in XBRL" };
  const annualEnds = [...new Set(anchor.facts.filter((x) => isAnnualForm(x.form) && x.start && days(x.start, x.end) > 330 && days(x.start, x.end) < 380).map((x) => x.end))].sort().reverse().slice(0, 4);
  const flowAt = (key: string, start: string | null, end: string, approxDays: [number, number]) => {
    const p = picked[key];
    if (!p) return null;
    const cands = p.facts.filter((x) => x.end === end && x.start && days(x.start, x.end) >= approxDays[0] && days(x.start, x.end) <= approxDays[1] && (!start || x.start === start));
    return fig(latestFiled(cands), p.tag);
  };
  const annual: Period[] = annualEnds.map((end) => ({ label: `FY ending ${end}`, end, values: Object.fromEntries(FLOW.map((m) => [m.key, flowAt(m.key, null, end, [330, 380])])) }));

  // Latest quarterly report after the last fiscal year: year-to-date and the same period a year earlier.
  const lastFy = annualEnds[0] ?? "";
  const qFacts = anchor.facts.filter((x) => x.form?.startsWith("10-Q") && x.end > lastFy && x.start);
  const qEnd = qFacts.reduce((m, x) => (x.end > m ? x.end : m), "");
  let ytd: Financials["ytd"] = null, ttm: Period | null = null, latestQuarter: Period | null = null;
  if (qEnd) {
    const longest = qFacts.filter((x) => x.end === qEnd).reduce((m, x) => Math.max(m, days(x.start!, x.end)), 0);
    const range: [number, number] = [longest - 5, longest + 5];
    const cur: Period = { label: `Year to date ending ${qEnd}`, end: qEnd, values: Object.fromEntries(FLOW.map((m) => [m.key, flowAt(m.key, null, qEnd, range)])) };
    const priorEnd = anchor.facts.filter((x) => x.end < qEnd && Math.abs(days(x.end, qEnd) - 365) < 10 && x.start && Math.abs(days(x.start, x.end) - longest) < 6).map((x) => x.end)[0] ?? null;
    const prior: Period | null = priorEnd ? { label: `Year to date ending ${priorEnd}`, end: priorEnd, values: Object.fromEntries(FLOW.map((m) => [m.key, flowAt(m.key, null, priorEnd, range)])) } : null;
    ytd = { current: cur, prior };
    if (annual[0] && prior) {
      ttm = { label: `Trailing 12 months to ${qEnd}`, end: qEnd, values: {} };
      for (const m of FLOW) {
        if (m.unit !== "USD") { ttm.values[m.key] = null; continue; }
        const a = annual[0].values[m.key], c = cur.values[m.key], p = prior.values[m.key];
        ttm.values[m.key] = a && c && p ? { value: a.value + c.value - p.value, start: null, end: qEnd, form: "calculated", filed: c.filed, tag: `${a.tag} (FY + YTD - prior YTD)` } : null;
      }
    }
    latestQuarter = { label: `Quarter ending ${qEnd}`, end: qEnd, values: Object.fromEntries(FLOW.map((m) => [m.key, flowAt(m.key, null, qEnd, [80, 100])])) };
  } else if (annual[0]) {
    ttm = { ...annual[0], label: `Trailing 12 months = ${annual[0].label}` };
  }

  // Balance sheet: the latest date with cash reported.
  const bal: Financials["balance"] = { end: null, values: {} };
  const cashT = pickTag(facts, INSTANT[0].tags, "USD");
  bal.end = cashT ? cashT.facts.reduce((m, x) => (x.end > m ? x.end : m), "") || null : null;
  for (const m of INSTANT) {
    const p = pickTag(facts, m.tags, m.unit);
    bal.values[m.key] = p && bal.end ? fig(latestFiled(p.facts.filter((x) => x.end === bal.end)), p.tag) : null;
  }
  const dei = unitFacts(facts, "EntityCommonStockSharesOutstanding", "shares");
  const cover = dei.reduce<XFact | null>((m, x) => (!m || x.end > m.end ? x : m), null);
  bal.values.sharesCover = fig(cover, "dei:EntityCommonStockSharesOutstanding");

  const derived: Financials["derived"] = [];
  const add = (label: string, a: Fig | null | undefined, b: Fig | null | undefined, op: "-" | "/", formula: string) => {
    const v = a && b ? (op === "-" ? a.value - b.value : b.value ? a.value / b.value : null) : null;
    derived.push({ label, value: v === null ? null : Math.round(v * 10000) / 10000, formula });
  };
  for (const p of [...(ttm ? [ttm] : []), ...annual.slice(0, 3)]) {
    add(`Free cash flow, ${p.label}`, p.values.ocf, p.values.capex, "-", "operating cash flow - capital spending");
    add(`Gross margin, ${p.label}`, p.values.grossProfit, p.values.revenue, "/", "gross profit / revenue");
    add(`Operating margin, ${p.label}`, p.values.operatingIncome, p.values.revenue, "/", "operating income / revenue");
  }
  const r0 = annual[0]?.values.revenue?.value, r1 = annual[1]?.values.revenue?.value;
  if (annual[0] && r0 && r1) derived.push({ label: `Revenue growth, ${annual[0].label}`, value: Math.round((r0 / r1 - 1) * 10000) / 10000, formula: "this year's revenue / last year's - 1" });
  if (!picked.capex) notes.push("No capital-spending tag in XBRL: free cash flow cannot be computed from XBRL; read the cash-flow statement in the filing.");
  if (!picked.revenue) notes.push("No revenue tag found in XBRL.");
  void now;
  return { source: "", company: b.entityName ?? "", fetchedAt: new Date().toISOString(), annual, ytd, ttm, latestQuarter, balance: bal, derived, notes };
}

export async function getFinancials(cik: string): Promise<Financials | { error: string }> {
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${padCik(cik)}.json`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT }, cache: "no-store", signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { error: `HTTP ${res.status} from SEC XBRL` };
    const out = buildFinancials(await res.json());
    return "error" in out ? out : { ...out, source: url };
  } catch (e) {
    return { error: `SEC XBRL could not be reached (${(e as Error).message.slice(0, 80)})` };
  }
}

/** A compact text table for the model, with every figure's period and tag. */
export function financialsText(f: Financials): string {
  const m = (n: number | null | undefined, unit = "USD") => (n === null || n === undefined ? "n/a" : unit === "USD" ? (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(3)}B` : `$${(n / 1e6).toFixed(1)}M`) : unit === "shares" ? `${(n / 1e6).toFixed(1)}M sh` : `$${n.toFixed(2)}`);
  const row = (p: Period) => `${p.label}: ` + FLOW.map((x) => `${x.label} ${m(p.values[x.key]?.value, x.unit)}`).join("; ");
  const lines = [
    `SEC XBRL companyfacts for ${f.company} (${f.source}), fetched ${f.fetchedAt}. Figures are as reported; derived lines are computed by the app.`,
    ...f.annual.map(row),
    ...(f.ytd ? [row(f.ytd.current), ...(f.ytd.prior ? [row(f.ytd.prior)] : [])] : []),
    ...(f.ttm ? [row(f.ttm)] : []),
    ...(f.latestQuarter ? [row(f.latestQuarter)] : []),
    `Balance sheet ${f.balance.end ?? "n/a"}: ` + Object.entries(f.balance.values).map(([k, v]) => `${INSTANT.find((x) => x.key === k)?.label ?? "Shares outstanding (cover page)"} ${m(v?.value, k.startsWith("shares") ? "shares" : "USD")}${v && k === "sharesCover" ? ` as of ${v.end}` : ""}`).join("; "),
    "Derived: " + f.derived.map((d) => `${d.label} = ${d.value === null ? "n/a" : /margin|growth/i.test(d.label) ? `${(d.value * 100).toFixed(1)}%` : m(d.value)} (${d.formula})`).join("; "),
    ...f.notes,
  ];
  return lines.join("\n");
}
