import { ActionForm, SubmitButton } from "@/components/forms";
import { checkLatestFiling } from "@/app/(app)/research/actions";
import type { FilingCheck } from "@/lib/research/filingCheck";
import { shortDate } from "@/lib/format";
import { Card, CardHead, Disclose, Pill, SourceRef } from "@/components/ui";

export type StoredFilingCheck = { id: string; computed_at: string; code_version: string; inputs: Record<string, unknown>; outputs: FilingCheck };

const fmt = (v: number | null, unit: string) => (v === null ? "—" : unit === "shares" ? Math.round(v).toLocaleString("en-US") : `$${Math.round(v / 1e6).toLocaleString("en-US")}m`);

/** The stored result of the last SEC filing check, with every finding, source and gap, plus the button to run it again. */
export function FilingCheckCard({ symbol, run }: { symbol: string; run: StoredFilingCheck | null }) {
  const c = run?.outputs;
  const material = c?.findings.filter((f) => f.material) ?? [];
  const other = c?.findings.filter((f) => !f.material) ?? [];
  const missing = c ? [...c.gaps, ...c.refresh.notChecked.filter((x) => !c.gaps.includes(x))] : [];
  return (
    <Card labelledBy="fc-h" className="!gap-3">
      <CardHead id="fc-h" title="Latest SEC filing check" right={c && <Pill small tone={c.status === "CURRENT" ? "neutral" : "warn"}>{c.status}</Pill>} />
      {!c || !run ? (
        <p className="t-sm">Not run yet. The check reads the newest 10-Q or 10-K filed after your research directly from SEC EDGAR and compares it with that research. It never changes the research and never suggests a buy.</p>
      ) : (
        <>
          <p className="t-sm text-ink">{c.statusReason}</p>
          <p className="t-xs">
            Compared with your research of {shortDate(c.researchAsOf)}.{" "}
            {c.document ? <>Read {c.document.form} filed {shortDate(c.document.filed)} (accession {c.document.accession}).</> : "No new report was read."}{" "}
            Run {shortDate(run.computed_at.slice(0, 10))} · {run.code_version} · {c.refresh.rulesVersion}
          </p>
          {material.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="t-xs">Material changes</span>
              <ul className="flex flex-col gap-1 t-sm list-disc pl-5">{material.map((f) => <li key={f.key}>{f.text} <span className="t-xs">· {f.kind}</span></li>)}</ul>
            </div>
          )}
          {c.refresh.priceMove && <p className="t-sm">{c.refresh.priceMove}</p>}
          {c.refresh.triggers.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="t-xs">Refresh rules that fired</span>
              <ul className="flex flex-col gap-1 t-sm list-disc pl-5">{c.refresh.triggers.map((t) => <li key={t.rule}>{t.rule}: {t.evidence} <span className="t-xs">· {t.level.replace("_", " ")}</span></li>)}</ul>
            </div>
          )}
          {other.length > 0 && (
            <Disclose summary={<span className="t-sm">Other facts read · {other.length}</span>}>
              <ul className="flex flex-col gap-1 t-sm list-disc pl-5">{other.map((f) => <li key={f.key}>{f.text} <span className="t-xs">· {f.kind}</span></li>)}</ul>
            </Disclose>
          )}
          {c.facts.length > 0 && (
            <Disclose summary={<span className="t-sm">Figures from the filing&apos;s XBRL · {c.facts.filter((r) => r.now !== null).length} of {c.facts.length}</span>}>
              <div className="overflow-x-auto">
                <table className="t-sm w-full">
                  <thead><tr className="t-xs text-left"><th className="pr-3 font-normal">Item</th><th className="pr-3 font-normal text-right">Before</th><th className="pr-3 font-normal text-right">Now</th><th className="font-normal">XBRL concept</th></tr></thead>
                  <tbody>{c.facts.map((r) => (
                    <tr key={r.key} className="border-t border-line">
                      <td className="pr-3 py-1">{r.label}</td>
                      <td className="pr-3 num text-right whitespace-nowrap">{fmt(r.before, r.unit)}<span className="t-xs block">{r.beforeDate ?? ""}</span></td>
                      <td className="pr-3 num text-right whitespace-nowrap">{fmt(r.now, r.unit)}<span className="t-xs block">{r.nowDate ?? ""}</span></td>
                      <td className="t-xs break-all">{r.concept ?? "not found"}{r.basis ? ` · ${r.basis}` : ""}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </Disclose>
          )}
          {missing.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="t-xs warn">Not checked or not found</span>
              <ul className="flex flex-col gap-1 t-sm list-disc pl-5">{missing.map((g) => <li key={g}>{g}</li>)}</ul>
            </div>
          )}
          {c.diagnostics && c.diagnostics.length > 0 && (
            <Disclose summary={<span className="t-sm">Related share facts in the filing · {c.diagnostics.length}</span>}>
              <ul className="flex flex-col gap-1 t-xs list-disc pl-5 break-all">{c.diagnostics.map((d) => <li key={d}>{d}</li>)}</ul>
            </Disclose>
          )}
          <div className="flex flex-wrap gap-1.5">{c.sources.map((s) => <SourceRef key={s.url} kind="SEC" href={s.url}>{s.what}</SourceRef>)}</div>
          <p className="t-xs">This is a check of reported figures against your research, not a new valuation. Stored as run {run.id.slice(0, 8)}.</p>
        </>
      )}
      <ActionForm action={checkLatestFiling} success="Filing checked" className="flex flex-col gap-2">
        <input type="hidden" name="symbol" value={symbol} />
        <SubmitButton className="btn self-start" pendingText="Reading the filing… (up to a minute)">{c ? "Check again" : "Check latest SEC filing"}</SubmitButton>
      </ActionForm>
    </Card>
  );
}
