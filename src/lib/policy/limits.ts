/**
 * Reads the imported policy (Portfolio Baseline v2, latest approved revision) into numbers.
 * The policy text uses strings like "25-40%", "~18%", "50% aggregate"; this parses them.
 */
import type { Bucket } from "@/lib/portfolio/classify";

export type Range = { low: number; high: number } | null;
export type LimitStatus = "approved" | "imported" | "conflict" | "proposed" | "none";
export type BucketLimit = { bucket: Bucket; normal: Range; hardMax: number | null; status?: LimitStatus };
export type CompanyLimit = { symbol: string; role: string | null; normal: Range; highConviction: Range; hardMax: number | null; action: string | null; researchStatus: string | null; status?: LimitStatus; source?: string; provisional?: boolean; authority?: import("./rules").Authority };
export type Policy = {
  version: string;
  buckets: BucketLimit[];
  companies: Record<string, CompanyLimit>;
  /** Absolute ceiling for any single company. Never a company's own limit: see companyLimit(). */
  portfolioCeiling: number | null;
  protectedSavingsFloor: number;
  /** Index return range from published forecasts, with whether you approved it. */
  benchmark?: import("./rules").BenchmarkAssumption;
  riskMarginFactor?: number;
  audit?: import("./rules").PolicyAudit;
};

/**
 * Days after which the app reminds you to check what has happened since the research. A reminder only:
 * research is refreshed because of events (results, financings, material filings, a move into another
 * action zone), never because a counter ran out. See refreshState() in ./evidence.
 */
export const AGE_REMINDER_DAYS = 120;

/** "25-40%" -> {0.25, 0.40}; "~3-5%" -> {0.03,0.05}; "TBD" -> null */
export function parseRange(s: unknown): Range {
  if (typeof s !== "string") return null;
  const m = s.replace(/[~≈]/g, "").match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  return { low: Number(m[1]) / 100, high: Number(m[2]) / 100 };
}

/** "~18%" -> 0.18; "50% aggregate" -> 0.5; "No artificial maximum" -> null */
export function parsePct(s: unknown): number | null {
  if (typeof s === "number") return s > 1 ? s / 100 : s;
  if (typeof s !== "string") return null;
  const m = s.replace(/[~≈]/g, "").match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) / 100 : null;
}

const BUCKET_ALIASES: Record<string, Bucket> = {
  "u.s. broad-market equity": "US broad-market equity",
  "international equity": "International equity",
  "small/mid-cap": "Small/mid-cap",
  "sector etfs": "Sector ETFs",
  "quality/growth individual stocks": "Quality/growth individual stocks",
  "asymmetric/high-risk growth sleeve": "Asymmetric/high-risk growth sleeve",
  bonds: "Bonds",
  "deployable cash": "Deployable cash",
};

type Rules = Record<string, unknown>;

export function readPolicy(version: string, rules: Rules): Policy {
  const tap = (rules.target_allocation_policies ?? {}) as Record<string, unknown>;
  const rows = (tap.latest_approved_v2_revised ?? []) as Record<string, string>[];
  const buckets: BucketLimit[] = rows
    .map((r) => {
      const bucket = BUCKET_ALIASES[String(r.bucket ?? "").toLowerCase()];
      return bucket ? { bucket, normal: parseRange(r.normal), hardMax: parsePct(r.hard_max) } : null;
    })
    .filter((x): x is BucketLimit => x !== null);

  const scf = ((rules.single_company_frameworks ?? {}) as Record<string, unknown>).latest_approved_v2_revised as Record<string, Record<string, unknown>> | undefined;
  const companies: Record<string, CompanyLimit> = {};
  let portfolioCeiling: number | null = null;
  for (const [key, v] of Object.entries(scf ?? {})) {
    if (key.startsWith("generic")) {
      portfolioCeiling = parsePct(v.hard_boundary);
      continue;
    }
    companies[key] = {
      symbol: key,
      role: typeof v.role === "string" ? v.role : null,
      normal: parseRange(v.normal),
      highConviction: parseRange(v.high_conviction),
      hardMax: parsePct(v.hard_max ?? v.conditional_hard_max ?? v.provisional_hard_max ?? v.provisional_research_ceiling),
      action: typeof v.action === "string" ? v.action : null,
      researchStatus: typeof v.research_status === "string" ? v.research_status : null,
    };
  }
  return {
    version,
    buckets,
    companies,
    portfolioCeiling,
    protectedSavingsFloor: Number(rules.protected_savings_floor_usd ?? 3000),
  };
}

/**
 * A company's limit. Only a company-specific rule gives room for new money; a company without one
 * (unresearched, or researched but no limit set) gets none. `monitorMax` is the line used to flag an
 * existing holding: its own maximum, else the absolute portfolio ceiling.
 */
export function companyLimit(p: Policy | null, symbol: string): { hasLimit: boolean; newMoneyMax: number; monitorMax: number } {
  const own = p?.companies[symbol]?.hardMax ?? null;
  const ceiling = p?.portfolioCeiling ?? null;
  if (own !== null) return { hasLimit: true, newMoneyMax: ceiling !== null ? Math.min(own, ceiling) : own, monitorMax: ceiling !== null ? Math.min(own, ceiling) : own };
  return { hasLimit: false, newMoneyMax: 0, monitorMax: ceiling ?? 0.1 };
}

/** The line an existing holding is measured against (see companyLimit). */
export function companyMax(p: Policy | null, symbol: string): number {
  return companyLimit(p, symbol).monitorMax;
}
