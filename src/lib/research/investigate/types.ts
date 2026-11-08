/**
 * The state of one research investigation. It is saved after every step (model_runs
 * "investigation_step"), so each step is a checkpoint and a run can resume where it stopped.
 */
import type { ScenarioSpec, ValuationResult } from "./valuationCalc";
import type { Financials } from "./financials";

export type ResearchType = "full_investigation" | "material_event_refresh";
export type DocKind = "10-K" | "10-Q" | "20-F" | "earnings_release" | "earnings_exhibit" | "transcript" | "presentation" | "proxy" | "financing" | "material_8k" | "other";
/**
 * fully_reviewed: every material section was read in full by Claude.
 * partially_reviewed: some material sections (or parts) were read in full, not all.
 * retrieved: the document was downloaded but not read.
 * unavailable: it could not be found or downloaded (reason given).
 * search_result_only: only a search snippet was seen; never counted as reviewed.
 * reviewed_earlier: read in full by the research this refresh builds on (not re-read).
 */
export type DocStatus = "fully_reviewed" | "partially_reviewed" | "retrieved" | "unavailable" | "search_result_only" | "reviewed_earlier";

export type SectionInfo = { key: string; label: string; chars: number; material: boolean; parts: number; reviewedParts: number[] };
export type InvDoc = {
  id: string;
  kind: DocKind;
  title: string;
  url: string;
  form?: string | null;
  filed?: string | null;
  accession?: string | null;
  required: boolean;
  phases: number[];
  why: string;
  origin: "sec" | "company" | "web";
  fetched?: { chars: number; sha256: string; at: string; contentType: string } | null;
  sections?: SectionInfo[];
  status: DocStatus;
  unavailable_reason?: string | null;
  attempts?: string[];
};

export type Fact = { claim: string; value: string; unit: string; period: string; quote: string; check?: string };
export type Review = {
  key: string; // docId:section:part
  docId: string;
  section: string;
  part: number;
  parts: number;
  chars: number;
  model: string;
  at: string;
  summary: string;
  facts: Fact[];
  guidance: string[];
  risks: string[];
  capital: string[];
  qa: { question: string; answer: string }[];
  flags: string[];
  focus: string | null;
};

export type FindingSource = "primary" | "xbrl" | "secondary" | "calculation" | "estimate";
export type Finding = {
  id: string;
  phase: number;
  claim: string;
  value: string;
  unit: string;
  period: string;
  doc_id: string | null;
  quote: string;
  source: FindingSource;
  key: boolean;
  check: { status: "verified" | "quote_found_value_not_in_quote" | "quote_not_found" | "xbrl" | "secondary_unverifiable" | "calculation" | "estimate" | "document_unreadable"; detail: string };
  /** For a key figure not verified from a primary document: how it is treated (set in the evidence review). */
  classification?: FindingClassification;
  /** Set when the finding was withdrawn (wrong quote or figure, replaced by another finding); kept for the audit trail. */
  withdrawn?: { reason: string; replaced_by: string | null };
};

export type Question = {
  id: string;
  phase: number;
  question: string;
  materiality: "high" | "medium" | "low";
  why: string;
  status: "open" | "resolved" | "unresolvable";
  answer?: string;
  evidence?: string[];
  attempts?: string[];
  why_unresolvable?: string;
  could_change_conclusion?: boolean;
  impact?: string;
};

export type Conflict = { id: string; phase: number; description: string; finding_ids: string[]; resolution: string; status: "resolved" | "unresolved" };

export type PhaseState = {
  n: number;
  title: string;
  status: "pending" | "running" | "complete" | "incomplete" | "carried_forward";
  attempts: number;
  summary: string;
  key_points: string[];
  gate: string[];
  usage: Usage;
  at?: string;
  carried_from?: string | null;
};

export const CHALLENGE_AREAS = ["thesis", "valuation_assumptions", "probabilities", "projections", "competition", "portfolio_recommendation"] as const;
export type ChallengeArea = (typeof CHALLENGE_AREAS)[number];
/**
 * One challenge from the skeptical review. Each names the claim it attacks and the test the reviewer
 * actually ran (a document check, a stress test computed by the app, a comparison with the record),
 * and the result of that test, so it is a tested objection rather than an opinion.
 */
