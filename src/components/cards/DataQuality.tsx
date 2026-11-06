import Link from "next/link";
import type { PortfolioView } from "@/lib/portfolio/engine";
import { Disclose } from "@/components/ui";

/** Why the money figures are estimated, and what would verify them. Collapsed by default. */
export function DataQualityNote({ p, open }: { p: PortfolioView; open?: boolean }) {
  const q = p.quality;
  const n = q.reasons.length + q.missing.length;
  return (
    <div className="border-t border-line -mb-2">
      <Disclose open={open} summary={<span className="t-sm">{q.status === "verified" ? "Verified holdings" : "Why this is estimated"}{n ? <span className="t-xs"> · {n} note{n > 1 ? "s" : ""}</span> : null}</span>}>
        <p className="t-sm">{q.headline}.</p>
        {q.reasons.length > 0 && <ul className="flex flex-col gap-1 t-sm list-disc pl-4">{q.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        {q.missing.length > 0 && <div className="t-sm"><span className="text-ink">Missing:</span> {q.missing.join("; ")}.</div>}
        <Link href="/portfolio/reconcile" className="btn btn-sm self-start">Reconcile holdings and cash</Link>
      </Disclose>
    </div>
  );
}
