import { Tag } from "@/components/Tag";
import { shortDate, usd } from "@/lib/format";
import { STAGES, type ScreenResult, type CheckStatus } from "@/lib/research/screen";
import type { ResearchRecord } from "@/lib/research/records";
import { researchAgeDays } from "@/lib/research/records";
import { repriceCheck } from "@/lib/research/valuation";
import { runScreen, setStage } from "@/app/(app)/research/actions";

const STATUS: Record<CheckStatus, { label: string; tone: "accent" | "warn" | "alert" | "neutral" }> = {
  pass: { label: "OK", tone: "accent" },
  watch: { label: "Watch", tone: "warn" },
  fail: { label: "Weak", tone: "alert" },
  unknown: { label: "Unknown", tone: "neutral" },
  info: { label: "Note", tone: "neutral" },
};
const VERDICT_TONE = { "Worth researching": "accent", Mixed: "warn", "Weak on screen": "alert", "Not enough data": "neutral" } as const;

/** What the app knows about a company and what to do next: stage, research status and screen. */
export function ResearchSummary({ r, held, price, now, freshDays, error }: { r: ResearchRecord; held: boolean; price: number | null; now: Date; freshDays: number; error?: string }) {
  const v = r.current ?? r.latest;
  const age = researchAgeDays(r, now);
  const check = v ? repriceCheck(v.parsed, price, age, freshDays) : null;
  const research = !v
    ? { label: "Not researched", tone: "neutral" as const, detail: "No research on file." }
    : r.conflict
      ? { label: "Conflict review", tone: "alert" as const, detail: `${r.versions} dated records disagree and none is marked current.` }
      : check?.ok
        ? { label: v.completeness === "complete" ? "Full research" : "Incomplete archive", tone: v.completeness === "complete" ? ("accent" as const) : ("warn" as const), detail: `Dated ${shortDate(v.research_as_of)}, ${age} days old.` }
        : { label: "Refresh required", tone: "warn" as const, detail: `Dated ${shortDate(v.research_as_of)}. ${check?.reason ?? ""}` };
  const stage = held ? "owned" : r.pipeline.stage === "owned" ? "researching" : r.pipeline.stage;
  const stageLabel = STAGES.find((s) => s.key === stage)?.label ?? stage;
  const sc = r.pipeline.screen as ScreenResult | null;

  const next: string[] = [];
  if (!sc) next.push("Run the screen to check the basics from SEC data.");
  else if (sc.verdict === "Weak on screen" && !held) next.push("The screen is weak: consider passing, or note why it is still worth research.");
  if (!v) next.push(sc?.verdict === "Worth researching" ? "Start full research (business, moat, financials, valuation, risks)." : "Research is needed before this can be compared for new money.");
  else if (research.label !== "Full research") next.push("Refresh the research before relying on its price ranges.");
  else if (stage === "researching") next.push("Research is current: you can mark it Ready for decision.");

  return (
    <section aria-labelledby="sum-h" className="bg-surface border border-line rounded-2xl p-5 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="sum-h" className="font-semibold mr-1">Research status</h2>
        <Tag tone={stage === "passed" ? "neutral" : "accent"}>{stageLabel}</Tag>
        <Tag tone={research.tone}>{research.label}</Tag>
        {sc && <Tag tone={VERDICT_TONE[sc.verdict]}>Screen: {sc.verdict}</Tag>}
      </div>
      {error && <p className="rounded-lg bg-warn-bg text-warn-ink px-3 py-2 text-sm">{error}</p>}

      <dl className="grid gap-3 sm:grid-cols-3 text-sm">
        <div><dt className="text-muted">Research</dt><dd>{research.detail}</dd>{v?.parsed.action && <dd className="text-xs text-muted">Last research decision: {v.parsed.action}</dd>}</div>
        <div><dt className="text-muted">Stage</dt><dd>{stageLabel}{r.pipeline.stageUpdatedAt ? ` since ${shortDate(r.pipeline.stageUpdatedAt)}` : ""}</dd>{r.pipeline.note && <dd className="text-xs text-muted">{r.pipeline.note}</dd>}</div>
        <div><dt className="text-muted">Screen</dt><dd>{sc ? `${sc.verdict}, ${shortDate(r.pipeline.screenedAt)}` : "Not run yet"}</dd>{sc?.price != null && <dd className="text-xs text-muted">At {usd(sc.price, 2)} · SEC data through {sc.dataThrough ? shortDate(sc.dataThrough) : "—"}</dd>}</div>
      </dl>

      {next.length > 0 && (
        <div className="text-sm"><span className="font-medium">Next: </span>{next.join(" ")}</div>
      )}

      {sc && (
        <details className="border border-line rounded-lg" open={!v}>
          <summary className="cursor-pointer px-4 py-3 min-h-11 font-medium text-sm">Screen checks ({sc.checks.filter((c) => c.status === "pass").length} of {sc.checks.filter((c) => c.status !== "info").length} OK)</summary>
          <ul className="flex flex-col divide-y divide-line text-sm px-4 pb-3">
            {sc.checks.map((c) => (
              <li key={c.key} className="py-2 grid grid-cols-[1fr_auto] gap-x-3">
                <span className="font-medium">{c.label}</span>
                <span className="flex items-center gap-2 justify-end"><span className="font-mono">{c.value}</span><Tag tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Tag></span>
                <span className="text-xs text-muted col-span-2">{c.detail}</span>
              </li>
            ))}
          </ul>
          {sc.toVerify.length > 0 && (
            <div className="px-4 pb-4 text-sm">
              <div className="font-medium mb-1">To verify in research</div>
              <ul className="list-disc pl-5 flex flex-col gap-0.5">{sc.toVerify.map((t) => <li key={t}>{t}</li>)}</ul>
            </div>
          )}
          <p className="px-4 pb-3 text-xs text-muted">Screening defaults, not your policy: revenue growth 10%+, positive operating profit and free cash flow, debt below cash, share count up no more than 2%, price to sales up to 10×. A screen decides what to research; it is never a buy signal.</p>
        </details>
      )}

      <div className="flex flex-wrap gap-3 items-end">
        <form action={runScreen}>
          <input type="hidden" name="symbol" value={r.symbol} />
          <button className="min-h-10 px-4 rounded-lg border border-line-strong font-medium text-sm">{sc ? "Screen again" : "Run screen"}</button>
        </form>
        {!held && (
          <form action={setStage} className="flex flex-wrap gap-2 items-end">
            <input type="hidden" name="symbol" value={r.symbol} />
            <label className="text-sm flex flex-col gap-1">Move to
              <select name="stage" defaultValue={stage} className="rounded-lg border border-line-strong bg-ground px-3 min-h-10">
                {STAGES.filter((s) => s.key !== "owned").map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
            <label className="text-sm flex flex-col gap-1">Note (needed to pass)<input name="note" maxLength={500} className="rounded-lg border border-line-strong bg-ground px-3 min-h-10 w-56" /></label>
            <button className="min-h-10 px-4 rounded-lg bg-ink text-ground font-medium text-sm">Save stage</button>
          </form>
        )}
      </div>
    </section>
  );
}
