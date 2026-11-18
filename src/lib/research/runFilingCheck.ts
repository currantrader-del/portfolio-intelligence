import "server-only";
import { getFilings, padCik, secText } from "@/lib/market/sec";
import type { ResearchRecord } from "./records";
import { buildFilingCheck, chooseReport, instanceFromIndex, type FilingCheck } from "./filingCheck";

const archive = (cik: string, accession: string) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}`;

/**
 * Fetches the newest 10-Q/10-K filed after the stored research straight from SEC EDGAR, reads its
 * own XBRL instance, and runs the deterministic check. Each failed step becomes a listed gap.
 */
export async function runFilingCheck(args: { record: ResearchRecord; price: number | null; priceAsOf: string | null; now: Date; freshDays: number }): Promise<{ check: FilingCheck; basis: { versionId: string; researchAsOf: string } }> {
  const v = args.record.current ?? args.record.latest;
  if (!v) throw new Error("No stored research to compare against");
  const errors: string[] = [];
  const fl = await getFilings(args.record.symbol, args.now);
  const filings = "error" in fl ? null : fl.filings;
  if ("error" in fl) errors.push(fl.error);

  let document: FilingCheck["document"] = null;
  let instanceXml: string | null = null;
  const pick = filings ? chooseReport(filings, v.research_as_of) : null;
  if (filings && !pick) errors.push("No 10-Q or 10-K in the recent SEC filing list");
  if (pick?.afterResearch && !("error" in fl)) {
    const base = archive(padCik(fl.cik), pick.filing.accession!);
    const indexUrl = `${base}/index.json`;
    const idx = await secText(indexUrl);
    let instanceName: string | null = null;
    if (idx.ok) {
      try { instanceName = instanceFromIndex(JSON.parse(idx.body)); } catch { errors.push(`The filing index at ${indexUrl} was not valid JSON`); }
      if (idx.ok && !instanceName) errors.push("The filing has no XBRL instance file, so its numbers could not be read");
    } else errors.push(idx.error);
    const instanceUrl = instanceName ? `${base}/${instanceName}` : null;
    if (instanceUrl) {
      const inst = await secText(instanceUrl);
      if (inst.ok) instanceXml = inst.body; else errors.push(inst.error);
    }
    document = { form: pick.filing.form, filed: pick.filing.filed, accession: pick.filing.accession!, periodEnd: pick.filing.reportDate, indexUrl, instanceUrl };
  }

  const check = buildFilingCheck({
    symbol: args.record.symbol, researchAsOf: v.research_as_of, completeness: v.completeness, conclusion: v.parsed,
    price: args.price, priceAsOf: args.priceAsOf, filings, filingsUrl: "error" in fl ? null : fl.source,
    document, instanceXml, now: args.now, freshDays: args.freshDays, errors, noNewReport: !!pick && !pick.afterResearch,
  });
  return { check, basis: { versionId: v.id, researchAsOf: v.research_as_of } };
}
