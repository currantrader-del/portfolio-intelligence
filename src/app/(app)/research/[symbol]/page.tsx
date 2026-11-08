import { ActionForm, SubmitButton } from "@/components/forms";
import { AGE_REMINDER_DAYS } from "@/lib/policy/limits";
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
import { InvestigationRunner } from "@/components/InvestigationRunner";
import { InvestigationReport, type InvVersion, type SourceRow } from "@/components/InvestigationReport";
import type { ValidationReport } from "@/lib/research/validate";
import { getQuote } from "@/lib/market/quotes";
import { coverage } from "@/lib/research/status";
import { researchStanding, qualityOf, QUALITY_LABEL, approvalOf, type Standing } from "@/lib/research/standing";
import { pctStr, shortDate, toneOf, usd } from "@/lib/format";
import { Card, CardHead, Chevron, DataLabel, Disclose, Pill, SourceRef } from "@/components/ui";

type Phase = { phase_number: number; title: string | null; extraction: string; body_markdown: string | null; details?: Record<string, unknown> | null };
type Version = {
  id: string; research_as_of: string; completeness: string; origin: string; is_current: boolean;
  conclusion: Record<string, unknown>; change_summary: string | null;
  source_documents: { file_name: string; sha256: string } | null;
  research_phases: Phase[];
  research_sources?: SourceRow[];
  created_at?: string;
};

const ERRORS: Record<string, string> = {
  reason: "Add a short reason before passing on a company.",
  ready: "Ready for decision needs complete research marked current. Refresh or finish the research first.",
  nofiling: "There is no stored research to check a filing against.",
};
const SAVED: Record<string, string> = { adopted: "Approved: the investigation is now your research in use. The earlier research stays on file.", provisional: "Approved provisionally: the investigation is in use with its open items listed, and no new money is suggested until they are resolved. The earlier research stays on file.", set_aside: "Kept your current research. The investigation stays on file, marked as set aside.", stage: "Stage saved.", screen: "Screen updated.", filing: "SEC filing checked and the result stored." };

