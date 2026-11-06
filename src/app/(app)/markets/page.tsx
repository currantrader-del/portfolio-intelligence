import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { BriefingRunner } from "@/components/intel/BriefingRunner";
import { Card, CardHead, Disclose, Pill } from "@/components/ui";
import { AskButton } from "@/components/AskPanel";
import { GROUP_LABEL, type Group } from "@/lib/intel/instruments";
import { fmtChange, type DeskResult, type Item, type Source } from "@/lib/intel/desks";
import type { Snapshot, Row } from "@/lib/intel/snapshot";
import type { Point, Synthesis } from "@/lib/intel/synthesis";
import type { CalendarEvent } from "@/lib/intel/desks";

export const dynamic = "force-dynamic";

type Briefing = { version: string; generatedAt: string; model: string; snapshotId: string; deskIds: string[]; missingDesks: string[]; synthesis: Synthesis; calendar: CalendarEvent[]; problems: string[]; costUsd: number };

const et = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", ...opts }).format(new Date(iso));
const etDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const KIND_TONE = { verified: "gain", statistical: "info", interpretation: "neutral", speculation: "warn" } as const;
const STANCE_TONE = { bullish: "gain", bearish: "alert", neutral: "neutral", mixed: "warn" } as const;
const ACTION_LABEL = { none: "No action", monitor: "Monitor", research: "Research", review: "Review" } as const;

