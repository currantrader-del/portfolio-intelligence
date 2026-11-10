/**
 * Tools the analyst uses during an investigation. They read documents in full (through the reader),
 * record findings (each checked against its source by code), raise and resolve questions, record
 * conflicting evidence, compute the valuation, and complete a phase only when the completion rules
 * are met. All of it writes to the run's state, which is saved after the step.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace } from "@/lib/workspace-core";
import { runTool } from "@/lib/assistant/tools";
import { technicals } from "@/lib/assistant/agent";
import { attachText, fetchDocText, sectionText } from "./documents";
import { financialsText } from "./financials";
import { phaseGate, docStatus } from "./gates";
import { markReviewed, pendingParts, reviewPart, reviewText } from "./reader";
import { checkQuote } from "./text";
import { computeValuation, type ScenarioSpec } from "./valuationCalc";
import { consistencyCheck, customStress } from "./challenge";
import { addUsage, CHALLENGE_AREAS, type ChallengeArea, type DocKind, type EvidenceClass, type Finding, type InvDoc, type Objection, type RunState } from "./types";
import type { ToolDef } from "./loop";

const S = (description: string) => ({ type: "string", description });
const N = (description: string) => ({ type: "number", description });
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef => ({ name, description, input_schema: { type: "object", properties, required } as ToolDef["input_schema"] });

export const T = {
  list_documents: tool("list_documents", "The reading list: every document with its id, kind, why it matters, review status (fully_reviewed, partially_reviewed, retrieved, unavailable, search_result_only) and its sections with what has been read.", {}, []),
  review_document: tool("review_document", "Reads a document IN FULL with the reader model and returns its notes (summary, figures with verified quotes, guidance, risks, capital structure, Q&A, flags). Without 'section' it reads every material section not yet read; with 'section' (a key from list_documents) it reads that section, including non-material ones. Reading again is never needed: earlier notes are returned.", { doc_id: S("Document id, e.g. D3"), section: S("Optional section key, e.g. 7 or I-2; empty for all material sections") }, ["doc_id"]),
  ask_document: tool("ask_document", "Reads one whole section again with a specific question and returns the answer with quotes. Use it to resolve an open question from a document already on the list.", { doc_id: S("Document id"), section: S("Section key from list_documents ('full' for an undivided document)"), question: S("The specific question") }, ["doc_id", "section", "question"]),
  read_text: tool("read_text", "Raw text of a section, 15,000 characters per page, for checking exact wording or copying a quote. Does not count as reviewing the document.", { doc_id: S("Document id"), section: S("Section key"), page: N("Page number from 1") }, ["doc_id", "section", "page"]),
  add_document: tool("add_document", "Downloads a primary document found on the web (company investor-relations page, earnings call transcript, presentation PDF, an SEC exhibit) in full and adds it to the reading list. For the transcript and presentation placeholders, give kind 'transcript' or 'presentation' and it fills them.", { url: S("Direct link to the document"), kind: { type: "string", enum: ["transcript", "presentation", "earnings_release", "earnings_exhibit", "financing", "material_8k", "proxy", "10-Q", "10-K", "other"] }, title: S("Document title with its date"), why: S("Why it matters") }, ["url", "kind", "title", "why"]),
  mark_unavailable: tool("mark_unavailable", "Records that a document on the list cannot be obtained, with what was tried. Only after real attempts (searches, the company's investor-relations site, SEC exhibits).", { doc_id: S("Document id"), reason: S("Why it is unavailable"), attempts: { type: "array", items: { type: "string" }, description: "What was tried (queries, URLs)" } }, ["doc_id", "reason", "attempts"]),
  get_financials: tool("get_financials", "Multi-year reported financials from SEC XBRL (annual, year to date, trailing 12 months, latest quarter, balance sheet) with free cash flow and margins computed by the app. These figures count as verified primary data.", {}, []),
  record_finding: tool("record_finding", "Records a finding the research relies on. For a reported figure give the document id and a quote copied word for word from it; code checks that the quote and figure are in the document. source: primary (company document), xbrl (from get_financials), secondary (analyst consensus, news; cannot be verified against a primary document), calculation (your arithmetic: put the inputs in 'quote'), estimate (your judgment). key=true for figures the conclusion depends on.", { claim: S("What the finding says"), value: S("The figure as written, e.g. '35,082' or '61.2%'; empty if none"), unit: S("e.g. USD millions, %, shares"), period: S("e.g. Q2 FY27, FY ending 2026-01-25"), doc_id: S("Document id for primary findings; empty otherwise"), quote: S("Verbatim quote containing the figure (primary), the source and date (secondary), or the inputs (calculation)"), source: { type: "string", enum: ["primary", "xbrl", "secondary", "calculation", "estimate"] }, key: { type: "boolean" } }, ["claim", "value", "unit", "period", "quote", "source", "key"]),
  withdraw_finding: tool("withdraw_finding", "Withdraws a finding that was recorded wrongly (a failed source check, a wrong figure or a duplicate). It stays in the audit trail marked withdrawn and no longer counts. Record the corrected finding first and pass its id as replaced_by.", { id: S("Finding id, e.g. F12"), reason: S("Why it is withdrawn"), replaced_by: S("Id of the corrected finding, or empty") }, ["id", "reason", "replaced_by"]),
  raise_question: tool("raise_question", "Records a question the research must answer, with how material it is to the conclusion. Then investigate it now, or, when a later phase covers it (competition and capital allocation: phase 3; risks, demand and catalysts: phase 4; valuation: phase 5), set for_phase to that phase so it is answered there.", { question: S("The question"), materiality: { type: "string", enum: ["high", "medium", "low"] }, why: S("Why it matters to the conclusion"), for_phase: N("Phase that must answer it; this phase if empty or 0") }, ["question", "materiality", "why"]),
  resolve_question: tool("resolve_question", "Closes a question. resolved: give the answer and the finding ids that support it. deferred: hands it to the later phase that covers it (to_phase); it must be answered there. unresolvable: only after trying to answer it; list the attempts, why it cannot be answered with available information, whether it could change the conclusion, and its likely impact.", { id: S("Question id, e.g. Q2"), status: { type: "string", enum: ["resolved", "unresolvable", "deferred"] }, to_phase: N("For deferred: the later phase that covers it"), answer: S("The answer, or the best current understanding"), evidence: { type: "array", items: { type: "string" }, description: "Finding ids" }, attempts: { type: "array", items: { type: "string" } }, why_unresolvable: S("For unresolvable"), could_change_conclusion: { type: "boolean" }, impact: S("How the answer could move the valuation or action") }, ["id", "status", "answer"]),
  record_conflict: tool("record_conflict", "Records evidence that conflicts (two sources or two figures that disagree, or management claims that the numbers do not support) and how it was resolved or why it remains open.", { description: S("What conflicts"), finding_ids: { type: "array", items: { type: "string" } }, resolution: S("Which is right and why, or why it cannot be settled"), status: { type: "string", enum: ["resolved", "unresolved"] } }, ["description", "finding_ids", "resolution", "status"]),
  complete_phase: tool("complete_phase", "Saves this phase's checkpoint. Accepted only when the phase's documents are fully reviewed (or shown unavailable after attempts), its questions are resolved or explained, and its key findings passed the source check; otherwise it returns what is missing.", { summary_markdown: S("The phase's findings and reasoning, citing finding ids and document ids (400-1500 words)"), key_points: { type: "array", items: { type: "string" }, description: "3-8 key points" } }, ["summary_markdown", "key_points"]),
  set_valuation: tool("set_valuation", "Sets the bear/base/bull valuation. The app computes every per-share value, the probability-weighted value and the expected annual return from these inputs; you never compute them yourself. Give revenue and net debt in dollars and shares as a count (not millions); margins and tax as fractions. For each input name its source: a finding id, 'calc: ...' or 'estimate: <reason>'. Methods: pe (revenue, operating_margin, tax_rate, diluted_shares, multiple, optional net_other_income), ev_ebitda (revenue, ebitda_margin, multiple, net_debt, diluted_shares), ev_sales (revenue, multiple, net_debt, diluted_shares), p_fcf (revenue, fcf_margin, multiple, diluted_shares).", {
    horizon_date: S("Date the valuation applies, YYYY-MM-DD, 1-5 years out"),
    revenue_basis: S("Which fiscal year the revenue is for, e.g. 'FY ending Jan 2029'"),
    scenarios: { type: "array", items: { type: "object", properties: { name: { type: "string", enum: ["bear", "base", "bull"] }, probability: N("0-1"), method: { type: "string", enum: ["pe", "ev_ebitda", "ev_sales", "p_fcf"] }, inputs: { type: "object", properties: { revenue: N(""), multiple: N(""), diluted_shares: N(""), operating_margin: N(""), net_other_income: N(""), tax_rate: N(""), ebitda_margin: N(""), fcf_margin: N(""), net_debt: N("") } }, sources: { type: "object", description: "input name -> finding id, 'calc: ...' or 'estimate: reason'" }, rationale: S("Why this scenario, what has to happen"), floor_value: N("Optional floor per share, justified in the rationale") }, required: ["name", "probability", "method", "inputs", "sources", "rationale"] } },
  }, ["horizon_date", "revenue_basis", "scenarios"]),
  respond_objection: tool("respond_objection", "Answers one of the skeptic's objections after checking the evidence it points to. outcome: rebutted (the evidence answers it), accepted (it is right: the conclusion must change), partly_accepted.", { id: S("Objection id, e.g. S2"), response: S("The answer, citing finding ids"), outcome: { type: "string", enum: ["rebutted", "accepted", "partly_accepted"] } }, ["id", "response", "outcome"]),
  submit_summary: tool("submit_summary", "The concise investment summary the investor reads. Use the app-computed valuation figures. The action must respect the investor's policy limits.", {
    headline: S("One sentence: the conclusion"), business_quality: { type: "object", properties: { rating: { type: "string", enum: ["Exceptional", "High", "Good", "Mixed", "Weak"] }, why: S("") }, required: ["rating", "why"] },
    valuation: S("Weighted value vs price, method, horizon (app figures)"), expected_return: S("Expected annual return and how it compares with VOO/cash"), risks: { type: "array", items: { type: "string" } }, portfolio_fit: S("Fit with current holdings, exposure and policy limits"),
    action: S("e.g. Buy below $X, Hold, Trim above $X, Watch, Avoid"), confidence: { type: "string", enum: ["Low", "Moderate", "High"] }, would_change: { type: "array", items: { type: "string" } }, reasons: { type: "array", items: { type: "string" }, description: "The 3-6 reasons that support the action, with finding ids" },
    classification: S("e.g. Quality compounder, Speculative growth, Cyclical"), thesis: S("2-4 sentences"),
    price_framework: { type: "array", items: { type: "object", properties: { price_zone: S("'< $35', '$35–$50' or '> $50'"), action: S("") }, required: ["price_zone", "action"] } },
    allocation: { type: "object", properties: { target_pct: { type: ["number", "null"] }, max_pct: { type: ["number", "null"] }, note: S("") }, required: ["target_pct", "max_pct", "note"] },
    changes_vs_prior: S("What changed versus the earlier research on file and why"),
  }, ["headline", "business_quality", "valuation", "expected_return", "risks", "portfolio_fit", "action", "confidence", "would_change", "reasons", "classification", "thesis", "price_framework", "allocation", "changes_vs_prior"]),
  stress_test: tool("stress_test", "Recomputes the valuation with changed assumptions (the app does the arithmetic). Each change applies to one scenario or 'all': multiply, add to, or set one input (revenue, multiple, operating_margin, ebitda_margin, fcf_margin, 'margin' for whichever margin the scenario uses, diluted_shares, net_debt, tax_rate, net_other_income), or set the probabilities. Returns the weighted value and annual return versus the research's.", { label: S("What this tests, e.g. 'base multiple at the 5-year median'"), changes: { type: "array", items: { type: "object", properties: { scenario: { type: "string", enum: ["all", "bear", "base", "bull"] }, input: S("Input name, or empty when only probabilities change"), multiply: N("Multiply the input by this"), add: N("Add this to the input (margins as fractions: -0.05 = 5 points)"), set: N("Set the input to this"), probabilities: { type: "object", properties: { bear: N(""), base: N(""), bull: N("") } } } } } }, ["label", "changes"]),
  record_objection: tool("record_objection", "Records one tested challenge. Name the area, the exact claim attacked, the test you ran (a document check with ask_document/read_text, a stress_test, a comparison with the reported record or guidance) and what the test showed. An objection without a test is not accepted.", { area: { type: "string", enum: [...CHALLENGE_AREAS] }, claim: S("The research's claim or assumption being challenged, quoted or cited by id"), objection: S("The weakness"), test_kind: { type: "string", enum: ["document", "stress_test", "record", "reasoning"] }, test: S("What you checked or computed"), test_result: S("What it showed, with numbers"), severity: { type: "string", enum: ["critical", "major", "minor"] }, finding_ids: { type: "array", items: { type: "string" } }, evidence_to_check: S("What evidence would settle it") }, ["area", "claim", "objection", "test_kind", "test", "test_result", "severity", "finding_ids", "evidence_to_check"]),
  finish_review: tool("finish_review", "Ends the skeptical review with the verdict: does the thesis survive, does the valuation survive, does the recommendation survive (survives, survives_with_changes, fails), and the changes the conclusion must make. Accepted when every area has at least one tested challenge and at least three challenges were tested against documents or with stress tests.", { thesis: { type: "string", enum: ["survives", "survives_with_changes", "fails"] }, valuation: { type: "string", enum: ["survives", "survives_with_changes", "fails"] }, recommendation: { type: "string", enum: ["survives", "survives_with_changes", "fails"] }, summary: S("2-4 sentences: what held up and what did not"), required_changes: { type: "array", items: { type: "string" } } }, ["thesis", "valuation", "recommendation", "summary", "required_changes"]),
  classify_finding: tool("classify_finding", "Classifies a key figure that is not verified from a primary document: verified_primary (you found it in a primary document: record that finding first and give its id as replaced_by), labeled_estimate (an assumption, consensus or calculation, labelled as such), unresolved_not_material, or unresolved_thesis_changing. Explain what is uncertain and how it affects the conclusion.", { id: S("Finding id"), cls: { type: "string", enum: ["verified_primary", "labeled_estimate", "unresolved_not_material", "unresolved_thesis_changing"] }, explanation: S("What was checked and what remains uncertain"), impact: S("How it affects the valuation, the action or the confidence"), replaced_by: S("For verified_primary: the id of the verified finding") }, ["id", "cls", "explanation", "impact", "replaced_by"]),
  finish_answers: tool("finish_answers", "Ends the answers to the skeptical review. Accepted when every objection is answered, the conclusion was revisited where the review required it, every unverified key figure is classified, and the summary matches the app's numbers and the position limits.", { account: S("What survived the review, what changed and why (cite objection ids)") }, ["account"]),
  get_quote: tool("get_quote", "Latest delayed quote for a ticker.", { symbol: S("") }, ["symbol"]),
  get_technicals: tool("get_technicals", "Price trend, returns and levels for a ticker.", { symbol: S("") }, ["symbol"]),
  get_portfolio: tool("get_portfolio", "The investor's holdings, weights, cash and single-company exposure including ETFs.", {}, []),
  get_policy: tool("get_policy", "The investor's policy limits and the dated return forecasts for alternatives (VOO, VXUS, cash).", {}, []),
  get_exposure: tool("get_exposure", "Portfolio exposure by sector/industry/theme with an optional what-if purchase.", { dimension: S("all, sector, industry, theme, company..."), what_if_symbol: S("ticker or empty"), what_if_dollars: N("dollars or 0") }, ["dimension", "what_if_symbol", "what_if_dollars"]),
  finish_discovery: tool("finish_discovery", "Ends the document search. Accepted when the transcript and presentation entries are each either added (and downloaded) or marked unavailable with attempts.", {}, []),
};

export type ToolCtx = { state: RunState; phase: number; db: SupabaseClient; ws: Workspace | null; done: { value: boolean } };

/** Active key findings that are not verified from a primary source and not yet classified. */
export const unclassified = (s: RunState) => s.findings.filter((f) => f.key && !f.withdrawn && f.check.status !== "verified" && f.check.status !== "xbrl" && !f.classification);

