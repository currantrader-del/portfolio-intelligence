/**
 * Versioned policy rules (table policy_rules) turned into the limits the engines use.
 *
 * Every rule keeps its source, date and approval. For each subject:
 *  - a rule YOU approved in the app (approved_at set) controls;
 *  - a rule imported from the old archive as "approved" (approved_at empty) is shown as imported, not as
 *    your approval. It still controls as a ceiling until you confirm, revise or retire it;
 *  - a PROPOSAL (approval "proposed", or any candidate nobody has approved) never controls. It is shown
 *    beside the rule in control and changes nothing until you approve it;
 *  - when sources disagree (an imported rule and an unresolved research value), the stricter one is used
 *    as a temporary safety limit, labelled as such, until you decide;
 *  - superseded and rejected rules are kept for history and never used.
 *
 * Companies without their own limit never inherit the generic maximum: they get no new money until
 * research sets a limit and you approve it. The generic maximum is kept only as an absolute ceiling.
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

/** Who stands behind the controlling rule. */
export type Authority = "you" | "imported" | "provisional" | "safety" | "none";

/** Plain labels, so "in control", "proposed" and "imported" can never be confused on screen. */
export const AUTHORITY_LABEL: Record<Authority, string> = {
  you: "Approved by you",
  imported: "Imported from the old archive, not confirmed by you",
  provisional: "Provisional (you marked it), not approved",
  safety: "Temporary safety limit: the stricter of the disputed values, until you decide",
  none: "No rule in control",
};

export type SubjectAudit = {
  scope: PolicyRuleRow["scope"];
  subject: string;
  status: LimitStatus;
  authority: Authority;
  used: PolicyRuleRow | null; // the row whose numbers the app uses
  candidates: PolicyRuleRow[]; // unresolved or proposed rows still waiting for your decision
  history: PolicyRuleRow[]; // superseded and rejected rows
  approvedRow: PolicyRuleRow | null;
  differences: string[]; // plain-language differences between the controlling rule and the candidates
  /** The owner named this candidate as the provisional controlling rule while the conflict stays open. */
  provisional: boolean;
  recommended: PolicyRuleRow | null; // the candidate Claude recommends, if any
};

/** A candidate the owner marked provisional (approval_note starts with "Provisional"). It controls, but is not approved. */
export const isProvisional = (r: PolicyRuleRow) => r.approval !== "approved" && /^provisional/i.test(r.approval_note ?? "");
/** Approved by the owner in the app (as opposed to imported from the archive marked "approved"). */
export const isYours = (r: PolicyRuleRow) => r.approval === "approved" && !!r.approved_at;
export const isRejected = (r: PolicyRuleRow) => r.approval === "superseded" && /rejected by you/i.test(r.approval_note ?? "");
export const RECOMMEND_PREFIX = "Claude recommends:";
export const isRecommended = (r: PolicyRuleRow) => r.approval !== "approved" && (r.approval_note ?? "").startsWith(RECOMMEND_PREFIX);

/**
 * Assumptions the engine no longer uses. Kept in history with their approvals, never used:
 *  - etf_expected_return (7%), hurdle_over_etf (3 points), research_freshness_days (120): app placeholders, never research-backed;
 *  - benchmark_return (one 4.8–7.5% U.S. range) and risk_margin_factor (0.5 x scenario spread): withdrawn 2026-11-08 at your
 *    request. Stocks are now compared with each alternative's own dated forecasts (see ./evidence), with no fixed cutoff.
 */
export const RETIRED_ASSUMPTIONS = new Set(["etf_expected_return", "hurdle_over_etf", "research_freshness_days", "benchmark_return", "risk_margin_factor"]);
export const RETIRED_WHY: Record<string, string> = {
  etf_expected_return: "App placeholder, never from research. Replaced by each alternative's published forecasts.",
  hurdle_over_etf: "App placeholder, never from research. No fixed hurdle is used.",
  research_freshness_days: "App placeholder. Research is refreshed when events happen, not after a fixed number of days.",
  benchmark_return: "Withdrawn 2026-11-08 at your request: one combined U.S. range is no longer used as a bar for every stock.",
  risk_margin_factor: "Withdrawn 2026-11-08 at your request: no universal premium. Downside and uncertainty are shown, not folded into a cutoff.",
};

export type Assumption = { value: number; status: LimitStatus; source: string };

export type PolicyAudit = {
  subjects: SubjectAudit[];
  conflicts: SubjectAudit[];
  /** Every subject with something for you to decide (conflicts and proposals), most material first. */
  decisions: SubjectAudit[];
  /** Imported rules that control but that you never confirmed in the app. */
  imported: SubjectAudit[];
  protectedReserve: Assumption;
  retired: PolicyRuleRow[];
};

const n = (v: number | string | null | undefined): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

const pctTxt = (v: number | null) => (v === null ? "none" : `${+(v * 100).toFixed(2)}%`);
const sameNumbers = (a: PolicyRuleRow, b: PolicyRuleRow) =>
  (["normal_low", "normal_high", "high_conviction_low", "high_conviction_high", "hard_max", "value"] as const).every((k) => n(a[k]) === n(b[k]));

function strictest(rows: PolicyRuleRow[]): PolicyRuleRow | null {
  if (!rows.length) return null;
  // Lowest hard maximum wins; rows without a maximum lose to rows with one.
  return [...rows].sort((a, b) => (n(a.hard_max) ?? Infinity) - (n(b.hard_max) ?? Infinity))[0];
}

const label = (r: PolicyRuleRow) => `${r.source_label}${r.source_date ? `, ${r.source_date}` : ", undated"}`;

