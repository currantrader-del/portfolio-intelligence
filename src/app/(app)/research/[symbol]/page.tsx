import { actionNow, type ActionNow } from "@/lib/decision/actionNow";
import { reviewPosition } from "@/lib/decision/review";
import { researchVerdict, type Verdict } from "@/lib/research/verdict";
import { loadReviews, withReviews, type ReviewAnnotations } from "@/lib/research/review";
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
import { RecoveryCard } from "@/components/RecoveryCard";
import { AnalystCard } from "@/components/AnalystCard";
import { InvestmentSummary, type Brief } from "@/components/TodayValuation";
import { AskButton } from "@/components/AskPanel";
import { FilingCheckCard, type StoredFilingCheck } from "@/components/FilingCheckCard";
import { ResearchButton } from "@/components/ResearchButton";
import { InvestigationRunner } from "@/components/InvestigationRunner";
import { ShareResearchCard } from "@/components/ShareResearchCard";
import { shareOptions } from "@/lib/research/share/report";
import { InvestigationConclusion, InvestigationEvidence, InvestigationPills, type InvVersion, type SourceRow } from "@/components/InvestigationReport";
import type { ValidationReport } from "@/lib/research/validate";
import { updatePlanFor } from "@/lib/research/updateCheck";
import { measuredEstimates } from "@/lib/research/costEstimates";
import type { VersionRow } from "@/lib/research/records";
import { getQuote } from "@/lib/market/quotes";
import { coverage } from "@/lib/research/status";
import { researchStanding, qualityOf, QUALITY_LABEL, approvalOf, statusFields, displaySummary, type Standing, type StatusFields } from "@/lib/research/standing";
import { refreshState } from "@/lib/policy/evidence";
import { getFilings } from "@/lib/market/sec";
import { pctStr, shortDate, toneOf, usd } from "@/lib/format";
import { Card, CardHead, Chevron, DataLabel, Disclose, LinkRow, Pill, SourceRef } from "@/components/ui";

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
const SAVED: Record<string, string> = { full: "Approved in full: the research in use is no longer provisional. The open items you accepted stay listed on the record.", adopted: "Approved: the investigation is now your research in use. The earlier research stays on file.", provisional: "Approved provisionally: the investigation is in use with its open items listed, and no new money is suggested until they are resolved. The earlier research stays on file.", set_aside: "Kept your current research. The investigation stays on file, marked as set aside.", stage: "Stage saved.", screen: "Screen updated.", filing: "SEC filing checked and the result stored." };