export type Objection = {
  id: string; objection: string; severity: "critical" | "major" | "minor"; evidence_to_check: string;
  area?: ChallengeArea; claim?: string; test?: string; test_result?: string; test_kind?: "document" | "stress_test" | "record" | "reasoning"; finding_ids?: string[];
  response?: string; outcome?: "rebutted" | "accepted" | "partly_accepted"; response_evidence?: string[];
};
/** The skeptic's verdict on whether the research's conclusions survive its challenges. */
export type ReviewVerdict = {
  thesis: "survives" | "survives_with_changes" | "fails"; valuation: "survives" | "survives_with_changes" | "fails"; recommendation: "survives" | "survives_with_changes" | "fails";
  summary: string; required_changes: string[]; at: string;
};
/** How a key figure that is not verified from a primary document is treated. */
export type EvidenceClass = "verified_primary" | "labeled_estimate" | "unresolved_not_material" | "unresolved_thesis_changing";
export type FindingClassification = { cls: EvidenceClass; explanation: string; impact: string; replaced_by?: string | null };
/** App-computed checks that the written conclusion matches the numbers and the portfolio. */
export type ConsistencyCheck = { ok: boolean; issues: string[]; checks: { label: string; ok: boolean; detail: string }[] };

export type Usage = { calls: number; input: number; cacheRead: number; cacheWrite: number; output: number; searches: number; costUsd: number; ms: number; byModel: Record<string, { calls: number; costUsd: number }> };

export type InvestmentSummary = {
  headline: string;
  business_quality: { rating: string; why: string };
  valuation: string;
  expected_return: string;
  risks: string[];
  portfolio_fit: string;
  action: string;
  confidence: "Low" | "Moderate" | "High";
  would_change: string[];
  reasons: string[];
  classification: string;
  thesis: string;
  price_framework: { price_zone: string; action: string }[];
  allocation: { target_pct: number | null; max_pct: number | null; note: string };
  changes_vs_prior: string;
};

export type RunState = {
  version: string;
  type: ResearchType;
  symbol: string;
  name: string | null;
  cik: string | null;
  today: string;
  requestId: string;
  versionId: string | null;
  base: { versionId: string; research_as_of: string; origin: string; summary: string; type: string | null } | null;
  steps: string[]; // the plan, in order
  next: number; // index into steps
  attemptsAtStep: number;
  seq: number;
  startedAt: string;
  status: "running" | "paused" | "finished" | "failed";
  pauseReason?: string | null;
  price: { value: number | null; asOf: string | null; source: string | null };
  financials: Financials | null;
  inventory: InvDoc[];
  reviews: Review[];
  findings: Finding[];
  questions: Question[];
  conflicts: Conflict[];
  phases: PhaseState[];
  valuation: { specs: ScenarioSpec[]; horizon_date: string; result: ValuationResult; revenue_basis: string } | null;
  objections: Objection[];
  review?: ReviewVerdict | null;
  /** Sensitivity results the app computed for the skeptic (kept for the audit trail). */
  stress?: { label: string; weighted_value: number | null; annualized_return: number | null; note: string }[];
  consistency?: ConsistencyCheck | null;
  portfolioCheck?: { weight: number | null; direct: number | null; normalHigh: number | null; max: number | null; limitAuthority: string | null; headroomDollars: number | null } | null;
  summary: InvestmentSummary | null;
  /** When the summary and the valuation were last set, to tell whether the conclusion was revisited after the review. */
  summaryAt?: string | null;
  valuationAt?: string | null;
  /** The conclusion as it stood before the skeptical review, kept to show whether it survived. */
  draft?: { action: string | null; confidence: string | null; headline: string | null; weighted_value: number | null; annualized_return: number | null; at: string } | null;
  /**
   * complete: every rule met. work_incomplete: work that could still be done is missing.
   * material_uncertainty: the work was done but a material question has no reliable answer.
   */
  completeness: { complete: boolean; reasons: string[]; kind?: "complete" | "work_incomplete" | "material_uncertainty" } | null;
  usage: Usage;
  log: { at: string; step: string; note: string }[];
  refreshTriggers?: { rule: string; evidence: string }[];
};

export const emptyUsage = (): Usage => ({ calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, searches: 0, costUsd: 0, ms: 0, byModel: {} });

export function addUsage(a: Usage, b: Usage): Usage {
  const byModel = { ...a.byModel };
  for (const [k, v] of Object.entries(b.byModel)) byModel[k] = { calls: (byModel[k]?.calls ?? 0) + v.calls, costUsd: Math.round(((byModel[k]?.costUsd ?? 0) + v.costUsd) * 10000) / 10000 };
  return { calls: a.calls + b.calls, input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output, searches: a.searches + b.searches, costUsd: Math.round((a.costUsd + b.costUsd) * 10000) / 10000, ms: a.ms + b.ms, byModel };
}
