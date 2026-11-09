import { ActionForm, SubmitButton } from "@/components/forms";
import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { Tag } from "@/components/Tag";
import { Card, CardHead, Disclose } from "@/components/ui";
import { AUTHORITY_LABEL, RECOMMEND_PREFIX, RETIRED_WHY, isRecommended, isRejected, type PolicyRuleRow, type SubjectAudit } from "@/lib/policy/rules";
import { ALTERNATIVES } from "@/lib/policy/evidence";
import { approvalEffect, reviewImported, type ImportReviewItem } from "@/lib/policy/importReview";
import { addRule, approveRule, confirmImported, rejectRule, reviseImported, saveProfile } from "./actions";
import { createClient } from "@/lib/supabase/server";
import { loadProfile } from "@/lib/profile";

const p = (v: number | string | null | undefined, d = 2) => (v === null || v === undefined ? "—" : `${+(Number(v) * 100).toFixed(d)}%`);
const rng = (lo: number | string | null, hi: number | string | null) => (lo === null || hi === null ? null : `${p(lo)}–${p(hi)}`);

/** One line of numbers for a rule, in plain words. */
function numbers(r: PolicyRuleRow): string {
  if (r.scope === "portfolio" && r.subject === "protected_reserve") return `$${Number(r.value).toLocaleString()} kept in savings, never invested`;
  if (r.scope === "assumption" && r.subject === "benchmark_return") return `U.S. stocks ${rng(r.normal_low, r.normal_high)} a year (shown middle ${p(r.value, 1)}: the average of Vanguard's 5.8% midpoint and J.P. Morgan's 7.5%, not the middle of the range)`;
  if (r.scope === "assumption" && r.subject === "risk_margin_factor") return `${Number(r.value)} x each stock's scenario spread`;
  if (r.scope === "assumption") return String(r.value);
  const parts = [rng(r.normal_low, r.normal_high) && `normal ${rng(r.normal_low, r.normal_high)}`, rng(r.high_conviction_low, r.high_conviction_high) && `high conviction ${rng(r.high_conviction_low, r.high_conviction_high)}`, r.hard_max !== null && `max ${p(r.hard_max)}`].filter(Boolean);
  return parts.join(" · ") || "no numbers";
}

const SUBJECT: Record<string, string> = {
  protected_reserve: "Protected savings reserve",
  benchmark_return: "Index return to beat",
  risk_margin_factor: "Extra return for a riskier stock",
  generic: "Any company without its own limit",
};
const subjectName = (s: { scope: string; subject: string }) => SUBJECT[s.subject] ?? s.subject;

function Who({ s }: { s: SubjectAudit }) {
  const u = s.used;
  if (!u) return <Tag>{s.status === "proposed" ? "Nothing in control" : "No rule"}</Tag>;
  if (s.authority === "you") return <Tag tone="accent">Approved by you {u.approved_at?.slice(0, 10)}</Tag>;
  if (s.authority === "imported") return <Tag>Imported · not confirmed</Tag>;
  if (s.authority === "provisional") return <Tag tone="warn">Provisional · not approved</Tag>;
  return <Tag tone="alert">Temporary safety limit</Tag>;
}

const src = (r: PolicyRuleRow) => `${r.source_label}${r.source_date ? `, ${r.source_date}` : ", undated"}`;
const why = (r: PolicyRuleRow | null) => (r?.approval_note?.startsWith(RECOMMEND_PREFIX) ? r.approval_note.slice(RECOMMEND_PREFIX.length).split(" | ")[0].trim() : null);

