/**
 * The shareable report: one saved investigation laid out in full for someone else to read, with the
 * owner's private financial information removed (see redact.ts).
 *
 * Everything comes from the saved record, its reviewer annotations and the app's own validation. No
 * research is re-run and no AI is called. The only text the app adds is clearly labeled: status lines,
 * redaction markers, and a short standard note on position sizing in general terms.
 */
import type { Conflict, ConsistencyCheck, Finding, InvestmentSummary, Objection, Question, ReviewVerdict } from "../investigate/types";
import type { ScenarioSpec, ValuationResult } from "../investigate/valuationCalc";
import type { ValidationReport } from "../validate";
import { inputRows, type ReviewAnnotations } from "../review";
import { findLeaks, MARK_SENTENCE, type Redactor } from "./redact";

export type ShareVersion = {
  id: string;
  research_as_of: string;
  created_at?: string | null;
  completeness: string;
  origin: string;
  is_current: boolean;
  conclusion: Record<string, unknown>;
  research_phases: { phase_number: number; title: string | null; body_markdown: string | null; details?: Record<string, unknown> | null }[];
  research_sources?: { title: string; url: string | null; document_date: string | null; details: Record<string, unknown> }[];
};

export type Block =
  | { t: "p"; text: string; tone?: "warn" | "muted" | "strong"; app?: boolean }
  | { t: "md"; text: string }
  | { t: "list"; items: string[]; ordered?: boolean; app?: boolean }
  | { t: "kv"; rows: [string, string][] }
  | { t: "table"; head: string[]; rows: string[][]; widths?: number[]; app?: boolean }
  | { t: "h"; text: string }
  | { t: "box"; title: string; items: string[]; tone: "warn" | "info"; app?: boolean };

export type Section = { id: string; title: string; blocks: Block[] };

export type ShareChoice = "latest" | "approved";

export type ShareReport = {
  symbol: string;
  name: string | null;
  title: string;
  subtitle: string;
  generatedAt: string;
  facts: [string, string][];
  notices: string[];
  sections: Section[];
  redactions: { why: string; count: number }[];
};

type Ev = {
  findings?: (Finding & { claim_original?: string; claim_correction?: string })[];
  questions?: Question[];
  conflicts?: Conflict[];
  objections?: Objection[];
  valuation?: { specs: ScenarioSpec[]; result: ValuationResult; revenue_basis: string; horizon_date?: string } | null;
  phases?: { n: number; title: string; status: string; gate: string[]; attempts: number }[];
  review?: ReviewVerdict | null;
  draft?: { action: string | null; confidence: string | null; headline?: string | null; weighted_value: number | null; annualized_return: number | null; at?: string } | null;
  stress?: { label: string; weighted_value: number | null; annualized_return: number | null; note: string }[];
  consistency?: ConsistencyCheck | null;
};

const STATUS_LABEL: Record<string, string> = {
  fully_reviewed: "Read in full", partially_reviewed: "Partly read", retrieved: "Downloaded, not read", unavailable: "Unavailable",
  search_result_only: "Search snippet only (not counted as reviewed)", reviewed_earlier: "Read in earlier research",
};
const CHECK_LABEL: Record<string, string> = {
  verified: "Verified: quote and figure found in the document", xbrl: "Verified: SEC XBRL data", quote_found_value_not_in_quote: "Quote found, figure not in quote", quote_not_found: "Quote not found in document",
  secondary_unverifiable: "Secondary source, not verifiable", calculation: "Calculation", estimate: "Estimate", document_unreadable: "Document unreadable",
};
const CLASS_LABEL: Record<string, string> = {
  verified_primary: "Verified from a primary document", labeled_estimate: "Labeled estimate or assumption", unresolved_not_material: "Unresolved, not material", unresolved_thesis_changing: "Unresolved, could change the thesis",
};
const VERDICT: Record<string, string> = { survives: "survives", survives_with_changes: "survives with changes", fails: "does not survive" };
const VAL_VERDICT: Record<string, string> = { passes: "Passes", passes_with_caveats: "Passes with caveats", does_not_pass: "Does not pass" };
const KIND_LABEL: Record<string, string> = { sourced: "Sourced from a finding", calculation: "Calculated", estimate: "Model estimate" };

