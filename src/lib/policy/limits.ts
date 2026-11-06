/**
 * Reads the imported policy (Portfolio Baseline v2, latest approved revision) into numbers.
 * The policy text uses strings like "25-40%", "~18%", "50% aggregate"; this parses them.
 */
import type { Bucket } from "@/lib/portfolio/classify";

export type Range = { low: number; high: number } | null;
export type LimitStatus = "approved" | "conflict" | "proposed" | "none";
export type BucketLimit = { bucket: Bucket; normal: Range; hardMax: number | null; status?: LimitStatus };
export type CompanyLimit = { symbol: string; role: string | null; normal: Range; highConviction: Range; hardMax: number | null; action: string | null; researchStatus: string | null; status?: LimitStatus; source?: string };
export type Policy = {
  version: string;
  buckets: BucketLimit[];
  companies: Record<string, CompanyLimit>;
  genericCompanyHardMax: number | null;
  protectedSavingsFloor: number;
  researchFreshnessDays: number;
  hurdleOverEtfPoints: number | null;
  audit?: import("./rules").PolicyAudit;
};

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
  let genericCompanyHardMax: number | null = null;
  for (const [key, v] of Object.entries(scf ?? {})) {
    if (key.startsWith("generic")) {
      genericCompanyHardMax = parsePct(v.hard_boundary);
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
    genericCompanyHardMax,
    protectedSavingsFloor: Number(rules.protected_savings_floor_usd ?? 10000),
    researchFreshnessDays: Number(rules.research_freshness_days ?? 120),
    hurdleOverEtfPoints: typeof rules.hurdle_over_etf_points === "number" ? rules.hurdle_over_etf_points : null,
  };
}

/** The largest weight a company may reach: its own maximum, else the generic boundary, else 10%. */
export function companyMax(p: Policy | null, symbol: string): number {
  return p?.companies[symbol]?.hardMax ?? p?.genericCompanyHardMax ?? 0.1;
}
