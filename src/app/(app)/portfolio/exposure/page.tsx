import { getWorkspace } from "@/lib/workspace";
import { insights, type Action } from "@/lib/exposure/insights";
import { NOT_PROPOSED, PROPOSALS, type LimitCheck } from "@/lib/exposure/limits";
import { THEMES } from "@/lib/exposure/reference";
import type { Dimension, ExposureReport, Line } from "@/lib/exposure/engine";
import { pctStr, usd } from "@/lib/format";
import { Bar, Card, CardHead, DataLabel, Disclose, LinkRow, PageHeader, Pill } from "@/components/ui";
import { ExposureReview } from "@/components/exposure/ExposureReview";
import { SendButton } from "@/components/exposure/SendButton";
import { sendProposals } from "./actions";

export const metadata = { title: "Exposure" };

const ACTION: Record<Action, { tone: "alert" | "warn" | "neutral" | "info" | "copper"; label: string }> = {
  reduce: { tone: "alert", label: "Reduce" },
  review: { tone: "warn", label: "Review" },
  maintain: { tone: "neutral", label: "Maintain" },
  research: { tone: "info", label: "Research" },
  info: { tone: "neutral", label: "Good to know" },
};
const STATE: Record<LimitCheck["state"], { tone: "alert" | "warn" | "neutral"; label: string }> = {
  over_ceiling: { tone: "alert", label: "Over ceiling" },
  review: { tone: "warn", label: "Review level" },
  above_normal: { tone: "neutral", label: "Above normal" },
  below_normal: { tone: "neutral", label: "Below normal" },
  within: { tone: "neutral", label: "Within range" },
  no_range: { tone: "neutral", label: "Under review level" },
};

const range = (l: Line) => (l.upperPct !== undefined ? `${pctStr(l.pct)}–${pctStr(l.upperPct)}` : pctStr(l.pct));

