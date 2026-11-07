import { Suspense } from "react";
import Link from "next/link";
import { ResearchSummary } from "@/components/ResearchSummary";
import { addToPipeline } from "../actions";
import { FeedSkeleton, FilingsList, FundamentalsCard, LinesSkeleton, NewsList } from "@/components/CompanyFeeds";
import { isEtf } from "@/lib/portfolio/classify";
import { createClient } from "@/lib/supabase/server";
import { EXTRACTION_LABEL, ORIGIN_LABEL } from "@/lib/research-labels";
import { getWorkspace } from "@/lib/workspace";
import { dayChangePct } from "@/lib/market/quotes";
import { InvestmentSummary } from "@/components/TodayValuation";
import { AskButton } from "@/components/AskPanel";
import { FilingCheckCard, type StoredFilingCheck } from "@/components/FilingCheckCard";
import { ResearchButton } from "@/components/ResearchButton";
import { coverage } from "@/lib/research/status";
import { pctStr, shortDate, toneOf, usd } from "@/lib/format";
import { Card, CardHead, Chevron, DataLabel, Disclose, Pill, SourceRef } from "@/components/ui";

type Phase = { phase_number: number; title: string | null; extraction: string; body_markdown: string | null };
type Version = {
  id: string; research_as_of: string; completeness: string; origin: string; is_current: boolean;
  conclusion: Record<string, unknown>; change_summary: string | null;
  source_documents: { file_name: string; sha256: string } | null;
  research_phases: Phase[];
};

const ERRORS: Record<string, string> = {
  reason: "Add a short reason before passing on a company.",
  ready: "Ready for decision needs complete research marked current. Refresh or finish the research first.",
  nofiling: "There is no stored research to check a filing against.",
};
const SAVED: Record<string, string> = { stage: "Stage saved.", screen: "Screen updated.", filing: "SEC filing checked and the result stored." };

