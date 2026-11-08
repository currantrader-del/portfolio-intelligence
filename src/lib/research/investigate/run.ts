/**
 * Runs a research investigation as a chain of background steps. Each step does one piece of work
 * (build the reading list, find the transcript and presentation, read every document in full, one
 * phase, the skeptic's review, the final checks) and saves a checkpoint (model_runs
 * "investigation_step"). The next step starts from that checkpoint, so a timeout loses one step at
 * most and a run can be resumed.
 *
 * The result is a NEW research version (origin claude_full or claude_targeted_update) that is never
 * made current automatically: it waits for the investor's approval. Earlier versions are not touched.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { save } from "@/lib/intel/jobs";
import { DAILY_CAP, spentToday } from "@/lib/intel/start";
import { getQuote } from "@/lib/market/quotes";
import { buildWorkspace } from "@/lib/workspace-core";
import { attachText, buildInventory, fetchDocText } from "./documents";
import { getFinancials } from "./financials";
import { docStatus, finalGate } from "./gates";
import { validateInvestigation } from "../validate";
import { updateFoundation } from "../standing";
import { runLoop } from "./loop";
import { consistencyCheck, portfolioCheckFrom, stressTests } from "./challenge";
import { INV_MODELS } from "./models";
import { ANSWER_DEF, FULL_PHASES, REFRESH_PHASES, phaseSystem, phaseUser, type PhaseDef } from "./phases";
import { pendingParts, markReviewed, reviewPart } from "./reader";
import { makeExec, nextId, T } from "./tools";
import { addUsage, emptyUsage, type InvDoc, type PhaseState, type ResearchType, type RunState } from "./types";

export const INVESTIGATION_VERSION = "investigation@3";
/** A safety ceiling per run, not a target: a run that reaches it stops and is saved as incomplete. */
export const RUN_CEILING_USD = 12;
const STEP_MS = 11 * 60_000;
const MAX_ATTEMPTS: Record<string, number> = { read: 6, discover: 2, skeptic: 3, answer: 3, inventory: 2, finalize: 2 };
const PHASE_ATTEMPTS = 3;

const nyDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

export async function startInvestigation(db: SupabaseClient, symbol: string, type: ResearchType): Promise<string> {
  return save(db, "investigation_request", INVESTIGATION_VERSION, { symbol, type }, {});
}

async function latestCheckpoint(db: SupabaseClient, requestId: string): Promise<{ state: RunState; at: string } | null> {
  const { data } = await db.from("model_runs").select("computed_at, outputs").eq("kind", "investigation_step").eq("inputs->>request_id", requestId).order("computed_at", { ascending: false }).limit(1).maybeSingle();
  return data ? { state: (data.outputs as { state: RunState }).state, at: data.computed_at } : null;
}

function initState(requestId: string, symbol: string, type: ResearchType): RunState {
  const steps = type === "full_investigation"
    ? ["inventory", "discover", "read", "phase:1", "phase:2", "phase:3", "phase:4", "phase:5", "phase:6", "skeptic", "answer", "finalize"]
    : ["inventory", "discover", "read", "phase:2", "phase:5", "phase:6", "skeptic", "answer", "finalize"];
  const defs = type === "full_investigation" ? FULL_PHASES : FULL_PHASES; // titles; refresh re-titles phase 2 below
  const phases: PhaseState[] = defs.map((d) => ({ n: d.n, title: type === "material_event_refresh" && d.n === 2 ? REFRESH_PHASES[0].title : d.title, status: "pending", attempts: 0, summary: "", key_points: [], gate: [], usage: emptyUsage() }));
  return {
    version: INVESTIGATION_VERSION, type, symbol, name: null, cik: null, today: nyDate(), requestId, versionId: null, base: null,
    steps, next: 0, attemptsAtStep: 0, seq: 0, startedAt: new Date().toISOString(), status: "running", price: { value: null, asOf: null, source: null },
    financials: null, inventory: [], reviews: [], findings: [], questions: [], conflicts: [], phases, valuation: null, objections: [], summary: null, completeness: null,
    usage: emptyUsage(), log: [],
  };
}

const note = (s: RunState, step: string, text: string) => { s.log.push({ at: new Date().toISOString(), step, note: text.slice(0, 600) }); };

/** Runs the next step of an investigation. Returns whether the run still has steps to do. */
export async function runInvestigationStep(db: SupabaseClient, requestId: string): Promise<{ more: boolean; step: string | null; status: string }> {
  const { data: req } = await db.from("model_runs").select("id, inputs").eq("id", requestId).eq("kind", "investigation_request").maybeSingle();
  if (!req) throw new Error("Unknown investigation request");
  const input = req.inputs as { symbol: string; type: ResearchType; resume?: boolean };
  const cp = await latestCheckpoint(db, requestId);
  const s: RunState = cp?.state ?? initState(requestId, String(input.symbol).toUpperCase(), input.type);
  repairIds(s);
  const seqAtStart = s.seq;
  // Heartbeat: shows a step is in progress, so the status check can tell a long step from a lost one.
  await save(db, "investigation_heartbeat", INVESTIGATION_VERSION, { request_id: requestId, seq: seqAtStart }, { step: s.steps[s.next] ?? null, note: "step started" }).catch(() => null);
  if (s.status === "finished" || s.status === "failed") return { more: false, step: null, status: s.status };
  if (s.status === "paused") s.status = "running";

  const before = s.usage;
  const step = s.steps[s.next];
  const t0 = Date.now();
  try {
    const spent = await spentToday(db);
    if (spent.answers >= DAILY_CAP.answers || spent.total >= DAILY_CAP.total) {
      s.status = "paused"; s.pauseReason = `Today's cost limit is reached ($${spent.total.toFixed(2)} spent). Resume after midnight UTC.`;
      note(s, step, s.pauseReason);
    } else if (s.usage.costUsd >= RUN_CEILING_USD && step !== "finalize") {
      note(s, step, `The run reached its $${RUN_CEILING_USD} safety ceiling; finishing with what was done.`);
      s.next = s.steps.indexOf("finalize");
    } else {
      await doStep(db, s, step);
    }
  } catch (e) {
    s.attemptsAtStep++;
    note(s, step, `Step failed: ${(e as Error).message.slice(0, 300)}`);
    if (s.attemptsAtStep >= 3) {
      if (step === "inventory") { s.status = "failed"; }
      else if (step.startsWith("phase:")) { markPhaseIncomplete(s, Number(step.split(":")[1]), [`The step failed three times: ${(e as Error).message.slice(0, 200)}`]); advance(s); }
      else advance(s);
      if (step.startsWith("phase:")) await savePhaseRow(db, s, Number(step.split(":")[1])).catch(() => null);
    }
  }
  // Someone else (a resume) saved a newer checkpoint while this step ran: keep theirs.
  const now = await latestCheckpoint(db, requestId);
  if (now && now.state.seq > seqAtStart) return { more: false, step, status: "superseded" };
  s.seq = seqAtStart + 1;
  const stepUsage = { costUsd: Math.round((s.usage.costUsd - before.costUsd) * 10000) / 10000, ms: Date.now() - t0 };
  await save(db, "investigation_step", INVESTIGATION_VERSION, { request_id: requestId, step, seq: s.seq, symbol: s.symbol }, { state: s, step, costUsd: stepUsage.costUsd, ms: stepUsage.ms, status: s.status, symbol: s.symbol });
  return { more: s.status === "running", step, status: s.status };
}

