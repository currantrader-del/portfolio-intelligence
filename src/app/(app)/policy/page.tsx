import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { Tag } from "@/components/Tag";
import { Card, CardHead, Disclose } from "@/components/ui";
import { RECOMMEND_PREFIX, isRejected, type PolicyRuleRow, type SubjectAudit } from "@/lib/policy/rules";
import { US_EQUITY_FORECASTS } from "@/lib/policy/evidence";
import { addRule, approveRule, confirmImported, rejectRule, saveProfile } from "./actions";
import { createClient } from "@/lib/supabase/server";
import { loadProfile } from "@/lib/profile";

const p = (v: number | string | null | undefined, d = 2) => (v === null || v === undefined ? "—" : `${+(Number(v) * 100).toFixed(d)}%`);
const rng = (lo: number | string | null, hi: number | string | null) => (lo === null || hi === null ? null : `${p(lo)}–${p(hi)}`);

/** One line of numbers for a rule, in plain words. */
function numbers(r: PolicyRuleRow): string {
  if (r.scope === "portfolio" && r.subject === "protected_reserve") return `$${Number(r.value).toLocaleString()} kept in savings, never invested`;
  if (r.scope === "assumption" && r.subject === "benchmark_return") return `U.S. stocks ${rng(r.normal_low, r.normal_high)} a year (middle ${p(r.value, 1)})`;
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
  if (!u) return <Tag>No rule</Tag>;
  if (s.authority === "you") return <Tag tone="accent">You approved {u.approved_at?.slice(0, 10)}</Tag>;
  if (s.authority === "imported") return <Tag>Imported · not confirmed</Tag>;
  if (s.status === "conflict") return <Tag tone="alert">Open decision</Tag>;
  return <Tag tone="warn">Proposed</Tag>;
}

const src = (r: PolicyRuleRow) => `${r.source_label}${r.source_date ? `, ${r.source_date}` : ", undated"}`;
const why = (r: PolicyRuleRow | null) => (r?.approval_note?.startsWith(RECOMMEND_PREFIX) ? r.approval_note.slice(RECOMMEND_PREFIX.length).split(" | ")[0].trim() : null);

