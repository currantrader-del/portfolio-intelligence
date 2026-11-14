import { analystEvidence, type AnalystReport } from "@/lib/analyst/report";
/** Builds the "Update research" plan for a company from its saved versions (used by the page and the server). */
import { getFilings } from "@/lib/market/sec";
import { shortDate } from "@/lib/format";
import { AUTHORITY_LABEL, updateFoundation } from "./standing";
import { planUpdate, type UpdatePlan } from "./updatePlan";
import type { VersionRow } from "./records";

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() && Number.isFinite(Number(x.replace(/[$,]/g, ""))) ? Number(x.replace(/[$,]/g, "")) : null);

export async function updatePlanFor(symbol: string, versions: (VersionRow & { created_at?: string | null })[], price: number | null, estimates?: Partial<UpdatePlan["estimates"]>, now = new Date(), analyst: AnalystReport[] = []): Promise<{ plan: UpdatePlan; filingsChecked: boolean }> {
  const found = updateFoundation(versions);
  const filingsRes = await getFilings(symbol).catch(() => null);
  const filings = filingsRes && !("error" in filingsRes) ? filingsRes.filings : null;
  const fc = (found?.v.conclusion ?? {}) as Record<string, unknown>;
  const fv = (fc.valuation ?? {}) as Record<string, unknown>;
  const plan = planUpdate({
    foundation: found ? {
      versionId: found.v.id, asOf: found.v.research_as_of, label: `${shortDate(found.v.research_as_of)}, ${AUTHORITY_LABEL[found.authority].toLowerCase()}`,
      // Finished all its phases (complete, or with open questions recorded) is a foundation; only a run that stopped part-way is not.
      complete: found.v.completeness === "complete" || !!fc.completion, isInvestigation: true, referencePrice: num(fc.reference_price), terminalDate: typeof fv.terminal_date === "string" ? fv.terminal_date : null,
      scenarios: { bear: num(fv.bear_value), base: num(fv.base_value), bull: num(fv.bull_value), pBear: num(fv.bear_probability), pBase: num(fv.base_probability), pBull: num(fv.bull_probability) },
      reviewedAccessions: [],
    } : null,
    filings, price, now, estimates, analyst: found ? analystEvidence(analyst, (found.v as { created_at?: string | null }).created_at ?? found.v.research_as_of) : [],
  });
  return { plan, filingsChecked: filings !== null };
}
