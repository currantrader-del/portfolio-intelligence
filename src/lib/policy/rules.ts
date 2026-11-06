/**
 * Versioned policy rules (table policy_rules) turned into the limits the engines use.
 *
 * Every rule keeps its source, date and approval. For each subject:
 *  - an approved rule is used as is;
 *  - with no approved rule and several unresolved candidates, the app does NOT pick the largest limit.
 *    It uses the strictest candidate for safety, marks the subject as a conflict, and asks the owner to choose;
 *  - superseded rules are kept for history and never used.
 */
import type { Bucket } from "@/lib/portfolio/classify";
import type { BucketLimit, CompanyLimit, LimitStatus, Policy } from "./limits";

export type PolicyRuleRow = {
  id: string;
  scope: "bucket" | "company" | "generic_company" | "portfolio" | "assumption";
  subject: string;
  normal_low: number | string | null;
  normal_high: number | string | null;
  high_conviction_low: number | string | null;
  high_conviction_high: number | string | null;
  hard_max: number | string | null;
  value: number | string | null;
  conditions: string | null;
  source_label: string;
  source_date: string | null;
  source_status: string;
  approval: "approved" | "superseded" | "unresolved" | "proposed";
  approved_at: string | null;
  approval_note: string | null;
  created_at: string;
};

export type { LimitStatus };

export type SubjectAudit = {
  scope: PolicyRuleRow["scope"];
  subject: string;
  status: LimitStatus;
  used: PolicyRuleRow | null; // the row whose numbers the app uses
  candidates: PolicyRuleRow[]; // unresolved or proposed rows still competing
  history: PolicyRuleRow[]; // superseded rows
  approvedRow: PolicyRuleRow | null;
  differences: string[]; // plain-language differences between candidates
  /** The owner named this candidate as the provisional controlling rule while the conflict stays open. */
  provisional: boolean;
};

/** A candidate the owner marked provisional (approval_note starts with "Provisional"). It controls, but is not approved. */
export const isProvisional = (r: PolicyRuleRow) => r.approval !== "approved" && /^provisional/i.test(r.approval_note ?? "");

export type Assumption = { value: number; status: LimitStatus; source: string };

export type PolicyAudit = {
  subjects: SubjectAudit[];
  conflicts: SubjectAudit[];
  assumptions: { etfExpectedReturn: Assumption; hurdle: Assumption; freshnessDays: Assumption };
  protectedReserve: Assumption;
};

const n = (v: number | string | null | undefined): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

const pctTxt = (v: number | null) => (v === null ? "none" : `${+(v * 100).toFixed(2)}%`);

function strictest(rows: PolicyRuleRow[]): PolicyRuleRow | null {
  if (!rows.length) return null;
  // Lowest hard maximum wins; rows without a maximum lose to rows with one.
  return [...rows].sort((a, b) => (n(a.hard_max) ?? Infinity) - (n(b.hard_max) ?? Infinity))[0];
}

function describeDifferences(rows: PolicyRuleRow[]): string[] {
  if (rows.length < 2) return [];
  const out: string[] = [];
  const fields: [keyof PolicyRuleRow, string][] = [["hard_max", "Maximum"], ["normal_high", "Top of normal range"], ["high_conviction_high", "Top of high-conviction range"]];
  for (const [k, label] of fields) {
    const vals = rows.map((r) => n(r[k] as number | null));
    if (new Set(vals.map(String)).size > 1) out.push(`${label}: ${rows.map((r, i) => `${pctTxt(vals[i])} (${r.source_label}${r.source_date ? `, ${r.source_date}` : ", undated"})`).join(" vs ")}`);
  }
  return out;
}

