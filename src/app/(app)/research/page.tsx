import Link from "next/link";
import { Tag } from "@/components/Tag";
import { ORIGIN_LABEL } from "@/lib/research-labels";
import { getWorkspace } from "@/lib/workspace";
import { researchAgeDays, type ResearchRecord } from "@/lib/research/records";
import { repriceCheck } from "@/lib/research/valuation";
import { isEtf } from "@/lib/portfolio/classify";
import { pctStr } from "@/lib/format";

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

export default async function ResearchPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const sp = await searchParams;
  const ws = await getWorkspace();
  const freshDays = ws.policy?.researchFreshnessDays ?? 120;
  const owned = ws.portfolio.holdings.filter((h) => !isEtf(h.symbol)).sort((a, b) => b.value - a.value);
  const ownedSet = new Set(owned.map((h) => h.symbol));
  const pipeline = ws.research.filter((r) => !ownedSet.has(r.symbol));
  const researched = pipeline.filter((r) => r.current || r.latest);
  const notResearched = pipeline.filter((r) => !r.current && !r.latest);
  const show = sp.show === "all" ? "all" : "researched";
  const list = show === "all" ? pipeline : researched;

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

      <section aria-labelledby="pipe-h" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="pipe-h" className="font-semibold">Opportunity pipeline</h2>
          <nav className="flex gap-1.5 text-sm" aria-label="Filter pipeline">
            <Link href="/research" className={`min-h-9 px-3 inline-flex items-center rounded-full border no-underline ${show === "researched" ? "bg-ink text-ground border-ink" : "border-line-strong text-ink"}`}>Researched ({researched.length})</Link>
            <Link href="/research?show=all" className={`min-h-9 px-3 inline-flex items-center rounded-full border no-underline ${show === "all" ? "bg-ink text-ground border-ink" : "border-line-strong text-ink"}`}>All ({pipeline.length})</Link>
          </nav>
        </div>
        {list.length === 0 ? (
          <p className="text-sm text-muted bg-surface border border-line rounded-xl px-4 py-3">No researched companies outside your holdings yet. {notResearched.length} watchlist names need research, for example {notResearched.slice(0, 4).map((r) => r.symbol).join(", ")}.</p>
        ) : (
          <ul className="bg-surface border border-line rounded-xl divide-y divide-line">
            {list.map((r) => {
              const v = r.current ?? r.latest;
              const c = coverage(r, null, ws.now, freshDays);
              return (
                <li key={r.symbol}>
                  <Link href={`/research/${r.symbol}`} className="flex items-center justify-between gap-3 px-4 py-2.5 no-underline text-ink hover:bg-ground">
                    <span><span className="font-mono font-medium">{r.symbol}</span>{r.name && <span className="text-ink-2 text-sm"> · {r.name}</span>}</span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {v && <span className="text-xs text-muted hidden sm:inline">{ORIGIN_LABEL[v.origin] ?? v.origin}</span>}
                      <Tag tone={v ? c.tone : "neutral"}>{v ? (v.parsed.action ?? c.label) : "Watching · research needed"}</Tag>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <p className="text-xs text-muted">Prices for pipeline names load on each company page.</p>
    </div>
  );
}