/** Next free id with this prefix (max existing number + 1), so ids stay unique even if an earlier bug duplicated one. */
export const nextId = (prefix: string, items: { id: string }[]) => `${prefix}${items.reduce((m, x) => Math.max(m, Number(x.id.slice(prefix.length)) || 0), 0) + 1}`;

const findDoc = (s: RunState, id: unknown) => s.inventory.find((d) => d.id === String(id ?? "").trim().toUpperCase());
const brief = (d: InvDoc) => ({ id: d.id, kind: d.kind, title: d.title, url: d.url || null, required: d.required, phases: d.phases, why: d.why, status: docStatus(d), unavailable_reason: d.unavailable_reason ?? undefined, chars: d.fetched?.chars, sections: d.sections?.map((x) => ({ key: x.key, label: x.label, chars: x.chars, material: x.material, read: `${x.reviewedParts.length}/${x.parts} parts` })) });

async function textFor(d: InvDoc) {
  if (!d.url) return { error: "This entry has no document yet (add it with add_document or mark it unavailable)" };
  const t = await fetchDocText(d.url, d.form);
  if ("error" in t) return t;
  if (!d.fetched || d.fetched.chars !== t.text.length) await attachText(d, t);
  return t;
}

/** Reads every pending part of a document (or one section) with the reader, four at a time. */
export async function reviewDoc(s: RunState, d: InvDoc, section: string | null, focus: string | null = null) {
  const t = await textFor(d);
  if ("error" in t) return { error: t.error };
  const want = section ? (d.sections ?? []).filter((x) => x.key === section).flatMap((x) => Array.from({ length: x.parts }, (_, i) => ({ section: x.key, part: i })).filter((p) => focus || !x.reviewedParts.includes(p.part))) : pendingParts(d);
  if (section && !d.sections?.some((x) => x.key === section)) return { error: `No section ${section} in ${d.id}; sections: ${(d.sections ?? []).map((x) => x.key).join(", ")}` };
  const errors: string[] = [];
  for (let i = 0; i < want.length; i += 4) {
    const batch = await Promise.all(want.slice(i, i + 4).map((p) => reviewPart({ symbol: s.symbol, doc: d, text: t, section: p.section, part: p.part, focus })));
    batch.forEach((r, j) => {
      if ("usage" in r && r.usage) s.usage = addUsage(s.usage, r.usage);
      if ("error" in r) { errors.push(r.error); return; }
      const p = want[i + j];
      s.reviews = s.reviews.filter((x) => !(x.key === r.review.key && !focus && !x.focus));
      s.reviews.push(r.review);
      markReviewed(d, p.section, p.part);
    });
  }
  d.status = docStatus(d);
  return { errors };
}

