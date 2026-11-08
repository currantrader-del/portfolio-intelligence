import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFilingCheck, chooseReport, instanceFromIndex } from "./filingCheck";
import { classifyFiling } from "@/lib/market/filingClass";
import { parseSubmissions, type Filing } from "@/lib/market/sec";
import type { ParsedConclusion } from "./valuation";
import submissions from "@/lib/market/__fixtures__/iren-submissions-2026-11-06.json";

// Transcribed subset of IREN's Q1 FY27 10-Q (see the header of the fixture file).
const xml = readFileSync(join(__dirname, "../market/__fixtures__/iren-10q-2026-09-30-subset.xml"), "utf8");
// Shaped like the stored September IREN research: reference $44.30 on 2026-09-10, bear 14.6 / base 76.6 / bull 184.8.
const pc: ParsedConclusion = {
  action: "HOLD / NO ADD", classification: "Speculative", confidence: "6/10", thesis: null, referencePrice: 44.3, referenceDate: "2026-09-10",
  scenarios: [{ name: "bear", value: 14.6, probability: 0.4 }, { name: "base", value: 76.6, probability: 0.45 }, { name: "bull", value: 184.8, probability: 0.15 }] as ParsedConclusion["scenarios"],
  weightedValue: 68, horizonDate: "2030-06-30", zones: [], allocation: null,
};
const f = (form: string, filed: string, accession?: string): Filing => ({ form, filed, reportDate: null, description: form, items: [], isEarnings: false, url: "", accession, ...classifyFiling(form, []) });
const tenQ = f("10-Q", "2026-11-05", "0001878848-26-000066");
// The real submissions list (through 2026-10-13) plus the 10-Q filed on 2026-11-05.
const filings = [tenQ, ...parseSubmissions(submissions, 25).filings];
const doc = { form: "10-Q", filed: "2026-11-05", accession: "0001878848-26-000066", periodEnd: "2026-09-30", indexUrl: "https://www.sec.gov/Archives/edgar/data/1878848/000187884826000066/index.json", instanceUrl: "https://www.sec.gov/Archives/edgar/data/1878848/000187884826000066/iren-20260930_htm.xml" };
const base = { symbol: "IREN", researchAsOf: "2026-09-10", completeness: "complete", conclusion: pc, filings, filingsUrl: "https://data.sec.gov/submissions/CIK0001878848.json", document: doc, now: new Date("2026-11-06T15:00:00Z"), freshDays: 120 };

describe("chooseReport and instanceFromIndex", () => {
  it("picks the 10-Q filed after the research, not the 10-K the research already covered", () => {
    expect(chooseReport(filings, "2026-09-10")).toMatchObject({ afterResearch: true, filing: { form: "10-Q", accession: "0001878848-26-000066" } });
    const old = chooseReport(parseSubmissions(submissions, 25).filings, "2026-09-10");
    expect(old).toMatchObject({ afterResearch: false, filing: { form: "10-K" } });
  });
  it("finds the extracted XBRL instance in an EDGAR index.json, ignoring linkbases", () => {
    const idx = { directory: { item: [{ name: "FilingSummary.xml" }, { name: "iren-20260930_cal.xml" }, { name: "iren-20260930.htm" }, { name: "iren-20260930_htm.xml" }] } };
    expect(instanceFromIndex(idx)).toBe("iren-20260930_htm.xml");
    expect(instanceFromIndex({})).toBeNull();
  });
});