export default async function CompanyPage({ params, searchParams }: { params: Promise<{ symbol: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const { symbol: raw } = await params;
  const sp = await searchParams;
  const symbol = decodeURIComponent(raw).toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);
  const supabase = await createClient();
  const [{ data: company }, ws, { data: lastCheck }] = await Promise.all([
    supabase
      .from("companies")
      .select("symbol, name, research_versions(id, research_as_of, completeness, origin, is_current, conclusion, change_summary, source_documents(file_name, sha256), research_phases(phase_number, title, extraction, body_markdown))")
      .eq("symbol", symbol)
      .maybeSingle(),
    getWorkspace(),
    supabase.from("model_runs").select("id, computed_at, code_version, inputs, outputs").eq("kind", "research_filing_check").eq("inputs->>symbol", symbol).order("computed_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const etf = isEtf(symbol);
  const q = ws.quotes.get(symbol);
  const h = ws.portfolio.holdings.find((x) => x.symbol === symbol);
  const price = q?.price ?? h?.price ?? null;
  const day = q ? dayChangePct(q) : h?.dayPct ?? null;

  const feeds = (name: string | null) => (
    <Card flush>
      {!etf && <Disclose summary="Filings and earnings dates"><Suspense fallback={<LinesSkeleton />}><FilingsList symbol={symbol} /></Suspense></Disclose>}
      <Disclose summary={<span>Headlines <span className="t-xs">· unverified</span></span>}><Suspense fallback={<LinesSkeleton />}><NewsList symbol={symbol} name={name} /></Suspense></Disclose>
    </Card>
  );

  if (!company) {
    return (
      <div className="flex flex-col gap-3 lg:gap-4 max-w-3xl">
        <Header symbol={symbol} name={null} kicker={`${symbol} · not in your research yet`} price={price} day={day} />
        {!etf && <ResearchButton symbol={symbol} hasResearch={false} needsResearch />}
        <Card flush>
          <Disclose summary={<span className="t-sm">Add to your list without researching</span>}>
            <form action={addToPipeline} className="flex flex-col gap-2">
              <input type="hidden" name="symbol" value={symbol} />
              <label className="field">Why it is interesting (optional)<input name="note" maxLength={300} className="input" /></label>
              <button className="btn btn-sm self-start">Add to pipeline</button>
            </form>
          </Disclose>
        </Card>
        {!etf && <Suspense fallback={<FeedSkeleton title="Reported financials" />}><FundamentalsCard symbol={symbol} /></Suspense>}
        {feeds(null)}
      </div>
    );
  }

  const versions = ([...(company.research_versions ?? [])] as unknown as Version[]).sort((a, b) => b.research_as_of.localeCompare(a.research_as_of));
  const record = ws.research.find((x) => x.symbol === company.symbol);
  const held = !!h;
  const cur = record?.current ?? record?.latest;
  const thesis = cur?.parsed.thesis;
  const phases = versions.reduce((n, v) => n + (v.research_phases?.length ?? 0), 0);

  return (
    <div className="flex flex-col gap-3 lg:gap-4">
      <Header symbol={company.symbol} name={company.name} kicker={`${company.symbol}${cur?.parsed.classification ? ` · ${cur.parsed.classification}` : ""}`} price={price} day={day} />
      {versions.length > 1 && !versions.some((v) => v.is_current) && (
        <p role="alert" className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2">These records disagree and none is marked current. A targeted refresh is needed before any advice.</p>
      )}
      {sp.saved && SAVED[sp.saved] && <p role="status" className="t-sm rounded-[12px] bg-surface-2 px-3 py-2">{SAVED[sp.saved]}</p>}

      <div className="grid grid-cols-1 gap-3 lg:gap-4 lg:grid-cols-12 items-start">
        <div className="lg:col-span-7 flex flex-col gap-3 lg:gap-4 min-w-0">
          <InvestmentSummary ws={ws} symbol={company.symbol} />
          {thesis && (
            <Card labelledBy="th-h" className="!gap-2">
              <CardHead id="th-h" title="Thesis" right={cur && <SourceRef kind="Research">{shortDate(cur.research_as_of).replace(/, \d{4}$/, "")}</SourceRef>} />
              <p className="t-sm leading-relaxed">{thesis}</p>
            </Card>
          )}
          {!etf && <Suspense fallback={<FeedSkeleton title="Reported financials" />}><FundamentalsCard symbol={company.symbol} /></Suspense>}
        </div>

        <div className="lg:col-span-5 flex flex-col gap-3 lg:gap-4 min-w-0">
          {!etf && <ResearchButton symbol={company.symbol} hasResearch={versions.length > 0} needsResearch={coverage(record, price, ws.now, ws.policy?.researchFreshnessDays ?? 120).key !== "current"} />}
          {versions.length > 0 && (
            <Card flush>
              <Disclose summary={`Your research · ${versions.length} record${versions.length > 1 ? "s" : ""}${phases ? `, ${phases} phases` : ""}`}>
                {versions.map((v) => {
                  const c = v.conclusion as Record<string, string | number | null>;
                  return (
                    <div key={v.id} className="flex flex-col gap-2 pb-3 border-b border-line last:border-b-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-ink font-semibold mr-1">{shortDate(v.research_as_of)}</span>
                        {v.is_current && <Pill small tone="gain" dot="solid">Current</Pill>}
                        <Pill small tone={v.completeness === "complete" ? "neutral" : "warn"}>{v.completeness.replace("_", " ")}</Pill>
                        <Pill small>{ORIGIN_LABEL[v.origin] ?? v.origin}</Pill>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 t-sm">
                        {(["action", "confidence", "classification", "reference_price"] as const).map((k) => (
                          <div key={k} className="min-w-0"><span className="t-xs block capitalize">{k.replace("_", " ")}</span><span className="text-ink">{c[k] ?? "—"}</span></div>
                        ))}
                      </div>
                      {v.change_summary && <p className="t-sm">{v.change_summary}</p>}
                      {v.source_documents && <SourceRef kind="Source">{v.source_documents.file_name} · {v.source_documents.sha256.slice(0, 10)}…</SourceRef>}
                      {v.research_phases?.length > 0 && (
                        <div className="flex flex-col rounded-[12px] border border-line px-3">
                          {[...v.research_phases].sort((a, b) => a.phase_number - b.phase_number).map((p) => (
                            <Disclose key={p.phase_number} summary={<span className="t-sm">Phase {p.phase_number}{p.title ? ` · ${p.title}` : ""} <span className={`t-xs ${p.extraction === "verbatim" ? "" : "warn"}`}>· {EXTRACTION_LABEL[p.extraction] ?? p.extraction}</span></span>}>
                              <pre className="whitespace-pre-wrap font-sans t-sm max-h-[420px] overflow-auto">{p.body_markdown ?? "No text preserved."}</pre>
                            </Disclose>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </Disclose>
            </Card>
          )}
          {record && !etf && (
            <ResearchSummary r={record} held={held} price={price} now={ws.now} freshDays={ws.policy?.researchFreshnessDays ?? 120} error={sp.error ? ERRORS[sp.error] : undefined} />
          )}
          {!etf && versions.length > 0 && (
            <Card flush>
              <Disclose summary={<span className="t-sm">SEC filing check <span className="t-xs">· optional, AI research covers it</span></span>}>
                <FilingCheckCard symbol={company.symbol} run={(lastCheck as StoredFilingCheck | null) ?? null} />
              </Disclose>
            </Card>
          )}
          {feeds(company.name)}
          <div className="flex gap-2">
            <AskButton question={`What has to be true for ${company.symbol} to reach the base case, and what would break the thesis?`} className="btn flex-1">Ask about the thesis</AskButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function Header({ symbol, name, kicker, price, day }: { symbol: string; name: string | null; kicker: string; price: number | null; day: number | null }) {
  return (
    <div className="flex items-end justify-between gap-3 min-w-0">
      <div className="flex flex-col gap-1 min-w-0">
        <Link href="/research" className="max-lg:hidden inline-flex items-center gap-1 t-sm no-underline -ml-1 min-h-8"><Chevron dir="left" />Research</Link>
        <span className="cap truncate">{kicker}</span>
        <h1 className="h1 truncate">{name ?? symbol}</h1>
      </div>
      <div className="flex flex-col items-end shrink-0">
        <span className="t-val">{price ? usd(price, 2) : "No price"}</span>
        {day !== null ? <span className={`t-xs num ${toneOf(day)}`}>{pctStr(day, 1, true)} today</span> : <DataLabel kind="delayed" small />}
      </div>
    </div>
  );
}
