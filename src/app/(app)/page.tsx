import { Suspense } from "react";
import { after } from "next/server";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { recordDaily } from "@/lib/portfolio/daily";
import { getWorkspace } from "@/lib/workspace";
import { shortDate } from "@/lib/format";
import { Card, CardHead, Disclose, LinkRow, PageHeader, Skel } from "@/components/ui";
import { settingsFrom } from "@/lib/costs/spend";
import { AnswerView } from "@/components/AnswerView";
import { MorningRunner } from "@/components/MorningRunner";
import { OutdatedNotice } from "@/components/OutdatedNotice";
import { loadContextEvents } from "@/lib/freshness/contextEvents";
import { outdatedVerdict } from "@/lib/freshness/outdated";
import { ImprovementTeaser } from "@/components/ImprovementCard";
import { improvementView } from "@/lib/shadow/proposals";
import { PlanCard } from "@/components/PlanCard";

/** An account that does not sync gets a statement reminder after this many days. */
const STATEMENT_REMINDER_DAYS = 35;

/**
 * Home = your plan (2026-11-17). Today's move, every holding and the calendar are on Stocks & funds; alerts on Alerts.
 */
export default async function TodayPage() {
  const ws = await getWorkspace();
  const p = ws.portfolio;
  // Recording today's row happens after the response is sent, so it never slows the page.
  const db = await createClient();
  after(() => recordDaily(db, ws));
  const { data: mrow } = await db.from("model_runs").select("computed_at, outputs").eq("kind", "assistant_answer").eq("inputs->>purpose", "morning").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const mout = mrow?.outputs as { answer?: string; ms?: number; costUsd?: number; error?: string } | undefined;
  const etDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const morning = mrow && mout?.answer && !mout.error ? { answer: mout.answer, at: mrow.computed_at as string, ms: mout.ms ?? 0, costUsd: mout.costUsd ?? 0, today: etDay(new Date(mrow.computed_at)) === etDay(ws.now) } : null;
  // A saved briefing stays as written; it is flagged when the policy, holdings, cash or research it used changed since.
  // What this morning's scheduled run could not do (budget, ceiling or a failed step), said plainly rather than left out.
  const { data: runRow } = await db.from("model_runs").select("computed_at, outputs").eq("kind", "morning_run").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const morningSkipped = runRow && etDay(new Date(runRow.computed_at)) === etDay(ws.now) ? ((runRow.outputs as { skipped?: string[] }).skipped ?? []).filter((x) => !/^trade_scan paused/.test(x)) : [];
  const morningCheck = morning ? outdatedVerdict({ writtenAt: morning.at, events: await loadContextEvents(db, morning.at).catch(() => []), text: morning.answer, currentReserve: 0 }) : null;

  const queue = ws.alerts.filter((a) => a.severity !== "low");
  const dateLabel = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" }).format(ws.now);
  const improve = await improvementView(db, ws).catch(() => null);
  // Things only you can do, shown until done: start the 30-day test, and upload a statement for an account that does not sync.
  const { data: costRow } = await db.from("model_runs").select("outputs").eq("kind", "cost_settings").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const testNotStarted = !settingsFrom(costRow?.outputs ?? null).evalStart;
  const staleAccounts = p.accounts.filter((a) => a.sourceKind !== "schwab_api" && a.role !== "cash" && a.role !== "protected_savings" && a.ageDays > STATEMENT_REMINDER_DAYS);

  if (!p.holdings.length && !ws.research.length) {
    return (
      <Card className="max-w-xl">
        <h1 className="h1">Welcome</h1>
        <p className="t-sm">Import your research and holdings to start.</p>
        <div><Link href="/import" className="btn btn-primary">Import research</Link></div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3 lg:gap-4">
      <PageHeader kicker={dateLabel} title="Your plan" />

      {(testNotStarted || staleAccounts.length > 0) && (
        <Card labelledBy="todo-h" className="!gap-2">
          <CardHead id="todo-h" title="Needs you" />
          {testNotStarted && <LinkRow href="/costs"><span className="t-sm text-ink block">Start the 30-day test</span><span className="t-xs block">Nothing counts toward the proof-of-value test until you tap Start on AI spending.</span></LinkRow>}
          {staleAccounts.map((a) => <LinkRow key={a.id} href="/import"><span className="t-sm text-ink block">Upload the latest {a.name} statement</span><span className="t-xs block">Its figures are from {shortDate(a.asOf)} ({a.ageDays} days old), so its holdings and cash are estimates. It doesn&apos;t sync automatically.</span></LinkRow>)}
        </Card>
      )}

      {/* One plan first (2026-11-17): mix vs target, the next dated step, stocks nearest their buy levels. */}
      <Suspense fallback={<div className="card card-tight"><Skel w="60%" /></div>}><PlanCard db={db} ws={ws} /></Suspense>

      <Card labelledBy="mb-h" className="!gap-2" flush>
        <Disclose summary={<span className="t-sm" id="mb-h">Monthly briefing{morning ? ` · ${morning.today ? "today" : shortDate(morning.at)}` : ""}</span>}>
        <div className="flex flex-col gap-2">
        <div><MorningRunner label={morningCheck?.outdated ? "Rewrite with today's facts" : morning ? "Write a new one" : "Write it now"} /></div>
        {morningSkipped.length > 0 && <p className="t-xs warn">Not done this morning: {morningSkipped.map((x) => x.replace(/^(\w+) (skipped: |failed: )?/, (_m, k: string, how?: string) => `${({ market_briefing: "market briefing", assistant_answer: "this summary", morning_answer: "this summary", portfolio_plan: "weekly plan", trade_scan: "trade scan", radar_run: "Opportunity Radar" } as Record<string, string>)[k] ?? k} ${how?.startsWith("failed") ? "failed: " : "skipped, "}`)).join("; ")}. <Link href="/costs">Costs</Link></p>}
        {morning ? (
          <>
            {morningCheck && <OutdatedNotice v={morningCheck} what="briefing" />}
            <div className={morningCheck?.outdated ? "opacity-70" : undefined}><AnswerView text={morning.answer} /></div>
            <span className="t-xs">Written {new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(morning.at))} ET{morning.today ? "" : ` on ${shortDate(morning.at)}`} · {Math.round(morning.ms / 1000)}s · ${morning.costUsd.toFixed(2)} · from your portfolio, policy, research and that day&apos;s market briefing · AI summary: facts are checked against sources on Markets, not here</span>
          </>
        ) : <p className="t-sm">Written automatically at 9:00 AM ET on the first business day of each month (tap above for one any day). It answers six questions, key recommendation first: what happened in the market, whether anything materially affected your investments, whether any action is needed, which researched stocks are approaching entry, which new opportunities are worth investigating, and what is coming up.</p>}
        </div>
        </Disclose>
      </Card>

      {improve && <ImprovementTeaser items={improve.active} />}

      {queue.length > 0 && (
        <Card tight className="!gap-0">
          <LinkRow href="/alerts"><span className="t-sm text-ink block">{queue.length} alert{queue.length === 1 ? "" : "s"} to look at</span><span className="t-xs block">{queue.slice(0, 2).map((q) => q.title).join(" · ")}</span></LinkRow>
        </Card>
      )}

      <Link href="/stocks" className="t-xs px-1 no-underline hover:text-ink">Today&apos;s move, every stock and fund with what to do: Stocks &amp; funds</Link>
    </div>
  );
}
