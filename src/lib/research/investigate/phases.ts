/**
 * What each phase of an investigation has to do, and the context its analyst starts from. A phase's
 * work is its own step: it reads its documents (already read in full by the reading step, or read
 * now), records findings with sources, raises and resolves questions, and saves a checkpoint.
 */
import { reviewText } from "./reader";
import { docStatus } from "./gates";
import type { RunState } from "./types";
import { T } from "./tools";
import type { ToolDef } from "./loop";

export type PhaseDef = { n: number; title: string; tasks: string; tools: ToolDef[]; webSearches: number; high?: boolean };

const BASE_TOOLS = [T.list_documents, T.review_document, T.ask_document, T.read_text, T.add_document, T.mark_unavailable, T.get_financials, T.record_finding, T.withdraw_finding, T.raise_question, T.resolve_question, T.record_conflict, T.complete_phase];

export const FULL_PHASES: PhaseDef[] = [
  { n: 1, title: "Business and thesis", webSearches: 4, tools: BASE_TOOLS, tasks: `Establish what the company actually does and why it could be a good investment.
- What it sells, to whom, how it makes money; segments and their share of revenue and profit (with figures from the 10-K or presentation).
- Its competitive position and what protects it (or does not): scale, technology, switching costs, cost position. Evidence, not adjectives.
- The main growth drivers and how much of the future depends on each.
- A draft thesis in 2-4 sentences, and the 3-5 debates that will decide whether it is right. Raise each debate as a question for later phases where it cannot be settled here.` },
  { n: 2, title: "Financials and filings", webSearches: 3, tools: BASE_TOOLS, tasks: `Establish the financial record and its quality from the filings.
- Multi-year revenue, margins, earnings, operating cash flow, capital spending and free cash flow (get_financials), and the latest quarters from the 10-Qs and the earnings release. Record the key figures as findings with quotes or XBRL.
- Reconcile: do the XBRL figures, the release and the 10-Q agree? Record conflicts.
- Quality of earnings: stock-based compensation, one-offs, capitalised costs, receivables and inventory versus revenue, customer concentration, related parties.
- Balance sheet and liquidity: cash, debt by instrument, convertibles, leases, commitments and purchase obligations, and what funding the plan needs.
- Guidance: what management guided for, and how the latest results compared with the previous guidance (from the transcript or release).` },
  { n: 3, title: "Competition, management and capital allocation", webSearches: 5, tools: BASE_TOOLS, tasks: `Judge the people and the use of capital, and how competition is evolving.
- The earnings call: what management said, and the analyst Q&A (which questions were asked, which answers were weak or evasive).
- Track record: did management deliver its earlier guidance and targets? Use filings and transcripts.
- Incentives from the proxy: what executives are paid for, dilution from equity plans.
- Capital allocation: buybacks, dividends, acquisitions, share count trend, every financing in the last year with its exact terms (price, coupon, conversion, maturity, dilution).
- Competitors and their recent moves (web search, cited as secondary), and any evidence of share gains or losses.` },
  { n: 4, title: "Risks and catalysts", webSearches: 5, tools: BASE_TOOLS, tasks: `Find what could go wrong and what will decide the outcome, including evidence against the thesis.
- The material risks from the risk factors and recent filings, ranked by likelihood and impact on value; legal proceedings; regulation and export controls; customer and supplier concentration; financing risk.
- Search deliberately for the strongest bear case and for evidence that contradicts the draft thesis; record conflicts.
- Dated catalysts in the next 12 months (next earnings date from an official source where possible, product launches, contract milestones, financing events, lock-ups).
- What would break the thesis, stated as observable facts.` },
  { n: 5, title: "Valuation: bear, base and bull", webSearches: 5, high: true, tools: [...BASE_TOOLS, T.set_valuation, T.get_quote, T.get_policy], tasks: `Value the company from the evidence gathered.
- Build bear, base and bull scenarios with set_valuation. Every input names its source: a finding id (reported figures, guidance, consensus recorded as a secondary finding) or a stated estimate with its reason. The app computes the values; never compute them yourself.
- Anchor the assumptions: compare each scenario's revenue, margin and multiple with the reported trailing figures, management's guidance and analyst consensus (search for consensus and record it as secondary findings). Explain every large gap.
- Account for share count changes (buybacks, dilution, convertibles) and net debt.
- Probabilities must reflect the evidence from phases 1-4, including the open debates.
- Compare the expected return with the investor's alternatives (get_policy lists the dated forecasts for VOO and others) and with cash.` },
  { n: 6, title: "Conclusion and what would change it", webSearches: 2, high: true, tools: [...BASE_TOOLS, T.respond_objection, T.submit_summary, T.get_quote, T.get_technicals, T.get_portfolio, T.get_policy, T.get_exposure], tasks: `Answer the skeptic, then decide.
- Respond to every objection (respond_objection) after checking the evidence it points to; investigate further where needed. Accepted objections must change the valuation (call set_valuation again) or the conclusion.
- Portfolio fit: current holdings and exposure (get_portfolio, get_exposure with a what-if), the investor's policy limits and reserve (get_policy). Room under a limit is never a reason to buy; a price drop is never a reason to buy by itself; the reserve is never invested.
- The action with price bands, an allocation within policy, confidence, what would change the call, and what changed versus the earlier research on file.
- submit_summary, then complete_phase with the reasoning.` },
];