describe("buildFilingCheck on IREN's Q1 FY27 10-Q", () => {
  const c = buildFilingCheck({ ...base, price: 23.95, priceAsOf: "2026-10-31", instanceXml: xml });
  const finding = (k: string) => c.findings.find((x) => x.key === k)!;

  it("compares the quarter-end balance sheet with the one the research could have known", () => {
    const sh = c.facts.find((r) => r.key === "shares")!;
    expect(sh).toMatchObject({ now: 406_929_463, before: 380_710_559, nowDate: "2026-09-30", beforeDate: "2026-06-30", concept: "us-gaap:CommonStockSharesOutstanding" });
    expect(c.coverShares).toEqual({ value: 424_357_381, date: "2026-10-30" });
  });
  it("reconciles net debt exactly to the 10-Q figures ($216m to $4,430m)", () => {
    expect(c.derived).toEqual({ netDebtBefore: 216_000_000, netDebtNow: 4_430_000_000 });
    expect(finding("netDebt")).toMatchObject({ material: true, kind: "calculated" });
    expect(finding("netDebt").text).toContain("$216m to $4,430m");
  });
  it("flags dilution and the share count increase as material, with the numbers shown", () => {
    expect(finding("shares")).toMatchObject({ material: true });
    expect(finding("shares").text).toContain("+6.9%");
    expect(finding("coverShares").text).toContain("+11.5%");
    expect(finding("potentialDilution")).toMatchObject({ material: true });
    expect(finding("potentialDilution").text).toMatch(/193,995,967 .* 46% of shares outstanding/);
  });
  it("reports revenue and loss as reported facts, not as conclusions", () => {
    expect(finding("revenue")).toMatchObject({ kind: "reported", material: false });
    expect(finding("revenue").text).toContain("$228m (-5.0% versus the same quarter a year earlier)");
    expect(finding("netIncome").text).toContain("−$263m");
  });
  it("concludes WAIT / REVIEW, citing the refresh rules that fired", () => {
    expect(c.status).toBe("WAIT / REVIEW");
    expect(c.refresh.level).toBe("targeted_refresh");
    expect(c.refresh.triggers.map((t) => t.rule)).toEqual(expect.arrayContaining(["R3 new financial report"]));
    expect(c.refresh.priceMove).toMatch(/price move/);
    expect(c.statusReason).toMatch(/targeted refresh/);
  });
  it("cites every source it used", () => {
    expect(c.sources.map((s) => s.url)).toEqual([base.filingsUrl, doc.indexUrl, doc.instanceUrl]);
  });
  it("lists what it could not find instead of filling it in", () => {
    expect(c.gaps).toEqual([]); // every key fact was found in this filing and a price was given
    const noPrice = buildFilingCheck({ ...base, price: null, priceAsOf: null, instanceXml: xml });
    expect(noPrice.gaps).toContain("No current price, so price drift against the research was not checked");
    // Prior-year net income and operating cash flow are not in the subset: they show as null, not 0.
    expect(c.facts.find((r) => r.key === "netIncome")).toMatchObject({ now: -263_000_000, before: null, change: null });
  });
  it("never produces a buy, a target or a valuation", () => {
    const s = JSON.stringify(c);
    expect(s).not.toMatch(/"(buy|target|fairValue|valuation)"/i);
    expect(c.status).not.toMatch(/BUY|ADD/);
  });
});

describe("buildFilingCheck when inputs are missing", () => {
  it("stays WAIT / REVIEW and says why when SEC could not be reached", () => {
    const c = buildFilingCheck({ ...base, filings: null, filingsUrl: null, document: null, instanceXml: null, price: 45, priceAsOf: "2026-11-06", errors: ["SEC filing list could not be retrieved (HTTP 503)"] });
    expect(c.status).toBe("WAIT / REVIEW");
    expect(c.statusReason).toMatch(/could not be checked/);
    expect(c.gaps[0]).toMatch(/HTTP 503/);
    expect(c.refresh.notChecked.join(" ")).toMatch(/SEC filings could not be retrieved/);
    expect(c.findings).toEqual([]);
  });
  it("reports a missing tag as a gap and does not compute net debt from partial data", () => {
    const noDebt = xml.replace(/<us-gaap:LongTermDebtNoncurrent[\s\S]*?<\/us-gaap:LongTermDebtNoncurrent>/g, "");
    const c = buildFilingCheck({ ...base, price: 45, priceAsOf: "2026-11-06", instanceXml: noDebt });
    expect(c.derived.netDebtNow).toBeNull();
    expect(c.gaps.some((g) => g.startsWith("Debt, non-current: not found"))).toBe(true);
    expect(c.findings.find((x) => x.key === "netDebt")).toBeUndefined();
    expect(c.status).toBe("WAIT / REVIEW");
  });
  it("says CURRENT when nothing fired, nothing is material and nothing is missing", () => {
    const c = buildFilingCheck({ ...base, filings: [], document: doc, price: 45, priceAsOf: "2026-11-06", instanceXml: xml.replace("406929463", "381000000").replace("424357381", "381500000").replace(/193995967/, "1000").replace(/8947000000/g, "7424000000").replace(/950000000/, "169000000").replace(/3522000000/g, "5600000000").replace(/2208000000/, "1670000000"), freshDays: 120 });
    // Shares, cash, net debt and potential dilution moved less than the thresholds and no rule fired:
    // the check is not hard-wired to WAIT.
    expect(c.findings.filter((x) => x.material)).toEqual([]);
    expect(c.refresh.level).toBe("current");
    expect(c.status).toBe("CURRENT");
  });
});