/**
 * Runs saved before the parallel-call fix could hold several findings (or questions, conflicts) under
 * one id. Later duplicates get fresh ids so the gates and the model can tell them apart.
 */
export function repairIds(s: RunState) {
  for (const [prefix, items] of [["F", s.findings], ["Q", s.questions], ["C", s.conflicts]] as const) {
    const seen = new Set<string>();
    for (const x of items as { id: string }[]) {
      if (seen.has(x.id)) x.id = nextId(prefix, items as { id: string }[]);
      seen.add(x.id);
    }
  }
}

function advance(s: RunState) { s.next++; s.attemptsAtStep = 0; }

function markPhaseIncomplete(s: RunState, n: number, reasons: string[]) {
  const p = s.phases.find((x) => x.n === n);
  if (!p) return;
  p.status = "incomplete"; p.gate = reasons.length ? reasons : p.gate; p.at = new Date().toISOString();
}

async function doStep(db: SupabaseClient, s: RunState, step: string) {
  if (step === "inventory") return stepInventory(db, s);
  if (step === "discover") return stepDiscover(db, s);
  if (step === "read") return stepRead(s);
  if (step.startsWith("phase:")) return stepPhase(db, s, Number(step.split(":")[1]));
  if (step === "skeptic") return stepSkeptic(db, s);
  if (step === "answer") return stepAnswer(db, s);
  if (step === "finalize") return stepFinalize(db, s);
  throw new Error(`Unknown step ${step}`);
}

// ---------------------------------------------------------------- inventory

async function stepInventory(db: SupabaseClient, s: RunState) {
  const { data: company } = await db.from("companies").select("id, name, research_versions(id, research_as_of, completeness, origin, is_current, conclusion, created_at, research_phases(phase_number, title, body_markdown))").eq("symbol", s.symbol).maybeSingle();
  if (!company) throw new Error(`${s.symbol} is not in the research list`);
  s.name = company.name;
  type V = { id: string; research_as_of: string; completeness: string; origin: string; is_current: boolean; conclusion: Record<string, unknown>; created_at: string; research_phases: { phase_number: number; title: string | null; body_markdown: string | null }[] };
  const versions = ((company.research_versions ?? []) as V[]).sort((a, b) => b.created_at.localeCompare(a.created_at));
  // An update builds on the research you approved, or else the latest finished investigation; never on a quick screen.
  const base = s.type === "material_event_refresh" ? (updateFoundation(versions)?.v ?? null) : (versions.find((v) => v.is_current) ?? versions[0] ?? null);
  if (s.type === "material_event_refresh" && !base) throw new Error("There is no finished investigation to update; run a full investigation first");
  if (base) {
    const c = base.conclusion ?? {};
    const val = (c.valuation ?? {}) as Record<string, unknown>;
    const head = `Research dated ${base.research_as_of} (${base.origin}${c.research_type ? `, ${c.research_type}` : ""}, ${base.completeness}${base.is_current ? ", current" : ""}). Action: ${c.action ?? "none"}. Confidence: ${c.confidence ?? "n/a"}. Thesis: ${c.thesis ?? "n/a"}. Reference price: ${c.reference_price ?? "n/a"} on ${c.reference_date ?? "n/a"}. Scenarios: bear ${val.bear_value ?? "?"} (${val.bear_probability ?? "?"}), base ${val.base_value ?? "?"} (${val.base_probability ?? "?"}), bull ${val.bull_value ?? "?"} (${val.bull_probability ?? "?"}) by ${val.terminal_date ?? "?"}; method: ${String(val.method ?? "").slice(0, 600)}. Open items it listed: ${(Array.isArray(c.not_verified) ? c.not_verified : []).join(" | ").slice(0, 1500)}`;
    const phases = s.type === "material_event_refresh" ? [...(base.research_phases ?? [])].sort((a, b) => a.phase_number - b.phase_number).map((p) => `--- Phase ${p.phase_number} ${p.title ?? ""}\n${(p.body_markdown ?? "").slice(0, 5000)}`).join("\n") : "";
    s.base = { versionId: base.id, research_as_of: base.research_as_of, origin: base.origin, type: (c.research_type as string) ?? null, summary: phases ? `${head}\n${phases}` : head };
  }
  const inv = await buildInventory({ symbol: s.symbol, type: s.type, today: s.today, since: s.type === "material_event_refresh" ? base!.research_as_of : null });
  if ("error" in inv) throw new Error(inv.error);
  s.cik = inv.cik; s.name = s.name ?? inv.company;
  s.inventory = inv.docs;
  for (const n of inv.notes) note(s, "inventory", n);
  // Download everything on the list (four at a time) so section sizes and hashes are recorded.
  const docs = s.inventory.filter((d) => d.url);
  for (let i = 0; i < docs.length; i += 4) {
    await Promise.all(docs.slice(i, i + 4).map(async (d) => {
      const t = await fetchDocText(d.url, d.form);
      if ("error" in t) { d.status = "unavailable"; d.unavailable_reason = `Download failed: ${t.error}`; d.attempts = [`${d.url}: ${t.error}`]; }
      else await attachText(d, t);
    }));
  }
  const fin = s.cik ? await getFinancials(s.cik) : { error: "No CIK" };
  if ("error" in fin) note(s, "inventory", `XBRL financials not available: ${fin.error}`); else s.financials = fin;
  const q = await getQuote(s.symbol).catch(() => null);
  s.price = { value: q?.price ?? null, asOf: q?.asOf ?? null, source: q ? `${q.provider} (delayed)` : null };
  if (s.type === "material_event_refresh") {
    for (const p of s.phases.filter((x) => ![2, 5, 6].includes(x.n))) { p.status = "carried_forward"; p.carried_from = base!.id; p.summary = `Not redone: carried forward from the research dated ${base!.research_as_of}.`; }
  }
  if (!s.versionId) {
    const { data: v, error } = await db.from("research_versions").insert({
      company_id: company.id, research_as_of: s.today, completeness: "in_progress", origin: s.type === "full_investigation" ? "claude_full" : "claude_targeted_update", is_current: false,
      supersedes_id: base?.id ?? null, conclusion: { research_type: s.type, review_state: "running", request_id: s.requestId, generated_by: INVESTIGATION_VERSION },
      change_summary: `${s.type === "full_investigation" ? "Full investigation" : "Material-event refresh"} started ${s.today}. Not yet reviewed or approved.`,
    }).select("id").single();
    if (error || !v) throw new Error(`Could not create the research version: ${error?.message}`);
    s.versionId = v.id;
  }
  note(s, "inventory", `${s.inventory.length} documents on the reading list (${s.inventory.filter((d) => d.required).length} required); ${s.inventory.filter((d) => d.fetched).reduce((a, d) => a + (d.fetched?.chars ?? 0), 0).toLocaleString("en-US")} characters downloaded.`);
  advance(s);
}

