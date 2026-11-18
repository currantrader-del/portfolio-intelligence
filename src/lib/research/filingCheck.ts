/**
 * Research-to-decision check against a company's latest SEC filing.
 *
 *   SEC filing list -> newest report after the research -> its XBRL facts -> material changes
 *   versus what the research could have known -> refresh rules -> WAIT / REVIEW or CURRENT.
 *
 * The core (buildFilingCheck) is pure and deterministic; runFilingCheck does the fetching.
 * It never produces a buy, a target or a valuation. Every number carries its source document
 * and XBRL concept; anything it cannot find is listed as a gap, never filled in.
 */
import type { Filing } from "@/lib/market/sec";
import { describeConcepts, factAt, factByClass, parseXbrlInstance, type XbrlFact } from "@/lib/market/xbrl";
import type { ParsedConclusion } from "./valuation";
import { decideRefresh, type RefreshDecision } from "./refresh";

export const FILING_CHECK_VERSION = "filing-check@1";

type Spec = { key: string; label: string; kind: "instant" | "duration"; tags: string[]; unit: "USD" | "shares" };
export const KEY_FACTS: Spec[] = [
  { key: "shares", label: "Ordinary shares outstanding (balance sheet)", kind: "instant", unit: "shares", tags: ["us-gaap:CommonStockSharesOutstanding", "us-gaap:SharesOutstanding"] },
  { key: "cash", label: "Cash and cash equivalents", kind: "instant", unit: "USD", tags: ["us-gaap:CashAndCashEquivalentsAtCarryingValue"] },
  { key: "restrictedCurrent", label: "Restricted cash, current", kind: "instant", unit: "USD", tags: ["us-gaap:RestrictedCashCurrent", "us-gaap:RestrictedCashAndCashEquivalentsAtCarryingValue"] },
  { key: "restrictedNoncurrent", label: "Restricted cash, non-current", kind: "instant", unit: "USD", tags: ["us-gaap:RestrictedCashNoncurrent", "us-gaap:RestrictedCashAndCashEquivalentsNoncurrent"] },
  { key: "debtCurrent", label: "Debt, current", kind: "instant", unit: "USD", tags: ["us-gaap:LongTermDebtCurrent", "us-gaap:DebtCurrent"] },
  { key: "debtNoncurrent", label: "Debt, non-current", kind: "instant", unit: "USD", tags: ["us-gaap:LongTermDebtNoncurrent"] },
  { key: "leaseCurrent", label: "Finance leases, current", kind: "instant", unit: "USD", tags: ["us-gaap:FinanceLeaseLiabilityCurrent"] },
  { key: "leaseNoncurrent", label: "Finance leases, non-current", kind: "instant", unit: "USD", tags: ["us-gaap:FinanceLeaseLiabilityNoncurrent"] },
  { key: "assets", label: "Total assets", kind: "instant", unit: "USD", tags: ["us-gaap:Assets"] },
  { key: "equity", label: "Stockholders' equity", kind: "instant", unit: "USD", tags: ["us-gaap:StockholdersEquity"] },
  { key: "revenue", label: "Revenue (quarter)", kind: "duration", unit: "USD", tags: ["us-gaap:Revenues", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax"] },
  { key: "netIncome", label: "Net income (quarter)", kind: "duration", unit: "USD", tags: ["us-gaap:NetIncomeLoss", "us-gaap:ProfitLoss"] },
  { key: "opCashFlow", label: "Operating cash flow (quarter)", kind: "duration", unit: "USD", tags: ["us-gaap:NetCashProvidedByUsedInOperatingActivities"] },
  { key: "antidilutive", label: "Potential shares excluded as anti-dilutive", kind: "duration", unit: "shares", tags: ["us-gaap:AntidilutiveSecuritiesExcludedFromComputationOfEarningsPerShareAmount"] },
  { key: "rpo", label: "Remaining performance obligations", kind: "instant", unit: "USD", tags: ["us-gaap:RevenueRemainingPerformanceObligation"] },
];

/** Explicit, versioned thresholds for "material". Each one says why it matters. */
export const MATERIAL = {
  shareGrowth: 0.05, // share count up 5%+ since the research's period: per-share values change
  netDebtToAssets: 0.1, // net debt moved by 10%+ of total assets: the capital structure changed
  cashChange: 0.25, // cash moved 25%+ either way
  potentialDilution: 0.1, // excluded potential shares are 10%+ of shares outstanding
};

export type FactRow = { key: string; label: string; unit: string; now: number | null; before: number | null; change: number | null; concept: string | null; nowDate: string | null; beforeDate: string | null; basis?: string };
export type Finding = { key: string; material: boolean; text: string; kind: "reported" | "calculated" };
export type FilingCheck = {
  version: string;
  symbol: string;
  status: "WAIT / REVIEW" | "CURRENT";
  statusReason: string;
  researchAsOf: string;
  document: { form: string; filed: string; accession: string; periodEnd: string | null; instanceUrl: string | null; indexUrl: string } | null;
  coverShares: { value: number; date: string; basis?: string } | null;
  facts: FactRow[];
  derived: { netDebtNow: number | null; netDebtBefore: number | null };
  findings: Finding[];
  refresh: RefreshDecision;
  sources: { url: string; what: string }[];
  gaps: string[];
  /** Related concepts the filing does contain, recorded when a key fact was not found. */
  diagnostics?: string[];
};

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const m = (x: number) => `$${Math.round(x / 1e6).toLocaleString("en-US")}m`;
const n = (x: number) => Math.round(x).toLocaleString("en-US");

function pick(facts: XbrlFact[], spec: Spec, date: string | null): { value: number; concept: string; basis?: string } | null {
  if (!date) return null;
  for (const t of spec.tags) {
    const f = spec.kind === "instant" ? factAt(facts, t, date, "instant") : factAt(facts, t, date, "duration", 80, 100);
    if (f) return f;
  }
  // Share counts are sometimes tagged only per class of stock; never used for dollar amounts.
  if (spec.unit === "shares" && spec.kind === "instant") {
    for (const t of spec.tags) {
      const c = factByClass(facts, t, date);
      if (c) return { value: c.value, concept: t, basis: `sum of ${c.members.length} share class${c.members.length > 1 ? "es" : ""} (${c.members.join(", ")})` };
    }
  }
  return null;
}

/** Instants and quarter ends present in the instance, newest first. */
function periods(facts: XbrlFact[]) {
  const inst = [...new Set(facts.filter((f) => !f.dimensional && f.instant && f.concept === "us-gaap:Assets").map((f) => f.instant!))].sort().reverse();
  const dur = [...new Set(facts.filter((f) => !f.dimensional && f.end && f.start && (Date.parse(f.end) - Date.parse(f.start)) / 86400000 < 100 && (Date.parse(f.end) - Date.parse(f.start)) / 86400000 > 80).map((f) => f.end!))].sort().reverse();
  return { inst, dur };
}

export function buildFilingCheck(args: {
  symbol: string;
  researchAsOf: string;
  completeness: string;
  conclusion: ParsedConclusion;
  price: number | null;
  priceAsOf: string | null;
  filings: Filing[] | null;
  filingsUrl: string | null;
  document: FilingCheck["document"];
  instanceXml: string | null;
  now: Date;
  freshDays: number;
  errors?: string[];
  /** True when the filing list was read and no 10-Q/10-K was filed after the research: nothing new to read. */
  noNewReport?: boolean;
}): FilingCheck {
  const gaps = [...(args.errors ?? [])];
  const sources: FilingCheck["sources"] = [];
  if (args.filingsUrl) sources.push({ url: args.filingsUrl, what: "SEC filing list" });
  if (args.document) sources.push({ url: args.document.indexUrl, what: `${args.document.form} filed ${args.document.filed} (accession ${args.document.accession})` });
  if (args.document?.instanceUrl && args.instanceXml) sources.push({ url: args.document.instanceUrl, what: "XBRL facts from that filing" });

  const facts = args.instanceXml ? parseXbrlInstance(args.instanceXml) : [];
  if (args.instanceXml && !facts.length) gaps.push("The filing's XBRL file had no readable numeric facts");
  const { inst, dur } = periods(facts);
  const nowI = inst[0] ?? null;
  // "Before" = the latest balance-sheet date the research could have known (on or before its date).
  const beforeI = inst.find((d) => d <= args.researchAsOf && d !== nowI) ?? inst[1] ?? null;
  const nowD = dur[0] ?? null;
  const beforeD = nowD ? dur.find((d) => Date.parse(nowD) - Date.parse(d) > 300 * 86400000) ?? null : null;

  const rows: FactRow[] = facts.length ? KEY_FACTS.map((s) => {
    const a = pick(facts, s, s.kind === "instant" ? nowI : nowD);
    const b = pick(facts, s, s.kind === "instant" ? beforeI : beforeD);
    const basis = [a?.basis && `now: ${a.basis}`, b?.basis && `before: ${b.basis}`].filter(Boolean).join("; ") || undefined;
    return { key: s.key, label: s.label, unit: s.unit, now: a?.value ?? null, before: b?.value ?? null, change: a && b && b.value ? a.value / b.value - 1 : null, concept: a?.concept ?? b?.concept ?? null, nowDate: s.kind === "instant" ? nowI : nowD, beforeDate: s.kind === "instant" ? beforeI : beforeD, ...(basis ? { basis } : {}) };
  }) : [];
  for (const r of rows) if (r.now === null) gaps.push(`${r.label}: not found in the filing's XBRL under ${KEY_FACTS.find((s) => s.key === r.key)!.tags.join(" or ")}`);

  const COVER = "dei:EntityCommonStockSharesOutstanding";
  const coverDates = [...new Set(facts.filter((f) => f.concept === COVER && f.instant).map((f) => f.instant!))].sort().reverse();
  let coverShares: FilingCheck["coverShares"] = null;
  for (const d of coverDates) {
    const plain = factAt(facts, COVER, d, "instant");
    if (plain) { coverShares = { value: plain.value, date: d }; break; }
    const byClass = factByClass(facts, COVER, d);
    if (byClass) { coverShares = { value: byClass.value, date: d, basis: `sum of ${byClass.members.length} share class${byClass.members.length > 1 ? "es" : ""} (${byClass.members.join(", ")})` }; break; }
  }
  if (facts.length && !coverShares) gaps.push(coverDates.length ? "Cover-page shares outstanding were tagged in a way this check does not combine safely" : "Cover-page shares outstanding not found");
  const diagnostics = facts.length && (!coverShares || rows.find((r) => r.key === "shares")?.now == null) ? describeConcepts(facts, /SharesOutstanding|SharesIssued|StockSharesOutstanding/i) : [];

  const v = (k: string, w: "now" | "before") => rows.find((r) => r.key === k)?.[w] ?? null;
  const netDebt = (w: "now" | "before") => {
    const parts = ["debtCurrent", "debtNoncurrent", "leaseCurrent", "leaseNoncurrent"].map((k) => v(k, w) ?? 0);
    const cash = ["cash", "restrictedCurrent", "restrictedNoncurrent"].map((k) => v(k, w) ?? 0);
    return v("debtNoncurrent", w) === null || v("cash", w) === null ? null : parts.reduce((s, x) => s + x, 0) - cash.reduce((s, x) => s + x, 0);
  };
  const derived = { netDebtNow: netDebt("now"), netDebtBefore: netDebt("before") };

  const findings: Finding[] = [];
  const sh = rows.find((r) => r.key === "shares");
  if (sh?.change != null) findings.push({ key: "shares", kind: "calculated", material: sh.change >= MATERIAL.shareGrowth, text: `Shares outstanding ${n(sh.before!)} (${sh.beforeDate}) to ${n(sh.now!)} (${sh.nowDate}): ${pct(sh.change)}${sh.basis ? ` (${sh.basis})` : ""}` });
  if (coverShares && sh?.before) {
    const c = coverShares.value / sh.before - 1;
    findings.push({ key: "coverShares", kind: "calculated", material: c >= MATERIAL.shareGrowth, text: `Cover page: ${n(coverShares.value)} shares on ${coverShares.date}${coverShares.basis ? ` (${coverShares.basis})` : ""}, ${pct(c)} versus ${sh.beforeDate}` });
  }
  if (derived.netDebtNow !== null && derived.netDebtBefore !== null) {
    const d = derived.netDebtNow - derived.netDebtBefore;
    const assets = v("assets", "now");
    findings.push({ key: "netDebt", kind: "calculated", material: !!assets && Math.abs(d) >= MATERIAL.netDebtToAssets * assets, text: `Net debt (debt + finance leases − cash − restricted cash) ${m(derived.netDebtBefore)} to ${m(derived.netDebtNow)}: ${d >= 0 ? "+" : "−"}${m(Math.abs(d))}` });
  }
  const cash = rows.find((r) => r.key === "cash");
  if (cash?.change != null) findings.push({ key: "cash", kind: "reported", material: Math.abs(cash.change) >= MATERIAL.cashChange, text: `Cash ${m(cash.before!)} to ${m(cash.now!)}: ${pct(cash.change)}` });
  const anti = v("antidilutive", "now");
  const base = coverShares?.value ?? v("shares", "now");
  if (anti !== null && base) findings.push({ key: "potentialDilution", kind: "calculated", material: anti / base >= MATERIAL.potentialDilution, text: `${n(anti)} potential shares (options, RSUs, convertibles, rights) were excluded from diluted EPS: ${(anti / base * 100).toFixed(0)}% of shares outstanding` });
  const rev = rows.find((r) => r.key === "revenue");
  if (rev?.now != null) findings.push({ key: "revenue", kind: "reported", material: false, text: `Quarterly revenue ${m(rev.now)}${rev.change != null ? ` (${pct(rev.change)} versus the same quarter a year earlier)` : ""}` });
  const ni = v("netIncome", "now");
  const niBefore = v("netIncome", "before");
  // A swing from profit to loss is material; an unknown prior year is not assumed to be a profit.
  if (ni !== null) findings.push({ key: "netIncome", kind: "reported", material: ni < 0 && niBefore !== null && niBefore >= 0, text: `Quarterly net income ${ni < 0 ? "−" : ""}${m(Math.abs(ni))}${niBefore === null ? " (same quarter a year earlier not in this filing's facts)" : ` versus ${niBefore < 0 ? "−" : ""}${m(Math.abs(niBefore))} a year earlier`}` });

  const refresh = decideRefresh({
    conclusion: args.conclusion, researchAsOf: args.researchAsOf, completeness: args.completeness,
    price: args.price, priceAsOf: args.priceAsOf, filings: args.filings, now: args.now, freshDays: args.freshDays,
  });
  if (args.price === null) gaps.push("No current price, so price drift against the research was not checked");

  const material = findings.filter((f) => f.material);
  const unread = !args.document && !args.noNewReport;
  const wait = refresh.level !== "current" || material.length > 0 || unread || gaps.length > 0;
  const statusReason = unread
    ? "No report filed after the research could be read, so the research could not be checked."
    : refresh.level !== "current"
      ? `Refresh rules call for a ${refresh.level.replace("_", " ")} (${refresh.triggers.map((t) => t.rule).join("; ")}).`
      : material.length ? `${material.length} material change${material.length > 1 ? "s" : ""} since the research period.`
      : gaps.length ? "Some inputs could not be checked."
      : args.noNewReport ? "No 10-Q or 10-K filed since the research, and no refresh rule fired." : "No material change found in the items checked.";
  return {
    version: FILING_CHECK_VERSION, symbol: args.symbol, status: wait ? "WAIT / REVIEW" : "CURRENT", statusReason,
    researchAsOf: args.researchAsOf, document: args.document, coverShares, facts: rows, derived, findings, refresh, sources, gaps,
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}

/** Newest 10-Q/10-K filed after the research date, or the newest one at all if none is newer. */
export function chooseReport(filings: Filing[], researchAsOf: string): { filing: Filing; afterResearch: boolean } | null {
  const periodic = filings.filter((f) => f.category === "periodic" && f.accession).sort((a, b) => b.filed.localeCompare(a.filed));
  const after = periodic.find((f) => f.filed > researchAsOf);
  if (after) return { filing: after, afterResearch: true };
  return periodic[0] ? { filing: periodic[0], afterResearch: false } : null;
}

/** EDGAR index.json -> the filing's extracted XBRL instance (*_htm.xml), if any. */
export function instanceFromIndex(body: unknown): string | null {
  const items = (body as { directory?: { item?: { name?: string }[] } })?.directory?.item ?? [];
  const names = items.map((i) => i.name ?? "");
  return names.find((x) => /_htm\.xml$/i.test(x)) ?? names.find((x) => /\.xml$/i.test(x) && !/^(FilingSummary|MetaLinks)/i.test(x) && !/_(cal|def|lab|pre)\.xml$/i.test(x)) ?? null;
}
