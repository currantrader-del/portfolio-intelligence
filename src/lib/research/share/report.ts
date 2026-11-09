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
  | { t: "box"; title: string; items: string[]; tone: "warn" | "info"; app?: boolean }
  /** Labeled records (findings, questions, challenges): a bold title line, a grey meta line, then labeled lines. */
  | { t: "entries"; items: Entry[] }
  | { t: "chart"; chart: Chart };

export type Entry = { title: string; meta?: string; tone?: "muted" | "warn"; lines: [string, string][] };

/** Charts drawn from the saved numbers. Every figure is one the research or the app already computed. */
export type Chart =
  | { kind: "scenarios"; price: number | null; weighted: number | null; rows: { name: string; probability: number; value: number; annualized: number | null }[] }
  | { kind: "zones"; price: number | null; zones: Zone[] }
  | { kind: "tornado"; base: number; rows: { label: string; delta: number; weighted: number }[] };

export type Zone = { label: string; lo: number | null; hi: number | null; tone: "good" | "wait" | "bad"; action: string };

export type Section = { id: string; title: string; blocks: Block[]; appendix?: boolean };

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
  /** The one-page summary on the cover. */
  summary?: {
    stance: string | null;
    headline: string | null;
    price: number | null;
    priceDate: string;
    weighted: number | null;
    annualized: number | null;
    years: number | null;
    horizon: string | null;
    confidence: string;
    charts: Chart[];
  };
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
/** $41.8B, $250M, $690.00: money at a readable scale, with the sign before the dollar sign. */
export const money = (n: number | null | undefined) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  const a = Math.abs(n), sign = n < 0 ? "-" : "";
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(a >= 1e11 ? 0 : 1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  return `${sign}${usd(a, a >= 1e4 ? 0 : 2)}`;
};

