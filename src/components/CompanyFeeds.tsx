import { getFilings, getFundamentals, type Metric } from "@/lib/market/sec";
import { getNews } from "@/lib/market/news";
import { shortDate, pctStr, toneOf } from "@/lib/format";
import { Card, CardHead, DataLabel, Disclose, Metric as M, Pill, Skel, SourceRef } from "@/components/ui";

function compact(n: number | null | undefined, unit: Metric["unit"]): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (unit === "USD/share") return `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : a.toFixed(0);
  return `${n < 0 ? "−" : ""}${unit === "shares" ? "" : "$"}${s}`;
}

const unavailable = (what: string, why: string) => <p className="t-sm">{what} unavailable: {why}</p>;

/** Reported financials: four headline items as reported to the SEC, the full table on demand. */
export async function FundamentalsCard({ symbol }: { symbol: string }) {
  const r = await getFundamentals(symbol);
  const pick = (k: string) => ("error" in r ? undefined : r.metrics.find((m) => m.key === k || m.label.toLowerCase().startsWith(k)));
  const rev = pick("revenue"), op = pick("operating income"), ocf = pick("operating cash"), sh = pick("shares");
  const q = rev?.latestQuarter ?? rev?.latest ?? null;
  return (
    <Card labelledBy="fun-h" className="!gap-2.5">
      <CardHead id="fun-h" title="Reported financials" right={!("error" in r) && <SourceRef kind="SEC">{q ? `qtr to ${shortDate(q.end).replace(/, \d{4}$/, "")}` : "as reported"}</SourceRef>} />
      {"error" in r ? unavailable("Financials", r.error) : r.metrics.length === 0 ? unavailable("Financials", "no XBRL data for this company") : (
        <>
          <div className="grid grid-cols-2 gap-3">
            {rev && <M size="sm" label="Revenue, quarter" value={<>{compact(rev.latestQuarter?.value ?? rev.latest?.value, rev.unit)} {rev.yoy !== null && <span className={`t-xs ${toneOf(rev.yoy)}`}>{pctStr(rev.yoy, 0, true)}</span>}</>} />}
            {op && <M size="sm" label="Operating income, quarter" value={<>{compact(op.latestQuarter?.value ?? op.latest?.value, op.unit)} {op.yoy !== null && <span className={`t-xs ${toneOf(op.yoy)}`}>{pctStr(op.yoy, 0, true)}</span>}</>} />}
            {ocf && <M size="sm" label="Operating cash flow, 12m" value={compact(ocf.ttm, ocf.unit)} />}
            {sh && <M size="sm" label="Shares, vs a year ago" value={sh.yoy === null ? "—" : pctStr(sh.yoy, 1, true)} tone={sh.yoy !== null && sh.yoy > 0.02 ? "warn" : null} />}
          </div>
          <div className="border-t border-line -mb-2">
            <Disclose summary="All reported items">
              <div className="overflow-x-auto -mx-1">
                <table className="tbl">
                  <thead><tr><th>Item</th><th className="n">Latest</th><th className="n">vs year ago</th><th className="n">12 months</th></tr></thead>
                  <tbody>
                    {r.metrics.map((m) => {
                      const latest = m.latestQuarter ?? m.latest;
                      return (
                        <tr key={m.key}>
                          <td>{m.label}<div className="t-xs">{latest ? `${m.latestQuarter ? "Quarter to" : latest.start ? "Year to" : "As of"} ${shortDate(latest.end)}` : ""}</div></td>
                          <td className="n text-ink">{compact(latest?.value, m.unit)}</td>
                          <td className={`n ${toneOf(m.yoy)}`}>{m.yoy === null ? "—" : pctStr(m.yoy, 0, true)}</td>
                          <td className="n">{compact(m.ttm, m.unit)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {r.missing.length > 0 && <p className="t-xs">Not found in SEC data: {r.missing.join(", ")}.</p>}
              <p className="t-xs">As reported to the SEC · checked {shortDate(r.fetchedAt)}</p>
            </Disclose>
          </div>
        </>
      )}
    </Card>
  );
}

/** Filings list for a disclosure section. */
export async function FilingsList({ symbol }: { symbol: string }) {
  const r = await getFilings(symbol);
  if ("error" in r) return unavailable("Filings", r.error);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-3">
        <M size="sm" label="Last earnings release" value={r.lastEarnings ? shortDate(r.lastEarnings.filed) : "None recent"} />
        <M size="sm" label="Next report" value={r.nextEarningsEstimate ? <>~{shortDate(r.nextEarningsEstimate).replace(/, \d{4}$/, "")} <DataLabel kind="estimate" small>est.</DataLabel></> : "Unknown"} />
      </div>
      <ul className="flex flex-col">
        {r.filings.slice(0, 10).map((f) => (
          <li key={f.url + f.filed + f.form} className="flex items-start justify-between gap-3 py-2 border-t border-line first:border-t-0">
            <a href={f.url} target="_blank" rel="noreferrer" className="t-sm no-underline hover:text-ink min-w-0"><span className="pill pill-sm mr-2 align-middle">{f.form}</span>{f.description}</a>
            <span className="t-xs shrink-0 flex items-center gap-1.5">{f.isEarnings && <Pill small tone="copper">Earnings</Pill>}{shortDate(f.filed).replace(/, \d{4}$/, "")}</span>
          </li>
        ))}
      </ul>
      <SourceRef kind="SEC">EDGAR · checked {shortDate(r.fetchedAt)}</SourceRef>
    </div>
  );
}

export async function NewsList({ symbol, name, limit = 8 }: { symbol: string; name?: string | null; limit?: number }) {
  const r = await getNews(symbol, name, limit);
  if ("error" in r) return unavailable("Headlines", r.error);
  return (
    <div className="flex flex-col gap-2">
      <HeadlineList items={r.headlines} />
      <span className="t-xs">{r.feed} · headlines are unverified leads, not facts</span>
    </div>
  );
}

export function HeadlineList({ items }: { items: { title: string; url: string; publisher: string | null; publishedAt: string | null }[] }) {
  return (
    <ul className="flex flex-col">
      {items.map((h) => (
        <li key={h.url} className="py-2 border-t border-line first:border-t-0">
          <a href={h.url} target="_blank" rel="noreferrer nofollow" className="t-sm no-underline hover:text-ink">{h.title}</a>
          <div className="t-xs">{[h.publisher, h.publishedAt ? shortDate(h.publishedAt) : null].filter(Boolean).join(" · ")}</div>
        </li>
      ))}
    </ul>
  );
}

/** Brief page: headlines for the holdings that moved the most. */
export async function MoverHeadlines({ movers }: { movers: { symbol: string; dayPct: number | null; name?: string | null }[] }) {
  const rows = await Promise.all(movers.map(async (m) => ({ ...m, r: await getNews(m.symbol, m.name, 2) })));
  const ok = rows.filter((x) => !("error" in x.r));
  return (
    <Card labelledBy="why-h">
      <CardHead id="why-h" title="Headlines behind the moves" right={<DataLabel kind="unverified" small />} />
      {ok.length === 0 ? <p className="t-sm">Headlines unavailable right now.</p> : ok.map((x) => (
        <div key={x.symbol} className="flex flex-col gap-1">
          <div className="t-sm"><span className="font-semibold text-ink">{x.symbol}</span> <span className={`num ${toneOf(x.dayPct)}`}>{pctStr(x.dayPct, 1, true)}</span></div>
          {"error" in x.r ? null : <HeadlineList items={x.r.headlines} />}
        </div>
      ))}
    </Card>
  );
}

export function FeedSkeleton({ title }: { title: string }) {
  return (
    <Card label={title}>
      <span className="h2">{title}</span>
      <Skel w="85%" /><Skel w="70%" /><Skel w="78%" />
    </Card>
  );
}

export function LinesSkeleton() {
  return <div className="flex flex-col gap-2" aria-hidden="true"><Skel w="90%" /><Skel w="75%" /><Skel w="82%" /></div>;
}
