import { getNews } from "@/lib/market/news";
import { pctStr, shortDate, toneOf } from "@/lib/format";
import { headlineTiming } from "@/lib/market/hours";

export async function MoverHeadlines({ movers, window }: { movers: { symbol: string; dayPct: number | null; name?: string | null }[]; window?: { startIso: string; endIso: string } }) {
  const rows = await Promise.all(movers.map(async (m) => ({ ...m, r: await getNews(m.symbol, m.name, 2) })));
  const ok = rows.filter((x) => !("error" in x.r));
  if (!ok.length) return <p className="t-sm">Headlines are unavailable right now.</p>;
  return (
    <div className="flex flex-col gap-3">
      {ok.map((x) => (
        <div key={x.symbol} className="flex flex-col gap-1.5">
          <div className="t-sm"><span className="font-semibold text-ink">{x.symbol}</span> <span className={`num ${toneOf(x.dayPct)}`}>{pctStr(x.dayPct, 1, true)}</span></div>
          {"error" in x.r ? null : x.r.headlines.map((h) => (
            <a key={h.url} href={h.url} target="_blank" rel="noreferrer nofollow" className="t-sm no-underline hover:text-ink">
              {h.title}
              <span className="block t-xs">{[h.publisher, h.publishedAt ? shortDate(h.publishedAt) : null].filter(Boolean).join(" · ")}{window && headlineTiming(h.publishedAt, window.startIso, window.endIso) === "after" ? <span className="warn"> · published after this move, not its cause</span> : null}</span>
            </a>
          ))}
        </div>
      ))}
      <p className="t-xs">Headlines are leads to check, not reasons to trade.</p>
    </div>
  );
}

