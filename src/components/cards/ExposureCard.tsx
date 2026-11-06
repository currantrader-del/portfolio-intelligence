import type { CompanyExposure } from "@/lib/portfolio/engine";
import type { CompanyLimit } from "@/lib/policy/limits";
import { pctStr } from "@/lib/format";
import { Bar, Cap, LinkRow, Pill } from "@/components/ui";

/**
 * Single-company exposure card (the reference design): one big combined number, the limit on
 * the right with its approval state, a bar, and the direct vs look-through split.
 * Every number comes from the portfolio engine and the policy; nothing is fixed here.
 */
export function ExposureCard({ e, name, limit, conflict }: { e: CompanyExposure; name: string | null; limit?: CompanyLimit; conflict: boolean }) {
  const over = e.total > e.max + 1e-9;
  const near = !over && e.total >= e.max * 0.9;
  const approved = limit?.status === "approved";
  const pill = conflict ? { tone: "warn" as const, text: "Policy review" } : over ? { tone: "alert" as const, text: "Over limit" } : near ? { tone: "warn" as const, text: "Near limit" } : { tone: "neutral" as const, text: "Within limit" };
  const limitNote = conflict ? "Displayed limit · needs verification" : approved ? "Approved maximum" : limit?.hardMax != null ? "Proposed limit · not approved" : "Generic limit";
  return (
    <section className="card" aria-labelledby={`exp-${e.symbol}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <Cap>Single-company exposure</Cap>
          <h2 id={`exp-${e.symbol}`} className="text-[19px] font-semibold truncate">{name ?? e.symbol} {name && <span className="text-muted font-medium">({e.symbol})</span>}</h2>
        </div>
        <Pill tone={pill.tone}>{pill.text}</Pill>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col"><span className={`t-mid ${over ? "loss" : ""}`}>{pctStr(e.total)}</span><span className="t-xs">Combined exposure</span></div>
        <div className="flex flex-col items-end text-right"><span className="t-val text-ink-2">{pctStr(e.max, e.max * 100 % 1 ? 1 : 0)}</span><span className={`t-xs ${conflict ? "warn" : ""}`}>{limitNote}</span></div>
      </div>
      <Bar value={e.total} max={e.max} tone={over ? "loss" : "copper"} label={`${pctStr(e.total)} of a ${pctStr(e.max, 0)} limit`} />
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col"><span className="t-sm num text-ink">{pctStr(e.direct)} direct</span><span className="t-xs">Shares you own</span></div>
        <div className="flex flex-col items-end text-right"><span className="t-sm num text-ink">{pctStr(e.viaEtfs)} via ETFs</span><span className="t-xs">Look-through, approx.</span></div>
      </div>
      <LinkRow href="/policy">{conflict ? "Review limit and underlying policy" : "Review limit and sources"}</LinkRow>
    </section>
  );
}
