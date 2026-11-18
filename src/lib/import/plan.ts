/**
 * Builds an import plan from the preserved ChatGPT originals.
 * Pure: takes already-read file contents and their SHA-256, returns rows to insert plus an audit report.
 * Import rules (from the handoff): never treat history as live, keep provenance on every row,
 * never mark partial archives complete, label reconstructions, flag conflicts instead of resolving them.
 */
export type Doc = { key: string; fileName: string; sha256: string; byteSize: number; origin: "chatgpt_export" | "chatgpt_paste"; description: string };
export type PhasePlan = { phase_number: number; title: string | null; body_markdown: string | null; extraction: "verbatim" | "reconstructed" | "summary_only" | "truncated" | "missing"; docKey: string; details?: Record<string, unknown> };
export type VersionPlan = {
  symbol: string; research_as_of: string; completeness: "complete" | "partial" | "in_progress";
  origin: "chatgpt_original" | "chatgpt_reconstructed"; is_current: boolean;
  conclusion: Record<string, unknown>; change_summary: string; docKey: string; phases: PhasePlan[];
};
export type CompanyPlan = { symbol: string; name: string | null; watchlist_status: "held" | "watch" | "queued" | "excluded" };
export type DecisionPlan = { symbol: string | null; decided_at: string; recommendation: Record<string, unknown>; docKey: string };
export type PolicyPlan = { version: string; effective_from: string; rules: Record<string, unknown>; docKey: string };
export type ImportPlan = { documents: Doc[]; companies: CompanyPlan[]; versions: VersionPlan[]; decisions: DecisionPlan[]; policy: PolicyPlan | null; report: string[] };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export type Inputs = {
  docs: Doc[];
  irenArchive?: Json;             // IREN_FULL_RESEARCH_ARCHIVE
  rddtArchiveA?: Json;            // 131 KB version: phase 4 verbatim, 6 restated, 1-3 summaries
  rddtArchiveB?: Json;            // 99 KB version: 1-3 and 6 reconstructed, master record present
  rddtPhase4Md?: string;          // Pasted markdown(8)
  rddtPhase5Md?: string;          // Pasted markdown(9)
  googlMasterMd?: string;         // Pasted markdown(7), Sep 12
  master?: Json;                  // MASTER_INVESTMENT_RESEARCH_AND_DECISIONS_2026.json
  watchlist?: Json;               // WATCHLIST_SCREENING_COMPLETE_2026.json
  baseline?: Json;                // PORTFOLIO_BASELINE_AND_RISK_POLICY.json
};

const docKeyFor = (inputs: Inputs, key: string) => {
  if (!inputs.docs.some((d) => d.key === key)) throw new Error(`Missing source document for ${key}`);
  return key;
};

function conclusionFromMaster(rec: Json): Record<string, unknown> {
  const conf = rec.confidence;
  return {
    classification: rec.investment_classification ?? null,
    status: rec.status ?? null,
    action: rec.current_action ?? null,
    confidence: typeof conf === "object" && conf ? `${conf.score}/${conf.scale}${conf.label ? ` (${conf.label})` : ""}` : conf ?? null,
    reference_price: rec.reference_price != null ? `$${rec.reference_price}` : null,
    reference_date: rec.reference_date ?? null,
    thesis: rec.thesis ?? null,
    valuation: rec.valuation ?? null,
    allocation: rec.allocation_framework ?? null,
    price_framework: rec.price_action_framework ?? null,
    is_historical: true,
  };
}

const findPhase = (archive: Json, n: number) => (archive?.research_phases ?? []).find((p: Json) => Number(p.phase_number) === n);

