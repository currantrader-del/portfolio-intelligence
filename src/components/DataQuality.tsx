import Link from "next/link";
import type { PortfolioView } from "@/lib/portfolio/engine";
import { DataLabel } from "./ui";
import { DataQualityNote } from "./cards/DataQuality";

/** The note every money figure sits under: estimated vs verified, why, and what is missing. */
export function DataQuality({ p, compact = false }: { p: PortfolioView; compact?: boolean }) {
  const q = p.quality;
  return (
    <section className="card card-tight" aria-label="Data quality">
      <div className="flex items-center justify-between gap-3">
        <span className="t-sm text-ink">{q.headline}</span>
        <DataLabel kind={q.status === "verified" ? "verified" : "estimated"} />
      </div>
      {compact ? <Link href="/portfolio/reconcile" className="t-xs no-underline">Reconcile holdings and cash</Link> : <DataQualityNote p={p} />}
    </section>
  );
}
