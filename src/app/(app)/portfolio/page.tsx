import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { Tag } from "@/components/Tag";
import { DataQuality } from "@/components/DataQuality";
import { isEtf, LOOKTHROUGH_AS_OF } from "@/lib/portfolio/classify";
import { pctStr, shortDate, toneOf, usd } from "@/lib/format";

const STATUS = {
  below: { tone: "warn", label: "Below range" },
  within: { tone: "accent", label: "Within range" },
  above: { tone: "warn", label: "Above range" },
  over_max: { tone: "alert", label: "Over maximum" },
  no_limit: { tone: "neutral", label: "No limit set" },
} as const;

const time = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

export default async function PortfolioPage() {
  const ws = await getWorkspace();
  const p = ws.portfolio;
  if (!p.holdings.length) {
    return (
      <section className="bg-surface border border-line rounded-2xl p-6 max-w-3xl">
        <h1 className="font-serif text-3xl font-semibold">Portfolio</h1>
        <p className="text-ink-2 mt-2">No holdings loaded yet.</p>
      </section>
    );
  }
  const c = p.cashDetail;
  const session = ws.marketOpen ? "today" : "last session";
  const conflicts = new Set(ws.policy?.audit?.conflicts.map((x) => x.subject) ?? []);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-semibold">Portfolio</h1>
          <p className="text-muted text-sm">Investable capital (excludes the {usd(c.protectedReserve)} protected reserve)</p>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted">{p.quality.status === "verified" ? "Verified value" : "Estimated value"}</div>
          <div className="font-mono text-2xl">{usd(p.total)}</div>
          <div className={`font-mono text-sm ${toneOf(p.dayPct)}`}>{p.dayPct === null ? "No live change" : `${pctStr(p.dayPct, 2, true)} ${session} · ${usd(p.dayDollar)}`}</div>
          {p.sinceStatementDollar !== null && <div className={`font-mono text-xs ${toneOf(p.sinceStatementDollar)}`}>{usd(p.sinceStatementDollar)} price change since statements (est.)</div>}
        </div>
      </div>

      <DataQuality p={p} />

      <section aria-labelledby="acc-h" className="grid gap-2 grid-cols-2 sm:grid-cols-4">
        <h2 id="acc-h" className="sr-only">Accounts and cash</h2>
        {p.accounts.filter((a) => a.role !== "cash" && a.role !== "protected_savings").map((a) => (
          <div key={a.id} className="bg-surface border border-line rounded-xl p-3">
            <div className="font-semibold text-sm leading-tight">{a.name}</div>
            <div className="font-mono">{usd(a.value)}</div>
            <div className="text-xs text-muted">{a.role === "retirement" ? "Roth IRA" : "Taxable"} · stmt {shortDate(a.asOf)}{a.tradesAfter ? ` + ${a.tradesAfter} recorded` : ""}</div>
          </div>
        ))}
        <div className="bg-surface border border-line rounded-xl p-3">
          <div className="font-semibold text-sm">Cash</div>
          <div className="font-mono">{usd(c.deployable)} <span className="font-sans text-xs text-muted">deployable</span></div>
          <div className="text-xs text-muted">{usd(c.brokerage)} brokerage · {c.savings === null ? <Link href="/portfolio/reconcile">savings not entered</Link> : `${usd(c.deployableSavings)} savings above reserve`}</div>
        </div>
      </section>

      <section aria-labelledby="hold-h" className="bg-surface border border-line rounded-2xl">
        <div className="flex items-baseline justify-between px-4 pt-4">
          <h2 id="hold-h" className="font-semibold">Holdings</h2>
          <span className="text-xs text-muted">{p.pricedLive} of {p.holdings.length} priced from delayed quotes</span>
        </div>
        {/* Phones: compact rows. Larger screens: full table. */}
        <ul className="sm:hidden divide-y divide-line mt-2">
          {p.holdings.map((h) => (
            <li key={h.symbol}>
              <details className="px-4 py-2.5">
                <summary className="flex items-center justify-between gap-2 cursor-pointer list-none">
                  <span><span className="font-mono font-medium">{h.symbol}</span> <span className="text-xs text-muted">{pctStr(h.weight)}</span></span>
                  <span className="text-right font-mono text-sm">{usd(h.value)} <span className={toneOf(h.dayPct)}>{pctStr(h.dayPct, 1, true)}</span></span>
                </summary>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mt-2">
                  <dt className="text-muted">Price</dt><dd className="font-mono">{usd(h.price, 2)} · {h.priceSource === "quote" ? `quote ${time(h.priceAsOf)} ET` : `statement ${shortDate(h.priceAsOf)}`}</dd>
                  <dt className="text-muted">Shares</dt><dd className="font-mono">{+h.quantity.toFixed(4)}</dd>
                  <dt className="text-muted">Contribution {session}</dt><dd className={`font-mono ${toneOf(h.contributionPts)}`}>{h.contributionPts === null ? "—" : `${h.contributionPts >= 0 ? "+" : "−"}${Math.abs(h.contributionPts).toFixed(2)} pts`}</dd>
                  <dt className="text-muted">Unrealized</dt><dd className={`font-mono ${toneOf(h.unrealized)}`}>{h.unrealized === null ? "basis unknown" : usd(h.unrealized)}</dd>
                  <dt className="text-muted">Bucket</dt><dd>{h.bucket}</dd>
                  <dt className="text-muted">Accounts</dt><dd>{h.accounts.join(", ")}</dd>
                </dl>
                {!isEtf(h.symbol) && <Link href={`/research/${h.symbol}`} className="text-xs">Research →</Link>}
              </details>
            </li>
          ))}
        </ul>
        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-sm border-collapse mt-2">
            <thead>
              <tr className="text-left text-muted">
                {["Symbol", "Value", "Weight", "Price · source", "Day", "Contrib.", "Unrealized", "Bucket"].map((x) => (
                  <th key={x} scope="col" className="px-3 py-2 font-medium">{x}</th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono">
              {p.holdings.map((h) => (
                <tr key={h.symbol} className="border-t border-line">
                  <td className="px-3 py-2"><Link href={`/research/${h.symbol}`} className="font-medium">{h.symbol}</Link><div className="font-sans text-xs text-muted">{h.accounts.join(", ")}</div></td>
                  <td className="px-3 py-2">{usd(h.value)}</td>
                  <td className="px-3 py-2">{pctStr(h.weight)}</td>
                  <td className="px-3 py-2">{usd(h.price, 2)}<div className="font-sans text-xs text-muted">{h.priceSource === "quote" ? `quote ${time(h.priceAsOf)} ET` : `statement ${shortDate(h.priceAsOf)}`}</div></td>
                  <td className={`px-3 py-2 ${toneOf(h.dayPct)}`}>{pctStr(h.dayPct, 1, true)}</td>
                  <td className={`px-3 py-2 ${toneOf(h.contributionPts)}`}>{h.contributionPts === null ? "—" : `${h.contributionPts >= 0 ? "+" : "−"}${Math.abs(h.contributionPts).toFixed(2)}`}</td>
                  <td className={`px-3 py-2 ${toneOf(h.unrealized)}`}>{h.unrealized === null ? <span className="font-sans text-xs text-muted">basis unknown</span> : usd(h.unrealized)}</td>
                  <td className="px-3 py-2 font-sans text-xs text-ink-2">{h.bucket}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted px-4 py-3">Day change and contributions use each quote&apos;s previous close and today&apos;s quantities. Contribution is in percentage points of investable capital.</p>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="bk-h" className="bg-surface border border-line rounded-2xl p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="bk-h" className="font-semibold">Allocation against your policy</h2>
            <Link href="/policy" className="text-sm">Policy →</Link>
          </div>
          <p className="text-xs text-muted mb-3">{ws.policy?.version ?? "No policy"}</p>
          <ul className="flex flex-col gap-3">
            {p.buckets.map((b) => {
              const s = STATUS[b.status];
              const scale = Math.max(b.hardMax ?? 0, b.weight, b.normal?.high ?? 0, 0.01) * 1.1;
              return (
                <li key={b.bucket} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span>{b.bucket}</span>
                    <span className="flex items-center gap-2"><span className="font-mono">{pctStr(b.weight)}</span><Tag tone={s.tone}>{s.label}</Tag></span>
                  </div>
                  <div className="relative h-2.5 rounded-sm bg-ground" aria-hidden="true">
                    {b.normal && <div className="absolute h-2.5 bg-accent-soft border border-accent/30 rounded-sm" style={{ left: `${(b.normal.low / scale) * 100}%`, width: `${((b.normal.high - b.normal.low) / scale) * 100}%` }} />}
                    <div className="absolute top-[3px] h-1 rounded-sm bg-ink" style={{ width: `${(b.weight / scale) * 100}%` }} />
                    {b.hardMax !== null && <div className="absolute -top-0.5 h-3.5 w-0.5 bg-alert-ink" style={{ left: `${(b.hardMax / scale) * 100}%` }} />}
                  </div>
                  <div className="text-xs text-muted">{b.normal ? `Normal ${pctStr(b.normal.low, 0)}–${pctStr(b.normal.high, 0)}` : "No range"}{b.hardMax !== null ? ` · max ${pctStr(b.hardMax, 0)}` : ""}</div>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="ex-h" className="bg-surface border border-line rounded-2xl p-4">
          <h2 id="ex-h" className="font-semibold">Single-company exposure</h2>
          <p className="text-xs text-muted mb-3">Direct plus approximate ETF look-through (index weights {LOOKTHROUGH_AS_OF}, not live)</p>
          <ul className="flex flex-col divide-y divide-line">
            {[...p.exposures].sort((a, b) => b.total - a.total).map((e) => {
              const lim = ws.policy?.companies[e.symbol];
              return (
                <li key={e.symbol} className="py-2 flex flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-medium">{e.symbol}</span>
                    <span className={`font-mono text-sm ${e.total > e.max ? "text-alert-ink" : ""}`}>{pctStr(e.total)} / {pctStr(e.max, 0)} max</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <span>{pctStr(e.direct)} direct · {pctStr(e.viaEtfs)} via ETFs · room {usd(e.headroomDollars)}</span>
                    {conflicts.has(e.symbol) ? <Tag tone="alert">Limit conflict</Tag> : lim?.status === "approved" ? null : <Tag>Generic limit</Tag>}
                  </div>
                  {lim?.source && <div className="text-xs text-muted">Limit source: {lim.source}</div>}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}