export function describeDifferences(rows: PolicyRuleRow[]): string[] {
  if (rows.length < 2) return [];
  const out: string[] = [];
  const fields: [keyof PolicyRuleRow, string][] = [["hard_max", "Maximum"], ["normal_high", "Top of normal range"], ["normal_low", "Bottom of normal range"], ["high_conviction_high", "Top of high-conviction range"], ["value", "Value"]];
  for (const [k, lbl] of fields) {
    const vals = rows.map((r) => n(r[k] as number | null));
    if (new Set(vals.map(String)).size > 1) out.push(`${lbl}: ${rows.map((r, i) => `${k === "value" && r.scope === "portfolio" ? `$${vals[i]?.toLocaleString() ?? "none"}` : pctTxt(vals[i])} (${label(r)})`).join(" vs ")}`);
  }
  return out;
}

function auditSubject(scope: PolicyRuleRow["scope"], subject: string, rs: PolicyRuleRow[]): SubjectAudit {
  const approvedRows = rs.filter((r) => r.approval === "approved");
  const mine = approvedRows.filter(isYours).sort((a, b) => (b.approved_at ?? "").localeCompare(a.approved_at ?? ""));
  const imported = approvedRows.filter((r) => !isYours(r));
  const open = rs.filter((r) => r.approval === "unresolved" || r.approval === "proposed");
  const unresolved = open.filter((r) => r.approval === "unresolved");
  const history = rs.filter((r) => r.approval === "superseded");
  const recommended = open.find(isRecommended) ?? null;
  const base = { scope, subject, history, recommended, candidates: open };

  // 1. Your own approval controls. Open proposals stay visible as decisions, but do not change the numbers.
  if (mine.length) {
    const used = mine[0];
    return { ...base, status: "approved", authority: "you", used, approvedRow: used, differences: describeDifferences([used, ...open]), provisional: false };
  }
  // 2. Imported rules control as a ceiling. A proposal beside them is a decision, not a conflict, and changes nothing.
  const importsAgree = new Set(imported.map((r) => JSON.stringify([n(r.hard_max), n(r.value), n(r.normal_low), n(r.normal_high)]))).size <= 1;
  const provisionalRow = open.find(isProvisional) ?? null;
  if (imported.length && importsAgree && !unresolved.length && !provisionalRow) {
    return { ...base, status: "imported", authority: "imported", used: imported[0], approvedRow: null, differences: describeDifferences([imported[0], ...open]), provisional: false };
  }
  // 3. Only proposals: nothing is in control. A proposal never controls by itself.
  if (!imported.length && !provisionalRow && unresolved.length <= 1) {
    if (!open.length) return { ...base, status: "none", authority: "none", used: null, approvedRow: null, differences: [], provisional: false };
    return { ...base, status: "proposed", authority: "none", used: null, approvedRow: null, differences: describeDifferences(open), provisional: false };
  }
  // 4. Sources disagree: the one you marked provisional, else the stricter value, as a labelled temporary safety limit.
  const pool = [...imported, ...unresolved];
  const used = provisionalRow ?? strictest(pool)!;
  return {
    ...base, status: "conflict", authority: provisionalRow ? "provisional" : "safety", used, approvedRow: null,
    candidates: [...imported, ...open], differences: describeDifferences([...pool, ...open.filter((r) => !pool.includes(r))]), provisional: !!provisionalRow,
  };
}

export function auditRules(rows: PolicyRuleRow[]): PolicyAudit {
  const retired = rows.filter((r) => r.scope === "assumption" && RETIRED_ASSUMPTIONS.has(r.subject));
  const live = rows.filter((r) => !(r.scope === "assumption" && RETIRED_ASSUMPTIONS.has(r.subject)));
  const groups = new Map<string, PolicyRuleRow[]>();
  for (const r of live) {
    const key = `${r.scope}|${r.subject}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const subjects = [...groups.entries()].map(([key, rs]) => {
    const [scope, subject] = key.split("|") as [PolicyRuleRow["scope"], string];
    return auditSubject(scope, subject, rs);
  }).sort((a, b) => a.scope.localeCompare(b.scope) || a.subject.localeCompare(b.subject));

  const find = (scope: string, subject: string) => subjects.find((x) => x.scope === scope && x.subject === subject);
  const reserveRow = find("portfolio", "protected_reserve");

  const weight = (s: SubjectAudit) => (s.status === "conflict" ? 0 : 1) * 10 + (s.scope === "company" ? 0 : s.scope === "assumption" ? 1 : 2);
  return {
    subjects,
    conflicts: subjects.filter((s) => s.status === "conflict"),
    decisions: subjects.filter((s) => s.candidates.some((c) => c.approval === "unresolved" || c.approval === "proposed")).sort((a, b) => weight(a) - weight(b) || a.subject.localeCompare(b.subject)),
    imported: subjects.filter((s) => s.status === "imported"),
    protectedReserve: n(reserveRow?.used?.value) !== null
      ? { value: n(reserveRow!.used!.value)!, status: reserveRow!.status, source: reserveRow!.used!.source_label }
      : { value: 3000, status: "none", source: "App default (your stated USAA reserve)" },
    retired,
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
      authority: s.authority,
      provisional: s.provisional,
      conditions: u.conditions,
      source: `${u.source_label}${u.source_date ? ` (${u.source_date})` : ""}`,
    };
  }
  const generic = audit.subjects.find((s) => s.scope === "generic_company")?.used ?? null;
  return {
    version,
    buckets,
    companies,
    portfolioCeiling: n(generic?.hard_max),
    protectedSavingsFloor: audit.protectedReserve.value,
    audit,
  };
}
