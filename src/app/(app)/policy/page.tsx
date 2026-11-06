import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { Tag } from "@/components/Tag";
import type { PolicyRuleRow, SubjectAudit } from "@/lib/policy/rules";
import { addRule, approveRule } from "./actions";

const p = (v: number | string | null) => (v === null || v === undefined ? "—" : `${+(Number(v) * 100).toFixed(2)}%`);
const rng = (lo: number | string | null, hi: number | string | null) => (lo === null || hi === null ? "—" : `${p(lo)}–${p(hi)}`);
const STATUS = {
  approved: { tone: "accent", label: "Approved" },
  conflict: { tone: "alert", label: "Conflict" },
  proposed: { tone: "warn", label: "Placeholder" },
  none: { tone: "neutral", label: "No rule" },
} as const;

function RuleLine({ r }: { r: PolicyRuleRow }) {
  return (
    <div className="text-sm">
      <div className="font-medium">{r.source_label} <span className="text-muted font-normal">· {r.source_date ?? "undated"} · source says {r.source_status.replace(/_/g, " ")}</span></div>
      {r.scope === "assumption" || r.scope === "portfolio"
        ? <div className="font-mono">{r.subject === "research_freshness_days" || r.scope === "portfolio" ? Number(r.value).toLocaleString() : p(r.value)}</div>
        : <div className="font-mono text-[13px]">normal {rng(r.normal_low, r.normal_high)} · high conviction {rng(r.high_conviction_low, r.high_conviction_high)} · max {p(r.hard_max)}</div>}
      {r.conditions && <div className="text-xs text-ink-2 mt-0.5">{r.conditions}</div>}
      {r.approval_note && <div className="text-xs text-muted mt-0.5">{r.approval_note}</div>}
    </div>
  );
}

function ConflictCard({ s }: { s: SubjectAudit }) {
  return (
    <div className="bg-surface border border-alert-ink/40 rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold"><span className="font-mono">{s.subject}</span> limits disagree</h3>
        <Tag tone="alert">Your choice needed</Tag>
      </div>
      <ul className="text-sm text-ink-2 list-disc pl-5">{s.differences.map((d) => <li key={d}>{d}</li>)}</ul>
      <p className="text-sm">{s.provisional
        ? <>Until you approve one, the app uses the provisional {p(s.used?.hard_max ?? null)} maximum from {s.used?.source_label} as you instructed. It is not approved, so new-cash recommendations stay on wait for this company.</>
        : <>Until you choose, the app uses the stricter one ({p(s.used?.hard_max ?? null)} maximum) and will not size purchases above it. It did not assume the larger limit is approved.</>}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {s.candidates.map((r) => (
          <form key={r.id} action={approveRule} className="border border-line rounded-xl p-3 flex flex-col gap-2">
            <input type="hidden" name="rule_id" value={r.id} />
            <RuleLine r={r} />
            <label className="text-xs text-muted" htmlFor={`note-${r.id}`}>Why (optional)</label>
            <input id={`note-${r.id}`} name="note" className="rounded-lg border border-line-strong bg-ground px-3 min-h-10 text-sm" />
            <button className="min-h-10 px-3 rounded-lg bg-ink text-ground text-sm font-medium">Make this the approved rule</button>
          </form>
        ))}
      </div>
    </div>
  );
}

