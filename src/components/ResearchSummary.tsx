import { shortDate, usd } from "@/lib/format";
import { STAGES, type ScreenResult, type CheckStatus } from "@/lib/research/screen";
import type { ResearchRecord } from "@/lib/research/records";
import { runScreen, setStage } from "@/app/(app)/research/actions";
import { coverage } from "@/lib/research/status";
import { Card, CardHead, Disclose, Pill } from "@/components/ui";

const STATUS: Record<CheckStatus, { label: string; tone: "gain" | "warn" | "neutral" }> = {
  pass: { label: "OK", tone: "gain" },
  watch: { label: "Watch", tone: "warn" },
  fail: { label: "Weak", tone: "warn" },
  unknown: { label: "Unknown", tone: "neutral" },
  info: { label: "Note", tone: "neutral" },
};
const VERDICT_TONE = { "Worth researching": "gain", Mixed: "warn", "Weak on screen": "warn", "Not enough data": "neutral" } as const;

/** Where the company is in the research pipeline, its first-pass screen, and what to do next. */
export function ResearchSummary({ r, held, price, now, freshDays, error }: { r: ResearchRecord; held: boolean; price: number | null; now: Date; freshDays: number; error?: string }) {
  const v = r.current ?? r.latest;
  const cov = coverage(r, price, now, freshDays);
  const stage = held ? "owned" : r.pipeline.stage === "owned" ? "researching" : r.pipeline.stage;
  const stageLabel = STAGES.find((s) => s.key === stage)?.label ?? stage;
  const sc = r.pipeline.screen as ScreenResult | null;

  const next: string[] = [];
  if (!sc) next.push("Run the screen to check the basics from SEC data.");
  else if (sc.verdict === "Weak on screen" && !held) next.push("The screen is weak: consider passing, or note why it is still worth research.");
  if (!v) next.push(sc?.verdict === "Worth researching" ? "Start full research (business, moat, financials, valuation, risks)." : "Research is needed before this can be compared for new money.");
  else if (cov.key !== "current") next.push("Refresh the research before relying on its price ranges.");
  else if (stage === "researching") next.push("Research is current: you can mark it Ready for decision.");

  return (
    <Card labelledBy="sum-h">
      <CardHead id="sum-h" title="Pipeline and screen" right={<Pill tone={stage === "passed" ? "neutral" : "copper"}>{stageLabel}</Pill>} />
      {error && <p role="alert" className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2">{error}</p>}
      <div className="flex flex-col gap-1.5 t-sm">
        <div className="flex justify-between gap-3"><span>Stage</span><span className="text-ink text-right">{stageLabel}{r.pipeline.stageUpdatedAt ? <span className="t-xs"> · since {shortDate(r.pipeline.stageUpdatedAt)}</span> : null}</span></div>
        <div className="flex justify-between gap-3"><span>Screen</span><span className="text-right">{sc ? <Pill small tone={VERDICT_TONE[sc.verdict]}>{sc.verdict}</Pill> : <span className="text-ink">Not run yet</span>}</span></div>
        {r.pipeline.note && <p className="t-xs">{r.pipeline.note}</p>}
      </div>
      {next.length > 0 && <p className="t-sm"><span className="text-ink font-semibold">Next: </span>{next.join(" ")}</p>}

      {sc && (
        <div className="border-t border-line">
          <Disclose summary={`Screen checks · ${sc.checks.filter((c) => c.status === "pass").length} of ${sc.checks.filter((c) => c.status !== "info").length} OK`} open={!v}>
            <ul className="flex flex-col">
              {sc.checks.map((c) => (
                <li key={c.key} className="py-2 border-t border-line first:border-t-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
                  <span className="t-sm text-ink">{c.label}</span>
                  <span className="flex items-center gap-2 justify-end"><span className="t-sm num">{c.value}</span><Pill small tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Pill></span>
                  <span className="t-xs col-span-2">{c.detail}</span>
                </li>
              ))}
            </ul>
            {sc.toVerify.length > 0 && (
              <div className="t-sm"><div className="text-ink font-semibold mb-1">To verify in research</div><ul className="list-disc pl-5 flex flex-col gap-0.5">{sc.toVerify.map((t) => <li key={t}>{t}</li>)}</ul></div>
            )}
            <p className="t-xs">At {sc.price != null ? usd(sc.price, 2) : "—"} · SEC data through {sc.dataThrough ? shortDate(sc.dataThrough) : "—"} · screened {shortDate(r.pipeline.screenedAt)}. Screening defaults, not your policy: revenue growth 10%+, positive operating profit and free cash flow, debt below cash, share count up no more than 2%, price to sales up to 10×. A screen decides what to research; it is never a buy signal.</p>
          </Disclose>
        </div>
      )}

      <div className="flex flex-col gap-2.5 border-t border-line pt-3">
        <form action={runScreen}>
          <input type="hidden" name="symbol" value={r.symbol} />
          <button className="btn btn-sm">{sc ? "Screen again" : "Run screen"}</button>
        </form>
        {!held && (
          <form action={setStage} className="flex flex-col gap-2">
            <input type="hidden" name="symbol" value={r.symbol} />
            <div className="grid grid-cols-2 gap-2">
              <label className="field">Move to
                <select name="stage" defaultValue={stage} className="input">
                  {STAGES.filter((s) => s.key !== "owned").map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </label>
              <label className="field">Note (needed to pass)<input name="note" maxLength={500} className="input" /></label>
            </div>
            <button className="btn btn-sm self-start">Save stage</button>
          </form>
        )}
      </div>
    </Card>
  );
}