export const REFRESH_PHASES: PhaseDef[] = [
  { n: 2, title: "What changed: new results, filings and events", webSearches: 5, tools: BASE_TOOLS, tasks: `Investigate everything new since the earlier research, without redoing what it already covered.
- Read every new document on the list in full (the reading step has done most of it).
- New results versus the earlier research's expectations and versus guidance and consensus; new guidance.
- Changes in the balance sheet, share count, financing terms, and commitments.
- For each earlier thesis point, assumption and open question (below): confirmed, weakened, broken, or unchanged, with the evidence. Raise new questions where the evidence is incomplete and resolve them.
- Anything thesis-changing (new contracts, customer changes, regulation, management changes).` },
  FULL_PHASES[4],
  FULL_PHASES[5],
];

export function phaseSystem(type: RunState["type"]) {
  return `You are a senior equity research analyst inside Portfolio Intelligence, working for one private investor. You are doing one phase of a ${type === "full_investigation" ? "full initial investigation" : "material-event refresh"} of a company. The work is saved after the phase, and later phases build on it.

Rules:
- Evidence first. Read primary documents in full (review_document reads a whole section; the reader's notes include figures with quotes already checked against the text). Search snippets are leads, not evidence: to rely on a web page, download it with add_document and read it.
- Record every figure the conclusion depends on with record_finding (key=true), with a quote copied exactly from the document. Use read_text to copy exact wording when needed. If a source check fails, record the corrected finding and withdraw the failed one with withdraw_finding; never relabel a reported figure as an estimate to get past the check.
- Questions listed below as open for this phase were handed to it by earlier phases: answer them here.
- When something material is unclear, raise_question and then investigate it (or hand it to the later phase that covers it, with for_phase): read the relevant section, ask the document, search, compute. Resolve it with evidence, or, only after real attempts, mark it unresolvable with why and whether it could change the conclusion.
- When sources disagree, record_conflict and settle it if you can.
- Label secondary sources (news, consensus, data sites) as secondary. Never invent figures, quotes or dates.
- Prices from the app are delayed. Today's date is given; documents have their own dates.
- When the phase's work is done, call complete_phase. If it lists missing work, do that work; do not argue with the rules.
- Write plainly, in short paragraphs, citing finding ids (F3) and document ids (D2).`;
}

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** The analyst's starting context for a phase. */
export function phaseUser(s: RunState, def: PhaseDef, extra: { prior: string | null; attempt: number; objections?: string }) {
  const p = s.phases.find((x) => x.n === def.n)!;
  const earlier = s.phases.filter((x) => (x.status === "complete" || x.status === "incomplete") && x.n !== def.n).map((x) => `Phase ${x.n} (${x.title}) [${x.status}]:\n${short(x.summary, 6000)}\nKey points: ${x.key_points.join(" | ")}`).join("\n\n");
  const docs = s.inventory.filter((d) => d.phases.includes(def.n) || def.n >= 5);
  const reviews = s.reviews.filter((r) => docs.some((d) => d.id === r.docId) && (def.n < 5 || !r.focus)).map((r) => reviewText(r, s.inventory.find((d) => d.id === r.docId)));
  const reviewBlock = def.n >= 5 ? reviews.map((r) => short(r, 2500)).join("\n\n") : reviews.join("\n\n");
  const questions = s.questions.map((q) => `${q.id} [${q.status}, ${q.materiality}] (phase ${q.phase}) ${q.question}${q.answer ? ` -> ${short(q.answer, 300)}` : ""}`).join("\n");
  const findings = s.findings.filter((f) => !f.withdrawn).map((f) => `${f.id} ${f.key ? "[key] " : ""}${f.claim}: ${f.value} ${f.unit} (${f.period}) — ${f.source}${f.doc_id ? ` ${f.doc_id}` : ""} [${f.check.status}]`).join("\n");
  return `Company: ${s.symbol}${s.name ? ` (${s.name})` : ""}. Today: ${s.today}. App price: ${s.price.value ? `$${s.price.value} (${s.price.source}, ${s.price.asOf?.slice(0, 10) ?? "time unknown"})` : "none"}.
Research type: ${s.type === "full_investigation" ? "full initial investigation" : `material-event refresh of the research dated ${s.base?.research_as_of}`}.

THIS PHASE: ${def.n}. ${def.title}${extra.attempt > 1 ? ` (continuing: attempt ${extra.attempt}; earlier attempt stopped with: ${p.gate.join("; ") || "time budget"})` : ""}
${def.tasks}

EARLIER RESEARCH ON FILE (historical; compare with it, do not copy it):
${extra.prior ?? "None."}

${earlier ? `CHECKPOINTS FROM EARLIER PHASES:\n${earlier}\n` : ""}
${extra.objections ? `SKEPTIC'S OBJECTIONS TO ANSWER:\n${extra.objections}\n` : ""}
READING LIST (status per document; phase ${def.n} needs those marked for it):
${s.inventory.map((d) => `${d.id} [${docStatus(d)}${d.required ? ", required" : ""}${d.phases.includes(def.n) ? `, phase ${def.n}` : ""}] ${d.kind}: ${d.title}${d.unavailable_reason ? ` — unavailable: ${d.unavailable_reason}` : ""}`).join("\n")}

QUESTIONS SO FAR:
${questions || "None yet."}

FINDINGS SO FAR:
${findings || "None yet."}

${def.n === 2 || def.n >= 5 ? `REPORTED FINANCIALS: call get_financials.\n` : ""}${s.valuation ? `CURRENT VALUATION (computed by the app): ${JSON.stringify({ weighted: s.valuation.result.weighted_value, annualized: s.valuation.result.annualized_return, scenarios: s.valuation.result.scenarios.map((x) => ({ name: x.name, p: x.probability, value: x.value_per_share })), errors: s.valuation.result.errors })}\n` : ""}
NOTES FROM DOCUMENTS ALREADY READ IN FULL:
${reviewBlock || "None yet: use review_document."}`;
}