// ---------------------------------------------------------------- discover

async function stepDiscover(db: SupabaseClient, s: RunState) {
  const missing = s.inventory.filter((d) => (d.kind === "transcript" || d.kind === "presentation") && !d.url);
  if (!missing.length) { advance(s); return; }
  const lastEarnings = s.inventory.find((d) => d.kind === "earnings_release");
  const done = { value: false };
  const exec = makeExec({ state: s, phase: 0, db, ws: null, done });
  const r = await runLoop({
    model: INV_MODELS.analyst,
    system: `You find primary documents for an equity research file. You need the full text of the latest earnings call transcript (prepared remarks AND the analyst Q&A) and the latest investor or earnings presentation for ${s.symbol}${s.name ? ` (${s.name})` : ""}. Today is ${s.today}.${lastEarnings ? ` The latest earnings release on file: ${lastEarnings.title}. The transcript and presentation must be for that same quarter.` : ""}
Where to look: the company's investor-relations website (events, quarterly results, presentations, webcasts pages), the SEC filing exhibits already on the list (an EX-99.2 can be the presentation or CFO commentary), and free transcript pages. Use add_document with the direct URL to download the full text (PDF works). A page that only links to a webcast or requires a login is not a transcript. If, after real attempts, a document cannot be obtained, use mark_unavailable with every attempt. Then call finish_discovery.`,
    user: `Reading list:\n${s.inventory.map((d) => `${d.id} [${docStatus(d)}] ${d.kind}: ${d.title}${d.url ? ` ${d.url}` : ""}`).join("\n")}\n\nFind ${missing.map((d) => `${d.id} (${d.title})`).join(" and ")}.`,
    tools: [T.list_documents, T.add_document, T.mark_unavailable, T.finish_discovery],
    webSearches: 8,
    exec, isDone: () => done.value,
    missing: () => s.inventory.filter((d) => (d.kind === "transcript" || d.kind === "presentation") && !d.url && !(d.attempts?.length)).map((d) => d.id).join(", ") || "call finish_discovery",
    limits: { turns: 24, ms: STEP_MS - 60_000 },
  });
  s.usage = addUsage(s.usage, r.usage);
  for (const x of r.searches) note(s, "discover", `search "${x.query}": ${x.title} ${x.url}`);
  s.attemptsAtStep++;
  if (done.value || s.attemptsAtStep >= MAX_ATTEMPTS.discover) {
    for (const d of s.inventory.filter((x) => (x.kind === "transcript" || x.kind === "presentation") && !x.url)) {
      if (!(d.attempts?.length)) { d.status = "unavailable"; d.unavailable_reason = "Not found by the document search"; d.attempts = r.searches.filter((x) => x.query).map((x) => `search: ${x.query}`).slice(0, 8); }
    }
    advance(s);
  }
}

// ---------------------------------------------------------------- read