function DecisionCard({ s }: { s: SubjectAudit }) {
  const open = s.candidates.filter((c) => c.approval === "unresolved" || c.approval === "proposed");
  const rec = s.recommended;
  return (
    <Card labelledBy={`d-${s.scope}-${s.subject}`}>
      <CardHead id={`d-${s.scope}-${s.subject}`} title={subjectName(s)} right={s.status === "conflict" ? <Tag tone="alert">Conflict</Tag> : <Tag tone="warn">Proposal</Tag>} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted">In control now</dt>
        <dd>{s.used ? <><span className="font-mono">{numbers(s.used)}</span> <span className="text-muted">· {src(s.used)}{s.authority === "strictest" ? " (stricter of the two, used until you decide)" : s.authority === "imported" ? " (imported, never approved by you)" : ""}</span></> : "Nothing"}</dd>
        {open.map((c) => (
          <div key={c.id} className="contents">
            <dt className="text-muted">{c === rec ? "Claude recommends" : "Alternative"}</dt>
            <dd><span className="font-mono">{numbers(c)}</span> <span className="text-muted">· {src(c)}</span></dd>
          </div>
        ))}
      </dl>
      {why(rec) && <p className="text-sm"><span className="font-semibold">Why:</span> {why(rec)}</p>}
      <Disclose summary="Evidence">
        <ul className="list-disc pl-5 text-sm flex flex-col gap-1">
          {s.differences.map((d) => <li key={d}>{d}</li>)}
          {[s.used, ...open].filter((r, i, a): r is PolicyRuleRow => !!r?.conditions && a.findIndex((x) => x?.id === r.id) === i).map((r) => <li key={`c-${r.id}`}><span className="text-muted">{r.source_label}:</span> {r.conditions}</li>)}
          {s.subject === "benchmark_return" && US_EQUITY_FORECASTS.map((f) => <li key={f.url}><a href={f.url} target="_blank" rel="noreferrer">{f.firm}</a>: {f.low === f.high ? p(f.low, 1) : `${p(f.low, 1)}–${p(f.high, 1)}`} a year, {f.horizon}, as of {f.asOf}</li>)}
        </ul>
      </Disclose>
      <div className="flex flex-col gap-2">
        {open.map((c) => (
          <form key={c.id} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="rule_id" value={c.id} />
            <label className="sr-only" htmlFor={`n-${c.id}`}>Note (optional)</label>
            <input id={`n-${c.id}`} name="note" placeholder="Note (optional)" className="flex-1 min-w-36 rounded-lg border border-line-strong bg-ground px-3 min-h-10 text-sm" />
            <button formAction={approveRule} className="btn btn-sm btn-primary">Approve{open.length > 1 ? ` ${c.source_label.split(" (")[0]}` : ""}</button>
            <button formAction={rejectRule} className="btn btn-sm">Reject</button>
          </form>
        ))}
        <p className="text-xs text-muted">Approve makes it the controlling rule; the current one is kept in history. Reject keeps what controls now and records your choice.</p>
      </div>
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
        <h2 id="dec-h" className="h2">{audit.decisions.length ? `${audit.decisions.length} decision${audit.decisions.length > 1 ? "s" : ""} for you` : "Nothing waiting for you"}</h2>
        {audit.decisions.map((s) => <DecisionCard key={`${s.scope}|${s.subject}`} s={s} />)}
        {imported.length > 0 && (
          <Card labelledBy="imp-h">
            <CardHead id="imp-h" title={`${imported.length} imported rules you never confirmed`} right={<Tag>Imported</Tag>} />
            <p className="text-sm">These came from the old archive marked &quot;approved&quot;, but you did not approve them in this app. They control as ceilings meanwhile, and new-cash results stay on wait until you confirm them. To change one instead, use &quot;Change a limit&quot; below.</p>
            <ul className="text-sm flex flex-col divide-y divide-line">
              {imported.map((s) => <li key={`${s.scope}|${s.subject}`} className="py-1.5 flex flex-wrap justify-between gap-x-3"><span>{subjectName(s)}</span><span className="font-mono text-[13px]">{numbers(s.used!)}</span><span className="text-xs text-muted w-full">{src(s.used!)}{s.scope === "generic_company" ? " · applies only as an absolute ceiling, never as a company's own limit" : ""}</span></li>)}
            </ul>
            <form action={confirmImported} className="flex gap-2">
              {imported.map((s) => <input key={s.used!.id} type="hidden" name="rule_id" value={s.used!.id} />)}
              <button className="btn btn-sm btn-primary">Confirm all {imported.length} as my rules</button>
            </form>
          </Card>
        )}
      </section>

      <Card labelledBy="ctl-h">
        <CardHead id="ctl-h" title="Rules in control" />
        <ul className="flex flex-col divide-y divide-line text-sm">
          {[...controlling("portfolio"), ...controlling("company"), ...controlling("generic_company"), ...controlling("assumption")].map((s) => (
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
        <CardHead id="how-h" title="How a buy decision is made" />
        <ol className="list-decimal pl-5 text-sm flex flex-col gap-1.5">
          <li><span className="font-medium">Portfolio limit.</span> Only a company limit you approved gives room, and new cash fills only to the top of the normal range. A company without its own limit gets no new money.</li>
          <li><span className="font-medium">Valuation.</span> The research&apos;s own price zone must allow adding, and its bear/base/bull scenarios at today&apos;s price must beat the top of published U.S. stock forecasts ({p(ws.policy?.benchmark?.high, 1)}) plus a margin that grows with the stock&apos;s own spread of outcomes.</li>
          <li><span className="font-medium">Research is current.</span> Refresh is triggered by events: new results, a financing or share issuance, another material filing, or the price moving into a different action zone of the research. Age alone only prompts a filings check.</li>
        </ol>
        <p className="text-xs text-muted">All three must pass, and they are shown separately on every decision, so a good valuation never hides a missing limit, or the reverse.</p>
      </Card>

      <Disclose summary="Change a limit" className="card">
        <p className="text-sm text-ink-2">Your new rule becomes the controlling one. The previous rule stays in history, with your reason.</p>
        <form action={addRule} className="grid gap-2 sm:grid-cols-2">
          <label className="field">Applies to<select name="scope" className="input"><option value="company">A company</option><option value="bucket">A bucket</option></select></label>
          <label className="field">Ticker or bucket name<input name="subject" required className="input" /></label>
          <label className="field">Normal low %<input name="normal_low" inputMode="decimal" className="input font-mono" /></label>
          <label className="field">Normal high %<input name="normal_high" inputMode="decimal" className="input font-mono" /></label>
          <label className="field">High conviction low %<input name="hc_low" inputMode="decimal" className="input font-mono" /></label>
          <label className="field">High conviction high %<input name="hc_high" inputMode="decimal" className="input font-mono" /></label>
          <label className="field">Maximum %<input name="hard_max" inputMode="decimal" className="input font-mono" /></label>
          <label className="field">Reason (required)<input name="reason" required className="input" /></label>
          <button className="sm:col-span-2 btn btn-primary">Save and approve</button>
        </form>
      </Disclose>

      <Disclose summary={`History and sources (${history.length} earlier versions)`} className="card">
        <ul className="flex flex-col divide-y divide-line">
          {history.map((r) => (
            <li key={r.id} className="py-2 text-sm flex flex-col gap-0.5">
              <div className="flex items-center justify-between gap-2"><span className="font-medium">{subjectName(r)}</span><Tag>{isRejected(r) ? "Rejected" : audit.retired.includes(r) ? "Retired" : "Superseded"}</Tag></div>
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
          <form action={saveProfile} className="flex flex-col gap-2">
            <textarea name="text" defaultValue={profile.text} rows={8} maxLength={3000} className="input py-2 leading-relaxed" />
            <div><button className="btn btn-sm btn-primary">Save</button></div>
          </form>
        </div>
      </Disclose>
    </div>
  );
}