function DecisionCard({ s }: { s: SubjectAudit }) {
  const open = s.candidates.filter((c) => c.approval === "unresolved" || c.approval === "proposed");
  const rec = s.recommended;
  return (
    <Card labelledBy={`d-${s.scope}-${s.subject}`}>
      <CardHead id={`d-${s.scope}-${s.subject}`} title={subjectName(s)} right={s.status === "conflict" ? <Tag tone="alert">Sources disagree</Tag> : <Tag tone="warn">Proposal · not in effect</Tag>} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted">In control now</dt>
        <dd>{s.used ? <><span className="font-mono">{numbers(s.used)}</span> <span className="text-muted">· {src(s.used)} · {AUTHORITY_LABEL[s.authority]}</span></> : <span className="text-muted">Nothing. A proposal is not in effect until you approve it{s.scope === "company" ? ", so this company gets no new money meanwhile" : ""}.</span>}</dd>
        {open.map((c) => (
          <div key={c.id} className="contents">
            <dt className="text-muted">{isRecommended(c) ? "Proposed · Claude recommends" : "Proposed · alternative"}</dt>
            <dd><span className="font-mono">{numbers(c)}</span> <span className="text-muted">· {src(c)} · not in effect</span></dd>
          </div>
        ))}
      </dl>
      {why(rec) && <p className="text-sm"><span className="font-semibold">Why:</span> {why(rec)}</p>}
      <Disclose summary="Evidence">
        <ul className="list-disc pl-5 text-sm flex flex-col gap-1">
          {s.differences.map((d) => <li key={d}>{d}</li>)}
          {[s.used, ...open].filter((r, i, a): r is PolicyRuleRow => !!r?.conditions && a.findIndex((x) => x?.id === r.id) === i).map((r) => <li key={`c-${r.id}`}><span className="text-muted">{r.source_label}:</span> {r.conditions}</li>)}
        </ul>
      </Disclose>
      <div className="flex flex-col gap-2">
        {open.map((c) => (
          <ActionForm key={c.id} actions={{ approve: approveRule, reject: rejectRule }} successFor={{ approve: "Approved", reject: "Rejected" }} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="rule_id" value={c.id} />
            <label className="sr-only" htmlFor={`n-${c.id}`}>Note (optional)</label>
            <input id={`n-${c.id}`} name="note" placeholder="Note (optional)" className="flex-1 min-w-36 rounded-lg border border-line-strong bg-ground px-3 min-h-11 text-sm" />
            <SubmitButton pendingKey="approve" pendingText="Approving…" className="btn btn-sm btn-primary">Approve{open.length > 1 ? ` ${c.source_label.split(" (")[0]}` : ""}</SubmitButton>
            <SubmitButton pendingKey="reject" pendingText="Rejecting…" className="btn btn-sm">Reject</SubmitButton>
          </ActionForm>
        ))}
        <p className="text-xs text-muted">Approve makes it the controlling rule; the current one is kept in history. Reject keeps what controls now and records your choice.</p>
      </div>
    </Card>
  );
}

const VERDICT: Record<ImportReviewItem["verdict"], { tag: string; tone?: "warn" | "accent" | "alert" }> = {
  retain: { tag: "Retain" },
  interim: { tag: "Keep as interim ceiling", tone: "warn" },
  revise: { tag: "Revise", tone: "alert" },
};