export function makeExec(ctx: ToolCtx) {
  const s = ctx.state;
  return async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case "list_documents":
        return { documents: s.inventory.map(brief) };
      case "review_document": {
        const d = findDoc(s, input.doc_id);
        if (!d) return { error: `No document ${input.doc_id}` };
        const section = String(input.section ?? "").trim() || null;
        const r = await reviewDoc(s, d, section);
        if ("error" in r && r.error) return { error: r.error };
        const reviews = s.reviews.filter((x) => x.docId === d.id && (!section || x.section === section) && !x.focus);
        return { document: brief(d), problems: (r as { errors: string[] }).errors, notes: reviews.map((x) => reviewText(x, d)).join("\n\n") };
      }
      case "ask_document": {
        const d = findDoc(s, input.doc_id);
        if (!d) return { error: `No document ${input.doc_id}` };
        const r = await reviewDoc(s, d, String(input.section ?? "full"), String(input.question ?? ""));
        if ("error" in r && r.error) return { error: r.error };
        const got = s.reviews.filter((x) => x.docId === d.id && x.section === String(input.section) && x.focus === String(input.question));
        return { answer_notes: got.map((x) => reviewText(x, d)).join("\n\n"), problems: (r as { errors: string[] }).errors };
      }
      case "read_text": {
        const d = findDoc(s, input.doc_id);
        if (!d) return { error: `No document ${input.doc_id}` };
        const t = await textFor(d);
        if ("error" in t) return t;
        const body = sectionText(t, String(input.section ?? "full"));
        if (body === null) return { error: `No section ${input.section}` };
        const page = Math.max(1, Math.floor(Number(input.page) || 1));
        const size = 15000, pages = Math.ceil(body.length / size);
        return { doc_id: d.id, section: input.section, page, pages, text: body.slice((page - 1) * size, page * size) };
      }
      case "add_document": {
        const url = String(input.url ?? "").trim();
        const kind = String(input.kind ?? "other") as DocKind;
        const placeholder = (kind === "transcript" || kind === "presentation") ? s.inventory.find((d) => d.kind === kind && !d.url) : undefined;
        if (s.inventory.some((d) => d.url === url)) return { error: "Already on the list", document: brief(s.inventory.find((d) => d.url === url)!) };
        const t = await fetchDocText(url, kind === "10-Q" || kind === "10-K" ? kind : null);
        if ("error" in t) {
          if (placeholder) placeholder.attempts = [...(placeholder.attempts ?? []), `${url}: ${t.error}`];
          return { error: `Could not download: ${t.error}` };
        }
        const d: InvDoc = placeholder ?? { id: nextId("D", s.inventory), kind, title: "", url, required: false, phases: [ctx.phase || 2], why: "", origin: /sec\.gov/.test(url) ? "sec" : "company", status: "retrieved" };
        d.url = url; d.title = String(input.title ?? url).slice(0, 200); d.why = String(input.why ?? d.why).slice(0, 300);
        d.origin = /sec\.gov/.test(url) ? "sec" : /seekingalpha|fool\.com|investing\.com|marketbeat|yahoo|nasdaq\.com|benzinga/.test(url) ? "web" : "company";
        d.attempts = [...(d.attempts ?? []), `${url}: downloaded`];
        await attachText(d, t);
        if (!placeholder) { while (s.inventory.some((x) => x.id === d.id)) d.id = `D${Number(d.id.slice(1)) + 1}`; s.inventory.push(d); }
        return { added: brief(d), note: "Downloaded. Use review_document to read it in full." };
      }
      case "mark_unavailable": {
        const d = findDoc(s, input.doc_id);
        if (!d) return { error: `No document ${input.doc_id}` };
        const attempts = Array.isArray(input.attempts) ? (input.attempts as unknown[]).map(String).filter(Boolean) : [];
        if (!attempts.length) return { error: "List what was tried before marking a document unavailable" };
        if (docStatus(d) === "fully_reviewed") return { error: "This document was already reviewed in full" };
        d.status = "unavailable"; d.unavailable_reason = String(input.reason ?? "").slice(0, 400); d.attempts = [...(d.attempts ?? []), ...attempts].slice(-12);
        return { ok: true, document: brief(d) };
      }
      case "get_financials":
        return s.financials ? financialsText(s.financials) : { error: "XBRL financials could not be retrieved; use the filings' statements" };
      case "record_finding": {
        const src = String(input.source ?? "primary") as Finding["source"];
        const f: Finding = { id: nextId("F", s.findings), phase: ctx.phase, claim: String(input.claim ?? "").slice(0, 500), value: String(input.value ?? "").slice(0, 60), unit: String(input.unit ?? "").slice(0, 40), period: String(input.period ?? "").slice(0, 60), doc_id: String(input.doc_id ?? "").trim().toUpperCase() || null, quote: String(input.quote ?? "").slice(0, 600), source: src, key: input.key === true, check: { status: "estimate", detail: "" } };
        // Pushed before any await: the model often records several findings in one turn and the
        // calls run in parallel, so the id must be taken synchronously.
        s.findings.push(f);
        if (src === "primary") {
          const d = f.doc_id ? findDoc(s, f.doc_id) : undefined;
          if (!d) f.check = { status: "quote_not_found", detail: "A primary finding needs the id of the document it comes from" };
          else {
            const t = await textFor(d);
            f.check = "error" in t ? { status: "document_unreadable", detail: t.error } : checkQuote(t.text, f.quote, f.value);
          }
        } else if (src === "xbrl") f.check = s.financials ? { status: "xbrl", detail: "From SEC XBRL via get_financials" } : { status: "quote_not_found", detail: "No XBRL data loaded" };
        else if (src === "secondary") f.check = { status: "secondary_unverifiable", detail: "Secondary source; not checkable against a primary document" };
        else if (src === "calculation") f.check = { status: "calculation", detail: "Calculation; inputs shown" };
        else f.check = { status: "estimate", detail: "Labelled as an estimate" };
        return { id: f.id, check: f.check, ...(f.check.status.startsWith("quote") ? { fix: `Record a corrected finding (copy the quote exactly from read_text, with the figure inside the quote), then withdraw_finding ${f.id} with replaced_by. Do not relabel a reported figure as an estimate.` } : {}) };
      }
      case "withdraw_finding": {
        const id = String(input.id ?? "").trim().toUpperCase();
        const f = s.findings.find((x) => x.id === id && !x.withdrawn);
        if (!f) return { error: `No active finding ${input.id}` };
        const rep = String(input.replaced_by ?? "").trim().toUpperCase() || null;
        if (rep && !s.findings.some((x) => x.id === rep && !x.withdrawn)) return { error: `Replacement ${rep} does not exist; record the corrected finding first` };
        const reason = String(input.reason ?? "").trim();
        if (!reason) return { error: "Give the reason" };
        f.withdrawn = { reason: reason.slice(0, 400), replaced_by: rep };
        return { ok: true, withdrawn: id };
      }
      case "raise_question": {
        const forPhase = Math.round(Number(input.for_phase) || 0);
        const q = { id: nextId("Q", s.questions), phase: forPhase > ctx.phase && forPhase <= 6 && s.phases.some((p) => p.n === forPhase && p.status === "pending") ? forPhase : ctx.phase, question: String(input.question ?? "").slice(0, 500), materiality: (["high", "medium", "low"].includes(String(input.materiality)) ? input.materiality : "medium") as "high" | "medium" | "low", why: String(input.why ?? "").slice(0, 500), status: "open" as const };
        s.questions.push(q);
        return { id: q.id, note: q.phase === ctx.phase ? "Investigate it now (review or ask a document, search, compute), then resolve it." : `Phase ${q.phase} must answer it.` };
      }
      case "resolve_question": {
        const q = s.questions.find((x) => x.id === String(input.id ?? "").trim().toUpperCase());
        if (!q) return { error: `No question ${input.id}` };
        if (input.status === "deferred") {
          const to = Math.round(Number(input.to_phase) || 0);
          if (!(to > ctx.phase && s.phases.some((p) => p.n === to && p.status === "pending"))) return { error: "Defer only to a later phase that has not run yet; otherwise investigate it now" };
          q.phase = to;
          q.answer = String(input.answer ?? "").slice(0, 1500) || q.answer;
          return { ok: true, note: `Phase ${to} must answer ${q.id}.` };
        }
        const status = input.status === "unresolvable" ? "unresolvable" : "resolved";
        // In the first run, phase 1 gave up on the two biggest debates as "outside this phase's scope".
        if (status === "unresolvable" && q.materiality === "high" && ctx.phase > 0 && ctx.phase < 4 && s.phases.some((p) => p.n > ctx.phase && p.n <= 4 && p.status === "pending")) return { error: "A high-materiality question cannot be given up this early: investigate it now or defer it (status deferred, to_phase) to the phase that covers it" };
        const evidence = Array.isArray(input.evidence) ? (input.evidence as unknown[]).map(String) : [];
        const attempts = Array.isArray(input.attempts) ? (input.attempts as unknown[]).map(String).filter(Boolean) : [];
        if (status === "resolved" && !evidence.some((id) => s.findings.some((f) => f.id === id))) return { error: "A resolved question needs at least one supporting finding id (record the evidence first)" };
        if (status === "unresolvable" && (!attempts.length || !String(input.why_unresolvable ?? "").trim() || typeof input.could_change_conclusion !== "boolean")) return { error: "An unresolvable question needs the attempts made, why it cannot be answered, and could_change_conclusion" };
        Object.assign(q, { status, answer: String(input.answer ?? "").slice(0, 1500), evidence, attempts, why_unresolvable: input.why_unresolvable ? String(input.why_unresolvable).slice(0, 800) : undefined, could_change_conclusion: typeof input.could_change_conclusion === "boolean" ? input.could_change_conclusion : undefined, impact: input.impact ? String(input.impact).slice(0, 800) : undefined });
        return { ok: true, question: q };
      }
      case "record_conflict": {
        const c = { id: nextId("C", s.conflicts), phase: ctx.phase, description: String(input.description ?? "").slice(0, 800), finding_ids: Array.isArray(input.finding_ids) ? (input.finding_ids as unknown[]).map(String) : [], resolution: String(input.resolution ?? "").slice(0, 1200), status: input.status === "unresolved" ? "unresolved" as const : "resolved" as const };
        s.conflicts.push(c);
        return { id: c.id };
      }
      case "set_valuation": {
        const specs = (Array.isArray(input.scenarios) ? input.scenarios : []) as ScenarioSpec[];
        const trailing = s.financials?.ttm ? { revenue: s.financials.ttm.values.revenue?.value ?? null, operatingMargin: s.financials.ttm.values.operatingIncome && s.financials.ttm.values.revenue ? s.financials.ttm.values.operatingIncome.value / s.financials.ttm.values.revenue.value : null, fiscalYearEnd: s.financials.annual[0]?.end ?? null, revenueGrowth: s.financials.derived.find((d) => d.label.startsWith("Revenue growth"))?.value ?? null, label: s.financials.ttm.label } : null;
        const sourceErrors: string[] = [];
        for (const sc of specs) for (const [k, v] of Object.entries(sc.sources ?? {})) {
          const ref = String(v).trim();
          if (/^F\d+$/i.test(ref) && !s.findings.some((f) => f.id === ref.toUpperCase())) sourceErrors.push(`${sc.name}.${k}: finding ${ref} does not exist`);
        }
        const result = computeValuation({ scenarios: specs, horizon_date: String(input.horizon_date ?? ""), price: s.price.value, today: s.today, trailing });
        if (sourceErrors.length) { result.errors.push(...sourceErrors); result.ok = false; }
        s.valuation = { specs, horizon_date: String(input.horizon_date ?? ""), result, revenue_basis: String(input.revenue_basis ?? "") };
        s.valuationAt = new Date().toISOString();
        return { computed_by_app: result, note: result.ok ? "Use these computed figures in the phase summary. Explain any large gap between scenario assumptions and the reported trailing figures." : "Fix the errors and call set_valuation again." };
      }
      case "stress_test": {
        const changes = (Array.isArray(input.changes) ? input.changes : []) as Parameters<typeof customStress>[1];
        const r = customStress(s, changes);
        if ("error" in r) return r;
        s.stress = [...(s.stress ?? []), { label: `Skeptic: ${String(input.label ?? "test").slice(0, 160)}`, weighted_value: r.weighted_value, annualized_return: r.annualized_return, note: JSON.stringify(changes).slice(0, 400) }];
        return r;
      }
      case "record_objection": {
        const area = String(input.area ?? "") as ChallengeArea;
        if (!CHALLENGE_AREAS.includes(area)) return { error: `area must be one of ${CHALLENGE_AREAS.join(", ")}` };
        const test = String(input.test ?? "").trim(), result = String(input.test_result ?? "").trim();
        if (test.length < 20 || result.length < 20) return { error: "Describe the test you ran and what it showed (with numbers); an untested objection is not recorded" };
        const kind = String(input.test_kind ?? "reasoning") as Objection["test_kind"];
        if (kind === "stress_test" && !(s.stress ?? []).some((x) => x.label.startsWith("Skeptic:"))) return { error: "Run stress_test first" };
        const ids = (Array.isArray(input.finding_ids) ? input.finding_ids : []).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
        const bad = ids.filter((id) => !s.findings.some((f) => f.id === id));
        if (bad.length) return { error: `Unknown finding ids: ${bad.join(", ")}` };
        const sev = (["critical", "major", "minor"].includes(String(input.severity)) ? input.severity : "major") as Objection["severity"];
        const o: Objection = { id: nextId("S", s.objections), area, claim: String(input.claim ?? "").slice(0, 600), objection: String(input.objection ?? "").slice(0, 1200), test_kind: kind, test: test.slice(0, 800), test_result: result.slice(0, 1000), severity: sev, finding_ids: ids, evidence_to_check: String(input.evidence_to_check ?? "").slice(0, 600) };
        s.objections.push(o);
        const covered = new Set(s.objections.map((x) => x.area));
        return { id: o.id, areas_still_to_challenge: CHALLENGE_AREAS.filter((a) => !covered.has(a)) };
      }
      case "finish_review": {
        const covered = new Set(s.objections.map((x) => x.area));
        const missing: string[] = CHALLENGE_AREAS.filter((a) => !covered.has(a)).map((a) => `No tested challenge on ${a.replace(/_/g, " ")}`);
        const tested = s.objections.filter((o) => o.test_kind === "document" || o.test_kind === "stress_test").length;
        if (tested < 3) missing.push(`Only ${tested} challenge(s) tested against documents or with a stress test; at least 3 are needed`);
        if (!s.objections.some((o) => o.test_kind === "stress_test")) missing.push("At least one challenge must test a valuation assumption with stress_test");
        const verdict = (x: unknown) => (["survives", "survives_with_changes", "fails"].includes(String(x)) ? x : "survives_with_changes") as "survives" | "survives_with_changes" | "fails";
        if (missing.length) return { accepted: false, missing };
        s.review = { thesis: verdict(input.thesis), valuation: verdict(input.valuation), recommendation: verdict(input.recommendation), summary: String(input.summary ?? "").slice(0, 1500), required_changes: (Array.isArray(input.required_changes) ? input.required_changes : []).map(String).slice(0, 12), at: new Date().toISOString() };
        ctx.done.value = true;
        return { accepted: true };
      }
      case "classify_finding": {
        const f = s.findings.find((x) => x.id === String(input.id ?? "").trim().toUpperCase() && !x.withdrawn);
        if (!f) return { error: `No active finding ${input.id}` };
        const cls = String(input.cls ?? "") as EvidenceClass;
        if (!["verified_primary", "labeled_estimate", "unresolved_not_material", "unresolved_thesis_changing"].includes(cls)) return { error: "Unknown class" };
        const rep = String(input.replaced_by ?? "").trim().toUpperCase() || null;
        if (cls === "verified_primary") {
          const r = rep ? s.findings.find((x) => x.id === rep && !x.withdrawn) : undefined;
          if (!r || !(r.check.status === "verified" || r.check.status === "xbrl")) return { error: "verified_primary needs replaced_by: a finding whose quote and figure the app found in a primary document (record it first)" };
        }
        const explanation = String(input.explanation ?? "").trim(), impact = String(input.impact ?? "").trim();
        if (explanation.length < 15 || impact.length < 15) return { error: "Explain what was checked and how it affects the conclusion" };
        f.classification = { cls, explanation: explanation.slice(0, 800), impact: impact.slice(0, 800), replaced_by: rep };
        return { ok: true, still_to_classify: unclassified(s).map((x) => x.id) };
      }
      case "respond_objection": {
        const o = s.objections.find((x) => x.id === String(input.id ?? "").trim().toUpperCase());
        if (!o) return { error: `No objection ${input.id}` };
        const evidence = String(input.response ?? "").match(/\b[FQD]\d+\b|stress/gi) ?? [];
        if (o.severity !== "minor" && !evidence.length) return { error: "Answer a critical or major objection with evidence: cite finding, question or document ids, or a stress test" };
        o.response_evidence = [...new Set(evidence.map((x) => x.toUpperCase()))];
        o.response = String(input.response ?? "").slice(0, 1500);
        o.outcome = (["rebutted", "accepted", "partly_accepted"].includes(String(input.outcome)) ? input.outcome : "partly_accepted") as Objection["outcome"];
        return { ok: true, remaining: s.objections.filter((x) => !x.outcome).map((x) => x.id) };
      }
      case "submit_summary": {
        const sm = input as unknown as RunState["summary"];
        if (!sm?.action || !sm.headline || !Array.isArray(sm.reasons) || !sm.reasons.length) return { error: "The summary needs a headline, an action and the reasons" };
        if (!s.valuation?.result.ok) return { error: "Set a valuation that computes before the summary" };
        s.summary = sm;
        s.summaryAt = new Date().toISOString();
        return { ok: true };
      }
      case "complete_phase": {
        const summary = String(input.summary_markdown ?? "");
        const gate = phaseGate(s, ctx.phase, summary);
        if (ctx.phase === 6) {
          const unanswered = s.objections.filter((o) => !o.outcome).map((o) => o.id);
          if (unanswered.length) gate.push(`Answer the skeptic's objections first: ${unanswered.join(", ")}`);
          if (!s.summary) gate.push("Submit the investment summary first (submit_summary)");
          const open = unclassified(s);
          if (open.length) gate.push(`Classify every key figure not verified from a primary document (classify_finding): ${open.map((f) => f.id).join(", ")}`);
          if (s.summary) { const cc = consistencyCheck(s); if (!cc.ok) gate.push(...cc.issues); }
        }
        const p = s.phases.find((x) => x.n === ctx.phase)!;
        p.gate = gate;
        if (gate.length) return { accepted: false, missing: gate };
        p.status = "complete"; p.summary = summary.slice(0, 20000); p.key_points = (Array.isArray(input.key_points) ? input.key_points : []).map(String).slice(0, 10); p.at = new Date().toISOString();
        ctx.done.value = true;
        return { accepted: true };
      }
      case "finish_answers": {
        const gate: string[] = [];
        const unanswered = s.objections.filter((o) => !o.outcome).map((o) => o.id);
        if (unanswered.length) gate.push(`Answer every objection: ${unanswered.join(", ")}`);
        const mustRevisit = s.objections.some((o) => o.severity !== "minor" && (o.outcome === "accepted" || o.outcome === "partly_accepted")) || (!!s.review && (s.review.recommendation !== "survives" || s.review.valuation !== "survives"));
        const after = s.review?.at ?? s.draft?.at ?? "";
        if (mustRevisit && !(s.summaryAt && s.summaryAt > after)) gate.push("The review requires changes (or you accepted a critical or major objection): submit the summary again with the changes, even if the action stays the same");
        if (s.valuationAt && s.summaryAt && s.valuationAt > s.summaryAt) gate.push("The valuation changed after the summary: submit the summary again with the new figures");
        const open = unclassified(s);
        if (open.length) gate.push(`Classify every key figure not verified from a primary document: ${open.map((f) => f.id).join(", ")}`);
        const cc = consistencyCheck(s);
        if (!cc.ok) gate.push(...cc.issues);
        const account = String(input.account ?? "").trim();
        if (account.length < 150) gate.push("Give a fuller account of what survived the review and what changed");
        const p = s.phases.find((x) => x.n === 6)!;
        p.gate = gate;
        if (gate.length) return { accepted: false, missing: gate };
        p.summary = `${p.summary}\n\n**Answer to the skeptical review**\n${account.slice(0, 6000)}`.slice(0, 26000);
        p.at = new Date().toISOString();
        ctx.done.value = true;
        return { accepted: true };
      }
      case "finish_discovery": {
        const open = s.inventory.filter((d) => (d.kind === "transcript" || d.kind === "presentation") && !d.url && !(d.status === "unavailable" && (d.attempts?.length ?? 0) > 0));
        if (open.length) return { accepted: false, missing: open.map((d) => `${d.id} ${d.title}: add it or mark it unavailable with attempts`) };
        ctx.done.value = true;
        return { accepted: true };
      }
      case "get_technicals":
        return technicals(String(input.symbol ?? s.symbol));
      case "get_quote": case "get_portfolio": case "get_policy": case "get_exposure": {
        if (!ctx.ws) return { error: "Portfolio context is not loaded in this step" };
        const args = name === "get_exposure" ? { dimension: input.dimension ?? "all", country: "", market: "", sector: "", industry: "", theme: "", company: "", what_if_symbol: input.what_if_symbol ?? "", what_if_dollars: Number(input.what_if_dollars ?? 0) } : input;
        return runTool(name, args as Record<string, unknown>, ctx.ws, ctx.db);
      }
      default:
        return { error: `Unknown tool ${name}` };
    }
  };
}
