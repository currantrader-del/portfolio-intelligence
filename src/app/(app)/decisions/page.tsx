import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/workspace";
import { Tag } from "@/components/Tag";
import { pctStr, shortDate, toneOf } from "@/lib/format";

const ACTION_LABEL: Record<string, string> = {
  followed: "Followed", partially_followed: "Partly followed", declined: "Did something else", deferred: "Deferred", dismissed: "Dismissed",
};

export default async function DecisionsPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const ws = await getWorkspace();
  const { data } = await supabase
    .from("decisions")
    .select("id, kind, symbol, decided_at, recommendation, user_action, user_note")
    .order("decided_at", { ascending: false });

  const priceNow = (s: string) => ws.quotes.get(s)?.price ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-semibold">Decisions</h1>
          <p className="text-muted">Every recommendation, what you did, and how it has turned out since.</p>
        </div>
        <Link href="/decisions/new-capital" className="min-h-11 px-4 inline-flex items-center rounded-lg bg-ink text-ground no-underline font-medium">New cash decision</Link>
      </div>
      {sp.saved && <div className="rounded-xl bg-accent-soft text-accent px-4 py-3 text-sm">Decision saved.</div>}
      {!data?.length ? (
        <p className="text-ink-2">No decisions recorded yet.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {data.map((d) => {
            const r = d.recommendation as { action?: string; summary?: string; prices_at_decision?: Record<string, number>; confidence?: number };
            const then = r.prices_at_decision ?? {};
            const outcomes = Object.entries(then)
              .filter(([s]) => s !== "SPY")
              .map(([s, p0]) => ({ s, ret: priceNow(s) ? priceNow(s)! / p0 - 1 : null }))
              .filter((o) => o.ret !== null);
            const spyRet = then.SPY && priceNow("SPY") ? priceNow("SPY")! / then.SPY - 1 : null;
            const days = Math.floor((ws.now.getTime() - new Date(d.decided_at).getTime()) / 86_400_000);
            return (
              <li key={d.id} className="bg-surface border border-line rounded-xl p-5 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {d.symbol && <Link href={`/research/${d.symbol}`} className="font-mono font-medium">{d.symbol}</Link>}
                  <span className="font-semibold">{r.action ?? "Recommendation"}</span>
                  <Tag>{d.kind === "historical" ? "Imported history" : d.kind === "new_capital" ? "New cash" : d.kind === "alert_review" ? "Position review" : d.kind.replace("_", " ")}</Tag>
                  {d.user_action && <Tag tone="accent">{ACTION_LABEL[d.user_action] ?? d.user_action}</Tag>}
                  <span className="text-sm text-muted ml-auto">{shortDate(d.decided_at)}</span>
                </div>
                {r.summary && <p className="text-sm text-ink-2">{r.summary}</p>}
                {d.user_note && <p className="text-sm">Your note: {d.user_note}</p>}
                {outcomes.length > 0 && (
                  <div className="text-sm flex flex-wrap gap-x-4 gap-y-1 font-mono">
                    <span className="font-sans text-muted">Since then ({days} days):</span>
                    {outcomes.map((o) => <span key={o.s}>{o.s} <span className={toneOf(o.ret)}>{pctStr(o.ret, 1, true)}</span></span>)}
                    {spyRet !== null && <span>S&amp;P 500 <span className={toneOf(spyRet)}>{pctStr(spyRet, 1, true)}</span></span>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