export default async function ExposurePage({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const sp = await searchParams;
  const ws = await getWorkspace();
  const r = ws.exposure;
  if (!ws.portfolio.holdings.length) return <Card><p className="t-sm">No holdings loaded yet.</p></Card>;
  const checks = ws.exposureLimits;
  const list = insights(r, checks, ws.portfolio.exposures);
  const inv = (v: number) => (r.investable ? v / r.investable : 0);
  const check = (subject: string) => checks.find((c) => c.subject === subject);
  const top = (d: Dimension) => d.lines[0];
  const sector = top(r.dims.sector), industry = top(r.dims.industry), theme = top(r.dims.theme), company = top(r.dims.company);
  const companyLimit = ws.portfolio.exposures.find((e) => e.symbol === company?.key);
  const mk = (k: string) => r.dims.market.lines.find((l) => l.key === k);
  const stale = r.sources.filter((s) => s.stale);
  const oldest = [...r.sources].sort((a, b) => a.source.asOf.localeCompare(b.source.asOf))[0];

  const rows: { label: string; name: string; value: string; note: string; subject?: string }[] = [
    sector && { label: "Largest sector", name: sector.key, value: pctStr(sector.pct), note: `of your stocks · world market ${pctStr(sector.benchmarkPct ?? null)} · ${usd(sector.direct)} direct, ${usd(sector.indirect)} through funds`, subject: `exposure:sector:${sector.key}` },
    industry && { label: "Largest industry", name: industry.key.replace(" & Semiconductor Equipment", " and equipment"), value: range(industry), note: `of your stocks · ${pctStr(inv(industry.value))}${industry.upper ? `–${pctStr(inv(industry.upper))}` : ""} of investable capital`, subject: `exposure:industry:${industry.key}` },
    theme && { label: "Largest theme", name: theme.key, value: range(theme), note: `of your stocks · ${theme.contributors.slice(0, 4).map((c) => c.via).join(", ")}`, subject: `exposure:theme:${theme.key}` },
    { label: "Where", name: "US · developed · emerging", value: `${pctStr(mk("US")?.pct ?? 0, 0)} · ${pctStr(mk("Developed ex-US")?.pct ?? 0, 0)} · ${pctStr(mk("Emerging")?.pct ?? 0, 0)}`, note: `of your stocks · world market about 65% US · emerging up to ${pctStr(mk("Emerging")?.upperPct ?? mk("Emerging")?.pct ?? 0)}`, subject: "exposure:market:Emerging" },
    company && { label: "Largest company", name: company.key, value: pctStr(inv(company.value)), note: `of invested portfolio · ${usd(company.direct)} direct, ${usd(company.indirect)} through funds${companyLimit ? ` · your max ${pctStr(companyLimit.max, 0)}` : ""}` },
  ].filter(Boolean) as { label: string; name: string; value: string; note: string; subject?: string }[];

  return (
    <div className="flex flex-col gap-3 lg:gap-4">
      <PageHeader title="Exposure" kicker="Sectors, industries, themes and markets, with fund look-through" />

      <div className="grid grid-cols-1 gap-3 lg:gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-7" labelledBy="ov-h">
          <CardHead id="ov-h" title="What you're exposed to" right={<DataLabel kind={ws.portfolio.quality.status === "verified" ? "verified" : "estimated"} small />} />
          <ul className="flex flex-col divide-y divide-line">
            {rows.map((x) => {
              const c = x.subject ? check(x.subject) : undefined;
              const st = c ? STATE[c.state] : null;
              return (
                <li key={x.label} className="py-2.5 flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="t-xs">{x.label}</span>
                    <span className="t-sm text-ink font-semibold">{x.name}</span>
                    <span className="t-xs">{x.note}</span>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0 text-right">
                    <span className="t-val num">{x.value}</span>
                    {c && st ? <Pill small tone={st.tone}>{c.status === "proposed" ? `${st.label} · proposed` : st.label}</Pill> : x.label === "Largest company" && companyLimit ? <Pill small tone={companyLimit.total >= companyLimit.max * 0.9 ? "warn" : "neutral"}>{companyLimit.total > companyLimit.max ? "Over max" : companyLimit.total >= companyLimit.max * 0.9 ? "At its limit" : "Within limit"}</Pill> : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="t-xs">Invested portfolio {usd(r.investable)} (savings excluded; total investable capital incl. savings is {usd(ws.portfolio.investableCapital)}); stocks {usd(r.equity)}. A range means the funds don&apos;t publish enough detail to pin it down; the low end counts only companies identified. Fund data as of {oldest?.source.asOf ?? "—"} or later{stale.length ? `; ${stale.length} source${stale.length > 1 ? "s are" : " is"} stale` : ""}.</p>
        </Card>

        <Card className="lg:col-span-5" labelledBy="do-h">
          <CardHead id="do-h" title="What Claude recommends" right={<DataLabel kind="recommendation" small />} />
          <ul className="flex flex-col gap-3">
            {list.filter((i) => i.id !== "gaps").slice(0, 6).map((i) => (
              <li key={i.id} className="flex flex-col gap-1">
                <div className="flex items-start justify-between gap-2"><span className="t-sm text-ink font-semibold">{i.title}</span><Pill small tone={ACTION[i.action].tone} className="shrink-0">{ACTION[i.action].label}</Pill></div>
                <span className="t-xs">{i.detail}</span>
              </li>
            ))}
          </ul>
          <p className="t-xs">Being under a limit is not a reason to buy, and being above a normal range is not by itself a reason to sell.</p>
          <LinkRow href="/assistant">Ask about any sector, market, fund or stock</LinkRow>
        </Card>

        <div className="lg:col-span-12"><ExposureReview /></div>

        <Card className="lg:col-span-12" id="limits" labelledBy="lim-h">
          <CardHead id="lim-h" title="Exposure limits" right={checks.length ? <Pill small tone={checks.some((c) => c.status === "proposed") ? "warn" : "neutral"}>{checks.some((c) => c.status === "proposed") ? "Waiting for your approval" : "Approved"}</Pill> : <Pill small tone="warn">Draft</Pill>} />
          {sp.error && <p role="alert" className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2">{sp.error}</p>}
          {sp.sent && <p role="status" className="t-sm rounded-[12px] bg-surface-2 px-3 py-2">{Number(sp.sent) ? `Sent ${sp.sent} proposed limits to Policy. They control nothing until you approve them there.` : "These limits were already on your Policy page."}</p>}
          <LimitsTable r={r} checks={checks} />
          {checks.length ? (
            <LinkRow href="/policy">{checks.some((c) => c.status === "proposed") ? "Approve or reject them on Policy" : "See them on Policy"}</LinkRow>
          ) : (
            <form action={sendProposals} className="flex flex-col gap-2">
              <p className="t-xs">These are drafts. Sending them adds them to your Policy page as proposals, where you approve or reject each one. Until then they are shown for information only and never block anything.</p>
              <SendButton pending="Sending…">Send to Policy for approval</SendButton>
            </form>
          )}
          <Disclose summary="What is deliberately not limited, and why">
            <ul className="flex flex-col gap-1.5 t-sm">{NOT_PROPOSED.map((n) => <li key={n.exposure}><span className="text-ink">{n.exposure}:</span> {n.reason}</li>)}</ul>
          </Disclose>
        </Card>

        <Card className="lg:col-span-12" labelledBy="det-h">
          <CardHead id="det-h" title="Supporting calculations" />
          {(["sector", "industry", "theme", "country", "market", "region", "company", "size", "style", "cycle", "asset"] as const).map((k) => <DimensionDetail key={k} d={r.dims[k]} />)}
          <Disclose summary={`Fund overlap (${r.overlaps.length})`}>
            <ul className="flex flex-col gap-1.5 t-sm">{r.overlaps.map((o) => <li key={o.a + o.b}>{o.note}</li>)}</ul>
          </Disclose>
          <Disclose summary="Concentration and interest rates">
            <div className="flex flex-col gap-1.5 t-sm">
              <p>Your 10 largest companies (direct + through funds) are {pctStr(r.concentration.top10Pct)} of your stocks; for the world market the 10 largest are {pctStr(r.concentration.benchmarkTop10)}.</p>
              {r.rates.notes.map((n) => <p key={n}>{n}</p>)}
            </div>
          </Disclose>
          <Disclose summary={`Sources and dates (${r.sources.length})`}>
            <ul className="flex flex-col gap-1 t-xs">
              {r.sources.map((s) => <li key={s.fund + s.what}><span className="text-ink">{s.fund} {s.what}:</span> <a href={s.source.url} target="_blank" rel="noreferrer">{s.source.label}</a>, as of {s.source.asOf} ({s.ageDays} days){s.stale ? " · stale" : ""}</li>)}
            </ul>
          </Disclose>
          <Disclose summary="How this is calculated, and what it can't see">
            <div className="flex flex-col gap-1.5 t-sm">
              <p>Each stock you own counts at its value. Each fund is split by its own published sector, country and largest-holding weights, so a fund is never counted next to its own holdings. Each split adds up to 100% of your stocks, with a &quot;not itemized&quot; remainder for what the funds don&apos;t publish. Themes overlap, so their percentages are never added together.</p>
              <p>Themes: {Object.values(THEMES).map((t) => `${t.label}: ${t.definition}`).join(" ")}</p>
              {r.gaps.map((g) => <p key={g} className="warn">{g}</p>)}
            </div>
          </Disclose>
          <LinkRow href="/risk">Stress tests</LinkRow>
        </Card>
      </div>
    </div>
  );
}

function LimitsTable({ r, checks }: { r: ExposureReport; checks: LimitCheck[] }) {
  const rows = PROPOSALS.map((p) => {
    const c = checks.find((x) => x.subject === p.subject);
    const l = r.dims[p.dimension].lines.find((x) => x.key === p.key);
    const now = c?.value ?? (l && r.investable ? l.value / r.investable : 0);
    const up = c?.upper ?? (l?.upper && r.investable ? l.upper / r.investable : null);
    return { p, c, now, up };
  });
  return (
    <ul className="flex flex-col gap-4">
      {rows.map(({ p, c, now, up }) => (
        <li key={p.subject} className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="t-sm text-ink font-semibold">{p.label}</span>
            <span className="t-xs num"><span className="text-ink">{pctStr(now)}{up && up > now + 0.0005 ? `–${pctStr(up)}` : ""}</span> · review {pctStr(c?.review ?? p.review, 0)} · ceiling {pctStr(c?.ceiling ?? p.ceiling, 0)}</span>
          </div>
          <Bar thin value={up ?? now} max={c?.ceiling ?? p.ceiling} markers={[...new Set([c?.review ?? p.review, ...(p.normal ? [p.normal.low, p.normal.high] : [])])]} label={`${p.label} ${pctStr(now)} of a ${pctStr(p.ceiling, 0)} ceiling`} />
          <span className="t-xs">{p.normal ? `Normal ${pctStr(p.normal.low, 0)}–${pctStr(p.normal.high, 0)} (${p.evidence.normal}). ` : "No normal range. "}Review: {p.evidence.review}. Ceiling: {p.evidence.ceiling}.{c ? ` Status: ${c.status}.` : ""}</span>
          <Disclose summary="Why these numbers">
            <div className="flex flex-col gap-1 t-sm">
              <p>{p.why}</p>
              <ul className="t-xs flex flex-col gap-0.5">{p.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.label}</a> ({s.date})</li>)}</ul>
            </div>
          </Disclose>
        </li>
      ))}
    </ul>
  );
}

function DimensionDetail({ d }: { d: Dimension }) {
  const lines = d.lines.slice(0, d.key === "company" ? 20 : 15);
  return (
    <Disclose summary={`${d.label}${d.additive ? "" : " (overlapping)"}`}>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full t-xs num">
          <thead><tr className="text-left"><th className="py-1 px-1 font-medium">{d.label}</th><th className="px-1 text-right font-medium">Share</th><th className="px-1 text-right font-medium">Direct</th><th className="px-1 text-right font-medium">Via funds</th>{d.lines.some((l) => l.benchmarkPct != null) && <th className="px-1 text-right font-medium">World</th>}</tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key} className="border-t border-line align-top">
                <td className="py-1 px-1 text-ink">{l.key}<div className="t-xs font-normal">{l.contributors.slice(0, 4).map((c) => `${c.via} ${usd(c.value)}`).join(" · ")}</div></td>
                <td className="px-1 text-right text-ink">{range(l)}</td>
                <td className="px-1 text-right">{usd(l.direct)}</td>
                <td className="px-1 text-right">{usd(l.indirect)}</td>
                {d.lines.some((x) => x.benchmarkPct != null) && <td className="px-1 text-right">{l.benchmarkPct != null ? pctStr(l.benchmarkPct) : ""}</td>}
              </tr>
            ))}
            {d.notItemized > 0.5 && <tr className="border-t border-line"><td className="py-1 px-1">Not itemized by the sources</td><td className="px-1 text-right">{pctStr(d.notItemizedPct)}</td><td /><td className="px-1 text-right">{usd(d.notItemized)}</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="t-xs mt-1">Percent of {d.base === "equity" ? "your stocks" : "your invested portfolio"} ({usd(d.baseValue)}).{d.notes.length ? ` ${d.notes.join(" ")}` : ""}</p>
    </Disclose>
  );
}