export default async function MarketsPage() {
  const db = await createClient();
  const now = new Date();
  const [{ data: last }, { data: recentSnap }] = await Promise.all([
    db.from("model_runs").select("id, computed_at, outputs").eq("kind", "market_briefing").order("computed_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("model_runs").select("id, computed_at").eq("kind", "market_snapshot").order("computed_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const b = (last?.outputs ?? null) as Briefing | null;
  const [snapRow, deskRows] = b
    ? await Promise.all([
        db.from("model_runs").select("outputs").eq("id", b.snapshotId).maybeSingle(),
        db.from("model_runs").select("id, outputs").in("id", b.deskIds),
      ])
    : [null, null];
  const snapshot = (snapRow?.data?.outputs ?? null) as Snapshot | null;
  const desks = ((deskRows?.data ?? []) as { id: string; outputs: DeskResult }[]).map((d) => d.outputs).sort((x, y) => ["world", "us", "markets", "events"].indexOf(x.desk) - ["world", "us", "markets", "events"].indexOf(y.desk));
  const fresh = b && etDay(new Date(b.generatedAt)) === etDay(now);
  // Start today's briefing on first open, unless one started in the last 10 minutes.
  const inFlight = recentSnap && now.getTime() - Date.parse(recentSnap.computed_at) < 10 * 60000 && (!last || Date.parse(last.computed_at) < Date.parse(recentSnap.computed_at));
  const auto = !fresh && !inFlight;

  const itemId = new Map<string, { desk: string; item: Item }>();
  desks.forEach((d) => d.items.forEach((it, i) => itemId.set(`${d.desk[0].toUpperCase()}${i + 1}`, { desk: d.title, item: it })));

  return (
    <div className="flex flex-col gap-3 lg:gap-4 max-w-4xl">
      <div className="flex flex-col gap-1">
        <span className="cap">Market intelligence</span>
        <h1 className="h1">{b ? b.synthesis.headline : "Daily market briefing"}</h1>
        {b && <p className="t-xs">Written {et(b.generatedAt, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET · {b.model} · {b.version} · about ${b.costUsd.toFixed(2)}{!fresh ? " · from an earlier day" : ""}</p>}
      </div>

      <Card className="!gap-2">
        {!b && <p className="t-sm">No briefing yet. It reads current market data and macro data, searches for the day&apos;s developments with sources, and writes outlooks and implications for your holdings. It takes about a minute.</p>}
        {b && !fresh && <p className="t-sm warn">This briefing is from an earlier day.</p>}
        <BriefingRunner auto={auto} label={b ? "Refresh briefing" : "Generate briefing"} />
        {inFlight && !fresh && <p className="t-xs">A briefing started in the last few minutes. Refresh the page shortly, or start a new one.</p>}
      </Card>

      {b && (
        <>
          <Card labelledBy="sum-h" className="!gap-2">
            <CardHead id="sum-h" title="What happened and why it matters" />
            <Points points={b.synthesis.summary} items={itemId} />
            {b.synthesis.attention.length > 0 && (
              <div className="flex flex-col gap-1 pt-1">
                <span className="t-xs">Deserves your attention</span>
                <Points points={b.synthesis.attention} items={itemId} />
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 lg:gap-4 items-start">
            <Card labelledBy="st-h" className="!gap-2">
              <CardHead id="st-h" title="Short term · 1–20 trading days" right={<><Pill small tone={STANCE_TONE[b.synthesis.shortTerm.stance]}>{b.synthesis.shortTerm.stance}</Pill><Pill small>{b.synthesis.shortTerm.evidence} evidence</Pill></>} />
              <Labelled label="What supports it"><Points points={b.synthesis.shortTerm.drivers} items={itemId} /></Labelled>
              <Labelled label="Evidence against"><Points points={b.synthesis.shortTerm.contrary} items={itemId} /></Labelled>
              <Labelled label="What would change it"><Plain list={b.synthesis.shortTerm.wouldChange} /></Labelled>
            </Card>
            <Card labelledBy="lt-h" className="!gap-2">
              <CardHead id="lt-h" title="Long term · 6–36 months" right={<><Pill small tone={STANCE_TONE[b.synthesis.longTerm.stance]}>{b.synthesis.longTerm.stance}</Pill><Pill small>{b.synthesis.longTerm.evidence} evidence</Pill></>} />
              {(["base", "bull", "bear"] as const).map((k) => (
                <Disclose key={k} open={k === "base"} summary={<span className="t-sm capitalize">{k} case</span>}>
                  <p className="t-sm">{b.synthesis.longTerm[k].summary}</p>
                  <Labelled label="Conditions"><Plain list={b.synthesis.longTerm[k].conditions} /></Labelled>
                  <Labelled label="Signposts to watch"><Plain list={b.synthesis.longTerm[k].signposts} /></Labelled>
                </Disclose>
              ))}
              <Labelled label="Evidence against the stance"><Points points={b.synthesis.longTerm.contrary} items={itemId} /></Labelled>
              <Labelled label="What would change it"><Plain list={b.synthesis.longTerm.wouldChange} /></Labelled>
              <p className="t-xs">No probabilities or price targets: scenarios describe conditions, not predictions.</p>
            </Card>
          </div>

          <Card labelledBy="pf-h" className="!gap-2">
            <CardHead id="pf-h" title="For your portfolio" right={<span className="t-xs">Holdings are estimates from statements</span>} />
            {b.synthesis.portfolio.length ? (
              <ul className="flex flex-col gap-2">
                {b.synthesis.portfolio.map((p, i) => (
                  <li key={i} className="flex flex-col gap-0.5 t-sm">
                    <span className="flex flex-wrap items-center gap-1.5"><span className="text-ink font-semibold">{p.subject}</span><Pill small tone={p.action === "review" || p.action === "research" ? "warn" : "neutral"}>{ACTION_LABEL[p.action]}</Pill></span>
                    <span>{p.text} <Refs refs={p.refs} items={itemId} /></span>
                  </li>
                ))}
              </ul>
            ) : <p className="t-sm">Nothing specific to your holdings today.</p>}
            <p className="t-xs">The briefing never recommends a trade. Use Ask or the Decisions tab to test an idea against your policy and research.</p>
          </Card>

          <Card labelledBy="cal-h" className="!gap-2">
            <CardHead id="cal-h" title="Coming up" right={<span className="t-xs">Dates ahead only</span>} />
            {b.calendar.length ? (
              <ul className="flex flex-col divide-y divide-line">
                {b.calendar.map((c, i) => (
                  <li key={i} className="py-2 flex flex-col gap-0.5 t-sm">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-ink font-semibold num">{et(`${c.date}T12:00:00Z`, { weekday: "short", month: "short", day: "numeric" })}{c.time ? ` · ${c.time}` : ""}</span>
                      <Pill small>{c.type}</Pill>
                      <Pill small tone={c.status === "confirmed" ? "gain" : "warn"} dot={c.status === "confirmed" ? "solid" : "hollow"}>{c.status}</Pill>
                      {c.symbols.map((s) => <Link key={s} href={`/research/${s}`} className="t-xs">{s}</Link>)}
                    </span>
                    <span className="text-ink">{c.event}</span>
                    {c.expectation && <span className="t-xs">Expectation (as reported): {c.expectation}</span>}
                    {c.why && <span className="t-xs">{c.why}</span>}
                    {c.source && <SourceLink s={c.source} />}
                  </li>
                ))}
              </ul>
            ) : <p className="t-sm">No calendar events were found with sources.</p>}
          </Card>

          {snapshot && <MarketPanel snapshot={snapshot} />}

          {desks.map((d) => (
            <Card key={d.desk} labelledBy={`d-${d.desk}`} className="!gap-2">
              <CardHead id={`d-${d.desk}`} title={d.title} right={<span className="t-xs">{d.searches} searches · {d.pagesReturned} pages</span>} />
              <ul className="flex flex-col divide-y divide-line">
                {d.items.map((it, i) => {
                  const id = `${d.desk[0].toUpperCase()}${i + 1}`;
                  return (
                    <li key={id} id={id} className="py-2 flex flex-col gap-1 scroll-mt-20">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="t-xs num">{id}</span>
                        <Pill small tone={KIND_TONE[it.kind]}>{it.kind}</Pill>
                        {it.significance === "high" && <Pill small tone="copper">high significance</Pill>}
                        {it.unsourced && <Pill small tone="warn" dot="hollow">not confirmed by a returned source</Pill>}
                      </span>
                      <span className="text-ink font-semibold t-sm">{it.headline}</span>
                      <span className="t-sm">{it.detail}</span>
                      {it.portfolio && <span className="t-xs">For your portfolio: {it.portfolio}</span>}
                      <span className="flex flex-col gap-0.5">{it.sources.map((s) => <SourceLink key={s.url} s={s} />)}</span>
                    </li>
                  );
                })}
              </ul>
              {d.uncertainties.length > 0 && <Disclose summary={<span className="t-sm">Could not confirm · {d.uncertainties.length}</span>}><Plain list={d.uncertainties} /></Disclose>}
            </Card>
          ))}

          <Card flush>
            <Disclose summary={<span className="t-sm">Checks, gaps and method</span>}>
              <Labelled label="Data the briefing did not have"><Plain list={[...(snapshot?.missing ?? []).map((m) => `Market data: ${m}`), ...(snapshot?.macroMissing ?? []).map((m) => `Macro: ${m}`), ...b.missingDesks.map((m) => `Research desk did not finish: ${m}`), ...b.synthesis.gaps]} /></Labelled>
              <Labelled label="Automatic checks"><Plain list={[...b.problems, ...desks.flatMap((d) => d.problems.map((p) => `${d.title}: ${p}`))]} empty="All references resolved; every item had a source returned by its search." /></Labelled>
              <Labelled label="Method"><Plain list={[
                ...(snapshot?.notes ?? []),
                "Developments come from Claude web searches. A source is marked checked only when its URL was among the pages the search returned; items without one are flagged.",
                "Kinds: verified = a reported fact; statistical = a data or market observation; interpretation = an explanation (whose is stated); speculation = not established.",
                "Every point in the summary and outlooks links to its evidence (desk items W, U, M; calendar C; market rows; FRED series). Unknown references are removed and reported here.",
              ]} /></Labelled>
            </Disclose>
          </Card>
          <div className="flex gap-2"><AskButton question="Based on today's briefing, what could affect my portfolio over the next week, and what should I check?" className="btn flex-1">Ask about today&apos;s briefing</AskButton></div>
        </>
      )}
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-col gap-1"><span className="t-xs">{label}</span>{children}</div>;
}

function Plain({ list, empty }: { list: string[]; empty?: string }) {
  if (!list.length) return <p className="t-sm">{empty ?? "None."}</p>;
  return <ul className="flex flex-col gap-1 t-sm list-disc pl-5">{list.map((x, i) => <li key={i}>{x}</li>)}</ul>;
}

function Points({ points, items }: { points: Point[]; items: Map<string, { desk: string; item: Item }> }) {
  if (!points.length) return <p className="t-sm">None.</p>;
  return <ul className="flex flex-col gap-1.5 t-sm list-disc pl-5">{points.map((p, i) => <li key={i}>{p.text} <Refs refs={p.refs} items={items} /></li>)}</ul>;
}

function Refs({ refs, items }: { refs: string[]; items: Map<string, { desk: string; item: Item }> }) {
  if (!refs.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {refs.map((r) => {
        const it = items.get(r);
        const label = r.startsWith("S:") ? r.slice(2) : r.startsWith("F:") ? `FRED ${r.slice(2)}` : r;
        const href = it ? `#${r}` : r.startsWith("F:") ? `https://fred.stlouisfed.org/series/${r.slice(2)}` : r.startsWith("C") ? "#cal-h" : "#mkt-h";
        return <a key={r} href={href} title={it?.item.headline} className={`t-xs no-underline rounded px-1 border border-line ${it?.item.unsourced ? "warn" : ""}`} {...(r.startsWith("F:") ? { target: "_blank", rel: "noreferrer" } : {})}>{label}</a>;
      })}
    </span>
  );
}

function SourceLink({ s }: { s: Source }) {
  return (
    <a href={s.url} target="_blank" rel="noreferrer" className="t-xs no-underline break-words">
      <span className={s.checked ? "" : "warn"}>{s.checked ? "✓" : "?"}</span> {s.publisher ?? "Source"} · {s.published ?? "undated"} · <span className="underline">{s.title}</span>
    </a>
  );
}

function cell(v: number | null, kind: Row["kind"]) {
  if (v === null) return <span className="t-xs">—</span>;
  const tone = Math.abs(kind === "yield" ? v / 100 : v) < 1e-9 ? "" : v > 0 ? "gain" : "loss";
  return <span className={`num ${tone}`}>{fmtChange(v, kind)}</span>;
}

function MarketPanel({ snapshot }: { snapshot: Snapshot }) {
  const groups = [...new Set(snapshot.rows.map((r) => r.group))] as Group[];
  const b = snapshot.breadth;
  return (
    <Card labelledBy="mkt-h" className="!gap-2">
      <CardHead id="mkt-h" title="Markets" right={<span className="t-xs">Snapshot {et(snapshot.takenAt, { hour: "numeric", minute: "2-digit" })} ET · Yahoo, delayed</span>} />
      {b && (
        <p className="t-sm">
          Sector breadth: {b.sectorsUp} of {b.sectorsTotal} sectors up today; {b.sectorsAbove50d} above their 50-day average and {b.sectorsAbove200d} above their 200-day. Over a month, equal-weight S&amp;P {fmtChange(b.equalVsCapMonth, "price")} versus cap-weight, small caps {fmtChange(b.smallVsLargeMonth, "price")} versus large. <span className="t-xs">Statistical observation, sector level.</span>
        </p>
      )}
      {groups.map((g) => (
        <Disclose key={g} open={g === "us_equity" || g === "rates"} summary={<span className="t-sm">{GROUP_LABEL[g]}</span>}>
          <div className="overflow-x-auto">
            <table className="t-sm w-full">
              <thead><tr className="t-xs text-left"><th className="font-normal pr-2">Market</th><th className="font-normal pr-2 text-right">Last</th><th className="font-normal pr-2 text-right">Day</th><th className="font-normal pr-2 text-right">1w</th><th className="font-normal pr-2 text-right">1m</th><th className="font-normal text-right">YTD</th></tr></thead>
              <tbody>
                {snapshot.rows.filter((r) => r.group === g).map((r) => (
                  <tr key={r.symbol} className="border-t border-line">
                    <td className="pr-2 py-1">{r.label}<span className="t-xs block">{r.freshness === "previous close" ? "previous close" : r.freshness} · {et(r.marketTime, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></td>
                    <td className="pr-2 text-right num">{r.kind === "yield" ? `${r.last.toFixed(2)}%` : r.last.toLocaleString("en-US", { maximumFractionDigits: r.last < 10 ? 4 : 2 })}</td>
                    <td className="pr-2 text-right">{cell(r.day, r.kind)}</td>
                    <td className="pr-2 text-right">{cell(r.week, r.kind)}</td>
                    <td className="pr-2 text-right">{cell(r.month, r.kind)}</td>
                    <td className="text-right">{cell(r.ytd, r.kind)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Disclose>
      ))}
      {snapshot.macro.length > 0 && (
        <Disclose summary={<span className="t-sm">US macro data (FRED)</span>}>
          <div className="overflow-x-auto">
            <table className="t-sm w-full">
              <thead><tr className="t-xs text-left"><th className="font-normal pr-2">Series</th><th className="font-normal pr-2 text-right">Latest</th><th className="font-normal text-right">Previous</th></tr></thead>
              <tbody>
                {snapshot.macro.map((m) => (
                  <tr key={m.id} className="border-t border-line">
                    <td className="pr-2 py-1"><a href={m.source} target="_blank" rel="noreferrer" className="no-underline">{m.label}</a></td>
                    <td className="pr-2 text-right num whitespace-nowrap">{m.value.toFixed(m.unit === "k" ? 0 : 2)}{m.unit === "%" ? "%" : m.unit === "k" ? "k" : ""}<span className="t-xs block">{m.date}</span></td>
                    <td className="text-right num whitespace-nowrap">{m.previous == null ? "—" : `${m.previous.toFixed(m.unit === "k" ? 0 : 2)}${m.unit === "%" ? "%" : m.unit === "k" ? "k" : ""}`}<span className="t-xs block">{m.previousDate ?? ""}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="t-xs">Official data with its observation date. Monthly and quarterly series lag by weeks.</p>
        </Disclose>
      )}
    </Card>
  );
}