export default async function CompanyPage({ params, searchParams }: { params: Promise<{ symbol: string }>; searchParams: Promise<{ error?: string; saved?: string; targets?: string }> }) {
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
        {!etf && <Suspense fallback={<FeedSkeleton title="Analyst reports" />}><AnalystCard symbol={symbol} price={price} /></Suspense>}
        {!etf && <Suspense fallback={<FeedSkeleton title="Reported financials" />}><FundamentalsCard symbol={symbol} /></Suspense>}
        {feeds(null)}
      </div>
    );
  }

  const reviews = await loadReviews(supabase).catch(() => new Map<string, ReviewAnnotations>());
  const versions = withReviews([...(company.research_versions ?? [])] as unknown as Version[], reviews).sort((a, b) => b.research_as_of.localeCompare(a.research_as_of));
  const record = ws.research.find((x) => x.symbol === company.symbol);
  const held = !!h;
  const cur = record?.current ?? record?.latest;
  const phases = versions.reduce((n, v) => n + (v.research_phases?.length ?? 0), 0);
  const isInv = (v: Version) => v.conclusion?.research_type === "full_investigation" || v.conclusion?.research_type === "material_event_refresh";
  const investigations = versions.filter(isInv).sort((a, b) => (b.created_at ?? b.research_as_of).localeCompare(a.created_at ?? a.research_as_of));
  const standing = researchStanding(versions);
  const shownInv = standing.pending?.v as Version | undefined ?? (standing.inUse && isInv(standing.inUse.v as Version) ? standing.inUse.v as Version : investigations[0]) ?? null;
  const latestInv = shownInv;
  // "Update research": what is new since the research it would build on, and the free re-pricing.
  const estimates = etf ? null : await measuredEstimates(supabase).catch(() => null);
  const updatePlan = etf ? null : (await updatePlanFor(company.symbol, versions as unknown as (VersionRow & { created_at?: string | null })[], price, estimates ?? undefined)).plan;
  // The code-only check of the investigation, saved separately from the research record.
  const { data: valRow } = latestInv
    ? await supabase.from("model_runs").select("outputs").eq("kind", "research_validation").eq("inputs->>version_id", latestInv.id).order("computed_at", { ascending: false }).limit(1).maybeSingle()
    : { data: null };

  // Only a run still working is shown as pending; a finished investigation is used automatically.
  const pendingInv = standing.pending && latestInv && latestInv.id === standing.pending.v.id ? latestInv : null;
  const usedId = standing.inUse?.v.id ?? null;
  const inUseLabel = standing.inUse ? { research_as_of: standing.inUse.v.research_as_of, label: standing.inUse.label } : null;
  const brief = briefOf(standing, cur?.parsed.thesis ?? null);
  // The same "anything material since?" check Decisions uses.
  const secF = etf || !record?.current ? null : await getFilings(company.symbol, ws.now).catch(() => null);
  const reassess = record?.current ? refreshState({ asOf: record.current.research_as_of, pc: record.current.parsed, price, filings: secF && !("error" in secF) ? secF : null, isEtf: etf }) : null;
  const fields = statusFields(standing, reassess);
  // One answer and one next step, from the same plan the update button uses.
  const verdict = etf ? null : researchVerdict({
    inUse: standing.inUse ? { asOf: standing.inUse.v.research_as_of, isInvestigation: isInv(standing.inUse.v as Version), open: standing.inUse.open, label: QUALITY_LABEL[standing.inUse.quality] } : null,
    plan: updatePlan, zoneChange: reassess?.triggers.find((t) => t.kind === "zone_change")?.detail.split(". ")[0] ?? null,
  });
  const share = shareOptions(versions);
  // The plain action at today's price: the same rule the position review and the alerts use.
  const filingsOk = secF && !("error" in secF) ? secF : null;
  const plainAction = etf ? null : held ? reviewPosition(ws, company.symbol, filingsOk)?.now ?? null : actionNow({
    symbol: company.symbol, price, held: false, now: ws.now, preliminary: !!record?.current && !record.authoritative,
    unreadFiling: reassess?.status === "refresh" ? reassess.triggers.filter((t) => t.kind === "results" || t.kind === "financing" || t.kind === "material_event").map((t) => t.detail.replace(/^[^:]+: /, ""))[0] ?? null : null,
    research: record?.current && record.authoritative ? { pc: record.current.parsed, asOf: record.current.research_as_of, openQuestions: standing.inUse?.open.length ?? 0 } : null, trim: null,
  });

  return (
    <div className="flex flex-col gap-3 lg:gap-4">
      <Header symbol={company.symbol} name={company.name} kicker={`${company.symbol}${cur?.parsed.classification ? ` · ${cur.parsed.classification}` : ""}`} price={price} day={day} />
      {versions.length > 0 && !standing.inUse && !standing.pending && (
        <p role="alert" className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2">No finished research on file. A targeted investigation is needed before any advice.</p>
      )}
      {sp.saved && SAVED[sp.saved] && <p role="status" className="t-sm rounded-[12px] bg-surface-2 px-3 py-2">{SAVED[sp.saved]}</p>}

      {/* Investment view: the decision first. */}
      <div className="grid grid-cols-1 gap-3 lg:gap-4 lg:grid-cols-12 items-start">
        <div className="lg:col-span-7 flex flex-col gap-3 lg:gap-4 min-w-0">
          <ResearchStatus s={standing} f={fields} verdict={verdict} now={plainAction} price={price} />
          <Card flush>
            <Disclose summary={<span className="t-sm">The numbers behind it · valuation, your exposure, thesis</span>}>
              <InvestmentSummary ws={ws} symbol={company.symbol} brief={brief} />
            </Disclose>
          </Card>
          {pendingInv && <InvestigationConclusion symbol={company.symbol} v={pendingInv as unknown as InvVersion} inUse={inUseLabel} usedId={usedId} validation={(valRow?.outputs as ValidationReport | undefined) ?? null} />}
        </div>

        <div className="lg:col-span-5 flex flex-col gap-3 lg:gap-4 min-w-0">
          {!etf && <InvestigationRunner symbol={company.symbol} hasResearch={versions.some((v) => v.is_current || isInv(v))} hasInvestigation={investigations.some((v) => v.is_current)} plan={updatePlan} />}
          {!etf && <Suspense fallback={<FeedSkeleton title="Analyst reports" />}><AnalystCard symbol={company.symbol} price={price} /></Suspense>}
          {!etf && <Suspense fallback={<FeedSkeleton title="Recovery odds" />}><RecoveryCard symbol={company.symbol} price={price} priceAsOf={q?.asOf ?? null} targetsRaw={sp.targets?.slice(0, 80)} /></Suspense>}
          {!etf && <ResearchButton symbol={company.symbol} hasResearch={versions.length > 0} needsResearch={!latestInv && coverage(record, price, ws.now, AGE_REMINDER_DAYS).key !== "current"} />}
          {!etf && <ShareResearchCard symbol={company.symbol} latest={share.latest} approved={share.approved} />}
          <Card labelledBy="tv-h" className="!gap-1.5">
            <CardHead id="tv-h" cap="Trading view · separate" />
            <p className="t-xs">Short-term trade ideas are tracked on their own page as paper trades. They never change the investment view, research or limits on this page.</p>
            <LinkRow href="/trades">Trade ideas</LinkRow>
          </Card>
        </div>
      </div>

      {/* Supporting research: everything behind the summary, collapsed. */}
      <h2 className="cap mt-2 lg:mt-3">Supporting research</h2>
      <div className="grid grid-cols-1 gap-3 lg:gap-4 lg:grid-cols-12 items-start">
        <div className="lg:col-span-7 flex flex-col gap-3 lg:gap-4 min-w-0">
          {latestInv && (
            <Card labelledBy="ev-h" className="!gap-2">
              <CardHead id="ev-h" title={`${latestInv.conclusion?.research_type === "material_event_refresh" ? "Material-event refresh" : "Full investigation"} · ${shortDate(latestInv.research_as_of)}`} right={<InvestigationPills v={latestInv as unknown as InvVersion} usedId={usedId} />} />
              <div className="flex flex-col rounded-[12px] border border-line px-3">
                {!pendingInv && (
                  <Disclose summary={<span className="t-sm">Full conclusion · reasons, valuation, portfolio fit, reviewer corrections</span>}>
                    <InvestigationConclusion bare symbol={company.symbol} v={latestInv as unknown as InvVersion} inUse={inUseLabel} usedId={usedId} validation={(valRow?.outputs as ValidationReport | undefined) ?? null} />
                  </Disclose>
                )}
                <InvestigationEvidence v={latestInv as unknown as InvVersion} sources={latestInv.research_sources ?? []} />
              </div>
            </Card>
          )}
          {versions.length > 0 && (
            <Card flush>
              <Disclose summary={`Research history · ${versions.length} record${versions.length > 1 ? "s" : ""}${phases ? `, ${phases} phases` : ""}`}>
                {versions.map((v) => {
                  const c = v.conclusion as Record<string, string | number | null>;
                  return (
                    <div key={v.id} className="flex flex-col gap-2 pb-3 border-b border-line last:border-b-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-ink font-semibold mr-1">{shortDate(v.research_as_of)}</span>
                        {v.id === usedId && <Pill small tone={approvalOf(v) === "automatic" ? "warn" : "gain"} dot="solid">{approvalOf(v) === "automatic" ? "In use, preliminary" : "In use for decisions"}</Pill>}
                        <Pill small tone={qualityOf(v) === "complete_investigation" || qualityOf(v) === "imported" ? "neutral" : "warn"}>{v.completeness === "in_progress" ? "In progress" : QUALITY_LABEL[qualityOf(v)]}</Pill>
                        <Pill small>{v.conclusion?.research_type === "preliminary_screen" ? "Preliminary screen" : v.conclusion?.research_type === "full_investigation" ? "Full investigation" : v.conclusion?.research_type === "material_event_refresh" ? "Material-event refresh" : ORIGIN_LABEL[v.origin] ?? v.origin}</Pill>
                        {v.conclusion?.review_state === "set_aside" && <Pill small>Set aside</Pill>}
                        {v.id !== usedId && v !== standing.pending?.v && <Pill small>History</Pill>}
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 t-sm">
                        {(["action", "confidence", "classification", "reference_price"] as const).map((k) => (
                          <div key={k} className="min-w-0"><span className="t-xs block capitalize">{k.replace("_", " ")}</span><span className="text-ink">{c[k] ?? "—"}</span></div>
                        ))}
                      </div>
                      {v.change_summary && (() => { const d = displaySummary(v.change_summary, v.id === usedId); return <>{d.text && <p className="t-sm">{d.text}</p>}{d.note && <p className="t-xs">{d.note}</p>}</>; })()}
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
          {!etf && <Suspense fallback={<FeedSkeleton title="Reported financials" />}><FundamentalsCard symbol={company.symbol} /></Suspense>}
        </div>

        <div className="lg:col-span-5 flex flex-col gap-3 lg:gap-4 min-w-0">
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

/**
 * The short text for the top of the page, from the research in use (reviewer annotations applied):
 * thesis, principal risks, what would change the call, and the material open items. Nothing is
 * generated or changed; it only picks fields already on the record.
 */
function briefOf(s: Standing, parsedThesis: string | null): Brief | null {
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((t): t is string => typeof t === "string" && !!t.trim()) : []);
  const pend = s.pending ? (() => {
    const pc = (s.pending.v.conclusion ?? {}) as Record<string, unknown>;
    const psm = (pc.investment_summary ?? {}) as Record<string, unknown>;
    return { date: s.pending.v.research_as_of, action: (psm.action ?? pc.action ?? null) as string | null, confidence: (psm.confidence ?? pc.confidence ?? null) as string | null, running: s.pending.state === "running" };
  })() : null;
  if (!s.inUse) return pend ? { from: "", thesis: null, risks: [], wouldChange: [], unresolved: [], pending: pend } : null;
  const v = s.inUse.v;
  const c = (v.conclusion ?? {}) as Record<string, unknown>;
  const sm = (c.investment_summary ?? null) as Record<string, unknown> | null;
  const ev = (c.evidence ?? {}) as { findings?: { id: string; claim: string; withdrawn?: unknown; classification?: { cls: string; explanation: string } }[]; questions?: { id: string; question: string; status: string; could_change_conclusion?: boolean }[] };
  const review = (c.review ?? null) as { material_inputs?: { input: string; scenario: string; note: string }[] } | null;
  const unresolved = [
    ...s.inUse.open,
    ...(review?.material_inputs ?? []).map((m) => `Material input not reconciled: ${m.input}${m.scenario === "all" ? "" : ` (${m.scenario})`}. ${m.note}`),
    ...(ev.findings ?? []).filter((f) => !f.withdrawn && f.classification?.cls === "unresolved_thesis_changing").map((f) => `${f.claim} (${f.id}): ${f.classification!.explanation}`),
    ...(ev.questions ?? []).filter((q) => q.status !== "resolved" && q.could_change_conclusion).map((q) => `${q.question} (${q.id}, ${q.status})`),
  ];
  const seen = new Set<string>();
  const dedup = unresolved.filter((x) => { const k = x.slice(0, 60).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const type = c.research_type === "full_investigation" ? "full investigation" : c.research_type === "material_event_refresh" ? "material-event refresh" : c.research_type === "preliminary_screen" ? "preliminary screen" : "research";
  return {
    from: `${shortDate(v.research_as_of)} ${type}`,
    action: (sm?.action ?? c.action ?? null) as string | null,
    confidence: (sm?.confidence ?? c.confidence ?? null) as string | null,
    headline: (sm?.headline ?? null) as string | null,
    thesis: ((sm?.thesis as string | undefined) || (c.thesis as string | undefined) || parsedThesis) ?? null,
    risks: strs(sm?.risks ?? c.risks ?? c.key_risks),
    wouldChange: strs(sm?.would_change ?? c.would_change),
    unresolved: dedup,
    pending: pend,
  };
}

/** Which research decisions use, what is waiting for you, what is history, and what is still open. */
function ResearchStatus({ s, f, verdict, now, price }: { s: Standing; f: StatusFields | null; verdict: Verdict | null; now: ActionNow | null; price: number | null }) {
  if (!s.inUse && !s.pending && !now) return null;
  const nx = verdict?.next;
  const row = (label: string, ok: boolean, text: string) => (
    <div className="grid grid-cols-[110px_1fr] gap-2 items-baseline"><span className="t-xs">{label}</span><span className={ok ? "text-ink" : "warn"}>{text}</span></div>
  );
  // The verb is shown big, so the sentence under it starts with the reason, not the verb again.
  const reason = now ? now.headline.replace(/^(Hold|Trim|Buy more|No action)(?: about \$[\d,]+)?(?: at \$[\d.,]+)?(?: for now)?:\s*/, "").replace(/^Reassess first, and /, "").replace(/^./, (c) => c.toUpperCase()) : "";
  const tone = now?.verb === "Hold" ? "text-ink" : now?.verb === "Buy more" ? "gain" : "warn";
  return (
    <Card labelledBy="rs-h" className="!gap-3">
      <CardHead id="rs-h" cap={`What to do${price ? ` · $${price.toFixed(2)}` : ""}`} />
      {now && (
        <div className="flex flex-col gap-2">
          <p className={`text-[28px] leading-tight font-semibold ${tone}`}>{now.verb}</p>
          <p className="text-[16px] leading-snug text-ink">{reason}</p>
          {now.zones.length > 0 && (
            <ul className="flex flex-col rounded-[12px] border border-line overflow-hidden" aria-label="Price levels from the research">
              {now.zones.map((z) => (
                <li key={z.label} className={`flex flex-col gap-0.5 px-3 py-2 border-b border-line last:border-b-0 ${z.current ? "bg-surface-2" : ""}`}>
                  <span className={`t-sm font-semibold ${z.current ? "text-ink" : ""}`}>{z.label}{z.current ? " · now" : ""}</span>
                  <span className="t-xs">{z.action}</span>
                </li>
              ))}
            </ul>
          )}
          {now.priceAnswer && <p className="t-sm"><span className="text-ink font-semibold">Good price to buy? </span>{now.priceAnswer}</p>}
          {now.downside && <p className="t-sm"><span className="text-ink font-semibold">Why it could go lower: </span>{now.downside}</p>}
          {(now.risks.length > 0 || now.watch.length > 0) && (
            <Disclose summary={<span className="t-sm">Main risks and what would change this</span>}>
              <ul className="t-xs list-disc pl-4 flex flex-col gap-1">
                {now.risks.map((x, i) => <li key={`r${i}`}>{x}</li>)}
                {now.watch.map((x, i) => <li key={`w${i}`}>Would change the view: {x}</li>)}
              </ul>
            </Disclose>
          )}
        </div>
      )}
      {nx && (nx.kind === "update" || nx.kind === "full") && (
        <p className="t-sm rounded-[12px] px-3 py-2 bg-warn-bg text-warn-ink">
          <span className="font-semibold">Next step: </span>{nx.text} About {nx.cost}. <a href="#inv-h">{nx.kind === "update" ? "Reassess now" : "Full investigation"}</a>
        </p>
      )}
      {verdict && (
        <Disclose summary={<span className="t-sm">{verdict.headline}</span>}>
          <div className="flex flex-col gap-1.5 t-sm">
            {verdict.detail && <p className="t-xs">{verdict.detail}</p>}
            {nx && nx.kind !== "update" && nx.kind !== "full" && <p className="t-xs">{nx.text}</p>}
            {f && <>
              {row("Investigation", f.finished.ok, f.finished.text)}
              {row("Your approval", true, f.approved.text)}
              {row("Used for decisions", f.inUse.ok, f.inUse.text)}
            </>}
            {s.pending && (
              <div><span className="t-xs block">Latest investigation</span>
                <span className="text-ink">{shortDate(s.pending.v.research_as_of)} · {s.pending.state === "running" ? "in progress" : `${s.pending.complete ? "complete" : s.pending.kind === "material_uncertainty" ? "incomplete: a material question has no reliable answer" : "incomplete"} · not in use: it has unfinished work`}{s.pending.open.length ? ` · ${s.pending.open.length} open item${s.pending.open.length === 1 ? "" : "s"}` : ""}</span>
              </div>
            )}
            {s.history.length > 0 && <p className="t-xs">{s.history.length} earlier record{s.history.length === 1 ? "" : "s"}, kept unchanged (under Research history).</p>}
            {s.inUse && s.inUse.open.length > 0 && <>
              <span className="t-xs">Open questions ({s.inUse.open.length}):</span>
              <ul className="t-xs list-disc pl-4 flex flex-col gap-0.5">{s.inUse.open.slice(0, 20).map((x, i) => <li key={i}>{x}</li>)}</ul>
            </>}
            {s.pending && s.pending.open.length > 0 && <>
              <span className="t-xs">Open items in the new investigation ({s.pending.open.length}):</span>
              <ul className="t-xs list-disc pl-4 flex flex-col gap-0.5">{s.pending.open.slice(0, 20).map((x, i) => <li key={i}>{x}</li>)}</ul>
            </>}
          </div>
        </Disclose>
      )}
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