function ImportedReview({ retain, exceptions }: { retain: ImportReviewItem[]; exceptions: ImportReviewItem[] }) {
  const total = retain.length + exceptions.length;
  const interim = exceptions.filter((x) => x.verdict === "interim");
  const revise = exceptions.filter((x) => x.verdict === "revise");
  return (
    <Card labelledBy="imp-h">
      <CardHead id="imp-h" title={`Review of ${total} imported rules`} right={<Tag>Not approved by you</Tag>} />
      <p className="text-sm">These came from the old archive marked &quot;approved&quot;, which is not your approval. I checked each against your current method (beat simply owning VOO, Treasuries or cash; limits from each company&apos;s own research; a range is a guide and a ceiling, never a target). Until you act: a bucket range stays a guideline and its maximum a ceiling; a company with only an imported limit gets no new money.</p>
      <p className="text-sm font-medium">Retain {retain.length}, keep {interim.length} as interim ceilings, revise {revise.length}. Review each one on its own; each says exactly what approving it changes.</p>
      <ul className="flex flex-col gap-3">
        {retain.map((x) => (
          <li key={x.row.id} className="flex flex-col gap-1.5 border-t border-line pt-2.5">
            <div className="flex items-center justify-between gap-2"><span className="font-medium">{subjectName(x)}</span><Tag>Retain</Tag></div>
            <span className="text-sm"><span className="text-muted">Imported guideline:</span> <span className="font-mono text-[13px]">{numbers(x.row)}</span></span>
            <p className="text-xs text-muted">{x.reason}</p>
            <p className="text-xs"><span className="font-medium">If you approve:</span> {approvalEffect(x)}</p>
            <ActionForm action={confirmImported} success="Confirmed" className="flex flex-wrap gap-2">
              <input type="hidden" name="rule_id" value={x.row.id} />
              <SubmitButton className="btn btn-sm btn-primary" pendingText="Approving…">Approve as mine</SubmitButton>
            </ActionForm>
          </li>
        ))}
      </ul>
      <h3 className="text-sm font-semibold mt-1">Exceptions</h3>
      <ul className="flex flex-col gap-3">
        {exceptions.map((x) => (
          <li key={x.row.id} className="flex flex-col gap-1.5 border-t border-line pt-2.5">
            <div className="flex items-center justify-between gap-2"><span className="font-medium">{subjectName(x)}</span><Tag tone={VERDICT[x.verdict].tone}>{VERDICT[x.verdict].tag}</Tag></div>
            <span className="text-sm"><span className="text-muted">Imported, in control now:</span> <span className="font-mono text-[13px]">{numbers(x.row)}</span></span>
            {x.revised && <span className="text-sm"><span className="text-muted">Proposed, not in effect:</span> <span className="font-mono text-[13px]">{numbers({ ...x.row, ...x.revised })}</span></span>}
            <p className="text-xs text-muted">{x.reason}</p>
            {x.revised && <p className="text-xs"><span className="font-medium">If you approve the revision:</span> {approvalEffect(x, true)}</p>}
            <p className="text-xs"><span className="font-medium">If you {x.revised ? "keep the imported rule" : "confirm it"}:</span> {approvalEffect(x)}</p>
            <ActionForm actions={{ revise: reviseImported, keep: confirmImported }} successFor={{ revise: "Revision approved", keep: "Confirmed" }} className="flex flex-wrap gap-2">
              <input type="hidden" name="rule_id" value={x.row.id} />
              {x.revised ? (
                <>
                  <SubmitButton pendingKey="revise" pendingText="Approving…" className="btn btn-sm btn-primary">Approve revision</SubmitButton>
                  <SubmitButton pendingKey="keep" pendingText="Confirming…" className="btn btn-sm">Keep the imported rule instead</SubmitButton>
                </>
              ) : (
                <SubmitButton pendingKey="keep" pendingText="Confirming…" className="btn btn-sm btn-primary">Confirm as interim ceiling</SubmitButton>
              )}
            </ActionForm>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">Leaving any of these alone changes nothing. Every earlier version stays in history.</p>
    </Card>
  );
}

export default async function PolicyPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const sp = await searchParams;
  const [ws, profile] = await Promise.all([getWorkspace(), createClient().then(loadProfile)]);
  const audit = ws.policy?.audit;
  if (!audit) {
    return <section className="card"><h1 className="h1">Policy</h1><p className="text-ink-2 mt-2">No versioned rules loaded yet.</p></section>;
  }
  const controlling = (scope: string) => audit.subjects.filter((s) => s.scope === scope && s.used);
  const imported = audit.imported;
  const history = [...audit.subjects.flatMap((s) => s.history), ...audit.retired].sort((a, b) => a.subject.localeCompare(b.subject));
  const saved = sp.saved?.split(":");

  return (
    <div className="flex flex-col gap-5 max-w-3xl">
      <div>
        <Link href="/portfolio" className="text-sm no-underline max-lg:hidden">← Portfolio</Link>
        <h1 className="h1 mt-1">Policy</h1>
        <p className="text-muted text-sm">What controls your decisions, what needs your call, and why. Nothing is ever deleted: older versions stay in history with their sources.</p>
      </div>
      {saved && <p className="rounded-xl bg-accent-soft px-4 py-2 text-sm">{saved[0] === "profile" ? "Saved. Every AI answer, research and plan now reads your updated profile." : saved[0] === "approved" ? `Approved. ${saved[1]} now uses the rule you chose.` : saved[0] === "rejected" ? `Rejected. ${saved[1]} keeps the rule that was in control.` : `Confirmed ${saved[1]} imported rules as yours.`}</p>}

      <section aria-labelledby="dec-h" className="flex flex-col gap-3">
        <h2 id="dec-h" className="h2">{audit.decisions.length + (imported.length ? 1 : 0) ? "For your review" : "Nothing waiting for you"}</h2>
        {audit.decisions.map((s) => <DecisionCard key={`${s.scope}|${s.subject}`} s={s} />)}
        {imported.length > 0 && <ImportedReview {...reviewImported(audit, (sym) => ws.portfolio.exposures.find((e) => e.symbol === sym)?.total ?? null)} />}
      </section>

      <Card labelledBy="ctl-h">
        <CardHead id="ctl-h" title="Rules in control" />
        <ul className="flex flex-col divide-y divide-line text-sm">
          {[...controlling("portfolio"), ...controlling("company"), ...controlling("generic_company")].map((s) => (
            <li key={`${s.scope}|${s.subject}`} className="py-2 flex flex-col gap-0.5">
              <div className="flex items-center justify-between gap-2"><span className="font-medium">{subjectName(s)}</span><Who s={s} /></div>
              <span className="font-mono text-[13px]">{s.scope === "generic_company" ? `no new money; ${p(s.used!.hard_max)} only as an absolute ceiling` : numbers(s.used!)}</span>
              <span className="text-xs text-muted">{src(s.used!)}</span>
            </li>
          ))}
        </ul>
        <Disclose summary={`Allocation buckets (${controlling("bucket").length})`}>
          <ul className="flex flex-col divide-y divide-line text-sm">
            {controlling("bucket").map((s) => (
              <li key={s.subject} className="py-1.5 flex flex-wrap items-center justify-between gap-x-3"><span>{s.subject}</span><span className="font-mono text-[13px]">{numbers(s.used!)}</span><Who s={s} /></li>
            ))}
          </ul>
        </Disclose>
      </Card>

      <Card labelledBy="how-h">
        <CardHead id="how-h" title="How a recommendation is made" />
        <ol className="list-decimal pl-5 text-sm flex flex-col gap-1.5">
          <li><span className="font-medium">Portfolio limit.</span> Only a company limit you approved gives room; a company without one gets no new money. Ranges are guidelines and ceilings, never targets: new money never takes a stock above the top of its normal range (or its high-conviction range, when you approved it and its conditions are met), and being below a range is never a reason to buy.</li>
          <li><span className="font-medium">Valuation against the alternatives.</span> The research&apos;s own price zone must allow adding. Its scenarios at today&apos;s price are compared with VOO&apos;s published forecasts (each shown separately, never averaged), a Treasury for the same horizon, the odds of a loss, the spread of outcomes and concentration. A 2-4 year stock case and a 10-15 year forecast are not like for like, so that comparison is shown as context, not a pass/fail. No fixed hurdle or premium.</li>
          <li><span className="font-medium">Research is current.</span> Refresh is triggered by events: new results, a financing or share issuance, another material filing, or the price moving into a different action zone of the research. Age alone only prompts a filings check.</li>
        </ol>
        <p className="text-xs text-muted">The three are assessed and shown separately. The app always gives its best recommendation on the evidence. A dollar amount is &quot;ready to execute&quot; only when the money is verified, your holdings are confirmed and nothing material is unresolved; otherwise it is conditional. The protected savings reserve is never invested, and keeping cash is always an option.</p>
        <Disclose summary="The alternatives and their published forecasts">
          <ul className="text-sm flex flex-col gap-2">
            {ALTERNATIVES.map((alt) => (
              <li key={alt.symbol} className="flex flex-col gap-1">
                <span className="font-medium">{alt.label}</span>
                <span className="text-xs text-muted">{alt.note}</span>
                <ul className="list-disc pl-5 flex flex-col gap-1">
                  {alt.forecasts.map((f) => (
                    <li key={`${f.firm}-${f.asset}`}><a href={f.url} target="_blank" rel="noreferrer">{f.firm}</a>, {f.asset}: <span className="font-mono">{f.kind === "range" ? `${p(f.low, 1)}–${p(f.high, 1)}` : p(f.low, 1)}</span> a year over {f.horizonYears[0] === f.horizonYears[1] ? f.horizonYears[0] : f.horizonYears.join("–")} years, as of {f.asOf}. <span className="text-xs text-muted">{f.method}</span></li>
                  ))}
                </ul>
              </li>
            ))}
            <li className="flex flex-col gap-1"><span className="font-medium">Treasuries (no stock risk)</span><span className="text-xs text-muted">{ws.yields.y2 && ws.yields.y10 ? `2-year ${ws.yields.y2.value.toFixed(2)}%, 10-year ${ws.yields.y10.value.toFixed(2)}% (FRED, ${ws.yields.y10.date}). Each stock is compared with the yield interpolated to its research horizon.` : "Yields not loaded yet."}</span></li>
          </ul>
        </Disclose>
      </Card>

      <Disclose summary="Change a limit" className="card">
        <p className="text-sm text-ink-2">Your new rule becomes the controlling one. The previous rule stays in history, with your reason.</p>
        <ActionForm action={addRule} success="New limit approved" className="grid gap-2 sm:grid-cols-2">
          <label className="field">Applies to<select name="scope" className="input"><option value="company">A company</option><option value="bucket">A bucket</option></select></label>
          <label className="field">Ticker or bucket name<input name="subject" required className="input" /></label>
          <label className="field">Normal low %<input name="normal_low" inputMode="decimal" className="input font-mono" /></label>
          <label className="field">Normal high %<input name="normal_high" inputMode="decimal" className="input font-mono" /></label>
          <label className="field">High conviction low %<input name="hc_low" inputMode="decimal" className="input font-mono" /></label>
          <label className="field">High conviction high %<input name="hc_high" inputMode="decimal" className="input font-mono" /></label>
          <label className="field">Maximum %<input name="hard_max" inputMode="decimal" className="input font-mono" /></label>
          <label className="field">Reason (required)<input name="reason" required className="input" /></label>
          <SubmitButton className="sm:col-span-2 btn btn-primary">Save and approve</SubmitButton>
        </ActionForm>
      </Disclose>

      <Disclose summary={`History and sources (${history.length} earlier versions)`} className="card">
        <ul className="flex flex-col divide-y divide-line">
          {history.map((r) => (
            <li key={r.id} className="py-2 text-sm flex flex-col gap-0.5">
              <div className="flex items-center justify-between gap-2"><span className="font-medium">{subjectName(r)}</span><Tag>{isRejected(r) ? "Rejected" : audit.retired.includes(r) ? "Retired" : "Superseded"}</Tag></div>
              {audit.retired.includes(r) && RETIRED_WHY[r.subject] && <span className="text-xs">{RETIRED_WHY[r.subject]}</span>}
              <span className="font-mono text-[13px]">{numbers(r)}</span>
              <span className="text-xs text-muted">{src(r)} · source said: {r.source_status.replace(/_/g, " ")}</span>
              {r.approval_note && <span className="text-xs text-muted">{r.approval_note}</span>}
            </li>
          ))}
        </ul>
      </Disclose>

      <Disclose summary="About you and your goals" className="card">
        <div id="profile" className="flex flex-col gap-2">
          <p className="text-sm text-muted">In your own words. The assistant, research and plan read this every time.{profile.updatedAt ? ` Last changed ${profile.updatedAt.slice(0, 10)}.` : ""}</p>
          <ActionForm action={saveProfile} success="Profile saved" className="flex flex-col gap-2">
            <textarea name="text" defaultValue={profile.text} rows={8} maxLength={3000} className="input py-2 leading-relaxed" />
            <div><SubmitButton className="btn btn-sm btn-primary">Save</SubmitButton></div>
          </ActionForm>
        </div>
      </Disclose>
    </div>
  );
}
