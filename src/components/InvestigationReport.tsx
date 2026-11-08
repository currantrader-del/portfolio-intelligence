import { ActionForm, SubmitButton } from "@/components/forms";
import { Markdown } from "@/components/Markdown";
import { Card, CardHead, Disclose, Pill } from "@/components/ui";
import { shortDate } from "@/lib/format";
import { adoptResearch, setAsideResearch } from "@/app/(app)/research/actions";
import type { ConsistencyCheck, Conflict, Finding, InvestmentSummary, Objection, Question, ReviewVerdict } from "@/lib/research/investigate/types";
import type { ScenarioSpec, ValuationResult } from "@/lib/research/investigate/valuationCalc";
import type { ValidationReport } from "@/lib/research/validate";

export type InvVersion = {
  id: string; research_as_of: string; completeness: string; origin: string; is_current: boolean; conclusion: Record<string, unknown>;
  research_phases: { phase_number: number; title: string | null; body_markdown: string | null; details?: Record<string, unknown> | null }[];
};
export type SourceRow = { title: string; url: string | null; document_date: string | null; details: Record<string, unknown> };

const STATUS_LABEL: Record<string, string> = {
  fully_reviewed: "Read in full", partially_reviewed: "Partly read", retrieved: "Downloaded, not read", unavailable: "Unavailable",
  search_result_only: "Search snippet only", reviewed_earlier: "Read in earlier research", excerpt_read: "Excerpt read", search_result_or_app_data: "Search result or app data",
};
const CHECK_LABEL: Record<string, string> = {
  verified: "Quote and figure found in document", xbrl: "SEC XBRL", quote_found_value_not_in_quote: "Figure not in quote", quote_not_found: "Quote not found",
  secondary_unverifiable: "Secondary source", calculation: "Calculation", estimate: "Estimate", document_unreadable: "Document unreadable",
};
const CLASS_LABEL: Record<string, string> = {
  verified_primary: "Verified from a primary document", labeled_estimate: "Labeled estimate or assumption", unresolved_not_material: "Unresolved, not material", unresolved_thesis_changing: "Unresolved, could change the thesis",
};
const VERDICT: Record<string, string> = { survives: "survives", survives_with_changes: "survives with changes", fails: "does not survive" };
const usd = (n: number | null | undefined, d = 2) => (n === null || n === undefined ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d })}`);
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`);

