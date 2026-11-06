import Link from "next/link";
import { Tag } from "@/components/Tag";
import { ORIGIN_LABEL } from "@/lib/research-labels";
import { getWorkspace } from "@/lib/workspace";
import { researchAgeDays, type ResearchRecord } from "@/lib/research/records";
import { repriceCheck } from "@/lib/research/valuation";
import { isEtf } from "@/lib/portfolio/classify";
import { pctStr, shortDate } from "@/lib/format";
import { STAGES, type Stage } from "@/lib/research/screen";
import { addToPipeline } from "./actions";

type Coverage = { label: string; tone: "accent" | "warn" | "alert" | "neutral"; detail: string };

function coverage(r: ResearchRecord | undefined, price: number | null, now: Date, freshDays: number): Coverage {
  if (!r || (!r.current && !r.latest)) return { label: "Not researched", tone: "neutral", detail: "No research on file" };
  if (r.conflict) return { label: "Conflict review", tone: "alert", detail: `${r.versions} dated records, none marked current` };
  const v = r.current!;
  const kind = v.completeness === "complete" ? "Full research" : "Incomplete archive";
  const check = repriceCheck(v.parsed, price, researchAgeDays(r, now), freshDays);
  return check.ok
    ? { label: kind, tone: v.completeness === "complete" ? "accent" : "warn", detail: `${kind} · current` }
    : { label: "Refresh required", tone: "warn", detail: `${kind} · ${check.reason}` };
}

const PIPE_STAGES = STAGES.filter((s) => s.key !== "owned");
type PipeStage = Exclude<Stage, "owned">;
const VERDICT_TONE = { "Worth researching": "accent", Mixed: "warn", "Weak on screen": "alert", "Not enough data": "neutral" } as const;

