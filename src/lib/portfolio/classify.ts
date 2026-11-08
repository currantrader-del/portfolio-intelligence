/**
 * Maps each symbol to a policy bucket, and gives approximate ETF look-through weights.
 * Look-through weights are reference inputs, labelled approximate, not live data.
 * Update LOOKTHROUGH_AS_OF when the table is refreshed.
 */
import { FUNDS, canonical } from "@/lib/exposure/reference";

export type Bucket =
  | "US broad-market equity"
  | "International equity"
  | "Small/mid-cap"
  | "Sector ETFs"
  | "Quality/growth individual stocks"
  | "Asymmetric/high-risk growth sleeve"
  | "Bonds"
  | "Deployable cash";

const ETF_BUCKET: Record<string, Bucket> = {
  VOO: "US broad-market equity", IVV: "US broad-market equity", SPY: "US broad-market equity", VTI: "US broad-market equity", ITOT: "US broad-market equity",
  VXUS: "International equity", IXUS: "International equity", VWO: "International equity", VEA: "International equity", IEFA: "International equity", IEMG: "International equity",
  AVUV: "Small/mid-cap", IJH: "Small/mid-cap", IJR: "Small/mid-cap", VB: "Small/mid-cap", VO: "Small/mid-cap",
  VHT: "Sector ETFs", XLK: "Sector ETFs", SMH: "Sector ETFs", SOXX: "Sector ETFs",
  AGG: "Bonds", ISTB: "Bonds", BND: "Bonds", SGOV: "Bonds",
};

export function isEtf(symbol: string): boolean {
  return symbol in ETF_BUCKET;
}

export function bucketOf(symbol: string, classification?: string | null): Bucket {
  if (symbol === "CASH") return "Deployable cash";
  if (ETF_BUCKET[symbol]) return ETF_BUCKET[symbol];
  // The classification comes from stored research or the policy's role for the company.
  if (classification && /specul|asymmetric|early-stage/i.test(classification)) return "Asymmetric/high-risk growth sleeve";
  return "Quality/growth individual stocks";
}

/**
 * Fraction of each ETF held in a company, from the dated fund reference data (src/lib/exposure/reference.ts):
 * each fund's largest published holdings, with share classes combined (GOOGL = Class A + C).
 * Companies outside a fund's listed holdings count as zero here, so look-through can be slightly understated.
 */
export const LOOKTHROUGH: Record<string, Record<string, number>> = Object.fromEntries(
  Object.values(FUNDS).filter((f) => f.top?.length).map((f) => [f.symbol, Object.fromEntries(f.top!.map((t) => [canonical(t.symbol), t.weight]))]),
);
export const LOOKTHROUGH_AS_OF = `${FUNDS.VOO.topSource!.asOf} (fund holdings; see Exposure for each source)`;
// IVV and SPY track the same index as VOO.
LOOKTHROUGH.IVV = LOOKTHROUGH.VOO;
LOOKTHROUGH.SPY = LOOKTHROUGH.VOO;

/** A broad-market ETF used as the "do the simple thing" alternative in decisions. */
export const DEFAULT_ETF_FOR_BUCKET: Partial<Record<Bucket, string>> = {
  "US broad-market equity": "VOO",
  "International equity": "VXUS",
  "Small/mid-cap": "AVUV",
  Bonds: "AGG",
};