/** The concise investment summary from an investigation, with the full evidence underneath. */
export function InvestigationReport({ symbol, v, sources, inUse, validation }: { symbol: string; v: InvVersion; sources: SourceRow[]; inUse?: { research_as_of: string; label: string } | null; validation?: ValidationReport | null }) {
  const c = v.conclusion;
  const sm = c.investment_summary as InvestmentSummary | null | undefined;
  const ev = (c.evidence ?? {}) as { findings?: Finding[]; questions?: Question[]; conflicts?: Conflict[]; objections?: Objection[]; valuation?: { specs: ScenarioSpec[]; result: ValuationResult; revenue_basis: string } | null; phases?: { n: number; title: string; status: string; gate: string[]; attempts: number; cost_usd: number; ms: number }[];
    review?: ReviewVerdict | null; draft?: { action: string | null; confidence: string | null; weighted_value: number | null; annualized_return: number | null } | null;
    stress?: { label: string; weighted_value: number | null; annualized_return: number | null; note: string }[]; consistency?: ConsistencyCheck | null };
  const completion = c.completion as { complete: boolean; reasons: string[]; kind?: string } | undefined;
  const adoption = c.adoption as { mode?: string; open_items?: string[] } | undefined;
  const usage = c.usage as { cost_usd: number; runtime_ms: number; calls: number; searches: number; by_model: Record<string, { calls: number; costUsd: number }>; input_tokens: number; output_tokens: number } | undefined;
  const state = String(c.review_state ?? "");
  const type = c.research_type === "material_event_refresh" ? "Material-event refresh" : "Full investigation";
  const docs = sources.filter((s) => s.details?.doc_id);
  const snippets = sources.filter((s) => s.details?.review_status === "search_result_only");
  const count = (st: string) => docs.filter((d) => d.details.review_status === st).length;
  const findings = ev.findings ?? [];
  const keyF = findings.filter((f) => f.key && !f.withdrawn);
  const withdrawn = findings.filter((f) => f.withdrawn);
  const val = ev.valuation;

  if (state === "running") {
    return (
      <Card labelledBy={`inv-${v.id}`} className="!gap-2">
        <CardHead id={`inv-${v.id}`} title={`${type} · in progress`} right={<Pill small tone="copper" dot="hollow">In progress</Pill>} />
        <p className="t-sm">Started {shortDate(v.research_as_of)}. Phase checkpoints appear below as each one is saved.</p>
        <Phases v={v} />
      </Card>
    );
  }

  return (
    <Card labelledBy={`inv-${v.id}`} className="!gap-3">
      <CardHead id={`inv-${v.id}`} title={`${type} · ${shortDate(v.research_as_of)}`} right={
        <>
          <Pill small tone={v.completeness === "complete" ? "gain" : "warn"}>{v.completeness === "complete" ? "Complete" : completion?.kind === "material_uncertainty" ? "Incomplete: material uncertainty" : "Incomplete"}</Pill>
          {v.is_current ? <Pill small tone={state === "adopted_provisional" ? "warn" : "gain"} dot="solid">{state === "adopted_provisional" ? "In use, provisional" : "In use"}</Pill> : state === "awaiting_approval" ? <Pill small tone="copper">Awaiting your decision</Pill> : state === "set_aside" ? <Pill small>Set aside</Pill> : null}
        </>
      } />
      {sm ? (
        <>
          <p className="text-ink font-semibold leading-snug">{sm.headline}</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 t-sm">
            <Field k="Action" v={sm.action} strong />
            <Field k="Confidence" v={sm.confidence} />
            <Field k="Business quality" v={`${sm.business_quality?.rating ?? "—"}: ${sm.business_quality?.why ?? ""}`} wide />
            <Field k="Valuation" v={sm.valuation} wide />
            <Field k="Expected return" v={sm.expected_return} wide />
            <Field k="Portfolio fit" v={sm.portfolio_fit} wide />
          </div>
          <List title="Why" items={sm.reasons} />
          <List title="Main risks" items={sm.risks} />
          <List title="What would change the conclusion" items={sm.would_change} />
          {sm.changes_vs_prior && <p className="t-sm"><span className="t-xs block">Versus the earlier research</span>{sm.changes_vs_prior}</p>}
        </>
      ) : <p className="t-sm warn">No investment summary was produced.</p>}
      {completion && !completion.complete && (
        <div className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2 flex flex-col gap-1">
          <span className="font-semibold">Not complete: {completion.reasons.length} item{completion.reasons.length === 1 ? "" : "s"} could not be closed</span>
          <ul className="list-disc pl-4">{completion.reasons.slice(0, 12).map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      )}
      {state === "adopted_provisional" && v.is_current && (
        <p className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2">Approved provisionally by you with {adoption?.open_items?.length ?? completion?.reasons.length ?? 0} open item{(adoption?.open_items?.length ?? 0) === 1 ? "" : "s"}. The app suggests no new money for {symbol} until a refresh resolves them.</p>
      )}
      {state === "awaiting_approval" && !v.is_current && (
        <div className="flex flex-col gap-2 rounded-[12px] border border-line px-3 py-2.5">
          <span className="text-ink font-semibold t-sm">Your decision</span>
          <span className="t-xs">Nothing changes until you choose. Approving makes this the research your decisions use; {inUse ? `the research in use now (${shortDate(inUse.research_as_of)}, ${inUse.label}) stays on file unchanged` : "there is no research in use now"}. Keeping your current research leaves this investigation on file, marked as set aside.</span>
          <span className="t-xs"><b className="text-ink">Approving the research does not approve its recommendation.</b> {c.action ? `“${String(c.action)}” stays a suggestion; ` : ""}no shares are bought or sold, and any trade is a separate decision you make on Decisions.</span>
          {validation && <ValidationBox r={validation} />}
          <ActionForm action={adoptResearch} success={v.completeness === "complete" ? "Approved: this research is now in use" : "Approved provisionally"} className="flex flex-col gap-1.5">
            <input type="hidden" name="symbol" value={symbol} />
            <input type="hidden" name="versionId" value={v.id} />
            {v.completeness === "complete" ? (
              <SubmitButton className="btn btn-primary self-start" pendingText="Approving…">Approve as my research</SubmitButton>
            ) : (
              <>
                <label className="t-sm flex items-start gap-2"><input type="checkbox" name="acknowledge" value="yes" required className="mt-1" />
                  <span>I have read the {completion?.reasons.length ?? 0} open item{completion?.reasons.length === 1 ? "" : "s"} above. Approve provisionally: they stay listed on the record, and the app suggests no new money for {symbol} until a refresh resolves them.</span></label>
                <SubmitButton className="btn self-start" pendingText="Approving…">Approve provisionally</SubmitButton>
              </>
            )}
          </ActionForm>
          <ActionForm action={setAsideResearch} success="Kept your current research" className="flex">
            <input type="hidden" name="symbol" value={symbol} />
            <input type="hidden" name="versionId" value={v.id} />
            <SubmitButton className="btn btn-sm" pendingText="Saving…">{inUse ? "Keep my current research" : "Set this aside"}</SubmitButton>
          </ActionForm>
        </div>
      )}

      <div className="flex flex-col rounded-[12px] border border-line px-3">
        <Disclose summary={<span className="t-sm">Documents · {count("fully_reviewed")} read in full, {count("partially_reviewed")} partly, {count("unavailable")} unavailable{snippets.length ? `, ${snippets.length} search snippets (not counted as reviewed)` : ""}</span>}>
          <div className="flex flex-col gap-2 t-sm">
            {docs.map((d, i) => (
              <div key={i} className="flex flex-col gap-0.5 border-b border-line pb-2 last:border-b-0">
                <span className="text-ink">{d.url ? <a href={d.url} target="_blank" rel="noreferrer" className="underline">{d.title}</a> : d.title}</span>
                <span className="t-xs">
                  <strong>{STATUS_LABEL[String(d.details.review_status)] ?? String(d.details.review_status)}</strong>
                  {d.details.required ? " · required" : ""}{d.details.chars ? ` · ${Number(d.details.chars).toLocaleString("en-US")} characters` : ""}
                  {Array.isArray(d.details.sections) && (d.details.sections as { label: string; read: string; material: boolean }[]).length > 1 ? ` · sections read: ${(d.details.sections as { label: string; read: string; material: boolean }[]).filter((x) => x.material).map((x) => `${x.label.split(".")[0]} ${x.read}`).join(", ")}` : ""}
                  {d.details.unavailable_reason ? ` · ${String(d.details.unavailable_reason)}` : ""}
                </span>
              </div>
            ))}
          </div>
        </Disclose>
        <Disclose summary={<span className="t-sm">Key numbers · {keyF.filter((f) => f.check.status === "verified" || f.check.status === "xbrl").length} of {keyF.length} verified against primary sources{classCounts(keyF)}</span>}>
          <div className="flex flex-col gap-1.5 t-sm">
            {[...keyF, ...findings.filter((f) => !f.key && !f.withdrawn), ...withdrawn].map((f, i) => (
              <div key={`${f.id}-${i}`} className={`flex flex-col ${f.withdrawn ? "opacity-60" : ""}`}>
                <span className="text-ink">{f.id} · {f.claim}{f.value ? `: ${f.value} ${f.unit}` : ""} <span className="t-xs">({f.period})</span></span>
                <span className={`t-xs ${f.check.status.startsWith("quote") ? "warn" : ""}`}>{CHECK_LABEL[f.check.status] ?? f.check.status}{f.doc_id ? ` · ${f.doc_id}` : ""}{f.key ? " · key" : ""}{f.withdrawn ? ` · withdrawn: ${f.withdrawn.reason}${f.withdrawn.replaced_by ? ` (see ${f.withdrawn.replaced_by})` : ""}` : ""}{f.quote && f.source === "primary" ? ` · “${f.quote.slice(0, 160)}${f.quote.length > 160 ? "…" : ""}”` : ""}</span>
                {f.classification && <span className={`t-xs ${f.classification.cls === "unresolved_thesis_changing" ? "warn" : ""}`}><strong>{CLASS_LABEL[f.classification.cls]}</strong>{f.classification.replaced_by ? ` (${f.classification.replaced_by})` : ""}: {f.classification.explanation} Effect: {f.classification.impact}</span>}
              </div>
            ))}
          </div>
        </Disclose>
        {val && (
          <Disclose summary={<span className="t-sm">Valuation · computed by the app: {usd(val.result.weighted_value)} weighted, {pct(val.result.annualized_return)} a year</span>}>
            <div className="flex flex-col gap-2 t-sm">
              <span className="t-xs">Horizon {val.result.horizon_date} ({val.result.years} years) · revenue basis {val.revenue_basis} · price {usd(val.result.price)}</span>
              {val.result.scenarios.map((sc) => {
                const spec = val.specs.find((x) => x.name === sc.name);
                return (
                  <div key={sc.name} className="flex flex-col gap-0.5 border-b border-line pb-2 last:border-b-0">
                    <span className="text-ink font-semibold capitalize">{sc.name} · {pct(sc.probability)} · {usd(sc.value_per_share)} ({sc.method}){sc.floored ? " · floor applied" : ""}</span>
                    {sc.steps.map((st, i) => <span key={i} className="t-xs num">{st.label}: {st.formula} = {Math.abs(st.value) > 1e5 ? usd(st.value, 0) : st.value.toFixed(2)}</span>)}
                    {spec && <span className="t-xs">Inputs from: {Object.entries(spec.sources ?? {}).map(([k, s]) => `${k} ${s}`).join("; ")}</span>}
                    {spec?.rationale && <span className="t-xs">{spec.rationale}</span>}
                  </div>
                );
              })}
              {val.result.comparisons.map((x) => <span key={x.scenario} className="t-xs">vs reported: {x.scenario}: {x.text}</span>)}
              {val.result.errors.length > 0 && <span className="t-xs warn">Errors: {val.result.errors.join("; ")}</span>}
            </div>
          </Disclose>
        )}
        <Disclose summary={<span className="t-sm">Questions · {(ev.questions ?? []).filter((q) => q.status === "resolved").length} resolved, {(ev.questions ?? []).filter((q) => q.status !== "resolved").length} not</span>}>
          <div className="flex flex-col gap-1.5 t-sm">
            {(ev.questions ?? []).map((q) => (
              <div key={q.id} className="flex flex-col">
                <span className="text-ink">{q.id} ({q.materiality}) {q.question}</span>
                <span className={`t-xs ${q.status !== "resolved" ? "warn" : ""}`}>{q.status}{q.answer ? `: ${q.answer}` : ""}{q.why_unresolvable ? ` · why not: ${q.why_unresolvable}` : ""}{q.could_change_conclusion ? " · could change the conclusion" : ""}</span>
              </div>
            ))}
          </div>
        </Disclose>
        {(ev.conflicts ?? []).length > 0 && (
          <Disclose summary={<span className="t-sm">Conflicting evidence · {(ev.conflicts ?? []).length}</span>}>
            <div className="flex flex-col gap-1.5 t-sm">{(ev.conflicts ?? []).map((x) => <div key={x.id}><span className="text-ink">{x.id} {x.description}</span><span className="t-xs block">{x.status}: {x.resolution}</span></div>)}</div>
          </Disclose>
        )}
        <Disclose summary={<span className="t-sm">Skeptical review · {ev.review ? `recommendation ${VERDICT[ev.review.recommendation]}, ${(ev.objections ?? []).length} tested challenges` : (ev.objections ?? []).length ? `${(ev.objections ?? []).length} objections (untested, earlier engine)` : "none recorded"}</span>}>
          <div className="flex flex-col gap-2 t-sm">
            {ev.review && (
              <div className="flex flex-col gap-0.5">
                <span className="text-ink">Thesis {VERDICT[ev.review.thesis]} · valuation {VERDICT[ev.review.valuation]} · recommendation {VERDICT[ev.review.recommendation]}</span>
                <span className="t-xs">{ev.review.summary}</span>
                {ev.review.required_changes.length > 0 && <ul className="t-xs list-disc pl-4">{ev.review.required_changes.map((x, i) => <li key={i}>{x}</li>)}</ul>}
                {ev.draft && <span className="t-xs">Before the review: {ev.draft.action ?? "—"} ({ev.draft.confidence ?? "—"}), {usd(ev.draft.weighted_value)} weighted. After: {sm?.action ?? "—"} ({sm?.confidence ?? "—"}), {usd(val?.result.weighted_value)} weighted{ev.draft.action === sm?.action ? "; the action survived" : "; the action changed"}.</span>}
              </div>
            )}
            {(ev.objections ?? []).map((o) => (
              <div key={o.id} className="flex flex-col border-t border-line pt-1.5">
                <span className="text-ink">{o.id} [{o.severity}{o.area ? `, ${o.area.replace(/_/g, " ")}` : ""}] {o.objection}</span>
                {o.claim && <span className="t-xs">Challenged: {o.claim}</span>}
                {o.test && <span className="t-xs">Test ({o.test_kind?.replace("_", " ")}): {o.test} → {o.test_result}</span>}
                <span className={`t-xs ${o.outcome ? "" : "warn"}`}>{o.outcome ? `Answer, ${o.outcome.replace("_", " ")}: ${o.response}` : "Not answered"}</span>
              </div>
            ))}
          </div>
        </Disclose>
        {(ev.stress ?? []).length > 0 && (
          <Disclose summary={<span className="t-sm">Sensitivity · computed by the app</span>}>
            <div className="flex flex-col gap-1 t-sm">
              {(ev.stress ?? []).map((x, i) => <span key={i} className="t-xs"><span className="text-ink">{x.label}</span>: {x.weighted_value !== null ? `${usd(x.weighted_value)} weighted, ` : ""}{pct(x.annualized_return)} a year{x.label.startsWith("Skeptic:") ? "" : ` · ${x.note}`}</span>)}
            </div>
          </Disclose>
        )}
        {ev.consistency && (
          <Disclose summary={<span className={`t-sm ${ev.consistency.ok ? "" : "warn"}`}>Conclusion checked against the numbers · {ev.consistency.ok ? "consistent" : `${ev.consistency.issues.length} problem${ev.consistency.issues.length === 1 ? "" : "s"}`}</span>}>
            <div className="flex flex-col gap-1 t-sm">{ev.consistency.checks.map((x, i) => <span key={i} className={`t-xs ${x.ok ? "" : "warn"}`}><span className="text-ink">{x.ok ? "✓" : "✕"} {x.label}</span>: {x.detail}</span>)}</div>
          </Disclose>
        )}
        <Disclose summary={<span className="t-sm">Phase checkpoints</span>}><Phases v={v} /></Disclose>
        {usage && (
          <Disclose summary={<span className="t-sm">Run · {Math.round(usage.runtime_ms / 60000)} min · ${usage.cost_usd.toFixed(2)}</span>}>
            <div className="flex flex-col gap-1 t-xs">
              <span>{usage.calls} model calls, {usage.searches} web searches, {usage.input_tokens.toLocaleString("en-US")} input and {usage.output_tokens.toLocaleString("en-US")} output tokens.</span>
              {Object.entries(usage.by_model ?? {}).map(([m, x]) => <span key={m}>{m}: {x.calls} calls, ${x.costUsd.toFixed(2)}</span>)}
              {(ev.phases ?? []).map((p) => <span key={p.n}>Phase {p.n}: {p.status}, {p.attempts} step{p.attempts === 1 ? "" : "s"}, ${p.cost_usd.toFixed(2)}</span>)}
            </div>
          </Disclose>
        )}
      </div>
    </Card>
  );
}

function Phases({ v }: { v: InvVersion }) {
  const ps = [...(v.research_phases ?? [])].sort((a, b) => a.phase_number - b.phase_number);
  if (!ps.length) return <p className="t-sm">No checkpoints yet.</p>;
  return (
    <div className="flex flex-col">
      {ps.map((p) => {
        const st = String(p.details?.status ?? "");
        return (
          <Disclose key={p.phase_number} summary={<span className="t-sm">Phase {p.phase_number}{p.title ? ` · ${p.title}` : ""} <span className={`t-xs ${st === "incomplete" ? "warn" : ""}`}>· {st.replace("_", " ") || "saved"}</span></span>}>
            <div className="t-sm max-h-[520px] overflow-auto"><Markdown text={p.body_markdown ?? ""} /></div>
          </Disclose>
        );
      })}
    </div>
  );
}

function classCounts(keyF: Finding[]) {
  const n = (c: string) => keyF.filter((f) => f.classification?.cls === c).length;
  const est = n("labeled_estimate"), nm = n("unresolved_not_material"), tc = n("unresolved_thesis_changing");
  const parts = [est ? `${est} labeled estimates` : "", nm ? `${nm} unresolved, not material` : "", tc ? `${tc} could change the thesis` : ""].filter(Boolean);
  return parts.length ? `; ${parts.join(", ")}` : "";
}

function Field({ k, v, strong, wide }: { k: string; v: string | null | undefined; strong?: boolean; wide?: boolean }) {
  return <div className={`min-w-0 ${wide ? "col-span-2" : ""}`}><span className="t-xs block">{k}</span><span className={`text-ink ${strong ? "font-semibold" : ""}`}>{v || "—"}</span></div>;
}
function List({ title, items }: { title: string; items: string[] | undefined }) {
  if (!items?.length) return null;
  return <div className="t-sm"><span className="t-xs block">{title}</span><ul className="list-disc pl-4">{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>;
}

const CHECK_TONE: Record<string, "gain" | "warn" | "alert"> = { pass: "gain", warn: "warn", fail: "alert" };
const VERDICT_TEXT: Record<string, string> = { passes: "Passes", passes_with_caveats: "Passes with caveats", does_not_pass: "Does not pass" };

/** The code-only check of the record (arithmetic, documents, Q&A, sensitivity, bridges), shown before you decide. */
function ValidationBox({ r }: { r: ValidationReport }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[12px] bg-surface-2 px-3 py-2">
      <span className="t-sm text-ink font-semibold flex items-center gap-2">Checked by the app before you decide <Pill small tone={r.verdict === "passes" ? "gain" : r.verdict === "does_not_pass" ? "alert" : "warn"}>{VERDICT_TEXT[r.verdict] ?? r.verdict}</Pill></span>
      <span className="t-xs">Re-checked from the saved evidence by code, without re-running the research or any paid AI. {shortDate(r.at.slice(0, 10))}.</span>
      <ul className="flex flex-col gap-1 t-sm">
        {r.checks.map((c) => (
          <li key={c.key} className="flex items-start gap-2"><Pill small tone={CHECK_TONE[c.status]}>{c.status === "pass" ? "OK" : c.status === "warn" ? "Caveat" : "Problem"}</Pill><span><span className="text-ink">{c.label}.</span> {c.detail}</span></li>
        ))}
      </ul>
      {r.notes.length > 0 && (
        <div className="flex flex-col gap-1 t-sm"><span className="text-ink font-semibold">Reviewer notes</span>{r.notes.map((n, i) => <p key={i}>{n}</p>)}</div>
      )}
      {r.sensitivity.length > 0 && (
        <Disclose summary={<span className="t-sm">What moves the value (one change at a time)</span>}>
          <table className="t-sm w-full"><tbody>
            {r.sensitivity.map((s, i) => <tr key={i} className="border-b border-line last:border-b-0"><td className="py-1 pr-2">{s.label}</td><td className="py-1 pr-2 text-right tabular-nums">{usd(s.weighted)}</td><td className="py-1 pr-2 text-right tabular-nums">{s.delta >= 0 ? "+" : ""}{s.delta.toFixed(2)}</td><td className="py-1 text-right tabular-nums">{pct(s.annualized)}/yr</td></tr>)}
          </tbody></table>
        </Disclose>
      )}
      {r.bridges.map((b, i) => (
        <Disclose key={i} summary={<span className="t-sm">{b.title}</span>}>
          <table className="t-sm w-full"><tbody>
            {b.steps.map((s, j) => <tr key={j} className="border-b border-line last:border-b-0"><td className={`py-1 pr-2 ${s.label.startsWith("  ") ? "pl-4 t-xs" : ""}`}>{s.label.trim()}</td><td className="py-1 text-right tabular-nums">{s.delta >= 0 ? "+" : ""}{s.delta.toFixed(2)}</td></tr>)}
          </tbody></table>
          <p className="t-xs pt-1">{b.note}</p>
        </Disclose>
      ))}
    </div>
  );
}
