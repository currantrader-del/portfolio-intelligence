import { getFilings, getFundamentals, type Metric } from "@/lib/market/sec";
import { getNews } from "@/lib/market/news";
import { shortDate, pctStr, toneOf } from "@/lib/format";
import { Tag } from "@/components/Tag";

function compact(n: number | null | undefined, unit: Metric["unit"]): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (unit === "USD/share") return `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : a.toFixed(0);
  return `${n < 0 ? "−" : ""}${unit === "shares" ? "" : "$"}${s}`;
}

const card = "bg-surface border border-line rounded-2xl p-5 flex flex-col gap-3";
const unavailable = (what: string, why: string) => (
  <p className="text-sm text-muted">{what} unavailable: {why}</p>
);

export async function FilingsSection({ symbol }: { symbol: string }) {
  const r = await getFilings(symbol);
  return (
    <section aria-labelledby="fil-h" className={card}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="fil-h" className="font-semibold">SEC filings and earnings</h2>
        {!("error" in r) && <span className="text-xs text-muted">SEC EDGAR · checked {shortDate(r.fetchedAt)}</span>}
      </div>
      {"error" in r ? unavailable("Filings", r.error) : (
        <>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-muted">Last earnings release</dt><dd className="font-medium">{r.lastEarnings ? <a href={r.lastEarnings.url} target="_blank" rel="noreferrer">{shortDate(r.lastEarnings.filed)}</a> : "None in recent filings"}</dd></div>
            <div><dt className="text-muted">Next report</dt><dd className="font-medium">{r.nextEarningsEstimate ? <>around {shortDate(r.nextEarningsEstimate)} <Tag tone="warn">Estimate</Tag></> : "Unknown"}</dd></div>
          </dl>
          <ul className="flex flex-col divide-y divide-line text-sm">
            {r.filings.slice(0, 10).map((f) => (
              <li key={f.url + f.filed} className="py-2 flex flex-wrap items-baseline justify-between gap-x-3">
                <a href={f.url} target="_blank" rel="noreferrer" className="flex-1 min-w-0"><span className="font-mono text-xs mr-2">{f.form}</span>{f.description}</a>
                <span className="text-xs text-muted flex items-center gap-2">{f.isEarnings && <Tag tone="accent">Earnings</Tag>}{shortDate(f.filed)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export async function FundamentalsSection({ symbol }: { symbol: string }) {
  const r = await getFundamentals(symbol);
  return (
    <section aria-labelledby="fun-h" className={card}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="fun-h" className="font-semibold">Reported financials</h2>
        {!("error" in r) && <span className="text-xs text-muted">As reported to the SEC · checked {shortDate(r.fetchedAt)}</span>}
      </div>
      {"error" in r ? unavailable("Financials", r.error) : r.metrics.length === 0 ? unavailable("Financials", "no XBRL data for this company") : (
        <>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm">
              <thead className="text-muted text-xs text-left">
                <tr><th className="font-normal py-1 px-1">Item</th><th className="font-normal px-1 text-right">Latest</th><th className="font-normal px-1 text-right">vs year ago</th><th className="font-normal px-1 text-right">Last 12 months</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.metrics.map((m) => {
                  const latest = m.latestQuarter ?? m.latest;
                  return (
                    <tr key={m.key}>
                      <td className="py-1.5 px-1">{m.label}<div className="text-xs text-muted">{latest ? `${m.latestQuarter ? "Quarter ended" : latest.start ? "Year ended" : "As of"} ${shortDate(latest.end)}` : ""}</div></td>
                      <td className="px-1 text-right font-mono">{compact(latest?.value, m.unit)}</td>
                      <td className={`px-1 text-right font-mono ${toneOf(m.yoy)}`}>{m.yoy === null ? "—" : pctStr(m.yoy, 0, true)}</td>
                      <td className="px-1 text-right font-mono">{compact(m.ttm, m.unit)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {r.missing.length > 0 && <p className="text-xs text-muted">Not found in SEC data: {r.missing.join(", ")}.</p>}
        </>
      )}
    </section>
  );
}

export async function NewsSection({ symbol, name, limit = 8, title = "Recent headlines" }: { symbol: string; name?: string | null; limit?: number; title?: string }) {
  const r = await getNews(symbol, name, limit);
  return (
    <section aria-label={title} className={card}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        {!("error" in r) && <span className="text-xs text-muted">{r.feed} · unverified</span>}
      </div>
      {"error" in r ? unavailable("Headlines", r.error) : <HeadlineList items={r.headlines} />}
    </section>
  );
}

export function HeadlineList({ items }: { items: { title: string; url: string; publisher: string | null; publishedAt: string | null }[] }) {
  return (
    <ul className="flex flex-col divide-y divide-line text-sm">
      {items.map((h) => (
        <li key={h.url} className="py-2">
          <a href={h.url} target="_blank" rel="noreferrer nofollow">{h.title}</a>
          <div className="text-xs text-muted">{[h.publisher, h.publishedAt ? shortDate(h.publishedAt) : null].filter(Boolean).join(" · ")}</div>
        </li>
      ))}
    </ul>
  );
}

/** Today: headlines for the holdings that moved the most, so a move can be checked against news. */
export async function MoverHeadlines({ movers }: { movers: { symbol: string; dayPct: number | null; name?: string | null }[] }) {
  const rows = await Promise.all(movers.map(async (m) => ({ ...m, r: await getNews(m.symbol, m.name, 2) })));
  const ok = rows.filter((x) => !("error" in x.r));
  return (
    <section aria-labelledby="why-h" className={card}>
      <div>
        <h2 id="why-h" className="font-semibold">Headlines behind the moves</h2>
        <p className="text-xs text-muted">Recent headlines for your biggest movers. Unverified, and not a reason to trade by themselves.</p>
      </div>
      {ok.length === 0 ? <p className="text-sm text-muted">Headlines unavailable right now.</p> : ok.map((x) => (
        <div key={x.symbol} className="flex flex-col gap-1">
          <div className="text-sm font-medium"><a href={`/research/${x.symbol}`} className="no-underline text-ink font-mono">{x.symbol}</a> <span className={`font-mono ${toneOf(x.dayPct)}`}>{pctStr(x.dayPct, 1, true)}</span></div>
          {"error" in x.r ? null : <HeadlineList items={x.r.headlines} />}
        </div>
      ))}
    </section>
  );
}

export function FeedSkeleton({ title }: { title: string }) {
  return (
    <section className={card} aria-busy="true">
      <h2 className="font-semibold">{title}</h2>
      <p className="text-sm text-muted">Loading…</p>
    </section>
  );
}
