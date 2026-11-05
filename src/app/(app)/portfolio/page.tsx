import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { Tag } from "@/components/Tag";
import { LOOKTHROUGH_AS_OF } from "@/lib/portfolio/classify";
import { pctStr, shortDate, toneOf, usd } from "@/lib/format";

const STATUS = {
  below: { tone: "warn", label: "Below range" },
  within: { tone: "accent", label: "Within range" },
  above: { tone: "warn", label: "Above range" },
  over_max: { tone: "alert", label: "Over maximum" },
  no_limit: { tone: "neutral", label: "No limit set" },
} as const;

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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-semibold">Portfolio</h1>
          <p className="text-muted text-sm">Quantities from statements; prices live where available ({p.pricedLive} of {p.holdings.length} holdings).</p>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl">{usd(p.total)}</div>
          <div className={`font-mono text-sm ${toneOf(p.dayPct)}`}>{p.dayPct === null ? "No live change" : `${pctStr(p.dayPct, 2, true)} today · ${usd(p.dayDollar)}`}</div>
        </div>
      </div>

      <section aria-labelledby="acc-h" className="grid gap-3 sm:grid-cols-3">
        <h2 id="acc-h" className="sr-only">Accounts</h2>
        {p.accounts.map((a) => (
          <div key={a.id} className="bg-surface border border-line rounded-xl p-4">
            <div className="font-semibold">{a.name}</div>
            <div className="font-mono">{usd(a.value)}</div>
            <div className="text-xs text-muted">{a.role.replace(/_/g, " ")} · statement {shortDate(a.asOf)}</div>
          </div>
        ))}
      </section>

      <section aria-labelledby="hold-h" className="bg-surface border border-line rounded-2xl overflow-x-auto">
        <h2 id="hold-h" className="font-semibold px-5 pt-4">Holdings</h2>
        <table className="w-full min-w-[820px] text-sm border-collapse mt-2">
          <thead>
            <tr className="text-left text-muted">
              {["Symbol", "Value", "Weight", "Price", "Today", "Contribution", "Unrealized", "Bucket", "Accounts"].map((h) => (
                <th key={h} scope="col" className="px-4 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono">
            {p.holdings.map((h) => (
              <tr key={h.symbol} className="border-t border-line">
                <td className="px-4 py-2.5"><Link href={`/research/${h.symbol}`} className="font-medium">{h.symbol}</Link></td>
                <td className="px-4 py-2.5">{usd(h.value)}</td>
                <td className="px-4 py-2.5">{pctStr(h.weight)}</td>
                <td className="px-4 py-2.5">{usd(h.price, 2)}{h.priceSource === "statement" && <span className="font-sans text-xs text-muted"> stmt</span>}</td>
                <td className={`px-4 py-2.5 ${toneOf(h.dayPct)}`}>{pctStr(h.dayPct, 1, true)}</td>
                <td className={`px-4 py-2.5 ${toneOf(h.contributionPts)}`}>{h.contributionPts === null ? "—" : `${h.contributionPts >= 0 ? "+" : "−"}${Math.abs(h.contributionPts).toFixed(2)}`}</td>
                <td className={`px-4 py-2.5 ${toneOf(h.unrealized)}`}>{h.unrealized === null ? <span className="font-sans text-xs text-muted">basis unknown</span> : usd(h.unrealized)}</td>
                <td className="px-4 py-2.5 font-sans text-xs text-ink-2">{h.bucket}</td>
                <td className="px-4 py-2.5 font-sans text-xs text-muted">{h.accounts.join(", ")}</td>
              </tr>
            ))}
            <tr className="border-t border-line">
              <td className="px-4 py-2.5 font-sans">Cash</td>
              <td className="px-4 py-2.5">{usd(p.cash)}</td>
              <td className="px-4 py-2.5">{pctStr(p.total ? p.cash / p.total : 0)}</td>
              <td colSpan={6} className="px-4 py-2.5 font-sans text-xs text-muted">Brokerage cash only. Your protected savings ($10,000 floor) are not tracked here.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="bk-h" className="bg-surface border border-line rounded-2xl p-5">
          <h2 id="bk-h" className="font-semibold">Allocation against your policy</h2>
          <p className="text-xs text-muted mb-3">{ws.policy?.version ?? "No policy"} · latest approved ranges</p>
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

        <section aria-labelledby="ex-h" className="bg-surface border border-line rounded-2xl p-5 overflow-x-auto">
          <h2 id="ex-h" className="font-semibold">Single-company exposure</h2>
          <p className="text-xs text-muted mb-3">Includes what you own through ETFs (weights {LOOKTHROUGH_AS_OF})</p>
          <table className="w-full min-w-[420px] text-sm">
            <thead><tr className="text-left text-muted"><th className="py-1.5 font-medium">Company</th><th className="py-1.5 font-medium">Direct</th><th className="py-1.5 font-medium">Via ETFs</th><th className="py-1.5 font-medium">Total / max</th><th className="py-1.5 font-medium">Room</th></tr></thead>
            <tbody className="font-mono">
              {p.exposures.sort((a, b) => b.total - a.total).map((e) => (
                <tr key={e.symbol} className="border-t border-line">
                  <td className="py-2">{e.symbol}</td>
                  <td className="py-2">{pctStr(e.direct)}</td>
                  <td className="py-2">{pctStr(e.viaEtfs)}</td>
                  <td className={`py-2 ${e.total > e.max ? "text-alert-ink" : ""}`}>{pctStr(e.total)} / {pctStr(e.max, 0)}</td>
                  <td className="py-2">{usd(e.headroomDollars)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
