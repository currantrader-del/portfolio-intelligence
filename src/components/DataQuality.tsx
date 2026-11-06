import Link from "next/link";
import type { PortfolioView } from "@/lib/portfolio/engine";
import { Tag } from "./Tag";

/** The banner every money figure sits under: estimated vs verified, why, and what is missing. */
export function DataQuality({ p, compact = false }: { p: PortfolioView; compact?: boolean }) {
  const q = p.quality;
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm flex flex-col gap-1 ${q.status === "verified" ? "border-accent/30 bg-accent-soft" : "border-warn-ink/30 bg-warn-bg text-warn-ink"}`}>
      <div className="flex flex-wrap items-center gap-2 font-medium">
        <Tag tone={q.status === "verified" ? "accent" : "warn"}>{q.status === "verified" ? "VERIFIED" : "ESTIMATED"}</Tag>
        {q.headline}
      </div>
      {!compact && q.reasons.map((r) => <span key={r}>{r}</span>)}
      {!compact && q.missing.length > 0 && <span>Missing: {q.missing.join("; ")}.</span>}
      <Link href="/portfolio/reconcile" className="self-start text-current">Reconcile holdings and cash →</Link>
    </div>
  );
}