export function auditRules(rows: PolicyRuleRow[]): PolicyAudit {
  const groups = new Map<string, PolicyRuleRow[]>();
  for (const r of rows) {
    const key = `${r.scope}|${r.subject}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const subjects: SubjectAudit[] = [...groups.entries()].map(([key, rs]) => {
    const [scope, subject] = key.split("|") as [PolicyRuleRow["scope"], string];
    const approvedRows = rs.filter((r) => r.approval === "approved");
    // Two approved rows that disagree are a conflict too: neither is treated as the approved one.
    const approvedAgree = new Set(approvedRows.map((r) => `${n(r.hard_max)}|${n(r.value)}|${n(r.normal_low)}|${n(r.normal_high)}`)).size <= 1;
    const approvedRow = approvedAgree ? approvedRows[0] ?? null : null;
    const candidates = [...(approvedAgree ? [] : approvedRows.map((r) => ({ ...r, approval: "unresolved" as const }))), ...rs.filter((r) => r.approval === "unresolved" || r.approval === "proposed")];
    const history = rs.filter((r) => r.approval === "superseded");
    let status: LimitStatus = "none";
    let used: PolicyRuleRow | null = null;
    if (approvedRow) { status = "approved"; used = approvedRow; }
    else if (candidates.filter((r) => r.approval === "unresolved").length > 1) { status = "conflict"; used = candidates.find(isProvisional) ?? strictest(candidates); }
    else if (candidates.length) { status = candidates.some((r) => r.approval === "unresolved") ? "conflict" : "proposed"; used = candidates.find(isProvisional) ?? strictest(candidates); }
    const provisional = !approvedRow && !!used && isProvisional(used);
    return { scope, subject, status, used, candidates, history, approvedRow, differences: describeDifferences(approvedRow ? [] : candidates), provisional };
  }).sort((a, b) => a.scope.localeCompare(b.scope) || a.subject.localeCompare(b.subject));

  const assumption = (subject: string, fallback: number): Assumption => {
    const s = subjects.find((x) => x.scope === "assumption" && x.subject === subject);
    const v = n(s?.used?.value);
    return v === null ? { value: fallback, status: "none", source: "App default" } : { value: v, status: s!.status, source: s!.used!.source_label };
  };
  const reserveRow = subjects.find((x) => x.scope === "portfolio" && x.subject === "protected_reserve");
  return {
    subjects,
    conflicts: subjects.filter((s) => s.status === "conflict"),
    assumptions: {
      etfExpectedReturn: assumption("etf_expected_return", 0.07),
      hurdle: assumption("hurdle_over_etf", 0.03),
      freshnessDays: assumption("research_freshness_days", 120),
    },
    protectedReserve: n(reserveRow?.used?.value) !== null
      ? { value: n(reserveRow!.used!.value)!, status: reserveRow!.status, source: reserveRow!.used!.source_label }
      : { value: 10000, status: "none", source: "App default" },
  };
}

const range = (lo: number | string | null, hi: number | string | null) => (n(lo) === null || n(hi) === null ? null : { low: n(lo)!, high: n(hi)! });

/** The engines' Policy view, built from the audited rules. */
export function policyFromRules(rows: PolicyRuleRow[], version = "Versioned policy rules"): Policy & { audit: PolicyAudit } {
  const audit = auditRules(rows);
  const buckets: BucketLimit[] = audit.subjects
    .filter((s) => s.scope === "bucket" && s.used)
    .map((s) => ({ bucket: s.subject as Bucket, normal: range(s.used!.normal_low, s.used!.normal_high), hardMax: n(s.used!.hard_max), status: s.status }));
  const companies: Record<string, CompanyLimit> = {};
  for (const s of audit.subjects.filter((x) => x.scope === "company" && x.used)) {
    const u = s.used!;
    companies[s.subject] = {
      symbol: s.subject,
      role: null,
      normal: range(u.normal_low, u.normal_high),
      highConviction: range(u.high_conviction_low, u.high_conviction_high),
      hardMax: n(u.hard_max),
      action: null,
      researchStatus: null,
      status: s.status,
      provisional: s.provisional,
      source: `${u.source_label}${u.source_date ? ` (${u.source_date})` : ""}`,
    };
  }
  const generic = audit.subjects.find((s) => s.scope === "generic_company")?.used ?? null;
  return {
    version,
    buckets,
    companies,
    genericCompanyHardMax: n(generic?.hard_max),
    protectedSavingsFloor: audit.protectedReserve.value,
    researchFreshnessDays: audit.assumptions.freshnessDays.value,
    hurdleOverEtfPoints: audit.assumptions.hurdle.status === "approved" ? audit.assumptions.hurdle.value : null,
    audit,
  };
}