export default async function ResearchPage({ searchParams }: { searchParams: Promise<{ stage?: string }> }) {
  const sp = await searchParams;
  const ws = await getWorkspace();
  const freshDays = ws.policy?.researchFreshnessDays ?? 120;
  const owned = ws.portfolio.holdings.filter((h) => !isEtf(h.symbol)).sort((a, b) => b.value - a.value);
  const ownedSet = new Set(owned.map((h) => h.symbol));
  const pipeline = ws.research.filter((r) => !ownedSet.has(r.symbol));
  const byStage = Object.fromEntries(PIPE_STAGES.map((s) => [s.key, [] as ResearchRecord[]])) as Record<PipeStage, ResearchRecord[]>;
  for (const r of pipeline) {
    // A company is only "owned" while it is in the holdings; otherwise it returns to research.
    const st: PipeStage = r.pipeline.stage === "owned" ? "researching" : (r.pipeline.stage as PipeStage);
    (byStage[st] ?? byStage.idea).push(r);
  }
  const want = sp.stage as PipeStage | undefined;
  const stage: PipeStage = want && byStage[want] ? want : (["ready", "researching", "screening", "idea"] as PipeStage[]).find((k) => byStage[k].length) ?? "idea";

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-serif text-2xl sm:text-3xl font-semibold">Research</h1>
        <p className="text-muted text-sm">Your positions first. Every conclusion keeps its date and source.</p>
      </div>

      <section aria-labelledby="own-h" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 id="own-h" className="font-semibold">Owned positions</h2>
          <span className="text-xs text-muted">{owned.length} stocks · largest first</span>
        </div>
        <ul className="grid gap-2 sm:grid-cols-2">
          {owned.map((h) => {
            const r = ws.research.find((x) => x.symbol === h.symbol);
            const c = coverage(r, h.price, ws.now, freshDays);
            const v = r?.current ?? r?.latest;
            const exp = ws.portfolio.exposures.find((e) => e.symbol === h.symbol);
            return (
              <li key={h.symbol}>
                <Link href={`/research/${h.symbol}`} className="block bg-surface border border-line rounded-xl px-4 py-3 no-underline text-ink hover:border-line-strong">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold"><span className="font-mono">{h.symbol}</span>{r?.name ? <span className="font-normal text-ink-2"> · {r.name}</span> : null}</span>
                    {v?.parsed.classification && <Tag>{v.parsed.classification}</Tag>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-xs">
                    <Tag tone={c.tone}>{c.label}</Tag>
                    {v && <span className="text-muted">{v.research_as_of}</span>}
                    <span className="text-muted">· {exp ? pctStr(exp.total) : pctStr(h.weight)} of portfolio</span>
                  </div>
                  <div className="text-sm mt-1.5">{v?.parsed.action ? <>Last decision: <span className="font-medium">{v.parsed.action}</span></> : <span className="text-muted">No research decision on file</span>}</div>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="pipe-h" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="pipe-h" className="font-semibold">Research pipeline</h2>
          <span className="text-xs text-muted">Idea → Screening → Researching → Ready for decision</span>
        </div>
        <form action={addToPipeline} className="flex flex-wrap gap-2 items-end bg-surface border border-line rounded-xl p-3">
          <label className="text-sm flex flex-col gap-1">Ticker<input name="symbol" required maxLength={10} placeholder="e.g. MSFT" className="rounded-lg border border-line-strong bg-ground px-3 min-h-10 w-28 font-mono uppercase" /></label>
          <label className="text-sm flex flex-col gap-1 flex-1 min-w-40">Why it is interesting (optional)<input name="note" maxLength={300} className="rounded-lg border border-line-strong bg-ground px-3 min-h-10" /></label>
          <button className="min-h-10 px-4 rounded-lg bg-ink text-ground font-medium">Add idea</button>
        </form>
        <nav className="flex flex-wrap gap-1.5 text-sm" aria-label="Pipeline stage">
          {PIPE_STAGES.map((st) => (
            <Link key={st.key} href={`/research?stage=${st.key}`} aria-current={stage === st.key ? "page" : undefined} className={`min-h-9 px-3 inline-flex items-center rounded-full border no-underline ${stage === st.key ? "bg-ink text-ground border-ink" : "border-line-strong text-ink"}`}>{st.label} ({byStage[st.key].length})</Link>
          ))}
        </nav>
        <p className="text-xs text-muted -mt-1">{PIPE_STAGES.find((x) => x.key === stage)?.hint}</p>
        {byStage[stage].length === 0 ? (
          <p className="text-sm text-muted bg-surface border border-line rounded-xl px-4 py-3">Nothing at this stage.</p>
        ) : (
          <ul className="bg-surface border border-line rounded-xl divide-y divide-line">
            {byStage[stage].map((r) => {
              const v = r.current ?? r.latest;
              const c = coverage(r, null, ws.now, freshDays);
              const sc = r.pipeline.screen;
              return (
                <li key={r.symbol}>
                  <Link href={`/research/${r.symbol}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 no-underline text-ink hover:bg-ground">
                    <span className="min-w-0"><span className="font-mono font-medium">{r.symbol}</span>{r.name && <span className="text-ink-2 text-sm"> · {r.name}</span>}
                      {r.pipeline.note && <span className="block text-xs text-muted truncate">{r.pipeline.note}</span>}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 shrink-0 text-xs">
                      {sc ? <Tag tone={VERDICT_TONE[sc.verdict]}>{sc.verdict}</Tag> : <Tag>Not screened</Tag>}
                      {sc && <span className="text-muted">{shortDate(r.pipeline.screenedAt)}</span>}
                      {v && <Tag tone={c.tone}>{c.label}</Tag>}
                      {v && <span className="text-muted hidden sm:inline">{ORIGIN_LABEL[v.origin] ?? v.origin}</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <p className="text-xs text-muted">The screen checks growth, profit, cash flow, debt, dilution and price to sales from SEC data. It decides what is worth researching; it never makes a buy call.</p>
    </div>
  );
}