export function buildPlan(inputs: Inputs): ImportPlan {
  const report: string[] = [];
  const versions: VersionPlan[] = [];
  const masterBy = new Map<string, Json>((inputs.master?.master_records ?? []).map((r: Json) => [r.ticker, r]));

  // IREN: complete original archive.
  if (inputs.irenArchive) {
    const a = inputs.irenArchive;
    const phases: PhasePlan[] = [1, 2, 3, 4, 5, 6].map((n) => {
      const p = findPhase(a, n);
      const body = p?.full_report_markdown || p?.checkpoint_text || null;
      return { phase_number: n, title: null, body_markdown: body, extraction: body ? "verbatim" : "missing", docKey: docKeyFor(inputs, "iren_archive"),
        details: p ? { major_findings: p.major_findings ?? null, conflicts: p.conflicts ?? null, unresolved_questions: p.unresolved_questions ?? null } : {} };
    });
    const missing = phases.filter((p) => p.extraction === "missing").length;
    versions.push({
      symbol: "IREN", research_as_of: a.research_as_of_date ?? "2026-09-10",
      completeness: missing ? "partial" : "complete", origin: "chatgpt_original", is_current: !missing,
      conclusion: masterBy.has("IREN") ? conclusionFromMaster(masterBy.get("IREN")) : { master_record_markdown: a.master_record?.master_record_markdown ?? null, is_historical: true },
      change_summary: "Imported from the original IREN research archive.", docKey: "iren_archive", phases,
    });
    report.push(`IREN: ${6 - missing}/6 phases verbatim from the original archive${missing ? `, ${missing} missing` : ""}.`);
  }

  // RDDT: assembled from the best available source per phase; always partial.
  if (inputs.rddtArchiveA || inputs.rddtArchiveB || inputs.rddtPhase4Md || inputs.rddtPhase5Md) {
    const phases: PhasePlan[] = [];
    for (const n of [1, 2, 3]) {
      const b = findPhase(inputs.rddtArchiveB, n);
      if (b?.checkpoint_text) phases.push({ phase_number: n, title: null, body_markdown: b.checkpoint_text, extraction: "reconstructed", docKey: docKeyFor(inputs, "rddt_b") });
      else phases.push({ phase_number: n, title: null, body_markdown: null, extraction: "missing", docKey: "rddt_b" });
    }
    if (inputs.rddtPhase4Md) phases.push({ phase_number: 4, title: null, body_markdown: inputs.rddtPhase4Md, extraction: "verbatim", docKey: docKeyFor(inputs, "rddt_p4") });
    if (inputs.rddtPhase5Md) phases.push({ phase_number: 5, title: null, body_markdown: inputs.rddtPhase5Md, extraction: "verbatim", docKey: docKeyFor(inputs, "rddt_p5") });
    const a6 = findPhase(inputs.rddtArchiveA, 6);
    if (a6?.checkpoint_text) phases.push({ phase_number: 6, title: null, body_markdown: a6.checkpoint_text, extraction: "reconstructed", docKey: docKeyFor(inputs, "rddt_a"),
      details: { note: "Restated in a later ChatGPT conversation; not the original checkpoint." } });
    versions.push({
      symbol: "RDDT", research_as_of: "2026-09-13", completeness: "partial", origin: "chatgpt_reconstructed", is_current: true,
      conclusion: masterBy.has("RDDT") ? conclusionFromMaster(masterBy.get("RDDT")) : { is_historical: true },
      change_summary: "Phases 4 and 5 are original text; phases 1-3 and 6 are ChatGPT reconstructions; dossier and full source inventory were never recovered.",
      docKey: inputs.rddtArchiveB ? "rddt_b" : "rddt_a", phases,
    });
    report.push("RDDT: phases 4-5 verbatim, 1-3 and 6 reconstructed; marked partial.");
  }

  // GOOGL: Sep 12 master record kept as dated history. It conflicts with the old app's Sep 26 record, so nothing is current.
  if (inputs.googlMasterMd) {
    versions.push({
      symbol: "GOOGL", research_as_of: "2026-09-12", completeness: "partial", origin: "chatgpt_original", is_current: false,
      conclusion: { classification: "Core", action: "HOLD / NO ADD", reference_price: "$339.43", master_record_markdown: inputs.googlMasterMd, is_historical: true },
      change_summary: "Master record only; the six phases were not recovered. Conflicts with the old app's Sep 26 record, so neither is current (decided 2026-11-05).",
      docKey: docKeyFor(inputs, "googl_md"), phases: [],
    });
    report.push("GOOGL: Sep 12 master record imported as history, not current. The Sep 26 record from the old database is imported separately.");
  }
  if (inputs.master?.incomplete_company_research?.some((r: Json) => r.ticker === "GOOGL")) {
    report.push("GOOGL: the master JSON's 'Phase 1, unapproved' entry is the oldest snapshot and is superseded; kept only as a source document.");
  }

  // Companies: the 39-company watchlist, plus anything with research.
  const companies = new Map<string, CompanyPlan>();
  for (const c of inputs.watchlist?.company_records ?? []) {
    const owned = String(c.latest_owned_status ?? "").toLowerCase() === "owned";
    companies.set(c.ticker, { symbol: c.ticker, name: c.company ?? null, watchlist_status: owned ? "held" : "watch" });
  }
  for (const v of versions) if (!companies.has(v.symbol)) companies.set(v.symbol, { symbol: v.symbol, name: null, watchlist_status: "held" });
  if (inputs.watchlist) report.push(`Watchlist: ${inputs.watchlist.company_records?.length ?? 0} companies; ownership flags are historical and get replaced by synced holdings.`);

  // Decision history: authoritative entries become historical decision records.
  const decisions: DecisionPlan[] = [];
  for (const d of inputs.master?.superseded_and_authoritative_decision_log ?? []) {
    const rec = masterBy.get(d.ticker);
    if (!rec) continue; // GOOGL has no authoritative record in this file
    decisions.push({ symbol: d.ticker, decided_at: rec.research_as_of_date ?? rec.reference_date,
      recommendation: { action: rec.current_action, summary: d.authoritative, superseded: d.superseded ?? [] }, docKey: docKeyFor(inputs, "master") });
  }
  if (decisions.length) report.push(`Decisions: ${decisions.length} historical decisions imported.`);

  // Policy: Portfolio Baseline v2 limits only. Account values in it are historical and are not imported as holdings.
  let policy: PolicyPlan | null = null;
  if (inputs.baseline) {
    const b = inputs.baseline;
    policy = { version: "Portfolio Baseline v2", effective_from: b.export_date ?? "2026-11-05",
      rules: { target_allocation_policies: b.target_allocation_policies ?? null, single_company_frameworks: b.single_company_frameworks ?? null,
        rebalancing_and_risk_rules: b.rebalancing_and_risk_rules ?? null, protected_savings_floor_usd: 10000,
        research_freshness_days: 120, hurdle_over_etf_points: null, note: "Hurdle not yet chosen by Brendan." },
      docKey: docKeyFor(inputs, "baseline") };
    report.push("Policy: Baseline v2 limits imported; its account balances are history only and are not used as holdings.");
  }

  return { documents: inputs.docs, companies: [...companies.values()], versions, decisions, policy, report };
}
