import type { OutdatedVerdict } from "@/lib/freshness/outdated";
import { Disclose } from "@/components/ui";

/**
 * Shown above a saved analysis whose inputs changed after it was written. The analysis itself stays
 * exactly as written (it is the historical record); this says why it is no longer the current view.
 */
export function OutdatedNotice({ v, what, action }: { v: OutdatedVerdict; what: string; action?: React.ReactNode }) {
  if (!v.outdated) return null;
  const n = v.changes.length + v.contradictions.length;
  return (
    <div role="status" className="rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2.5 flex flex-col gap-1.5">
      <p className="t-sm font-semibold">{v.headline}</p>
      <p className="t-xs">Kept below as it was written. Don&apos;t act on its recommendations until the {what} is rewritten with today&apos;s facts.</p>
      {v.contradictions.map((c) => <p key={c} className="t-xs">{c}</p>)}
      {v.changes.length > 0 && (
        <Disclose summary={<span className="t-xs">What changed since · {n}</span>}>
          <ul className="flex flex-col gap-0.5 t-xs list-disc pl-4">{v.changes.map((c) => <li key={`${c.kind}${c.label}${c.at}`}>{c.label} ({new Date(c.at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })})</li>)}</ul>
        </Disclose>
      )}
      {action}
    </div>
  );
}