const usd = (n: number | null | undefined, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? "n/a" : `$${n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d })}`);
const pct = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "n/a" : `${(n * 100).toFixed(1)}%`);
const signedPct = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "n/a" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`);
const big = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e5 ? usd(n, 0) : n.toLocaleString("en-US", { maximumFractionDigits: 4 }));
const day = (iso: string | null | undefined) => {
  if (!iso) return "n/a";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
};
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((t): t is string => typeof t === "string" && !!t.trim()) : []);
const isInvestigation = (v: Pick<ShareVersion, "conclusion">) => ["full_investigation", "material_event_refresh"].includes(String(v.conclusion?.research_type ?? ""));

/** Investigations that finished (complete or not), newest first. Running and failed runs are never shared. */
export function finishedInvestigations<T extends Pick<ShareVersion, "conclusion" | "research_as_of" | "created_at">>(versions: T[]): T[] {
  return versions
    .filter((v) => isInvestigation(v) && !["running", "failed"].includes(String(v.conclusion?.review_state ?? "")) && !!v.conclusion?.investment_summary)
    .sort((a, b) => (b.created_at ?? b.research_as_of).localeCompare(a.created_at ?? a.research_as_of));
}

/** The investigation the owner approved and uses (in full or provisionally), if any. */
export function approvedInvestigation<T extends Pick<ShareVersion, "conclusion" | "research_as_of" | "created_at" | "is_current">>(versions: T[]): T | null {
  return finishedInvestigations(versions).find((v) => v.is_current && ["adopted", "adopted_provisional"].includes(String(v.conclusion?.review_state ?? ""))) ?? null;
}

export function pickVersion<T extends Pick<ShareVersion, "conclusion" | "research_as_of" | "created_at" | "is_current">>(versions: T[], choice: ShareChoice): T | null {
  return choice === "approved" ? approvedInvestigation(versions) : finishedInvestigations(versions)[0] ?? null;
}

export type ShareOptions = { latest: { id: string; research_as_of: string } | null; approved: { id: string; research_as_of: string } | null };

/** Which investigations a company has to share (for the button on the company page). */
export function shareOptions(versions: Pick<ShareVersion, "id" | "conclusion" | "research_as_of" | "created_at" | "is_current">[]): ShareOptions {
  const latest = finishedInvestigations(versions)[0] ?? null;
  const approved = approvedInvestigation(versions);
  return { latest: latest && { id: latest.id, research_as_of: latest.research_as_of }, approved: approved && { id: approved.id, research_as_of: approved.research_as_of } };
}

export function approvalText(v: Pick<ShareVersion, "conclusion" | "completeness" | "is_current">): string {
  const c = v.conclusion ?? {};
  const rs = String(c.review_state ?? "");
  const at = (c.adopted_at as string | undefined) ?? (c.adoption as { at?: string } | undefined)?.at;
  const mode = (c.adoption as { mode?: string } | undefined)?.mode;
  if (rs === "adopted" && v.completeness === "complete") return `Approved in full by the owner${at ? ` on ${day(at)}` : ""}${mode === "full_after_provisional" ? " (after a provisional approval)" : ""}`;
  if (rs === "adopted" || rs === "adopted_provisional") return `Approved provisionally by the owner${at ? ` on ${day(at)}` : ""}, with open items listed`;
  if (rs === "awaiting_approval") return "Not approved: finished and waiting for the owner's review";
  if (rs === "set_aside") return "Not approved: set aside by the owner";
  return "Not approved";
}

/**
 * The research's own stance in general words, taken from the first words of its recommendation
 * (after reviewer corrections), so the direction survives when the personal sizing is removed.
 */
export function stanceOf(action: string | null | undefined): string | null {
  if (!action) return null;
  const a = action.trim().toLowerCase().replace(/^conditional(?:, not a trade instruction)?:\s*/, "");
  const noAdd = /\b(no new money|do not add|don't add|no add|not add)\b/.test(a);
  const lead = (a.match(/^[a-z-]+/) ?? [""])[0];
  const base: Record<string, string> = {
    hold: "Hold", watch: "Watch", trim: "Trim (reduce exposure)", reduce: "Trim (reduce exposure)", sell: "Sell or exit", exit: "Sell or exit",
    buy: "Buy", add: "Add", accumulate: "Accumulate", avoid: "Avoid", pass: "Pass", wait: "Wait",
  };
  const s = base[lead];
  if (!s) return null;
  return noAdd && !/^(sell|exit|avoid|pass)/.test(lead) ? `${s}; no new money` : s;
}

export function buildShareReport(input: {
  symbol: string;
  name: string | null;
  version: ShareVersion;
  choice: ShareChoice;
  approved: Pick<ShareVersion, "id" | "research_as_of"> | null;
  latest: Pick<ShareVersion, "id" | "research_as_of"> | null;
  validation: ValidationReport | null;
  redactor: Redactor;
  now?: Date;
}): ShareReport {
  const { symbol, name, version: v, redactor: R } = input;
  const T = (s: unknown) => (typeof s === "string" ? R.text(s) : "");
  const L = (x: unknown) => strs(x).map((s) => R.text(s)).filter((s) => !!s.trim());
  const c = v.conclusion ?? {};
  const sm = (c.investment_summary ?? null) as InvestmentSummary | null;
  const ev = (c.evidence ?? {}) as Ev;
  const review = (c.review ?? null) as ReviewAnnotations | null;
  const original = (c.review_original ?? null) as { action?: string | null } | null;
  const completion = (c.completion ?? null) as { complete: boolean; reasons: string[]; kind?: string } | null;
  const adoption = (c.adoption ?? null) as { mode?: string; open_items?: string[]; accepted_open_items?: string[] } | null;
  const type = c.research_type === "material_event_refresh" ? "Material-event refresh" : "Full investigation";
  const refPrice = typeof c.reference_price === "number" ? c.reference_price : null;
  const refDate = (c.reference_date as string | undefined) ?? v.research_as_of;
  const val = ev.valuation ?? null;
  const phases = [...(v.research_phases ?? [])].sort((a, b) => a.phase_number - b.phase_number);

  // ---- Status and notices -------------------------------------------------------------------
  const notices: string[] = [];
  const rs = String(c.review_state ?? "");
  if (input.choice === "latest" && input.approved && input.approved.id !== v.id) notices.push(`This is the most recent investigation, not the one the owner approved. The approved research is dated ${day(input.approved.research_as_of)}.`);
  if (input.choice === "approved" && input.latest && input.latest.id !== v.id) notices.push(`This is the owner's approved research. A newer investigation dated ${day(input.latest.research_as_of)} exists and is not approved.`);
  if (rs === "awaiting_approval") notices.push("Not approved: this investigation has not been reviewed and approved by the owner.");
  if (rs === "set_aside") notices.push("The owner set this investigation aside; it is not the research in use.");
  if (rs === "adopted_provisional" || (rs === "adopted" && v.completeness !== "complete")) notices.push("Provisional: approved with open items, listed under Research status.");
  if (v.completeness !== "complete") notices.push(`Incomplete: ${completion?.kind === "material_uncertainty" ? "a material question has no reliable answer" : "some work could not be finished"}. The open items are listed under Research status.`);
  const incompletePhases = phases.filter((p) => String(p.details?.status ?? "") === "incomplete");
  if (incompletePhases.length) notices.push(`Phase${incompletePhases.length === 1 ? "" : "s"} ${incompletePhases.map((p) => p.phase_number).join(", ")} ${incompletePhases.length === 1 ? "is" : "are"} marked incomplete.`);
  if (review) notices.push(`Reviewer corrections dated ${day(review.at)} are applied to the conclusion; each one is listed with what it replaced.`);

  const facts: [string, string][] = [
    ["Research date", day(v.research_as_of)],
    ["Research type", type],
    ["Reference price", refPrice !== null ? `${usd(refPrice)} on ${day(refDate)}${c.reference_price_source ? ` (${String(c.reference_price_source)})` : ""}` : "n/a"],
    ["Approval", approvalText(v)],
    ["Completeness", v.completeness === "complete" ? "Complete" : completion?.kind === "material_uncertainty" ? "Incomplete: material uncertainty" : "Incomplete"],
    ["Classification", T(sm?.classification ?? c.classification) || "n/a"],
    ["Confidence", String(sm?.confidence ?? c.confidence ?? "n/a")],
  ];

  const sections: Section[] = [];

  // ---- 1. About ------------------------------------------------------------------------------
  sections.push({
    id: "about", title: "About this report", blocks: [
      { t: "p", app: true, text: `This is the complete saved ${type.toLowerCase()} of ${name ?? symbol} (${symbol}) from Portfolio Intelligence, exported on ${day((input.now ?? new Date()).toISOString())}. It reproduces the saved research, calculations, skeptical review, reviewer corrections and source inventory. Nothing was re-run, re-estimated or newly analysed for this export.` },
      { t: "p", app: true, text: "The owner's private financial information has been removed: holdings, share counts, cost basis, gains and losses, cash and savings balances, account names, personal limits and policies, and trade amounts based on their holdings. Where wording was removed, a marker in square brackets shows it. Recommendations that referred to the owner's own position are shown as general research implications under Investment strategy, without changing the thesis or valuation." },
      { t: "p", app: true, tone: "muted", text: "This is research shared for discussion, not personalized investment advice. Figures are as of the research date and may be out of date. Third-party documents are cited and linked rather than reproduced; quotations are limited to short excerpts." },
    ],
  });

  // ---- 2. Research status ----------------------------------------------------------------------
  const status: Block[] = [{ t: "kv", rows: facts }];
  const phaseRows = phases.map((p) => [`Phase ${p.phase_number}`, p.title ?? "", String(p.details?.status ?? "saved").replace(/_/g, " "), p.details?.at ? day(String(p.details.at)) : "", p.details?.carried_from ? "Carried forward from earlier research" : ""]);
  if (phaseRows.length) status.push({ t: "h", text: "Phases" }, { t: "table", head: ["Phase", "Title", "Status", "Saved", "Note"], rows: phaseRows, widths: [12, 40, 16, 14, 18] });
  if (ev.review) status.push({ t: "p", text: `Skeptical review verdict: thesis ${VERDICT[ev.review.thesis] ?? ev.review.thesis}, valuation ${VERDICT[ev.review.valuation] ?? ev.review.valuation}, recommendation ${VERDICT[ev.review.recommendation] ?? ev.review.recommendation}.` });
  if (input.validation) status.push({ t: "p", text: `App validation (code-only re-check of the saved evidence, ${day(input.validation.at)}): ${VAL_VERDICT[input.validation.verdict] ?? input.validation.verdict}. ${T(input.validation.headline)}` });
  const open = [...L(completion?.reasons), ...L(adoption?.open_items), ...L(adoption?.accepted_open_items)];
  const openDedup = [...new Set(open)].filter((x) => x !== MARK_SENTENCE);
  if (openDedup.length) status.push({ t: "box", tone: "warn", title: completion && !completion.complete ? `Open items: ${openDedup.length} could not be closed` : `Open items attached to the approval: ${openDedup.length}`, items: openDedup });
  const notVerified = L(c.not_verified);
  if (notVerified.length) status.push({ t: "box", tone: "warn", title: "Not verified", items: notVerified });
  sections.push({ id: "status", title: "Research status", blocks: status });

  // ---- 3. Conclusion ---------------------------------------------------------------------------
  const concl: Block[] = [];
  if (sm) {
    if (sm.headline) concl.push({ t: "p", tone: "strong", text: T(sm.headline) });
    const action = T(sm.action);
    const stance = stanceOf(sm.action) ?? stanceOf(original?.action);
    concl.push({ t: "kv", rows: [
      ["Recommendation (as saved, personal parts removed)", action || "n/a"],
      ...(stance ? [["Research stance", stance] as [string, string]] : []),
      ["Classification", T(sm.classification) || "n/a"],
      ["Confidence", sm.confidence ?? "n/a"],
      ["Business quality", `${sm.business_quality?.rating ?? "n/a"}${sm.business_quality?.why ? `: ${T(sm.business_quality.why)}` : ""}`],
      ["Valuation", T(sm.valuation) || "n/a"],
      ["Expected return", T(sm.expected_return) || "n/a"],
    ] });
    if (sm.thesis) concl.push({ t: "h", text: "Investment thesis" }, { t: "p", text: T(sm.thesis) });
    const reasons = L(sm.reasons);
    if (reasons.length) concl.push({ t: "h", text: "Reasons" }, { t: "list", items: reasons });
    const risks = L(sm.risks);
    if (risks.length) concl.push({ t: "h", text: "Main risks" }, { t: "list", items: risks });
    const wc = L(sm.would_change);
    if (wc.length) concl.push({ t: "h", text: "What would change the conclusion" }, { t: "list", items: wc });
    if (sm.changes_vs_prior) concl.push({ t: "h", text: "Changes versus the earlier research" }, { t: "p", text: T(sm.changes_vs_prior) });
  } else concl.push({ t: "p", tone: "warn", text: "No investment summary was saved with this investigation." });
  if (review) {
    const items = [
      ...review.material_inputs.map((m) => `Material input not fully reconciled: ${m.input}${m.scenario === "all" ? "" : ` (${m.scenario})`}. ${T(m.note)}`),
      ...review.corrections.map((x) => `Corrected (${x.field.replace("_", " ")}): “${T(x.find)}” replaced with “${T(x.replace)}”`),
      ...(review.finding_corrections ?? []).map((x) => `Finding ${x.id} restated: ${T(x.reason)}`),
      ...review.withdrawn_findings.map((w) => `Finding ${w.id} withdrawn: ${T(w.reason)}`),
      ...(review.conditional_action ? [`Recommendation kept conditional. The investigation wrote “${T(original?.action ?? "")}”; it is shown as: ${T(review.conditional_action)}`] : []),
    ];
    concl.push({ t: "box", tone: "info", title: `Reviewer corrections (${day(review.at)}). The original record is unchanged; corrections are laid over it.`, items });
  }
  if (ev.draft) concl.push({ t: "p", tone: "muted", text: `Before the skeptical review the investigation concluded: ${T(ev.draft.action) || "n/a"} (${ev.draft.confidence ?? "n/a"} confidence), weighted value ${usd(ev.draft.weighted_value)}, ${pct(ev.draft.annualized_return)} a year. After the review: ${T(sm?.action) || "n/a"} (${sm?.confidence ?? "n/a"}), ${usd(val?.result.weighted_value)} weighted.` });
  sections.push({ id: "conclusion", title: "Investment conclusion", blocks: concl });

  // ---- 4. Strategy (general) -------------------------------------------------------------------
  const strat: Block[] = [];
  const zones = (sm?.price_framework ?? (c.price_framework as InvestmentSummary["price_framework"] | undefined) ?? []).filter((z) => z && (z.price_zone || z.action));
  if (zones.length) strat.push({ t: "h", text: "Price framework: when the research would act or wait" }, { t: "table", head: ["Price zone", "What the research says"], rows: zones.map((z) => [T(z.price_zone), T(z.action) || MARK_SENTENCE]), widths: [22, 78] });
  if (val?.result) {
    const sc = (n: string) => val.result.scenarios.find((s) => s.name === n);
    const price = val.result.price ?? refPrice;
    const rows: [string, string][] = [];
    for (const n of ["bear", "base", "bull"]) {
      const s = sc(n);
      if (s) rows.push([`${n[0].toUpperCase()}${n.slice(1)} case (${pct(s.probability)})`, `${usd(s.value_per_share)} per share${price ? `, ${signedPct(s.value_per_share / price - 1)} from ${usd(price)}` : ""}`]);
    }
    rows.push(["Probability-weighted", `${usd(val.result.weighted_value)}, ${pct(val.result.annualized_return)} a year`]);
    rows.push(["Investment horizon", `${day(val.result.horizon_date)}${val.result.years ? ` (${val.result.years.toFixed(1)} years)` : ""}`]);
    strat.push({ t: "h", text: "Return profile and horizon (from the saved valuation)" }, { t: "kv", rows });
  }
  const wcs = L(sm?.would_change ?? c.would_change);
  if (wcs.length) strat.push({ t: "h", text: "Catalysts, add / trim / exit conditions and thesis invalidation (from the research)" }, { t: "list", items: wcs });
  const bear = val?.result.scenarios.find((s) => s.name === "bear");
  const bearMove = bear && (val?.result.price ?? refPrice) ? bear.value_per_share / (val!.result.price ?? refPrice!) - 1 : null;
  strat.push(
    { t: "h", text: "Position sizing and concentration: general considerations" },
    { t: "p", app: true, tone: "muted", text: "Standard text added by the app for sharing. It is not part of the investigation and contains no new analysis; the figures are the saved ones." },
    { t: "list", app: true, items: [
      `Sizing: the research rates confidence ${sm?.confidence ?? "n/a"}${bearMove !== null ? ` and its bear case is ${signedPct(bearMove)} from the reference price` : ""}. In general, the lower the confidence and the wider the gap between bear and bull cases, the smaller a position needs to be for a bear-case loss to stay tolerable.`,
      "Concentration: the main risks above name the drivers this company shares with others (for example a common customer base, end market or theme). Holding several companies exposed to the same driver adds to concentration risk even when each position looks small.",
      "Adding: the research's own entry levels are in the price framework above; it treats a lower price alone as no reason to add unless the thesis holds and its conditions are met.",
      "Trimming or exiting: the research's downgrade triggers and thesis breakers listed above are the conditions under which it would reduce or exit. An investor might also consider trimming when the price rises into the zone where the research sees no new money, or when a position grows large relative to their own limits.",
    ] },
  );
  const personal: string[] = [];
  if (sm?.portfolio_fit) personal.push("The investigation's portfolio-fit assessment (it compared the company with the owner's own holdings, cash and limits).");
  if (sm?.allocation || c.allocation) personal.push("The owner's allocation target and maximum for this company.");
  if (c.evidence && (c.evidence as { portfolio_check?: unknown }).portfolio_check) personal.push("The app's check of how this company fits the owner's holdings and limits.");
  if (personal.length) strat.push({ t: "box", app: true, tone: "info", title: "Removed as personal to the owner (not research about the company)", items: personal });
  sections.push({ id: "strategy", title: "Investment strategy (general research implications)", blocks: strat });

  // ---- 5. Valuation ------------------------------------------------------------------------------
  if (val?.result) {
    const vb: Block[] = [
      { t: "p", text: `Computed by the app from the investigation's inputs. Horizon ${day(val.result.horizon_date)}${val.result.years ? ` (${val.result.years.toFixed(2)} years)` : ""}; revenue basis: ${T(val.revenue_basis) || "n/a"}; price used ${usd(val.result.price)}. Probability-weighted value ${usd(val.result.weighted_value)}; total return ${signedPct(val.result.total_return)}; ${pct(val.result.annualized_return)} a year.` },
      { t: "table", head: ["Scenario", "Probability", "Method", "Value per share", "Annualized"], rows: val.result.scenarios.map((s) => [s.name, pct(s.probability), s.method.replace("_", "/").toUpperCase(), `${usd(s.value_per_share)}${s.floored ? " (floor)" : ""}`, pct(val.result.scenario_annualized.find((x) => x.name === s.name)?.annualized)]), widths: [16, 16, 18, 26, 24] },
    ];
    const rows = inputRows(val.specs, review);
    for (const s of val.result.scenarios) {
      const spec = val.specs.find((x) => x.name === s.name);
      vb.push({ t: "h", text: `${s.name[0].toUpperCase()}${s.name.slice(1)} case: calculation` });
      vb.push({ t: "table", head: ["Step", "Formula", "Result"], rows: s.steps.map((st) => [T(st.label), T(st.formula), Math.abs(st.value) > 1e5 ? usd(st.value, 0) : st.value.toFixed(2)]), widths: [30, 50, 20] });
      const ir = rows.filter((r) => r.scenario === s.name);
      if (ir.length) vb.push({ t: "table", head: ["Input", "Value", "Basis", "Source or reasoning"], rows: ir.map((r) => [r.input.replace(/_/g, " "), big(r.value), `${KIND_LABEL[r.kind] ?? r.kind}${r.material ? "; MATERIAL, not fully reconciled" : ""}`, T(r.source) + (r.material ? ` Reviewer: ${T(r.material)}` : "")]), widths: [16, 14, 20, 50] });
      if (spec?.rationale) vb.push({ t: "p", text: `Rationale: ${T(spec.rationale)}` });
    }
    if (val.result.comparisons.length) vb.push({ t: "h", text: "Versus reported results" }, { t: "list", items: val.result.comparisons.map((x) => `${x.scenario}: ${T(x.text)}`) });
    if (val.result.errors.length) vb.push({ t: "p", tone: "warn", text: `Calculation errors recorded: ${val.result.errors.map(T).join("; ")}` });
    const stress = ev.stress ?? [];
    if (stress.length) vb.push({ t: "h", text: "Sensitivities computed by the app" }, { t: "table", head: ["Test", "Weighted value", "Annualized", "Note"], rows: stress.map((x) => [T(x.label), usd(x.weighted_value), pct(x.annualized_return), T(x.note)]), widths: [34, 16, 14, 36] });
    const vs = input.validation?.sensitivity ?? [];
    if (vs.length) vb.push({ t: "h", text: "What moves the value (one change at a time, app validation)" }, { t: "table", head: ["Change", "Weighted value", "Change per share", "Annualized"], rows: vs.map((s) => [T(s.label), usd(s.weighted), `${s.delta >= 0 ? "+" : ""}${s.delta.toFixed(2)}`, pct(s.annualized)]), widths: [46, 18, 18, 18] });
    for (const b of input.validation?.bridges ?? []) vb.push({ t: "h", text: T(b.title) }, { t: "table", head: ["Step", "Change per share"], rows: b.steps.map((s) => [T(s.label.trim()), `${s.delta >= 0 ? "+" : ""}${s.delta.toFixed(2)}`]), widths: [75, 25] }, { t: "p", tone: "muted", text: T(b.note) });
    sections.push({ id: "valuation", title: "Valuation: method, assumptions, calculations, scenarios and sensitivities", blocks: vb });
  }

  // ---- 6. Phases --------------------------------------------------------------------------------
  for (const p of phases) {
    const st = String(p.details?.status ?? "");
    const blocks: Block[] = [];
    const meta = [st ? `Status: ${st.replace(/_/g, " ")}` : "", p.details?.at ? `saved ${day(String(p.details.at))}` : "", p.details?.carried_from ? "carried forward from earlier research" : ""].filter(Boolean).join(" · ");
    if (meta) blocks.push({ t: "p", tone: st === "incomplete" ? "warn" : "muted", text: meta });
    blocks.push({ t: "md", text: R.markdown(p.body_markdown ?? "") || "No text was saved for this phase." });
    sections.push({ id: `phase-${p.phase_number}`, title: `Phase ${p.phase_number}: ${p.title ?? ""}`, blocks });
  }

  // ---- 7. Skeptical review ----------------------------------------------------------------------
  const sk: Block[] = [];
  if (ev.review) {
    sk.push({ t: "p", tone: "strong", text: `Thesis ${VERDICT[ev.review.thesis] ?? ev.review.thesis}; valuation ${VERDICT[ev.review.valuation] ?? ev.review.valuation}; recommendation ${VERDICT[ev.review.recommendation] ?? ev.review.recommendation}.` });
    if (ev.review.summary) sk.push({ t: "p", text: T(ev.review.summary) });
    const rc = L(ev.review.required_changes);
    if (rc.length) sk.push({ t: "h", text: "Changes the reviewer required" }, { t: "list", items: rc });
  }
  for (const o of ev.objections ?? []) {
    sk.push({ t: "h", text: `${o.id} [${o.severity}${o.area ? `, ${o.area.replace(/_/g, " ")}` : ""}]` });
    const items = [
      `Challenge: ${T(o.objection) || MARK_SENTENCE}`,
      o.claim ? `Claim challenged: ${T(o.claim)}` : "",
      o.test ? `Test (${(o.test_kind ?? "").replace("_", " ")}): ${T(o.test)}${o.test_result ? ` Result: ${T(o.test_result)}` : ""}` : "",
      o.evidence_to_check ? `Evidence to check: ${T(o.evidence_to_check)}` : "",
      o.outcome ? `Answer (${o.outcome.replace("_", " ")}): ${T(o.response)}` : "Not answered.",
    ].filter(Boolean);
    sk.push({ t: "list", items });
  }
  if (!sk.length) sk.push({ t: "p", tone: "warn", text: "No skeptical review was recorded." });
  sections.push({ id: "skeptic", title: "Skeptical review", blocks: sk });

  // ---- 8. Evidence: findings, questions, conflicts, consistency -----------------------------------
  const evb: Block[] = [];
  const findings = ev.findings ?? [];
  const keyF = findings.filter((f) => f.key && !f.withdrawn);
  if (findings.length) {
    evb.push({ t: "p", text: `${findings.length} findings recorded; ${keyF.length} key findings, of which ${keyF.filter((f) => f.check?.status === "verified" || f.check?.status === "xbrl").length} are verified against primary sources. Withdrawn findings are kept for the audit trail.` });
    const ordered = [...keyF, ...findings.filter((f) => !f.key && !f.withdrawn), ...findings.filter((f) => f.withdrawn)];
    evb.push({ t: "table", head: ["ID", "Claim and value", "Source", "Check", "Treatment"], widths: [7, 43, 14, 18, 18], rows: ordered.map((f) => [
      `${f.id}${f.key ? " (key)" : ""}`,
      `${T(f.claim) || MARK_SENTENCE}${f.value ? `: ${T(`${f.value} ${f.unit ?? ""}`)}` : ""}${f.period ? ` (${T(f.period)})` : ""}${f.quote && f.source === "primary" ? `. Quote: “${T(f.quote.slice(0, 200))}${f.quote.length > 200 ? "…" : ""}”` : ""}${f.claim_original ? `. Corrected by reviewer (${T(f.claim_correction)}); originally: “${T(f.claim_original)}”` : ""}`,
      `${f.source}${f.doc_id ? `, ${f.doc_id}` : ""}`,
      CHECK_LABEL[f.check?.status ?? ""] ?? f.check?.status ?? "",
      f.withdrawn ? `Withdrawn: ${T(f.withdrawn.reason)}${f.withdrawn.replaced_by ? ` (see ${f.withdrawn.replaced_by})` : ""}` : f.classification ? `${CLASS_LABEL[f.classification.cls] ?? f.classification.cls}: ${T(f.classification.explanation)} Effect: ${T(f.classification.impact)}` : "",
    ]) });
  }
  const qs = ev.questions ?? [];
  if (qs.length) {
    evb.push({ t: "h", text: `Research questions: ${qs.filter((q) => q.status === "resolved").length} resolved, ${qs.filter((q) => q.status !== "resolved").length} not` });
    evb.push({ t: "table", head: ["ID", "Question", "Status and answer"], widths: [8, 40, 52], rows: qs.map((q) => [`${q.id} (${q.materiality})`, T(q.question), `${q.status}${q.answer ? `: ${T(q.answer)}` : ""}${q.why_unresolvable ? ` Why not answerable: ${T(q.why_unresolvable)}` : ""}${q.could_change_conclusion ? " Could change the conclusion." : ""}${q.impact ? ` Impact: ${T(q.impact)}` : ""}`]) });
  }
  const cf = ev.conflicts ?? [];
  if (cf.length) evb.push({ t: "h", text: "Conflicting evidence" }, { t: "table", head: ["ID", "Conflict", "Status and resolution"], widths: [8, 46, 46], rows: cf.map((x) => [x.id, T(x.description), `${x.status}: ${T(x.resolution)}`]) });
  if (ev.consistency) {
    const rows = ev.consistency.checks.map((x) => [x.ok ? "OK" : "Problem", T(x.label), T(x.detail)]).filter((r) => r[1] !== MARK_SENTENCE || r[2] !== MARK_SENTENCE);
    if (rows.length) evb.push({ t: "h", text: "Conclusion checked against the numbers (app)" }, { t: "table", head: ["Result", "Check", "Detail"], widths: [12, 34, 54], rows });
  }
  if (evb.length) sections.push({ id: "evidence", title: "Evidence: findings, questions and conflicts", blocks: evb });

  // ---- 9. Validation ----------------------------------------------------------------------------
  if (input.validation) {
    const vr = input.validation;
    const blocks: Block[] = [
      { t: "p", text: `Re-checked from the saved evidence by code, without re-running the research or any AI, on ${day(vr.at)}. Verdict: ${VAL_VERDICT[vr.verdict] ?? vr.verdict}. ${T(vr.headline)}` },
      { t: "table", head: ["Result", "Check", "Detail"], widths: [12, 30, 58], rows: vr.checks.map((x) => [x.status === "pass" ? "OK" : x.status === "warn" ? "Caveat" : "Problem", T(x.label), T(x.detail)]) },
    ];
    const notes = L(vr.notes);
    if (notes.length) blocks.push({ t: "h", text: "Reviewer notes" }, { t: "list", items: notes });
    sections.push({ id: "validation", title: "App validation and reviewer notes", blocks });
  }

  // ---- 10. Sources --------------------------------------------------------------------------------
  const sources = v.research_sources ?? [];
  const docs = sources.filter((s) => s.details?.doc_id);
  const snippets = sources.filter((s) => !s.details?.doc_id);
  const sb: Block[] = [];
  if (docs.length) {
    const n = (st: string) => docs.filter((d) => d.details.review_status === st).length;
    sb.push({ t: "p", text: `${docs.length} documents: ${n("fully_reviewed")} read in full, ${n("partially_reviewed")} partly read, ${n("unavailable")} unavailable. Links go to the original publisher; documents are not reproduced here.` });
    sb.push({ t: "table", head: ["ID", "Document", "Date", "Review status"], widths: [8, 56, 14, 22], rows: docs.map((d) => {
      const secs = Array.isArray(d.details.sections) ? (d.details.sections as { label: string; read: string; material: boolean }[]).filter((x) => x.material) : [];
      return [
        String(d.details.doc_id),
        `${T(d.title)}${d.url ? `\n${d.url}` : ""}`,
        d.document_date ? day(d.document_date) : "",
        `${STATUS_LABEL[String(d.details.review_status)] ?? String(d.details.review_status ?? "")}${d.details.required ? "; required" : ""}${secs.length > 1 ? `; sections: ${secs.map((x) => `${x.label.split(".")[0]} ${x.read}`).join(", ")}` : ""}${d.details.unavailable_reason ? `; ${T(String(d.details.unavailable_reason))}` : ""}`,
      ];
    }) });
  }
  if (snippets.length) sb.push({ t: "h", text: "Other sources (search results and web pages, not counted as reviewed documents)" }, { t: "list", items: snippets.map((s) => `${T(s.title)}${s.document_date ? ` (${day(s.document_date)})` : ""}${s.url ? `: ${s.url}` : ""}`) });
  if (!sb.length) sb.push({ t: "p", tone: "warn", text: "No source inventory was saved with this investigation." });
  sections.push({ id: "sources", title: "Sources and document inventory", blocks: sb });

  // ---- Redaction summary and final leak check -----------------------------------------------------
  const redactions = [...R.log.entries()].map(([why, count]) => ({ why, count })).sort((a, b) => b.count - a.count);
  sections.push({ id: "redactions", title: "What was removed for privacy", blocks: [
    { t: "p", app: true, text: redactions.length ? `${redactions.reduce((a, b) => a + b.count, 0)} passages were removed or trimmed because they described the owner's own finances. Counts by reason:` : "No private passages were found in this investigation." },
    ...(redactions.length ? [{ t: "table", app: true, head: ["Reason", "Passages"], rows: redactions.map((r) => [r.why, String(r.count)]), widths: [80, 20] } as Block] : []),
  ] });

  const report: ShareReport = {
    symbol, name,
    title: `${name ?? symbol} (${symbol})`,
    subtitle: `${type} · ${day(v.research_as_of)} · ${approvalText(v)}`,
    generatedAt: (input.now ?? new Date()).toISOString(),
    facts, notices, sections, redactions,
  };
  const leaks = findLeaks(R, reportTexts(report, true));
  if (leaks.length) throw new ShareLeakError(leaks);
  return report;
}

export class ShareLeakError extends Error {
  constructor(public leaks: string[]) { super(`Private information still found after redaction (${leaks.length})`); }
}

/** Every piece of text in a report, for the leak check and tests. */
export function reportTexts(r: ShareReport, researchOnly = false): string[] {
  const out: string[] = researchOnly ? [...r.facts.map((f) => f[1])] : [r.title, r.subtitle, ...r.notices, ...r.facts.flat()];
  for (const s of r.sections) {
    if (!researchOnly) out.push(s.title);
    for (const b of s.blocks) {
      if (researchOnly && "app" in b && b.app) continue;
      if (b.t === "p" || b.t === "md" || b.t === "h") out.push(b.text);
      else if (b.t === "list") out.push(...b.items);
      else if (b.t === "kv") out.push(...b.rows.flat());
      else if (b.t === "table") out.push(...b.head, ...b.rows.flat());
      else if (b.t === "box") out.push(b.title, ...b.items);
    }
  }
  return out;
}