describe("buildFilingCheck with no new report", () => {
  it("does not invent a gap when the research already covers the newest report", () => {
    const c = buildFilingCheck({ ...base, filings: [], filingsUrl: base.filingsUrl, document: null, instanceXml: null, price: 45, priceAsOf: "2026-11-06", noNewReport: true });
    expect(c).toMatchObject({ status: "CURRENT", gaps: [], findings: [] });
    expect(c.statusReason).toMatch(/No 10-Q or 10-K filed since the research/);
  });
});

describe("share counts tagged per class of stock (as in the live IREN filing)", () => {
  // The live run on 2026-11-06 found no company-level share facts; filings with a named class
  // tag the cover and balance-sheet counts on StatementClassOfStockAxis instead.
  const ctx = (id: string, date: string, member: string) => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0001878848</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">${member}</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>${date}</xbrli:instant></xbrli:period></xbrli:context>`;
  const classed = xml
    .replace('contextRef="c-cover" unitRef="shares" decimals="INF">424357381', 'contextRef="k-cover" unitRef="shares" decimals="INF">424357381')
    .replace('contextRef="c-i-2026-09-30" unitRef="shares" decimals="INF">406929463', 'contextRef="k-sep" unitRef="shares" decimals="INF">406929463')
    .replace('contextRef="c-i-2026-06-30" unitRef="shares" decimals="INF">380710559', 'contextRef="k-jun" unitRef="shares" decimals="INF">380710559')
    .replace("<xbrli:unit id=\"usd\">", ctx("k-cover", "2026-10-30", "iren:OrdinarySharesMember") + ctx("k-sep", "2026-09-30", "iren:OrdinarySharesMember") + ctx("k-jun", "2026-06-30", "iren:OrdinarySharesMember") + "<xbrli:unit id=\"usd\">");
  const c = buildFilingCheck({ ...base, price: 22.34, priceAsOf: "2026-11-06", instanceXml: classed });

  it("reads them from the single class, says so, and keeps the dilution findings", () => {
    expect(c.coverShares).toMatchObject({ value: 424_357_381, date: "2026-10-30", basis: expect.stringContaining("iren:OrdinarySharesMember") });
    expect(c.facts.find((r) => r.key === "shares")).toMatchObject({ now: 406_929_463, before: 380_710_559 });
    expect(c.findings.find((f) => f.key === "shares")?.text).toMatch(/\+6\.9% \(now: sum of 1 share class/);
    expect(c.findings.find((f) => f.key === "potentialDilution")).toMatchObject({ material: true });
    expect(c.gaps).toEqual([]);
    expect(c.diagnostics).toBeUndefined();
  });
  it("never adds a class value to a company total, and refuses a mix of axes", () => {
    const mixed = classed.replace('dimension="us-gaap:StatementClassOfStockAxis">iren:OrdinarySharesMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>2026-10-30', 'dimension="srt:ConsolidationItemsAxis">srt:ParentCompanyMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>2026-10-30');
    const m = buildFilingCheck({ ...base, price: 22.34, priceAsOf: "2026-11-06", instanceXml: mixed });
    expect(m.coverShares).toBeNull();
    expect(m.gaps).toContain("Cover-page shares outstanding were tagged in a way this check does not combine safely");
    expect(m.diagnostics?.some((d) => d.includes("dei:EntityCommonStockSharesOutstanding 2026-10-30 [ConsolidationItemsAxis=srt:ParentCompanyMember]"))).toBe(true);
  });
});
