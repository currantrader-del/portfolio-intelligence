import { reviewPosition } from "@/lib/decision/review";
import { AGE_REMINDER_DAYS } from "@/lib/policy/limits";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SchwabCard } from "@/components/SchwabCard";
import { connection } from "@/lib/schwab/client";
import { lastSync } from "@/lib/schwab/sync";
import { recentSchwabTrades } from "@/lib/schwab/market";
import { getWorkspace } from "@/lib/workspace";
import { isEtf, LOOKTHROUGH_AS_OF } from "@/lib/portfolio/classify";
import { coverage } from "@/lib/research/status";
import type { Holding } from "@/lib/portfolio/engine";
import { pctStr, shortDate, toneOf, usd } from "@/lib/format";
import { Bar, Card, CardHead, Cap, DataLabel, Disclose, Dot, LinkRow, Metric, PageHeader, Pill, Seg, Tick } from "@/components/ui";
import { DataQualityNote } from "@/components/cards/DataQuality";

const STATUS = {
  below: { tone: null, label: "Below guide range" },
  within: { tone: null, label: "Within guide range" },
  above: { tone: null, label: "Above guide range" },
  over_max: { tone: "loss", label: "Over maximum" },
  no_limit: { tone: null, label: "No limit set" },
} as const;
const SWATCH = ["#c98c68", "#8a6a55", "#b9a089", "#5c6068", "#7b8590", "#45484f", "#34373d", "#2a2c31"];
const SORTS = { value: "Value", day: "Today", gain: "Gain" } as const;
type SortKey = keyof typeof SORTS;