export default async function PolicyPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const sp = await searchParams;
  const ws = await getWorkspace();
  const audit = ws.policy?.audit;
  if (!audit) {
    return <section className="bg-surface border border-line rounded-2xl p-6"><h1 className="h1">Policy</h1><p className="text-ink-2 mt-2">No versioned rules loaded yet.</p></section>;
  }
  const by = (scope: string) => audit.subjects.filter((s) => s.scope === scope);
  const assumptionRows = by("assumption");
  const history = audit.subjects.flatMap((s) => s.history);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/portfolio" className="text-sm no-underline max-lg:hidden">← Portfolio</Link>
        <h1 className="h1 mt-1">Investment policy</h1>
        <p className="text-muted text-sm">Every limit from every version of your policy and research, with its source and status. Nothing is deleted; changes supersede.</p>
      </div>
      {sp.saved && <p className="rounded-xl bg-accent-soft px-4 py-2 text-sm">Saved. {sp.saved} now uses the rule you approved.</p>}

      <section aria-labelledby="c-h" className="flex flex-col gap-3">
        <h2 id="c-h" className="text-lg font-semibold">{audit.conflicts.length ? `${audit.conflicts.length} unresolved conflict${audit.conflicts.length > 1 ? "s" : ""}` : "No unresolved conflicts"}</h2>
        {audit.conflicts.map((s) => <ConflictCard key={s.subject} s={s} />)}
      </section>

      <section aria-labelledby="a-h" className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-3">
        <h2 id="a-h" className="font-semibold">Decision assumptions</h2>
        <p className="text-sm text-ink-2">The new-cash engine will not call a result actionable while these are app placeholders.</p>
        <ul className="flex flex-col divide-y divide-line">
          {assumptionRows.map((s) => (
            <li key={s.subject} className="py-2.5 flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2"><span className="font-medium">{LABELS[s.subject] ?? s.subject}</span><Tag tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Tag></div>
              {s.used && <RuleLine r={s.used} />}
              <form action={addRule} className="flex flex-wrap gap-2 items-center">
                <input type="hidden" name="scope" value="assumption" /><input type="hidden" name="subject" value={s.subject} />
                <label className="sr-only" htmlFor={`v-${s.subject}`}>New value</label>
                <input id={`v-${s.subject}`} name="value" placeholder={s.subject === "research_freshness_days" ? "days" : "%"} inputMode="decimal" className="w-24 rounded-lg border border-line-strong bg-ground px-3 min-h-10 font-mono text-sm" />
                <label className="sr-only" htmlFor={`r-${s.subject}`}>Reason</label>
                <input id={`r-${s.subject}`} name="reason" placeholder="Why this number" className="flex-1 min-w-40 rounded-lg border border-line-strong bg-ground px-3 min-h-10 text-sm" />
                <button className="min-h-10 px-3 rounded-lg border border-line-strong text-sm font-medium">{s.status === "approved" ? "Change" : "Set my value"}</button>
                {s.status === "proposed" && s.used && <button formAction={approveRule} name="rule_id" value={s.used.id} className="min-h-10 px-3 rounded-lg border border-line-strong text-sm">Keep the placeholder</button>}
              </form>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="co-h" className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-2">
        <h2 id="co-h" className="font-semibold">Company limits in use</h2>
        <p className="text-xs text-muted">Percent of investable capital, including ETF look-through. The protected reserve is excluded.</p>
        <ul className="flex flex-col divide-y divide-line">
          {[...by("company"), ...by("generic_company")].map((s) => (
            <li key={s.subject} className="py-2.5 flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2"><span className="font-mono font-medium">{s.subject === "generic" ? "Any other company" : s.subject}</span><Tag tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Tag></div>
              {s.used && <RuleLine r={s.used} />}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="b-h" className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-2">
        <h2 id="b-h" className="font-semibold">Allocation buckets in use</h2>
        <ul className="flex flex-col divide-y divide-line">
          {by("bucket").map((s) => (
            <li key={s.subject} className="py-2.5 flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2"><span className="font-medium">{s.subject}</span><Tag tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Tag></div>
              {s.used && <RuleLine r={s.used} />}
            </li>
          ))}
          {by("portfolio").map((s) => (
            <li key={s.subject} className="py-2.5 flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2"><span className="font-medium">Protected savings reserve</span><Tag tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Tag></div>
              {s.used && <RuleLine r={s.used} />}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="n-h" className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-3">
        <h2 id="n-h" className="font-semibold">Change a limit</h2>
        <p className="text-sm text-ink-2">Your new rule becomes the approved one. The previous rule is kept as superseded, with your reason.</p>
        <form action={addRule} className="grid gap-2 sm:grid-cols-2">
          <label className="text-sm flex flex-col gap-1">Applies to
            <select name="scope" className="rounded-lg border border-line-strong bg-ground px-3 min-h-10"><option value="company">A company</option><option value="bucket">A bucket</option></select>
          </label>
          <label className="text-sm flex flex-col gap-1">Ticker or bucket name<input name="subject" required className="rounded-lg border border-line-strong bg-ground px-3 min-h-10" /></label>
          <label className="text-sm flex flex-col gap-1">Normal range low %<input name="normal_low" inputMode="decimal" className="rounded-lg border border-line-strong bg-ground px-3 min-h-10 font-mono" /></label>
          <label className="text-sm flex flex-col gap-1">Normal range high %<input name="normal_high" inputMode="decimal" className="rounded-lg border border-line-strong bg-ground px-3 min-h-10 font-mono" /></label>
          <label className="text-sm flex flex-col gap-1">High conviction low %<input name="hc_low" inputMode="decimal" className="rounded-lg border border-line-strong bg-ground px-3 min-h-10 font-mono" /></label>
          <label className="text-sm flex flex-col gap-1">High conviction high %<input name="hc_high" inputMode="decimal" className="rounded-lg border border-line-strong bg-ground px-3 min-h-10 font-mono" /></label>
          <label className="text-sm flex flex-col gap-1">Maximum %<input name="hard_max" inputMode="decimal" className="rounded-lg border border-line-strong bg-ground px-3 min-h-10 font-mono" /></label>
          <label className="text-sm flex flex-col gap-1">Reason (required)<input name="reason" required className="rounded-lg border border-line-strong bg-ground px-3 min-h-10" /></label>
          <button className="sm:col-span-2 min-h-11 px-4 rounded-lg bg-ink text-ground font-medium">Save and approve</button>
        </form>
      </section>

      <details className="bg-surface border border-line rounded-2xl p-5">
        <summary className="font-semibold cursor-pointer">Superseded rules ({history.length})</summary>
        <ul className="flex flex-col divide-y divide-line mt-2">
          {history.map((r) => (
            <li key={r.id} className="py-2"><div className="font-mono text-sm font-medium">{r.subject}</div><RuleLine r={r} /></li>
          ))}
        </ul>
      </details>
    </div>
  );
}

const LABELS: Record<string, string> = {
  etf_expected_return: "ETF expected annual return",
  hurdle_over_etf: "Hurdle a stock must beat the ETF by",
  research_freshness_days: "Research freshness limit (days)",
};