/** A valuation input in its own unit: margins as %, multiples as x, share counts without a dollar sign. */
export function fmtInput(input: string, v: number): string {
  if (!Number.isFinite(v)) return "n/a";
  if (/margin|growth|rate|pct|yield/.test(input)) return Math.abs(v) <= 1.5 ? `${+(v * 100).toFixed(1)}%` : `${v}%`;
  if (/multiple/.test(input)) return `${+v.toFixed(2)}x`;
  if (/shares/.test(input)) return v >= 1e9 ? `${(v / 1e9).toFixed(2)}B shares` : v >= 1e6 ? `${(v / 1e6).toFixed(0)}M shares` : `${v.toLocaleString("en-US")} shares`;
  if (/net_debt/.test(input) && v < 0) return `${money(v)} (net cash)`;
  if (/eps|per_share|price/.test(input)) return usd(v);
  return Math.abs(v) >= 1e5 ? money(v) : v.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** A finding's value and unit as one readable figure: "134 USD billions" becomes "$134B". */
export function fmtValue(value: string | null | undefined, unit: string | null | undefined): string {
  const v = String(value ?? "").trim(), u = String(unit ?? "").trim();
  if (!v) return "";
  const n = Number(v.replace(/,/g, ""));
  const scale = u.match(/^USD\s*(thousand|million|billion|trillion)s?$/i) ?? u.match(/^(thousand|million|billion|trillion)s?\s*(?:of\s*)?USD$/i);
  const mult: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
  if (scale && Number.isFinite(n)) return money(n * mult[scale[1].toLowerCase()]);
  if (/^(USD|\$)$/i.test(u) && Number.isFinite(n)) return money(n);
  if (/^USD per share$/i.test(u) && Number.isFinite(n)) return `${usd(n)} per share`;
  if (u.startsWith("%")) return `${v.replace(/%$/, "")}%${u.slice(1).trim() ? ` ${u.slice(1).trim()}` : ""}`;
  if (!u || v.toLowerCase().includes(u.toLowerCase())) return v;
  return `${v} ${u}`;
}

/** A stress test's recorded changes (saved as JSON, sometimes cut short) in words. */
export function describeChanges(note: string): string {
  const t = (note ?? "").trim();
  if (!/^[[{]/.test(t)) return t;
  const parts: string[] = [];
  for (const m of t.matchAll(/"probabilities":\{"bear":([\d.]+),"base":([\d.]+),"bull":([\d.]+)\}/g)) parts.push(`probabilities ${[m[1], m[2], m[3]].map((x) => Math.round(Number(x) * 100)).join("/")} (bear/base/bull)`);
  for (const m of t.matchAll(/"scenario":"(\w+)","input":"(\w+)","set":(-?[\d.e+]+)/g)) parts.push(`${m[1]} ${m[2].replace(/_/g, " ")} ${fmtInput(m[2], Number(m[3]))}`);
  if (!parts.length) return "";
  return `Changed: ${parts.join("; ")}${t.endsWith("]") ? "" : "; and more"}`;
}

/**
 * Phase bodies end with generated lists (key points, documents, findings, questions). The key points
 * lead the phase; the documents, findings and questions are in the appendix, so they are not repeated.
 */
export function splitPhaseBody(md: string): { body: string; keyPoints: string[] } {
  const out: string[] = [];
  const keyPoints: string[] = [];
  let mode: "body" | "key" | "skip" = "body";
  for (const line of md.replace(/\r/g, "").split("\n")) {
    const h = line.trim().match(/^\*\*(Key points|Documents for this phase|Findings|Questions)\*\*$/);
    if (h) { mode = h[1] === "Key points" ? "key" : "skip"; continue; }
    if (mode !== "body") {
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) { if (mode === "key") keyPoints.push(li[1]); continue; }
      if (!line.trim() || /^\s{2,}\S/.test(line)) continue;
      mode = "body";
    }
    out.push(line);
  }
  return { body: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), keyPoints };
}

/** Price zones such as "< $520", "$520-$600" or "Above $600" as ranges, or null when any zone can't be read. */
export function parseZones(zones: { label: string; action: string }[]): Zone[] | null {
  const out: Zone[] = [];
  for (const z of zones) {
    const nums = [...z.label.matchAll(/(\d[\d,]*(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
    let lo: number | null = null, hi: number | null = null;
    if (nums.length === 2) [lo, hi] = [Math.min(nums[0], nums[1]), Math.max(nums[0], nums[1])];
    else if (nums.length === 1 && /^\s*(<|≤|below|under|less)/i.test(z.label)) hi = nums[0];
    else if (nums.length === 1 && /^\s*(>|≥|above|over|more)/i.test(z.label)) lo = nums[0];
    else return null;
    const a = z.action.toLowerCase();
    const tone = /\b(sell|exit|trim|reduce|no new money|avoid|do not add)\b/.test(a) ? "bad" : /\b(buy|starter|add|accumulate|eligible)\b/.test(a) ? "good" : "wait";
    out.push({ label: z.label, lo, hi, tone, action: z.action });
  }
  return out.length >= 2 ? out.sort((a, b) => (a.lo ?? -Infinity) - (b.lo ?? -Infinity)) : null;
}

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
  const about: Section = {
    id: "about", title: "About this report", appendix: true, blocks: [
      { t: "p", app: true, text: `This is the complete saved ${type.toLowerCase()} of ${name ?? symbol} (${symbol}) from Portfolio Intelligence, exported on ${day((input.now ?? new Date()).toISOString())}. It reproduces the saved research, calculations, skeptical review, reviewer corrections and source inventory. Nothing was re-run, re-estimated or newly analysed for this export.` },
      { t: "p", app: true, text: "The owner's private financial information has been removed: holdings, share counts, cost basis, gains and losses, cash and savings balances, account names, personal limits and policies, and trade amounts based on their holdings. Where wording was removed, a marker in square brackets shows it. Recommendations that referred to the owner's own position are shown as general research implications under Investment strategy, without changing the thesis or valuation." },
      { t: "p", app: true, tone: "muted", text: "This is research shared for discussion, not personalized investment advice. Figures are as of the research date and may be out of date. Third-party documents are cited and linked rather than reproduced; quotations are limited to short excerpts." },
    ],
  };

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
  const statusSec: Section = { id: "status", title: "Research status", appendix: true, blocks: status };

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
  const price0 = val?.result.price ?? refPrice;
  const scenariosChart: Chart | null = val?.result?.scenarios.length
    ? { kind: "scenarios", price: price0, weighted: val.result.weighted_value, rows: val.result.scenarios.map((s) => ({ name: s.name, probability: s.probability, value: s.value_per_share, annualized: val.result.scenario_annualized.find((x) => x.name === s.name)?.annualized ?? null })) }
    : null;
  const zoneText = zones.map((z) => ({ label: T(z.price_zone), action: T(z.action) || MARK_SENTENCE }));
  const parsedZones = parseZones(zoneText);
  const zonesChart: Chart | null = parsedZones ? { kind: "zones", price: price0, zones: parsedZones } : null;
  if (zones.length) {
    strat.push({ t: "h", text: "Price framework: when the research would act or wait" });
    if (zonesChart) strat.push({ t: "chart", chart: zonesChart });
    strat.push({ t: "table", head: ["Price zone", "What the research says"], rows: zoneText.map((z) => [z.label, z.action]), widths: [22, 78] });
  }
  if (val?.result) strat.push({ t: "p", app: true, tone: "muted", text: `Probability-weighted value ${usd(val.result.weighted_value)} by ${day(val.result.horizon_date)}${val.result.years ? ` (${val.result.years.toFixed(1)} years)` : ""}, ${pct(val.result.annualized_return)} a year from ${usd(price0)}. The scenarios are charted under Valuation.` });
  if (L(sm?.would_change ?? c.would_change).length) strat.push({ t: "p", app: true, tone: "muted", text: "Catalysts, add, trim and exit conditions and what would invalidate the thesis are listed under “What would change the conclusion” in the Investment conclusion." });
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
      ...(scenariosChart ? [{ t: "chart", chart: scenariosChart } as Block] : []),
      { t: "table", head: ["Scenario", "Probability", "Method", "Value per share", "Versus price", "Annualized"], rows: val.result.scenarios.map((s) => [`${s.name[0].toUpperCase()}${s.name.slice(1)}`, pct(s.probability), s.method.replace("_", "/").toUpperCase(), `${usd(s.value_per_share)}${s.floored ? " (floor)" : ""}`, price0 ? signedPct(s.value_per_share / price0 - 1) : "n/a", pct(val.result.scenario_annualized.find((x) => x.name === s.name)?.annualized)]), widths: [14, 14, 16, 20, 18, 18] },
    ];
    const rows = inputRows(val.specs, review);
    const stepValue = (label: string, v: number) => (/per share/i.test(label) || Math.abs(v) < 1e5 ? usd(v) : money(v));
    for (const s of val.result.scenarios) {
      const spec = val.specs.find((x) => x.name === s.name);
      vb.push({ t: "h", text: `${s.name[0].toUpperCase()}${s.name.slice(1)} case: ${usd(s.value_per_share)} per share, ${pct(s.probability)} probability` });
      if (spec?.rationale) vb.push({ t: "p", text: T(spec.rationale) });
      const ir = rows.filter((r) => r.scenario === s.name);
      if (ir.length) vb.push({ t: "table", head: ["Input", "Value", "Basis and source"], rows: ir.map((r) => [r.input.replace(/_/g, " ").replace(/^ebitda/, "EBITDA"), fmtInput(r.input, r.value), `${KIND_LABEL[r.kind] ?? r.kind}${r.material ? "; MATERIAL, not fully reconciled" : ""}. ${T(r.source).replace(/^estimate:\s*/i, "")}${r.material ? ` Reviewer: ${T(r.material)}` : ""}`]), widths: [18, 20, 62] });
      vb.push({ t: "table", head: ["Step", "Formula", "Result"], rows: s.steps.map((st) => [T(st.label), T(st.formula).replace(/\$-/g, "-$"), stepValue(st.label, st.value)]), widths: [28, 50, 22] });
    }
    if (val.result.comparisons.length) vb.push({ t: "h", text: "Versus reported results" }, { t: "list", items: val.result.comparisons.map((x) => `${x.scenario}: ${T(x.text)}`) });
    if (val.result.errors.length) vb.push({ t: "p", tone: "warn", text: `Calculation errors recorded: ${val.result.errors.map(T).join("; ")}` });
    const stress = ev.stress ?? [];
    const vs = input.validation?.sensitivity ?? [];
    if (vs.length) {
      vb.push({ t: "h", text: "What moves the value (one change at a time, app validation)" });
      if (val.result.weighted_value !== null) vb.push({ t: "chart", chart: { kind: "tornado", base: val.result.weighted_value, rows: vs.map((s) => ({ label: T(s.label), delta: s.delta, weighted: s.weighted })) } });
      vb.push({ t: "table", head: ["Change", "Weighted value", "Change per share", "Annualized"], rows: vs.map((s) => [T(s.label), usd(s.weighted), `${s.delta >= 0 ? "+" : "-"}${usd(Math.abs(s.delta))}`, pct(s.annualized)]), widths: [46, 18, 18, 18] });
    }
    if (stress.length) {
      const sk = stress.filter((x) => x.label.startsWith("Skeptic:"));
      vb.push({ t: "h", text: "Stress tests run during the investigation and the skeptical review" });
      if (sk.length) vb.push({ t: "p", tone: "muted", text: "Tests marked “Skeptic” were run while the reviewer was challenging the draft valuation, so some start from inputs that were later corrected. The corrected result is the valuation above." });
      vb.push({ t: "table", head: ["Test", "Weighted value", "Annualized"], rows: stress.map((x) => { const d = describeChanges(T(x.note)); return [`${T(x.label)}${d && d !== T(x.label) ? `\n*${d}*` : ""}`, usd(x.weighted_value), pct(x.annualized_return)]; }), widths: [68, 16, 16] });
    }
    for (const b of input.validation?.bridges ?? []) vb.push({ t: "h", text: T(b.title) }, { t: "table", head: ["Step", "Change per share"], rows: b.steps.map((s) => [T(s.label.trim()), `${s.delta >= 0 ? "+" : ""}${s.delta.toFixed(2)}`]), widths: [75, 25] }, { t: "p", tone: "muted", text: T(b.note) });
    sections.push({ id: "valuation", title: "Valuation: method, assumptions, calculations, scenarios and sensitivities", blocks: vb });
  }

  // ---- 6. Phases --------------------------------------------------------------------------------
  for (const p of phases) {
    const st = String(p.details?.status ?? "");
    const blocks: Block[] = [];
    const meta = [st ? `Status: ${st.replace(/_/g, " ")}` : "", p.details?.at ? `saved ${day(String(p.details.at))}` : "", p.details?.carried_from ? "carried forward from earlier research" : ""].filter(Boolean).join(" · ");
    if (meta) blocks.push({ t: "p", tone: st === "incomplete" ? "warn" : "muted", text: meta });
    const { body, keyPoints } = splitPhaseBody(p.body_markdown ?? "");
    const kp = keyPoints.map((k) => R.text(k)).filter((k) => k.trim() && k !== MARK_SENTENCE);
    if (kp.length) blocks.push({ t: "box", tone: "info", title: "In short", items: kp });
    blocks.push({ t: "md", text: R.markdown(body) || "No text was saved for this phase." });
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
  const objections = ev.objections ?? [];
  if (objections.length) {
    sk.push({ t: "h", text: `The reviewer's challenges (${objections.length})` });
    sk.push({ t: "entries", items: objections.map((o): Entry => ({
      title: `${o.id}  ${T(o.objection) || MARK_SENTENCE}`,
      meta: [o.severity, o.area?.replace(/_/g, " "), o.outcome ? `answer: ${o.outcome.replace(/_/g, " ")}` : "not answered"].filter(Boolean).join(" · "),
      lines: ([
        o.claim ? ["Claim challenged", T(o.claim)] : null,
        o.test ? [`Test${o.test_kind ? ` (${o.test_kind.replace(/_/g, " ")})` : ""}`, T(o.test)] : null,
        o.test_result ? ["Result", T(o.test_result)] : null,
        o.evidence_to_check ? ["Evidence to check", T(o.evidence_to_check)] : null,
        o.outcome ? ["Answer", T(o.response)] : null,
      ] as ([string, string] | null)[]).filter((x): x is [string, string] => !!x && !!x[1].trim()),
    })) });
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
    evb.push({ t: "entries", items: ordered.map((f): Entry => {
      const value = T(fmtValue(f.value, f.unit));
      const claim = T(f.claim) || MARK_SENTENCE;
      return {
        title: `${f.id}  ${claim}${value && !claim.includes(value) ? ` (${value}${f.period ? `, ${T(f.period)}` : ""})` : ""}`,
        meta: [f.key ? "key finding" : "", f.withdrawn ? "WITHDRAWN" : "", `${f.source}${f.doc_id ? ` ${f.doc_id}` : ""}`, CHECK_LABEL[f.check?.status ?? ""] ?? f.check?.status ?? ""].filter(Boolean).join(" · "),
        tone: f.withdrawn ? "muted" : undefined,
        lines: ([
          f.quote && f.source === "primary" ? ["Quote", `“${T(f.quote.slice(0, 220))}${f.quote.length > 220 ? "…" : ""}”`] : null,
          f.claim_original ? ["Reviewer", `Corrected (${T(f.claim_correction)}); originally “${T(f.claim_original)}”`] : null,
          f.withdrawn ? ["Withdrawn", `${T(f.withdrawn.reason)}${f.withdrawn.replaced_by ? ` (see ${f.withdrawn.replaced_by})` : ""}`] : null,
          !f.withdrawn && f.classification ? [CLASS_LABEL[f.classification.cls] ?? f.classification.cls, `${T(f.classification.explanation)}${f.classification.impact ? ` Effect: ${T(f.classification.impact)}` : ""}`] : null,
        ] as ([string, string] | null)[]).filter((x): x is [string, string] => !!x && !!x[1].trim()),
      };
    }) });
  }
  const qs = ev.questions ?? [];
  if (qs.length) {
    evb.push({ t: "h", text: `Research questions: ${qs.filter((q) => q.status === "resolved").length} resolved, ${qs.filter((q) => q.status !== "resolved").length} not` });
    evb.push({ t: "entries", items: qs.map((q): Entry => ({
      title: `${q.id}  ${T(q.question)}`,
      meta: [`${q.materiality} materiality`, q.status.replace(/_/g, " "), q.could_change_conclusion ? "could change the conclusion" : ""].filter(Boolean).join(" · "),
      tone: q.status === "resolved" ? undefined : "warn",
      lines: ([
        q.answer ? ["Answer", T(q.answer)] : null,
        q.why_unresolvable ? ["Why not answerable", T(q.why_unresolvable)] : null,
        q.impact ? ["Impact", T(q.impact)] : null,
      ] as ([string, string] | null)[]).filter((x): x is [string, string] => !!x && !!x[1].trim()),
    })) });
  }
  const cf = ev.conflicts ?? [];
  if (cf.length) evb.push({ t: "h", text: "Conflicting evidence" }, { t: "entries", items: cf.map((x): Entry => ({ title: `${x.id}  ${T(x.description)}`, meta: x.status.replace(/_/g, " "), lines: x.resolution ? [["Resolution", T(x.resolution)]] : [] })) });
  if (ev.consistency) {
    const rows = ev.consistency.checks.map((x) => [x.ok ? "OK" : "Problem", T(x.label), T(x.detail)]).filter((r) => r[1] !== MARK_SENTENCE || r[2] !== MARK_SENTENCE);
    if (rows.length) evb.push({ t: "h", text: "Conclusion checked against the numbers (app)" }, { t: "table", head: ["Result", "Check", "Detail"], widths: [12, 34, 54], rows });
  }
  if (evb.length) sections.push({ id: "evidence", title: "Evidence: findings, questions and conflicts", appendix: true, blocks: evb });

  // ---- 9. Validation ----------------------------------------------------------------------------
  if (input.validation) {
    const vr = input.validation;
    const blocks: Block[] = [
      { t: "p", text: `Re-checked from the saved evidence by code, without re-running the research or any AI, on ${day(vr.at)}. Verdict: ${VAL_VERDICT[vr.verdict] ?? vr.verdict}. ${T(vr.headline)}` },
      { t: "table", head: ["Result", "Check", "Detail"], widths: [12, 30, 58], rows: vr.checks.map((x) => [x.status === "pass" ? "OK" : x.status === "warn" ? "Caveat" : "Problem", T(x.label), T(x.detail)]) },
    ];
    const notes = L(vr.notes);
    if (notes.length) blocks.push({ t: "h", text: "Reviewer notes" }, { t: "list", items: notes });
    sections.push({ id: "validation", title: "App validation and reviewer notes", appendix: true, blocks });
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
  sections.push({ id: "sources", title: "Sources and document inventory", appendix: true, blocks: sb }, statusSec, about);

  // ---- Redaction summary and final leak check -----------------------------------------------------
  const redactions = [...R.log.entries()].map(([why, count]) => ({ why, count })).sort((a, b) => b.count - a.count);
  sections.push({ id: "redactions", title: "What was removed for privacy", appendix: true, blocks: [
    { t: "p", app: true, text: redactions.length ? `${redactions.reduce((a, b) => a + b.count, 0)} passages were removed or trimmed because they described the owner's own finances. Counts by reason:` : "No private passages were found in this investigation." },
    ...(redactions.length ? [{ t: "table", app: true, head: ["Reason", "Passages"], rows: redactions.map((r) => [r.why, String(r.count)]), widths: [80, 20] } as Block] : []),
  ] });

  const report: ShareReport = {
    symbol, name,
    title: `${name ?? symbol} (${symbol})`,
    subtitle: `${type} · ${day(v.research_as_of)} · ${approvalText(v)}`,
    generatedAt: (input.now ?? new Date()).toISOString(),
    facts, notices, sections, redactions,
    summary: {
      stance: stanceOf(sm?.action) ?? stanceOf(original?.action),
      headline: sm?.headline ? T(sm.headline) : null,
      price: price0,
      priceDate: day(refDate),
      weighted: val?.result.weighted_value ?? null,
      annualized: val?.result.annualized_return ?? null,
      years: val?.result.years ?? null,
      horizon: val?.result.horizon_date ? day(val.result.horizon_date) : null,
      confidence: String(sm?.confidence ?? c.confidence ?? "n/a"),
      charts: ([scenariosChart, zonesChart] as (Chart | null)[]).filter((x): x is Chart => !!x),
    },
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
      else if (b.t === "entries") for (const e of b.items) out.push(e.title, e.meta ?? "", ...e.lines.flat());
      else if (b.t === "chart") out.push(...chartTexts(b.chart));
    }
  }
  if (r.summary) out.push(r.summary.stance ?? "", r.summary.headline ?? "", ...r.summary.charts.flatMap(chartTexts));
  return out;
}

function chartTexts(c: Chart): string[] {
  if (c.kind === "zones") return c.zones.flatMap((z) => [z.label, z.action]);
  if (c.kind === "tornado") return c.rows.map((r) => r.label);
  return [];
}
