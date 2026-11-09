import { Card, CardHead } from "@/components/ui";
import { shortDate } from "@/lib/format";

type Opt = { id: string; research_as_of: string } | null;

/**
 * "Share full research": downloads the complete saved investigation as a PDF for someone else, with
 * holdings, cost basis, cash, savings, limits and account details removed. Nothing is re-run.
 */
export function ShareResearchCard({ symbol, latest, approved }: { symbol: string; latest: Opt; approved: Opt }) {
  if (!latest && !approved) return null;
  const same = !!latest && !!approved && latest.id === approved.id;
  return (
    <Card labelledBy="share-h" className="!gap-2">
      <CardHead id="share-h" cap="Share full research" />
      <form action={`/api/research/${encodeURIComponent(symbol)}/share`} method="get" target="_blank" className="flex flex-col gap-2">
        {same || !approved || !latest ? (
          <>
            <input type="hidden" name="version" value={latest ? "latest" : "approved"} />
            <p className="t-sm">{latest ? `Most recent full investigation, ${shortDate(latest.research_as_of)}` : `Approved research, ${shortDate(approved!.research_as_of)}`}{same ? " (also your approved research)" : approved ? "" : " · not approved"}</p>
          </>
        ) : (
          <fieldset className="flex flex-col gap-1.5 t-sm">
            <label className="flex items-start gap-2"><input type="radio" name="version" value="latest" defaultChecked className="mt-1" /><span>Most recent investigation, {shortDate(latest.research_as_of)} <span className="t-xs">· not approved</span></span></label>
            <label className="flex items-start gap-2"><input type="radio" name="version" value="approved" className="mt-1" /><span>Approved research, {shortDate(approved.research_as_of)}</span></label>
          </fieldset>
        )}
        <button type="submit" className="btn btn-sm self-start">Download PDF</button>
        <p className="t-xs">The complete saved research: all six phases, valuation workings, skeptical review, reviewer corrections and sources. Your holdings, share counts, cost basis, cash, savings, limits and account details are removed and marked. Built from saved data only, with no AI cost.</p>
      </form>
    </Card>
  );
}