const time = (iso: string) => new Date(iso).toLocaleString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const pts = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`);
const STALE_DAYS = 31;

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<{ sort?: string; schwab?: string }> }) {
  const sp = await searchParams;
  const sdb = await createClient();
  const [schwab, schwabLast, schwabTrades] = await Promise.all([connection(sdb).catch(() => null), lastSync(sdb).catch(() => null), recentSchwabTrades(sdb, 8).catch(() => [])]);
  const sort: SortKey = sp.sort && sp.sort in SORTS ? (sp.sort as SortKey) : "value";
  const ws = await getWorkspace();
  const p = ws.portfolio;
  if (!p.holdings.length) {
    return (
      <Card className="max-w-xl">
        <h1 className="h1">Portfolio</h1>
        <p className="t-sm">No holdings loaded yet.</p>
        <div><Link href="/portfolio/reconcile" className="btn">Add a statement</Link></div>
      </Card>
    );
  }
  const c = p.cashDetail;
  const session = ws.marketOpen ? "today" : "last session";
  const verified = p.quality.status === "verified";
  const conflicts = new Set(ws.policy?.audit?.conflicts.map((x) => x.subject) ?? []);
  const freshDays = AGE_REMINDER_DAYS;
  const name = (s: string) => ws.research.find((r) => r.symbol === s)?.name ?? null;
  const exposure = new Map(p.exposures.map((e) => [e.symbol, e]));
  const sorted = [...p.holdings].sort((a, b) =>
    sort === "day" ? Math.abs(b.dayPct ?? 0) - Math.abs(a.dayPct ?? 0) : sort === "gain" ? (b.unrealized ?? -Infinity) - (a.unrealized ?? -Infinity) : b.value - a.value);
  const first = sorted.slice(0, 6);
  const rest = sorted.slice(6);
  const accounts = p.accounts.filter((a) => a.role !== "cash" && a.role !== "protected_savings");
  const buckets = p.buckets.filter((b) => b.weight > 0.0005 || b.hardMax !== null);
  const sortItems = (Object.keys(SORTS) as SortKey[]).map((k) => ({ key: k, label: SORTS[k], href: k === "value" ? "/portfolio" : `/portfolio?sort=${k}` }));

  return (
    <div className="flex flex-col gap-3 lg:gap-4">
      <PageHeader title="Portfolio" actionsDesktopOnly actions={<Link href="/portfolio/reconcile" className="btn max-lg:btn-sm">Reconcile</Link>} />

      <div className="grid grid-cols-1 gap-3 lg:gap-4 lg:grid-cols-12">
        {schwab && <SchwabCard c={schwab} last={schwabLast} note={sp.schwab} trades={schwabTrades} />}
        {/* Portfolio Summary */}
        <Card className="lg:col-span-4" labelledBy="cap-h">
          <CardHead id="cap-h" cap={p.quality.reconciliation.complete ? "Invested portfolio" : "Invested portfolio · incomplete"} right={<DataLabel kind={verified ? "verified" : "estimated"} />} />
          <div className="flex flex-col gap-1.5">
            <span className="t-big">{usd(p.total)}</span>
            <span className="t-sm num">
              {p.dayPct === null ? "No live change" : <><span className={toneOf(p.dayPct)}>{pctStr(p.dayPct, 2, true)} · {p.dayDollar !== null && p.dayDollar >= 0 ? "+" : ""}{usd(p.dayDollar)}</span> {session}</>}
            </span>
          </div>
          <div className="divider" />
          <div className="grid grid-cols-2 gap-2">
            <Metric size="sm" label="Since statements" value={p.sinceStatementDollar === null ? "—" : `${p.sinceStatementDollar >= 0 ? "+" : ""}${usd(p.sinceStatementDollar)}`} note="price change, est." tone={p.sinceStatementDollar === null ? null : p.sinceStatementDollar >= 0 ? "gain" : "loss"} />
            <Metric size="sm" label="Total investable capital" value={usd(p.investableCapital)} note={`+ ${usd(c.deployableSavings)} savings`} />
            <Metric size="sm" label="Weights and limits use" value="Invested" note="savings never change them" />
          </div>
          <DataQualityNote p={p} />
        </Card>

        <Card className="lg:col-span-4 !gap-1 !pb-1.5" labelledBy="acc-h">
          <div className="mb-1"><CardHead id="acc-h" title="Accounts" right={<span className="t-xs">statement date</span>} /></div>
          <div className="list">
            {accounts.map((a) => {
              const stale = a.ageDays > STALE_DAYS;
              return (
                <div key={a.id} className="li !min-h-12">
                  <div className="flex-1 min-w-0 flex flex-col">
                    <span className="font-semibold truncate">{a.name}</span>
                    <span className="t-xs">{a.role === "retirement" ? "Roth IRA" : "Taxable"} · {shortDate(a.asOf)}{a.tradesAfter ? ` + ${a.tradesAfter} recorded` : ""}{stale && <span className="warn"> · stale</span>}</span>
                  </div>
                  <span className="num font-semibold">{usd(a.value)}</span>
                </div>
              );
            })}
            <Link href="/portfolio/reconcile" className="li !min-h-12">
              <div className="flex-1 min-w-0 flex flex-col">
                <span className="font-semibold">Cash and savings</span>
                <span className="t-xs">{usd(c.brokerage)} in brokerage · {c.savings === null ? "savings not entered" : `${usd(c.deployableSavings)} savings`}</span>
              </div>
              {c.savings === null ? <Pill tone="warn">Add</Pill> : <span className="num font-semibold">{usd(c.deployable)}</span>}
            </Link>
          </div>
        </Card>

        {/* Allocation */}
        <Card className="lg:col-span-4" labelledBy="al-h">
          <CardHead id="al-h" title="Allocation" right={<Link href="/policy" className="t-xs no-underline hover:text-ink">% of invested portfolio · vs policy</Link>} />
          <div className="flex h-2.5 rounded-full overflow-hidden gap-0.5" role="img" aria-label={buckets.map((b) => `${b.bucket} ${pctStr(b.weight, 0)}`).join(", ")}>
            {buckets.filter((b) => b.weight > 0).map((b, i) => <span key={b.bucket} style={{ width: `${b.weight * 100}%`, background: b.status === "over_max" ? "var(--warn-ink)" : SWATCH[i % SWATCH.length] }} />)}
          </div>
          <ul className="flex flex-col gap-2">
            {buckets.map((b, i) => {
              const s = STATUS[b.status];
              const range = b.normal ? `${pctStr(b.normal.low, 0)}–${pctStr(b.normal.high, 0)}` : null;
              return (
                <li key={b.bucket} className="flex items-center justify-between gap-3 t-sm">
                  <span className="flex items-center gap-2 min-w-0"><Dot style={{ color: b.status === "over_max" ? "var(--warn-ink)" : SWATCH[i % SWATCH.length] }} /><span className="truncate">{b.bucket}</span></span>
                  <span className={`num shrink-0 ${s.tone === "loss" ? "warn" : s.tone === "warn" ? "text-ink" : ""}`} title={s.label}>
                    {pctStr(b.weight, 0)} <span className="t-xs">· {b.status === "over_max" && b.hardMax !== null ? `max ${pctStr(b.hardMax, 0)}` : range ?? "no range"}</span>
                    {b.status !== "within" && b.status !== "no_limit" && <span className="sr-only"> ({s.label})</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          <span className="t-xs">{ws.policy?.version ?? "No policy loaded"}</span>
        </Card>

        {/* Holdings */}
        <Card className="lg:col-span-12 !gap-2 !pb-1.5" labelledBy="hold-h">
          <CardHead id="hold-h" title="Holdings" right={<span className="t-xs">{p.holdings.length} positions · {p.pricedLive} on delayed quotes</span>} />
          <div className="lg:hidden"><Seg items={sortItems} current={sort} label="Sort holdings" /></div>

          {/* Phones */}
          <div className="list lg:hidden">
            {first.map((h) => <HoldingRow key={h.symbol} h={h} name={name(h.symbol)} verb={isEtf(h.symbol) ? null : reviewPosition(ws, h.symbol)?.now.verb ?? null} />)}
          </div>
          {rest.length > 0 && (
            <div className="lg:hidden border-t border-line">
              <Disclose summary={`Show ${rest.length} more`}>
                <div className="list -mt-2">{rest.map((h) => <HoldingRow key={h.symbol} h={h} name={name(h.symbol)} verb={isEtf(h.symbol) ? null : reviewPosition(ws, h.symbol)?.now.verb ?? null} />)}</div>
              </Disclose>
            </div>
          )}

          {/* Desktop */}
          <div className="max-lg:hidden overflow-x-auto -mx-1">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">Holding</th><th scope="col">Bucket</th><th scope="col" className="n">Shares</th><th scope="col" className="n">Price</th>
                  <th scope="col" className="n">Value</th><th scope="col" className="n">Today</th><th scope="col" className="n">Contrib.</th><th scope="col" className="n">Weight</th>
                  <th scope="col">Exposure vs limit</th><th scope="col" className="n">Unrealized</th><th scope="col">Research</th><th scope="col">Action now</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((h) => {
                  const e = exposure.get(h.symbol);
                  const cov = isEtf(h.symbol) ? null : coverage(ws.research.find((r) => r.symbol === h.symbol), h.price, ws.now, freshDays);
                  return (
                    <tr key={h.symbol}>
                      <td><Link href={`/research/${h.symbol}`} className="no-underline"><strong className="text-ink">{h.symbol}</strong> <span className="t-xs">{name(h.symbol) ?? ""}</span></Link></td>
                      <td className="whitespace-nowrap">{h.bucket.replace(" individual stocks", "").replace("/high-risk growth sleeve", "")}</td>
                      <td className="n">{+h.quantity.toFixed(4)}</td>
                      <td className="n" title={h.priceSource === "quote" ? `Delayed quote ${time(h.priceAsOf)} ET` : `Statement price ${shortDate(h.priceAsOf)}`}>{usd(h.price, 2)}{h.priceSource === "statement" && <span className="t-xs"> stmt</span>}</td>
                      <td className="n text-ink">{usd(h.value)}</td>
                      <td className={`n ${toneOf(h.dayPct)}`}>{pctStr(h.dayPct, 1, true)}</td>
                      <td className={`n ${toneOf(h.contributionPts)}`}>{pts(h.contributionPts)}</td>
                      <td className="n">{pctStr(h.weight)}</td>
                      <td>
                        {e && !isEtf(h.symbol) ? (
                          <div className="flex items-center gap-2 min-w-40">
                            <div className="w-24"><Bar thin value={e.total} max={e.max} /></div>
                            <span className="t-xs num whitespace-nowrap">{(e.total * 100).toFixed(1)} / {(e.max * 100).toFixed(0)}{conflicts.has(h.symbol) && <span className="warn"> · conflict</span>}</span>
                          </div>
                        ) : <span className="t-xs">—</span>}
                      </td>
                      <td className={`n ${toneOf(h.unrealized)}`}>{h.unrealized === null ? <span className="t-xs">basis unknown</span> : usd(h.unrealized)}</td>
                      <td>{cov ? <Pill small tone={cov.tone} dot={cov.dot} title={cov.detail}>{cov.label}</Pill> : <span className="t-xs">ETF</span>}</td>
                      <td>{(() => { const n = isEtf(h.symbol) ? null : reviewPosition(ws, h.symbol)?.now; return n ? <Link href={`/decisions/review/${h.symbol}`} title={`${n.headline}${n.levels ? ` Levels: ${n.levels}` : ""}`} className="no-underline"><Pill small tone={n.verb === "Hold" ? "neutral" : "warn"}>{n.verb}</Pill></Link> : <span className="t-xs">—</span>; })()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="t-xs py-2">Prices are delayed quotes where available, otherwise the statement price. Contribution is in points of the invested portfolio; day change uses each quote&apos;s previous close.</p>
        </Card>

        {/* Allocation / Exposure */}
        <Card className="lg:col-span-12" labelledBy="ex-h">
          <CardHead id="ex-h" title="Single-company exposure" right={<DataLabel kind="estimate" small>ETF look-through approx.</DataLabel>} />
          <ul className="grid gap-x-8 gap-y-3 lg:grid-cols-2">
            {[...p.exposures].sort((a, b) => b.total - a.total).map((e) => {
              const lim = ws.policy?.companies[e.symbol];
              const conflict = conflicts.has(e.symbol);
              return (
                <li key={e.symbol} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/research/${e.symbol}`} className="t-sm text-ink font-semibold no-underline">{e.symbol}</Link>
                    <span className="t-xs num">
                      <span className="text-ink">{pctStr(e.total)}</span> of invested · {pctStr(p.investableCapital ? (e.total * p.total) / p.investableCapital : e.total)} of all investable · limit {pctStr(e.max, 0)} (of invested)
                      {conflict ? <span className="warn"> · conflict</span> : lim?.status === "approved" ? null : <span> · generic</span>}
                    </span>
                  </div>
                  <Bar thin value={e.total} max={e.max} label={`${e.symbol} ${pctStr(e.total)} of a ${pctStr(e.max, 0)} limit`} />
                  <span className="t-xs" title={e.lookthroughGaps.join("; ") || undefined}>{pctStr(e.direct)} direct · {pctStr(e.viaEtfs)} via ETFs{e.totalMax - e.total > 0.0005 ? ` (could be up to ${pctStr(e.totalMax)} in total: fund holdings only partly published)` : ""} · room {usd(e.headroomDollars)}</span>
                </li>
              );
            })}
          </ul>
          <p className="t-xs">Index weights as of {LOOKTHROUGH_AS_OF}, not live. Conflicted limits use the stricter source until you choose.</p>
          <LinkRow href="/portfolio/exposure">Sector, industry, theme and country exposure</LinkRow>
          <LinkRow href="/risk">Concentration and stress tests</LinkRow>
        </Card>
      </div>
      <Cap className="sr-only">End of portfolio</Cap>
    </div>
  );
}

/** Holding Card (compact row for phones). */
function HoldingRow({ h, name, verb }: { h: Holding; name: string | null; verb: string | null }) {
  return (
    <Link href={`/research/${h.symbol}`} className="li">
      <Tick symbol={h.symbol} />
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="font-semibold">{h.symbol}</span>
        <span className="t-xs truncate">{verb ? <span className={verb === "Hold" ? "" : "warn"}>{verb} · </span> : null}{name ?? h.bucket}</span>
      </span>
      <span className="flex flex-col items-end shrink-0">
        <span className="num font-semibold">{usd(h.value)}</span>
        <span className="t-xs num"><span className={toneOf(h.dayPct)}>{pctStr(h.dayPct, 1, true)}</span> · {pctStr(h.weight)}</span>
      </span>
    </Link>
  );
}