export default async function CompanyPage({ params, searchParams }: { params: Promise<{ symbol: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const { symbol: raw } = await params;
  const sp = await searchParams;
  const symbol = decodeURIComponent(raw).toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);
  const supabase = await createClient();
  const [{ data: company }, ws, { data: lastCheck }] = await Promise.all([
    supabase
      .from("companies")
      .select("symbol, name, research_versions(id, research_as_of, created_at, completeness, origin, is_current, conclusion, change_summary, source_documents(file_name, sha256), research_phases(phase_number, title, extraction, body_markdown, details), research_sources(title, url, document_date, details))")
      .eq("symbol", symbol)
      .maybeSingle(),
    getWorkspace(),
    supabase.from("model_runs").select("id, computed_at, code_version, inputs, outputs").eq("kind", "research_filing_check").eq("inputs->>symbol", symbol).order("computed_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const etf = isEtf(symbol);
  // The workspace only quotes holdings and benchmarks; a researched idea needs its own quote.
  const q = ws.quotes.get(symbol) ?? (await getQuote(symbol).catch(() => null)) ?? undefined;
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
        {!etf && <InvestigationRunner symbol={symbol} hasResearch={false} hasInvestigation={false} />}
        {!etf && <ResearchButton symbol={symbol} hasResearch={false} needsResearch />}
        <Card flush>
          <Disclose summary={<span className="t-sm">Add to your list without researching</span>}>
            <ActionForm action={addToPipeline} success="Added to your pipeline" className="flex flex-col gap-2">
              <input type="hidden" name="symbol" value={symbol} />
              <label className="field">Why it is interesting (optional)<input name="note" maxLength={300} className="input" /></label>
              <SubmitButton className="btn btn-sm self-start" pendingText="Adding…">Add to pipeline</SubmitButton>
            </ActionForm>
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
  const isInv = (v: Version) => v.conclusion?.research_type === "full_investigation" || v.conclusion?.research_type === "material_event_refresh";
  const investigations = versions.filter(isInv).sort((a, b) => (b.created_at ?? b.research_as_of).localeCompare(a.created_at ?? a.research_as_of));
  const standing = researchStanding(versions);
  const shownInv = standing.pending?.v as Version | undefined ?? (standing.inUse && isInv(standing.inUse.v as Version) ? standing.inUse.v as Version : investigations[0]) ?? null;
  const latestInv = shownInv;
  // The code-only check of the investigation, saved separately from the research record.
  const { data: valRow } = latestInv
    ? await supabase.from("model_runs").select("outputs").eq("kind", "research_validation").eq("inputs->>version_id", latestInv.id).order("computed_at", { ascending: false }).limit(1).maybeSingle()
    : { data: null };

  return (
    <div className="flex flex-col gap-3 lg:gap-4">
      <Header symbol={company.symbol} name={company.name} kicker={`${company.symbol}${cur?.parsed.classification ? ` · ${cur.parsed.classification}` : ""}`} price={price} day={day} />
      {versions.length > 1 && !versions.some((v) => v.is_current) && (
        <p role="alert" className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2">These records disagree and none is marked current. A targeted refresh is needed before any advice.</p>
      )}
      {sp.saved && SAVED[sp.saved] && <p role="status" className="t-sm rounded-[12px] bg-surface-2 px-3 py-2">{SAVED[sp.saved]}</p>}

      <div className="grid grid-cols-1 gap-3 lg:gap-4 lg:grid-cols-12 items-start">
        <div className="lg:col-span-7 flex flex-col gap-3 lg:gap-4 min-w-0">
          <ResearchStatus s={standing} />
          {latestInv && <InvestigationReport symbol={company.symbol} v={latestInv as unknown as InvVersion} sources={latestInv.research_sources ?? []} inUse={standing.inUse && standing.inUse.v.id !== latestInv.id ? { research_as_of: standing.inUse.v.research_as_of, label: standing.inUse.label } : null} validation={(valRow?.outputs as ValidationReport | undefined) ?? null} />}
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
          {!etf && <InvestigationRunner symbol={company.symbol} hasResearch={versions.some((v) => v.is_current || isInv(v))} hasInvestigation={investigations.some((v) => v.is_current)} />}
          {!etf && <ResearchButton symbol={company.symbol} hasResearch={versions.length > 0} needsResearch={!latestInv && coverage(record, price, ws.now, AGE_REMINDER_DAYS).key !== "current"} />}
          {versions.length > 0 && (
            <Card flush>
              <Disclose summary={`Your research · ${versions.length} record${versions.length > 1 ? "s" : ""}${phases ? `, ${phases} phases` : ""}`}>
                {versions.map((v) => {
                  const c = v.conclusion as Record<string, string | number | null>;
                  return (
                    <div key={v.id} className="flex flex-col gap-2 pb-3 border-b border-line last:border-b-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-ink font-semibold mr-1">{shortDate(v.research_as_of)}</span>
                        {v.is_current && <Pill small tone={approvalOf(v) === "approved" ? "gain" : "warn"} dot="solid">{approvalOf(v) === "approved" ? "In use" : approvalOf(v) === "provisional" ? "In use, provisional" : "In use, not approved by you"}</Pill>}
                        <Pill small tone={qualityOf(v) === "complete_investigation" || qualityOf(v) === "imported" ? "neutral" : "warn"}>{v.completeness === "in_progress" ? "In progress" : QUALITY_LABEL[qualityOf(v)]}</Pill>
                        <Pill small>{v.conclusion?.research_type === "preliminary_screen" ? "Preliminary screen" : v.conclusion?.research_type === "full_investigation" ? "Full investigation" : v.conclusion?.research_type === "material_event_refresh" ? "Material-event refresh" : ORIGIN_LABEL[v.origin] ?? v.origin}</Pill>
                        {v.conclusion?.review_state === "awaiting_approval" && !v.is_current && <Pill small tone="copper">Awaiting your decision</Pill>}
                        {v.conclusion?.review_state === "set_aside" && <Pill small>Set aside</Pill>}
                        {!v.is_current && v !== standing.pending?.v && <Pill small>History</Pill>}
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
            <ResearchSummary r={record} held={held} price={price} now={ws.now} freshDays={AGE_REMINDER_DAYS} error={sp.error ? ERRORS[sp.error] : undefined} />
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

/** Which research decisions use, what is waiting for you, what is history, and what is still open. */
function ResearchStatus({ s }: { s: Standing }) {
  if (!s.inUse && !s.pending) return null;
  const gaps = [...(s.inUse?.open ?? []).map((x) => ({ x, from: "in use" })), ...(s.pending?.open ?? []).map((x) => ({ x, from: "new investigation" }))];
  return (
    <Card labelledBy="rs-h" className="!gap-2">
      <CardHead id="rs-h" cap="Research status" />
      <div className="flex flex-col gap-1.5 t-sm">
        <div><span className="t-xs block">In use for decisions</span>
          {s.inUse ? <span className="text-ink">{shortDate(s.inUse.v.research_as_of)} · {s.inUse.label}{s.inUse.open.length ? ` · ${s.inUse.open.length} open item${s.inUse.open.length === 1 ? "" : "s"}` : ""}</span> : <span className="text-ink">None</span>}
        </div>
        {s.pending && (
          <div><span className="t-xs block">Latest investigation</span>
            <span className="text-ink">{shortDate(s.pending.v.research_as_of)} · {s.pending.state === "running" ? "in progress" : `${s.pending.complete ? "complete" : s.pending.kind === "material_uncertainty" ? "incomplete: a material question has no reliable answer" : "incomplete"} · waiting for your decision (not used until you approve it)`}{s.pending.open.length ? ` · ${s.pending.open.length} open item${s.pending.open.length === 1 ? "" : "s"}` : ""}</span>
          </div>
        )}
        {s.history.length > 0 && <div><span className="t-xs block">History</span><span>{s.history.length} earlier record{s.history.length === 1 ? "" : "s"}, kept unchanged (listed under Your research)</span></div>}
        <p className={`t-xs ${s.inUse?.approval === "approved" && !s.pending ? "" : "warn"}`}>{s.decisions}</p>
        {gaps.length > 0 && (
          <Disclose summary={<span className="t-sm">Open evidence gaps · {gaps.length}</span>}>
            <ul className="t-xs list-disc pl-4 flex flex-col gap-0.5">{gaps.slice(0, 20).map((g, i) => <li key={i}><span className="text-ink">{g.from}:</span> {g.x}</li>)}</ul>
          </Disclose>
        )}
      </div>
    </Card>
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
