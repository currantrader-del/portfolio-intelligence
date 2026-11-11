import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHead, Disclose, Pill } from "@/components/ui";
import { RadarRunner } from "@/components/RadarRunner";
import { MyActionButtons } from "@/components/eval/MyAction";
import { radarRuns, radarStatus } from "@/lib/radar/job";
import { ideaResult, type RadarIdea } from "@/lib/radar/radar";
import { actionRef, loadMyActions, type ActionRecord } from "@/lib/eval/log";
import { getQuotes } from "@/lib/market/quotes";
import { shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const pct = (x: number | null) => (x === null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const KIND = { leader: "Leader", pullback: "Pullback in a leader", setup: "Chart setup" } as const;
const EVIDENCE = { filing: "filing", results: "results", news: "news", analyst: "analyst view (idea input only)", fund: "fund holding (idea input only)", social: "social post (idea input only)", other: "source" } as const;

function IdeaRow({ i, runId, now, voo, mine }: { i: RadarIdea; runId: string; now: number | null; voo: number | null; mine: ActionRecord | null }) {
  const r = ideaResult(i, now, voo);
  return (
    <li className="border-t border-line">
      <Disclose summary={
        <span className="flex items-center justify-between gap-2 w-full min-w-0">
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-ink font-semibold truncate">{i.symbol}{i.name ? ` · ${i.name}` : ""}</span>
            <Pill small tone={i.strength === "strong" ? "gain" : "neutral"}>{i.strength === "strong" ? "Strong" : "Worth a look"}</Pill>
            {mine && <Pill small tone="info">{mine.action === "did" ? "You're looking into it" : "Not interested"}</Pill>}
          </span>
          <span className="t-sm num shrink-0"><span className={r.returnPct !== null ? (r.returnPct >= 0 ? "gain" : "loss") : ""}>{pct(r.returnPct)}</span> <span className="t-xs">VOO {pct(r.vooPct)}</span></span>
        </span>
      }>
        <div className="flex flex-col gap-2 t-sm">
          <p className="text-ink">{i.idea}</p>
          <p><span className="text-ink font-semibold">Why now: </span>{i.whyNow}</p>
          <p className="t-xs num">Named {shortDate(i.at)} at ${i.price.toFixed(2)}{now ? ` · now $${now.toFixed(2)}` : ""}{r.edgePct !== null ? ` · ${r.edgePct >= 0 ? "ahead of" : "behind"} VOO by ${Math.abs(r.edgePct * 100).toFixed(1)} pts since` : ""}{i.fromShortlist ? "" : " · named from outside the app's screen"}</p>
          {i.risks.length > 0 && <div><span className="text-ink font-semibold">Risks</span><ul className="list-disc pl-5 t-xs">{i.risks.map((x) => <li key={x}>{x}</li>)}</ul></div>}
          {i.wouldChange && <p className="t-xs"><span className="text-ink font-semibold">Would drop it if: </span>{i.wouldChange}</p>}
          <ul className="t-xs flex flex-col gap-0.5">{i.evidence.map((e) => <li key={e.url}><a href={e.url} target="_blank" rel="noreferrer nofollow">{e.title}</a> · {EVIDENCE[e.kind]}{e.date ? ` · ${shortDate(e.date)}` : ""}</li>)}</ul>
          <Link href={`/research/${i.symbol}`} className="t-sm">Open {i.symbol}: quick screen or full research from there (asks before spending)</Link>
          <MyActionButtons subject="radar" refId={`${runId}:${i.symbol}`} symbol={i.symbol} summary={`Radar idea ${i.symbol}`} path="/radar" current={mine} label="Your call:" did="Look into it" passed="Not interested" />
        </div>
      </Disclose>
    </li>
  );
}

export default async function RadarPage() {
  const db = await createClient();
  const [runs, st, mine] = await Promise.all([radarRuns(db, 12), radarStatus(db), loadMyActions(db, 120).catch(() => new Map<string, ActionRecord>())]);
  const ideas = runs.flatMap((r) => r.ideas.map((i) => ({ i, runId: r.id })));
  const q = await getQuotes([...new Set([...ideas.map((x) => x.i.symbol), "VOO"])]).catch(() => new Map());
  const voo = q.get("VOO")?.price ?? null;
  const latest = runs[0] ?? null;
  const scored = ideas.map((x) => ideaResult(x.i, q.get(x.i.symbol)?.price ?? null, voo)).filter((r) => r.edgePct !== null);
  const ahead = scored.filter((r) => r.edgePct! > 0).length;

  return (
    <div className="flex flex-col gap-3 lg:gap-4">
      <Card labelledBy="rd-h" className="!gap-2">
        <CardHead id="rd-h" title="Opportunity Radar" right={<RadarRunner running={st.running} />} />
        <p className="t-sm">Every Wednesday morning: at most three new companies worth a research look, or none. The app screens the S&amp;P 500 in code (leaders, pullbacks in leaders, chart setups), leaves out what you hold or have researched, and one AI pass checks the recent facts. Analyst, fund and social inputs only suggest ideas; an idea needs a dated fact to be named. Nothing is researched or bought automatically, and there are no phone alerts for these.</p>
        {scored.length > 0 && <p className="t-sm">Since they were named, {ahead} of {scored.length} ideas are ahead of VOO over the same days (including ones you passed on). Early days are mostly noise.</p>}
      </Card>

      {latest && (
        <Card labelledBy="rd-last" className="!gap-2">
          <CardHead id="rd-last" title={`Latest run · ${shortDate(latest.at)}`} right={<span className="t-xs">${latest.costUsd.toFixed(2)} · {latest.searches} searches</span>} />
          {!latest.ok ? <p className="t-sm warn">This run failed: {latest.error}</p>
            : latest.ideas.length ? <p className="t-sm">{latest.ideas.length} idea{latest.ideas.length > 1 ? "s" : ""}: {latest.ideas.map((i) => i.symbol).join(", ")}.</p>
            : <p className="t-sm">No idea cleared the bar this time. {latest.noneReason}</p>}
          {latest.rejected.length > 0 && <p className="t-xs">Turned down by the app&apos;s checks: {latest.rejected.map((r) => `${r.symbol} (${r.why})`).join("; ")}.</p>}
          {latest.screen && (
            <Disclose summary={<span className="t-xs">What the screen found ({latest.screen.candidates.length} of {latest.screen.scanned} stocks)</span>}>
              <ul className="t-xs flex flex-col gap-0.5">{latest.screen.candidates.map((c) => <li key={c.symbol}><Link href={`/research/${c.symbol}`}>{c.symbol}</Link> · {KIND[c.kind]} · {c.why}</li>)}</ul>
            </Disclose>
          )}
        </Card>
      )}

      <Card labelledBy="rd-ideas" className="!gap-0" flush>
        <div className="px-4 pt-4 pb-2 lg:px-5"><CardHead id="rd-ideas" title="Ideas so far" /></div>
        {!ideas.length ? <p className="t-sm px-4 pb-4 lg:px-5">None yet. The first run is the next Wednesday morning, or tap Run Radar now.</p> : (
          <ul className="flex flex-col">
            {ideas.map(({ i, runId }) => <IdeaRow key={`${runId}:${i.symbol}`} i={i} runId={runId} now={q.get(i.symbol)?.price ?? null} voo={voo} mine={mine.get(actionRef("radar", `${runId}:${i.symbol}`)) ?? null} />)}
          </ul>
        )}
      </Card>
      <p className="t-xs">Looking for a short-term trade instead? <Link href="/trades">Trade ideas</Link>.</p>
    </div>
  );
}
