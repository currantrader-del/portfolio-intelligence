import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Tag } from "@/components/Tag";
import { ORIGIN_LABEL } from "@/lib/research-labels";
import { getWorkspace } from "@/lib/workspace";
import { getQuotes } from "@/lib/market/quotes";
import { expectedReturnAt } from "@/lib/research/valuation";
import { pctStr, usd } from "@/lib/format";

type Row = {
  id: string; symbol: string; name: string | null; watchlist_status: string;
  research_versions: { research_as_of: string; completeness: string; origin: string; is_current: boolean; conclusion: Record<string, unknown> }[];
};

export default async function ResearchPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("companies")
    .select("id, symbol, name, watchlist_status, research_versions(research_as_of, completeness, origin, is_current, conclusion)")
    .order("symbol");
  const rows = (data ?? []) as Row[];
  const ws = await getWorkspace();
  const valued = ws.research.filter((r) => r.current?.parsed.weightedValue);
  const extra = await getQuotes(valued.map((r) => r.symbol).filter((s) => !ws.quotes.has(s)));
  const priceOf = (s: string) => ws.quotes.get(s)?.price ?? extra.get(s)?.price ?? ws.portfolio.holdings.find((h) => h.symbol === s)?.price ?? null;
  const held = new Set(ws.portfolio.holdings.map((h) => h.symbol));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-serif text-3xl font-semibold">Research</h1>
        <p className="text-muted">Every stored conclusion keeps its date and where it came from.</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-ink-2">No research imported yet.</p>
      ) : (
        <div className="bg-surface border border-line rounded-2xl overflow-x-auto">
          <table className="w-full min-w-[800px] text-sm border-collapse">
            <thead>
              <tr className="text-left text-muted">
                <th scope="col" className="px-5 py-3 font-medium">Company</th>
                <th scope="col" className="px-5 py-3 font-medium">Latest conclusion</th>
                <th scope="col" className="px-5 py-3 font-medium">Price</th>
                <th scope="col" className="px-5 py-3 font-medium">Exp. return today</th>
                <th scope="col" className="px-5 py-3 font-medium">Research date</th>
                <th scope="col" className="px-5 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const versions = [...r.research_versions].sort((a, b) => b.research_as_of.localeCompare(a.research_as_of));
                const current = versions.find((v) => v.is_current);
                const latest = current ?? versions[0];
                const conflict = versions.length > 1 && !current;
                const action = latest?.conclusion?.["action"] as string | undefined;
                const rec = ws.research.find((x) => x.symbol === r.symbol);
                const price = priceOf(r.symbol);
                const er = rec?.current && price ? expectedReturnAt(rec.current.parsed, price, ws.now) : null;
                return (
                  <tr key={r.id} className="border-t border-line">
                    <td className="px-5 py-3">
                      <Link href={`/research/${r.symbol}`} className="font-mono font-medium">{r.symbol}</Link>
                      {r.name && <div className="text-muted text-xs">{r.name}{held.has(r.symbol) ? " · held" : ""}</div>}
                    </td>
                    <td className="px-5 py-3">{action ?? <span className="text-muted">—</span>}</td>
                    <td className="px-5 py-3 font-mono">{price ? usd(price, 2) : "—"}</td>
                    <td className="px-5 py-3 font-mono">{er === null ? <span className="text-muted">—</span> : pctStr(er)}</td>
                    <td className="px-5 py-3">{latest ? latest.research_as_of : "—"}</td>
                    <td className="px-5 py-3 flex flex-wrap gap-1.5">
                      {conflict && <Tag tone="alert">Records conflict</Tag>}
                      {latest && <Tag tone={latest.completeness === "complete" ? "accent" : "warn"}>{latest.completeness.replace("_", " ")}</Tag>}
                      {latest && <Tag>{ORIGIN_LABEL[latest.origin] ?? latest.origin}</Tag>}
                      {!latest && <Tag>Not researched</Tag>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