async function stepRead(s: RunState) {
  const t0 = Date.now();
  type Job = { d: InvDoc; section: string; part: number };
  const queue: Job[] = [];
  const order = (d: InvDoc) => (d.required ? 0 : 1);
  for (const d of [...s.inventory].sort((a, b) => order(a) - order(b))) {
    if (!d.url || docStatus(d) === "unavailable") continue;
    for (const p of pendingParts(d)) queue.push({ d, ...p });
  }
  const texts = new Map<string, Awaited<ReturnType<typeof fetchDocText>>>();
  let i = 0;
  const errors: string[] = [];
  const worker = async () => {
    while (i < queue.length && Date.now() - t0 < STEP_MS - 2 * 60_000) {
      const j = queue[i++];
      let t = texts.get(j.d.url);
      if (!t) { t = await fetchDocText(j.d.url, j.d.form); texts.set(j.d.url, t); }
      if ("error" in t) { errors.push(`${j.d.id}: ${t.error}`); continue; }
      if (!j.d.fetched || j.d.fetched.chars !== t.text.length) await attachText(j.d, t);
      const r = await reviewPart({ symbol: s.symbol, doc: j.d, text: t, section: j.section, part: j.part });
      if ("usage" in r && r.usage) s.usage = addUsage(s.usage, r.usage);
      if ("error" in r) { errors.push(`${j.d.id} ${j.section}: ${r.error}`); continue; }
      s.reviews = s.reviews.filter((x) => !(x.key === r.review.key && !x.focus));
      s.reviews.push(r.review);
      markReviewed(j.d, j.section, j.part);
      j.d.status = docStatus(j.d);
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  const left = s.inventory.filter((d) => d.required && d.url && pendingParts(d).length && docStatus(d) !== "unavailable");
  note(s, "read", `Read ${Math.min(i, queue.length)} of ${queue.length} section parts in full.${errors.length ? ` Problems: ${errors.slice(0, 5).join("; ")}` : ""}`);
  s.attemptsAtStep++;
  if (!left.length || s.attemptsAtStep >= MAX_ATTEMPTS.read) advance(s);
}

// ---------------------------------------------------------------- phases

async function stepPhase(db: SupabaseClient, s: RunState, n: number) {
  const defs = s.type === "full_investigation" ? FULL_PHASES : REFRESH_PHASES;
  const def = defs.find((d) => d.n === n) as PhaseDef;
  const p = s.phases.find((x) => x.n === n)!;
  if (p.status === "complete" || p.status === "carried_forward") { advance(s); return; }
  p.status = "running"; p.attempts++;
  const done = { value: false };
  const ws = n >= 5 ? await buildWorkspace(db).catch(() => null) : null;
  if (ws && n === 6) s.portfolioCheck = portfolioCheckFrom(ws, s.symbol);
  const exec = makeExec({ state: s, phase: n, db, ws, done });
  const objections = n === 6 && s.objections.length ? s.objections.map((o) => `${o.id} [${o.severity}] ${o.objection}${o.evidence_to_check ? ` (check: ${o.evidence_to_check})` : ""}${o.outcome ? ` -> answered: ${o.outcome}` : ""}`).join("\n") : undefined;
  const before = s.usage;
  const r = await runLoop({
    model: def.high ? INV_MODELS.analystHigh : INV_MODELS.analyst,
    system: phaseSystem(s.type),
    user: phaseUser(s, def, { prior: s.base?.summary ?? null, attempt: p.attempts, objections }),
    // A run saved by the previous version had the skeptic before phase 6, which then answered it.
    tools: n === 6 && s.objections.some((o) => !o.outcome) ? [...def.tools, T.respond_objection] : def.tools, webSearches: def.webSearches, exec, isDone: () => done.value,
    missing: () => p.gate.join("\n") || "call complete_phase with the phase summary",
    limits: { turns: 40, ms: STEP_MS },
  });
  s.usage = addUsage(s.usage, r.usage);
  p.usage = addUsage(p.usage, { ...emptyUsage(), costUsd: Math.round((s.usage.costUsd - before.costUsd) * 10000) / 10000, ms: r.usage.ms, calls: r.usage.calls, searches: r.usage.searches });
  for (const x of r.searches) note(s, `phase:${n}`, `search "${x.query}": ${x.title} ${x.url}`);
  if (done.value) { await savePhaseRow(db, s, n); advance(s); return; }
  if (p.attempts >= PHASE_ATTEMPTS) {
    markPhaseIncomplete(s, n, p.gate.length ? p.gate : [`Stopped: ${r.stopped ?? "did not finish"}`]);
    if (!p.summary) p.summary = r.lastText.slice(0, 8000);
    await savePhaseRow(db, s, n);
    advance(s);
  } else {
    p.status = "pending";
    note(s, `phase:${n}`, `Phase ${n} not finished in this step (${r.stopped ?? "not accepted"}); continuing.`);
  }
}

/** The phase checkpoint as a research_phases row on the new version. */
async function savePhaseRow(db: SupabaseClient, s: RunState, n: number) {
  if (!s.versionId) return;
  const p = s.phases.find((x) => x.n === n)!;
  const docs = s.inventory.filter((d) => d.phases.includes(n));
  const fs = s.findings.filter((f) => f.phase === n);
  const qs = s.questions.filter((q) => q.phase === n);
  const body = [
    p.summary || "(No summary was saved.)",
    p.key_points.length ? `\n**Key points**\n${p.key_points.map((k) => `- ${k}`).join("\n")}` : "",
    p.status === "incomplete" ? `\n**Incomplete:** ${p.gate.join("; ")}` : "",
    docs.length ? `\n**Documents for this phase**\n${docs.map((d) => `- ${d.id} ${d.title}: ${docStatus(d).replace(/_/g, " ")}`).join("\n")}` : "",
    fs.length ? `\n**Findings**\n${fs.map((f) => `- ${f.id} ${f.claim}: ${f.value} ${f.unit} (${f.period}) [${f.source}, ${f.check.status.replace(/_/g, " ")}]`).join("\n")}` : "",
    qs.length ? `\n**Questions**\n${qs.map((q) => `- ${q.id} (${q.materiality}) ${q.question} -> ${q.status}${q.answer ? `: ${q.answer}` : ""}`).join("\n")}` : "",
  ].join("\n");
  await db.from("research_phases").delete().eq("version_id", s.versionId).eq("phase_number", n);
  const { error } = await db.from("research_phases").insert({
    version_id: s.versionId, phase_number: n, title: p.title, body_markdown: body.slice(0, 60000), extraction: "verbatim",
    details: { checkpoint: true, generated_by: INVESTIGATION_VERSION, status: p.status, gate: p.gate, attempts: p.attempts, at: p.at ?? new Date().toISOString(), usage: p.usage, documents: docs.map((d) => ({ id: d.id, status: docStatus(d) })), findings: fs.map((f) => f.id), questions: qs.map((q) => ({ id: q.id, status: q.status })), carried_from: p.carried_from ?? null },
  });
  if (error) note(s, `phase:${n}`, `Checkpoint row not saved: ${error.message}`);
}

// ---------------------------------------------------------------- skeptic

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "?" : `${(x * 100).toFixed(1)}%`);

const SKEPTIC_SYSTEM = `You are the skeptical reviewer on an investment committee, independent of the analyst who wrote this research. Your job is to try to break the conclusion before any money depends on it, by testing it, not by restating it.

Challenge each of these areas, with at least one tested challenge each (record_objection):
- thesis: does the evidence in the documents actually support the thesis, or is it narrative, circular or secondary-sourced?
- valuation_assumptions: revenue, margins, multiples, share count and net debt in each scenario versus the reported record (get_financials), guidance and consensus. Use stress_test to measure what a realistic change does.
- probabilities: are the bear/base/bull weights justified by the evidence, or chosen to make the answer? Use the break-even results below.
- projections: growth and margin paths versus history, guidance and capacity; what would have to be true.
- competition: competitive threats, share loss, pricing pressure, customer concentration and in-house alternatives, with evidence.
- portfolio_recommendation: does the action follow from the numbers, the evidence state and the investor's position and limits (get_portfolio, get_exposure, get_policy)? An attractive modeled return is not permission to add; check room under approved limits, concentration and what is unresolved.

How to test: open the cited documents (ask_document, read_text) to check a claim or quote; run stress_test on the assumption you doubt; compare with the reported record (get_financials). Say exactly what you checked and what it showed, with numbers. Cite finding (F12), question (Q3) and document (D4) ids. Do not accept a figure because the analyst recorded it; do not invent figures. If an area holds up after testing, record that test as a minor objection that explains what you tried and why it held.

Severity: critical (could reverse the action), major (could change the valuation or sizing materially), minor. Then finish_review with your verdict on whether the thesis, the valuation and the recommendation survive, and the changes the conclusion must make.`;

function skepticUser(s: RunState) {
  const v = s.valuation, sm = s.summary;
  return `Company ${s.symbol}${s.name ? ` (${s.name})` : ""}, app price $${s.price.value ?? "?"} on ${s.today}.

THE CONCLUSION UNDER REVIEW:
${sm ? JSON.stringify({ headline: sm.headline, thesis: sm.thesis, action: sm.action, confidence: sm.confidence, valuation: sm.valuation, expected_return: sm.expected_return, risks: sm.risks, portfolio_fit: sm.portfolio_fit, allocation: sm.allocation, price_framework: sm.price_framework, would_change: sm.would_change, reasons: sm.reasons }) : "No summary was submitted."}

VALUATION (computed by the app): ${v ? JSON.stringify({ horizon: v.horizon_date, revenue_basis: v.revenue_basis, weighted: v.result.weighted_value, annualized: v.result.annualized_return, scenarios: v.specs.map((x) => ({ name: x.name, p: x.probability, method: x.method, inputs: x.inputs, sources: x.sources, rationale: x.rationale, value: v.result.scenarios.find((r) => r.name === x.name)?.value_per_share })) }) : "none"}

SENSITIVITY (computed by the app from the research's own inputs):
${(s.stress ?? []).filter((x) => !x.label.startsWith("Skeptic:")).map((x) => `- ${x.label}: ${x.weighted_value !== null ? `weighted $${x.weighted_value.toFixed(2)}, ` : ""}${pct(x.annualized_return)} a year. ${x.note}`).join("\n") || "none"}

POSITION (app data): ${s.portfolioCheck ? `weight ${pct(s.portfolioCheck.weight)} including ETFs (${pct(s.portfolioCheck.direct)} direct); top of normal range ${pct(s.portfolioCheck.normalHigh)}; maximum ${pct(s.portfolioCheck.max)} (limit authority: ${s.portfolioCheck.limitAuthority}); room for new money $${s.portfolioCheck.headroomDollars ?? "?"}` : "not loaded"}

PHASE CHECKPOINTS:
${s.phases.map((p) => `Phase ${p.n} ${p.title} [${p.status}]\n${p.summary.slice(0, 5000)}`).join("\n\n")}

KEY FINDINGS:
${s.findings.filter((f) => f.key && !f.withdrawn).map((f) => `${f.id} ${f.claim}: ${f.value} ${f.unit} (${f.period}) [${f.source}${f.doc_id ? ` ${f.doc_id}` : ""}, ${f.check.status}]${f.classification ? ` classified ${f.classification.cls}: ${f.classification.explanation}` : ""}`).join("\n")}

QUESTIONS:
${s.questions.map((q) => `${q.id} [${q.status}, ${q.materiality}] ${q.question}${q.answer ? ` -> ${q.answer.slice(0, 300)}` : ""}${q.why_unresolvable ? ` (unresolvable: ${q.why_unresolvable})` : ""}`).join("\n") || "none"}

CONFLICTS:
${s.conflicts.map((c) => `${c.id} ${c.description} -> ${c.resolution} [${c.status}]`).join("\n") || "none"}

DOCUMENTS: ${s.inventory.map((d) => `${d.id} ${d.kind} "${d.title}" ${docStatus(d)}`).join("; ")}

EARLIER RESEARCH ON FILE: ${s.base?.summary?.slice(0, 1500) ?? "none"}
${s.objections.length ? `\nCHALLENGES ALREADY RECORDED (continue from here; do not repeat them):\n${s.objections.map((o) => `${o.id} [${o.area}, ${o.severity}] ${o.objection}`).join("\n")}` : ""}`;
}

async function stepSkeptic(db: SupabaseClient, s: RunState) {
  const ws = await buildWorkspace(db).catch(() => null);
  if (!s.draft) {
    const r = s.valuation?.result;
    s.draft = { action: s.summary?.action ?? null, confidence: s.summary?.confidence ?? null, headline: s.summary?.headline ?? null, weighted_value: r?.weighted_value ?? null, annualized_return: r?.annualized_return ?? null, at: new Date().toISOString() };
    s.stress = stressTests(s);
  }
  if (ws) s.portfolioCheck = portfolioCheckFrom(ws, s.symbol);
  const done = { value: false };
  const exec = makeExec({ state: s, phase: 0, db, ws, done });
  const r = await runLoop({
    model: INV_MODELS.skeptic, system: SKEPTIC_SYSTEM, user: skepticUser(s),
    tools: [T.list_documents, T.ask_document, T.read_text, T.get_financials, T.get_portfolio, T.get_policy, T.get_exposure, T.stress_test, T.record_objection, T.finish_review],
    webSearches: 3, exec, isDone: () => done.value,
    missing: () => "Record tested challenges for every area with record_objection, then call finish_review",
    limits: { turns: 40, ms: STEP_MS },
  });
  s.usage = addUsage(s.usage, r.usage);
  for (const x of r.searches) note(s, "skeptic", `search "${x.query}": ${x.title} ${x.url}`);
  if (done.value) { advance(s); return; }
  s.attemptsAtStep++;
  note(s, "skeptic", `The skeptical review did not finish in this step (${r.stopped ?? "not accepted"}); ${s.objections.length} challenges recorded so far.`);
  if (s.attemptsAtStep >= MAX_ATTEMPTS.skeptic) advance(s);
}

// ---------------------------------------------------------------- answer the skeptic

async function stepAnswer(db: SupabaseClient, s: RunState) {
  const p = s.phases.find((x) => x.n === 6)!;
  if (!s.objections.length) { advance(s); return; }
  const done = { value: false };
  const ws = await buildWorkspace(db).catch(() => null);
  const exec = makeExec({ state: s, phase: 6, db, ws, done });
  const rv = s.review;
  const objections = s.objections.map((o) => `${o.id} [${o.severity}, ${o.area ?? "general"}] ${o.objection}${o.claim ? `\n  Claim challenged: ${o.claim}` : ""}${o.test ? `\n  Test: ${o.test}\n  Result: ${o.test_result}` : ""}${o.evidence_to_check ? `\n  Would settle it: ${o.evidence_to_check}` : ""}${o.outcome ? `\n  -> answered (${o.outcome}): ${o.response}` : ""}`).join("\n");
  const verdict = rv ? `SKEPTIC'S VERDICT: thesis ${rv.thesis}, valuation ${rv.valuation}, recommendation ${rv.recommendation}. ${rv.summary}\nRequired changes:\n${rv.required_changes.map((x) => `- ${x}`).join("\n") || "- none"}` : "The skeptic did not finish a verdict; answer the challenges recorded.";
  const r = await runLoop({
    model: INV_MODELS.analystHigh, system: phaseSystem(s.type),
    user: `${phaseUser(s, ANSWER_DEF, { prior: s.base?.summary ?? null, attempt: s.attemptsAtStep + 1, objections })}\n\n${verdict}\n\nYOUR DRAFT CONCLUSION BEFORE THE REVIEW: ${s.draft ? `${s.draft.action} (confidence ${s.draft.confidence}); weighted $${s.draft.weighted_value?.toFixed(2)}, ${pct(s.draft.annualized_return)} a year` : "none"}`,
    tools: ANSWER_DEF.tools, webSearches: ANSWER_DEF.webSearches, exec, isDone: () => done.value,
    missing: () => p.gate.join("\n") || "answer every objection, revisit the conclusion, then call finish_answers",
    limits: { turns: 40, ms: STEP_MS },
  });
  s.usage = addUsage(s.usage, r.usage);
  p.usage = addUsage(p.usage, { ...emptyUsage(), costUsd: r.usage.costUsd, ms: r.usage.ms, calls: r.usage.calls, searches: r.usage.searches });
  for (const x of r.searches) note(s, "answer", `search "${x.query}": ${x.title} ${x.url}`);
  if (done.value) { await savePhaseRow(db, s, 6); advance(s); return; }
  s.attemptsAtStep++;
  note(s, "answer", `Answers to the skeptic not finished in this step (${r.stopped ?? "not accepted"}).`);
  if (s.attemptsAtStep >= MAX_ATTEMPTS.answer) { await savePhaseRow(db, s, 6); advance(s); }
}

// ---------------------------------------------------------------- finalize

async function stepFinalize(db: SupabaseClient, s: RunState) {
  for (const d of s.inventory) d.status = docStatus(d);
  const ws = await buildWorkspace(db).catch(() => null);
  if (ws) s.portfolioCheck = portfolioCheckFrom(ws, s.symbol);
  // The work and evidence rules first, then whether the written conclusion matches the numbers, the
  // portfolio and that state (an add needs complete research), then the rules again with that result.
  s.consistency = null;
  const pre = finalGate(s);
  s.completeness = { complete: pre.complete, reasons: pre.reasons, kind: pre.kind };
  s.consistency = consistencyCheck(s);
  const gate = finalGate(s);
  if (s.usage.costUsd >= RUN_CEILING_USD) { gate.reasons.unshift(`Stopped at the $${RUN_CEILING_USD} safety ceiling`); gate.kind = "work_incomplete"; }
  s.completeness = { complete: gate.complete && s.usage.costUsd < RUN_CEILING_USD, reasons: gate.reasons, kind: gate.complete && s.usage.costUsd < RUN_CEILING_USD ? "complete" : gate.kind === "complete" ? "work_incomplete" : gate.kind };
  const v = s.valuation?.result;
  const sm = s.summary;
  const by = (n: "bear" | "base" | "bull") => v?.scenarios.find((x) => x.name === n);
  const counts = s.inventory.reduce<Record<string, number>>((a, d) => { a[d.status] = (a[d.status] ?? 0) + 1; return a; }, {});
  const runtimeMs = Date.now() - Date.parse(s.startedAt);
  const conclusion = {
    research_type: s.type, review_state: "awaiting_approval", request_id: s.requestId, generated_by: INVESTIGATION_VERSION,
    action: sm?.action ?? null, classification: sm?.classification ?? null, confidence: sm?.confidence ?? null, thesis: sm?.thesis ?? null, summary: sm?.headline ?? null,
    reference_price: s.price.value, reference_date: s.today, reference_price_source: s.price.source ?? "none",
    valuation: v ? {
      bear_value: by("bear")?.value_per_share ?? null, bear_probability: by("bear")?.probability ?? null,
      base_value: by("base")?.value_per_share ?? null, base_probability: by("base")?.probability ?? null,
      bull_value: by("bull")?.value_per_share ?? null, bull_probability: by("bull")?.probability ?? null,
      terminal_date: s.valuation!.horizon_date, weighted_value: v.weighted_value, annualized_return: v.annualized_return,
      method: s.valuation!.specs.map((x) => `${x.name}: ${x.method} on ${s.valuation!.revenue_basis} revenue`).join("; ") + " (values computed by the app)", computed_by_app: true,
    } : null,
    price_framework: sm?.price_framework ?? [], allocation: sm?.allocation ?? null, would_change: sm?.would_change ?? [],
    not_verified: [...transcriptGap(s), ...s.questions.filter((q) => q.status !== "resolved").map((q) => `${q.question}${q.why_unresolvable ? ` (${q.why_unresolvable})` : ""}`)],
    investment_summary: sm, completion: s.completeness, documents: counts,
    // The evidence behind the conclusion, kept with the record so it can be audited without the run log.
    evidence: {
      findings: s.findings, questions: s.questions, conflicts: s.conflicts, objections: s.objections,
      review: s.review ?? null, draft: s.draft ?? null, stress: s.stress ?? [], consistency: s.consistency ?? null, portfolio_check: s.portfolioCheck ?? null,
      valuation: s.valuation ? { specs: s.valuation.specs, result: s.valuation.result, revenue_basis: s.valuation.revenue_basis } : null,
      financials_source: s.financials?.source ?? null, base_version: s.base ? { id: s.base.versionId, research_as_of: s.base.research_as_of, origin: s.base.origin } : null,
      phases: s.phases.map((p) => ({ n: p.n, title: p.title, status: p.status, gate: p.gate, attempts: p.attempts, cost_usd: p.usage.costUsd, ms: p.usage.ms })),
      log: s.log.filter((l) => !l.note.startsWith("search ")).slice(-60),
    },
    usage: { cost_usd: s.usage.costUsd, runtime_ms: runtimeMs, calls: s.usage.calls, searches: s.usage.searches, by_model: s.usage.byModel, input_tokens: s.usage.input + s.usage.cacheRead + s.usage.cacheWrite, output_tokens: s.usage.output },
  };
  if (s.versionId) {
    const { error } = await db.from("research_versions").update({
      completeness: s.completeness.complete ? "complete" : "partial", conclusion,
      change_summary: `${s.type === "full_investigation" ? "Full investigation" : "Material-event refresh"} ${s.today}: ${s.completeness.complete ? "complete" : `incomplete (${s.completeness.reasons.length} open item${s.completeness.reasons.length === 1 ? "" : "s"})`}. ${counts.fully_reviewed ?? 0} documents read in full. $${s.usage.costUsd.toFixed(2)}, ${Math.round(runtimeMs / 60000)} min. Awaiting your approval before it is used.`.slice(0, 2000),
    }).eq("id", s.versionId);
    if (error) throw new Error(`Could not save the result: ${error.message}`);
    await db.from("research_sources").delete().eq("version_id", s.versionId);
    const searched = s.log.filter((l) => l.note.startsWith("search ")).map((l) => { const m = l.note.match(/^search "(.*)": (.*) (https?:\/\/\S+)$/); return m ? { query: m[1], title: m[2], url: m[3] } : null; }).filter((x): x is { query: string; title: string; url: string } => !!x);
    const seen = new Set(s.inventory.map((d) => d.url));
    const rows = [
      ...s.inventory.map((d) => ({ version_id: s.versionId, title: `${d.id} ${d.title}`.slice(0, 300), url: d.url || null, document_date: d.filed ?? null, details: { doc_id: d.id, kind: d.kind, review_status: d.status, required: d.required, origin: d.origin, why: d.why, chars: d.fetched?.chars ?? null, sha256: d.fetched?.sha256 ?? null, sections: d.sections?.map((x) => ({ key: x.key, label: x.label, chars: x.chars, material: x.material, read: `${x.reviewedParts.length}/${x.parts}` })) ?? [], unavailable_reason: d.unavailable_reason ?? null, attempts: d.attempts ?? [], cited_by: INVESTIGATION_VERSION } })),
      ...searched.filter((x) => !seen.has(x.url) && (seen.add(x.url), true)).slice(0, 80).map((x) => ({ version_id: s.versionId, title: x.title.slice(0, 300), url: x.url, document_date: null, details: { review_status: "search_result_only", query: x.query, cited_by: INVESTIGATION_VERSION } })),
    ];
    for (let i = 0; i < rows.length; i += 50) {
      const { error: e2 } = await db.from("research_sources").insert(rows.slice(i, i + 50));
      if (e2) note(s, "finalize", `Sources not saved: ${e2.message}`);
    }
    // A code-only check of the finished record, saved on its own and shown beside the approval buttons.
    if (s.valuation && s.price.value) {
      try {
        const report = validateInvestigation({ symbol: s.symbol, valuation: s.valuation, price: s.price.value, today: s.today, findings: s.findings, inventory: s.inventory, reviews: s.reviews, log: s.log });
        await save(db, "research_validation", report.version, { symbol: s.symbol, version_id: s.versionId, request_id: s.requestId }, report);
      } catch (e) { note(s, "finalize", `Validation not saved: ${(e as Error).message.slice(0, 160)}`); }
    }
    // Carried-forward phases keep the earlier text, marked as such, so the record reads in full.
    for (const p of s.phases.filter((x) => x.status === "carried_forward")) {
      const { data: old } = await db.from("research_phases").select("title, body_markdown").eq("version_id", p.carried_from!).eq("phase_number", p.n).maybeSingle();
      p.summary = `Carried forward unchanged from the research dated ${s.base?.research_as_of} (not redone in this refresh).\n\n${old?.body_markdown ?? "(no text in the earlier research)"}`;
      await savePhaseRow(db, s, p.n);
    }
  }
  s.status = "finished";
  advance(s);
}

/**
 * The standard includes the latest earnings call's analyst Q&A. When no transcript could be found, or one was
 * read but no Q&A came out of it, the record says so plainly instead of reading as complete on that point.
 */
export function transcriptGap(s: Pick<RunState, "inventory" | "reviews">): string[] {
  const t = s.inventory.filter((d) => d.kind === "transcript");
  if (!t.length) return ["Earnings-call Q&A not reviewed: no transcript was listed for this research."];
  const qa = s.reviews.filter((r) => t.some((d) => d.id === r.docId)).reduce((m, r) => m + (r.qa?.length ?? 0), 0);
  if (qa > 0) return [];
  const d = t[0];
  return [d.status === "unavailable" ? `Earnings-call Q&A not reviewed: no transcript was available (${d.unavailable_reason ?? "reason not recorded"}). Management's answers to analysts are missing from this research.` : "Earnings-call Q&A not reviewed: the transcript was read but no analyst questions and answers were captured."];
}

/** Short status for the app. */
export function statusOf(s: RunState, lastAt: string) {
  return {
    type: s.type, symbol: s.symbol, status: s.status, pauseReason: s.pauseReason ?? null, step: s.steps[s.next] ?? null, stepIndex: s.next, steps: s.steps.length,
    startedAt: s.startedAt, lastCheckpointAt: lastAt, costUsd: s.usage.costUsd, versionId: s.versionId,
    phases: s.phases.map((p) => ({ n: p.n, title: p.title, status: p.status })),
    documents: { total: s.inventory.length, fully: s.inventory.filter((d) => docStatus(d) === "fully_reviewed").length, unavailable: s.inventory.filter((d) => docStatus(d) === "unavailable").length },
    findings: s.findings.length, questions: { open: s.questions.filter((q) => q.status === "open").length, total: s.questions.length },
    completeness: s.completeness,
  };
}

/** A step that started this long ago without saving is lost (Netlify stops a background function at 15 minutes). */
const STEP_LOST_MS = 15.5 * 60_000;
/** After a checkpoint the next step starts within seconds; this long with no heartbeat means the hand-off was lost. */
const HANDOFF_LOST_MS = 3 * 60_000;

async function latestHeartbeat(db: SupabaseClient, requestId: string): Promise<string | null> {
  const { data } = await db.from("model_runs").select("computed_at").eq("kind", "investigation_heartbeat").eq("inputs->>request_id", requestId).order("computed_at", { ascending: false }).limit(1).maybeSingle();
  return data?.computed_at ?? null;
}

/**
 * Whether a running investigation has stopped moving. In progress = a heartbeat newer than the last
 * checkpoint (a step is working; lost after 15.5 minutes). Between steps = the last checkpoint is newer
 * (the next step should start at once; lost after 3 minutes).
 */
export function isStalled(p: { requestAt: string; checkpointAt: string | null; heartbeatAt: string | null; running: boolean }, now = Date.now()) {
  if (!p.running) return false;
  const cp = p.checkpointAt ? Date.parse(p.checkpointAt) : Date.parse(p.requestAt);
  const hb = p.heartbeatAt ? Date.parse(p.heartbeatAt) : 0;
  return hb > cp ? now - hb > STEP_LOST_MS : now - cp > HANDOFF_LOST_MS;
}

export async function investigationStatus(db: SupabaseClient, symbol: string) {
  const { data: req } = await db.from("model_runs").select("id, computed_at, inputs, code_version").eq("kind", "investigation_request").eq("inputs->>symbol", symbol).order("computed_at", { ascending: false }).limit(1).maybeSingle();
  if (!req) return { status: "none" as const };
  return statusForRequest(db, req);
}

async function statusForRequest(db: SupabaseClient, req: { id: string; computed_at: string; inputs: unknown; code_version?: string | null }) {
  const [cp, hb] = await Promise.all([latestCheckpoint(db, req.id), latestHeartbeat(db, req.id)]);
  const lastAt = cp?.at ?? req.computed_at;
  const stalled = isStalled({ requestAt: req.computed_at, checkpointAt: cp?.at ?? null, heartbeatAt: hb, running: !cp || cp.state.status === "running" });
  return { status: stalled ? ("stalled" as const) : cp ? (cp.state.status) : ("running" as const), requestId: req.id, type: (req.inputs as { type: ResearchType }).type, startedAt: req.computed_at, run: cp ? statusOf(cp.state, lastAt) : null,
    // Only runs started by this version restart on their own; older ones wait for the Resume button.
    autoResume: req.code_version === INVESTIGATION_VERSION };
}

/**
 * Restarts a stalled run from its last checkpoint. The heartbeat is written first, so the run counts as
 * in progress and a second caller (the page's polling, the scheduled sweep) does not start it twice.
 * Returns true when a restart was sent.
 */
export const AUTO_RESTARTS = 3;
export async function resumeIfStalled(db: SupabaseClient, requestId: string, dispatch: () => Promise<unknown>, manual = false) {
  if (!manual) {
    // Automatic restarts are capped: a step that keeps dying would otherwise be retried (and paid for) forever.
    const { count } = await db.from("model_runs").select("id", { count: "exact", head: true }).eq("kind", "investigation_heartbeat").eq("inputs->>request_id", requestId).eq("outputs->>note", "restarted after a stall");
    if ((count ?? 0) >= AUTO_RESTARTS) return false;
  }
  await save(db, "investigation_heartbeat", INVESTIGATION_VERSION, { request_id: requestId, seq: null }, { step: null, note: manual ? "resumed by you" : "restarted after a stall" });
  await dispatch();
  return true;
}

/** Investigations started in the last two days that have stalled (for the scheduled sweep). */
export async function stalledInvestigations(db: SupabaseClient) {
  const since = new Date(Date.now() - 2 * 86400_000).toISOString();
  const { data } = await db.from("model_runs").select("id, computed_at, inputs, code_version").eq("kind", "investigation_request").gte("computed_at", since).order("computed_at", { ascending: false }).limit(20);
  const out: { requestId: string; symbol: string }[] = [];
  for (const req of data ?? []) {
    const st = await statusForRequest(db, req);
    if (st.status === "stalled" && st.autoResume) out.push({ requestId: req.id, symbol: String((req.inputs as { symbol?: string }).symbol ?? "") });
  }
  return out;
}

export async function loadState(db: SupabaseClient, requestId: string) {
  return (await latestCheckpoint(db, requestId))?.state ?? null;
}
