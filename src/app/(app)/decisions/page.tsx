import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/workspace";
import { pctStr, shortDate, toneOf } from "@/lib/format";
import { Card, PageHeader, Pill, Seg } from "@/components/ui";
import { AlertList } from "@/components/cards/Alerts";
import { NewCapitalView, parseAmount } from "@/components/decisions/NewCapitalView";
import { parseSource } from "@/lib/decision/newCapital";
import { CurrentPortfolioView } from "@/components/decisions/CurrentPortfolioView";

const ACTION_LABEL: Record<string, string> = {
  followed: "Followed", partially_followed: "Partly followed", declined: "Did something else", deferred: "Deferred", dismissed: "Dismissed",
};
const KIND_LABEL = (k: string) => (k === "historical" ? "Imported history" : k === "new_capital" ? "New cash" : k === "alert_review" ? "Position review" : k.replace("_", " "));
type Tab = "current" | "whatif" | "reviews" | "past";

export default async function DecisionsPage({ searchParams }: { searchParams: Promise<{ saved?: string; tab?: string; amount?: string; source?: string; confirmed?: string }> }) {
  const sp = await searchParams;
  // Current portfolio is the default. "new" (the old New cash tab) and an amount in the URL open What-if.
  const tab: Tab = sp.tab === "reviews" || sp.tab === "past" || sp.tab === "whatif" ? sp.tab : sp.tab === "new" || sp.amount || sp.source ? "whatif" : sp.saved ? "past" : "current";
  const ws = await getWorkspace();
  const reviews = ws.alerts.filter((a) => a.kind === "review" || a.kind === "over_limit" || a.kind === "price_zone" || a.kind === "big_move");

  return (
    <div className="flex flex-col gap-3 lg:gap-4">
      <PageHeader title="Decisions" actionsDesktopOnly actions={<Link href="/decisions?tab=past" className="btn">History</Link>} />
      <div className="lg:max-w-md">
        <Seg label="Decision type" current={tab} items={[
          { key: "current", label: "Current portfolio", href: "/decisions" },
          { key: "whatif", label: "What-if", href: "/decisions?tab=whatif" },
          { key: "reviews", label: <>Reviews{reviews.length ? <span className="num opacity-70 ml-1">{reviews.length}</span> : null}</>, href: "/decisions?tab=reviews" },
          { key: "past", label: "Past", href: "/decisions?tab=past" },
        ]} />
      </div>
      {tab === "current" && <CurrentPortfolioView ws={ws} confirmed={sp.confirmed === "1"} />}
      {tab === "whatif" && <p className="t-sm lg:max-w-3xl">What-if: try a deposit or transfer that has not happened yet. Nothing here is your current position; the Current portfolio tab is.</p>}
      {tab === "whatif" && <NewCapitalView ws={ws} amount={parseAmount(sp.amount)} source={parseSource(sp.source)} confirmed={sp.confirmed === "1"} action="/decisions" />}
      {tab === "reviews" && (
        <Card className="!gap-1 !pb-1.5 lg:max-w-3xl">
          {reviews.length ? <AlertList alerts={reviews} wrap /> : <p className="t-sm py-2">No position needs a review right now. Reviews appear when a holding moves sharply, crosses a research price band or goes over its limit.</p>}
        </Card>
      )}
      {tab === "past" && <Past saved={!!sp.saved} ws={ws} />}
    </div>
  );
}

async function Past({ saved, ws }: { saved: boolean; ws: Awaited<ReturnType<typeof getWorkspace>> }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("decisions")
    .select("id, kind, symbol, decided_at, recommendation, user_action, user_note, status, research_as_of, imported_at, execution")
    .order("decided_at", { ascending: false });
  const priceNow = (s: string) => ws.quotes.get(s)?.price ?? null;

  return (
    <div className="flex flex-col gap-3 lg:max-w-3xl">
      {saved && <p role="status" className="t-sm rounded-[12px] bg-surface-2 px-3 py-2">Decision saved.</p>}
      {!data?.length ? <Card><p className="t-sm">No decisions recorded yet.</p></Card> : data.map((d) => {
        const r = d.recommendation as { action?: string; summary?: string; prices_at_decision?: Record<string, number>; to_verify?: string[] };
        const exec = d.execution as { description?: string } | null;
        const then = r.prices_at_decision ?? {};
        const outcomes = Object.entries(then).filter(([s]) => s !== "SPY").map(([s, p0]) => ({ s, ret: priceNow(s) ? priceNow(s)! / p0 - 1 : null })).filter((o) => o.ret !== null);
        const spyRet = then.SPY && priceNow("SPY") ? priceNow("SPY")! / then.SPY - 1 : null;
        const days = Math.floor((ws.now.getTime() - new Date(d.decided_at).getTime()) / 86_400_000);
        return (
          <article key={d.id} className="card !gap-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col min-w-0">
                <span className="font-semibold text-ink">{d.symbol ? <Link href={`/research/${d.symbol}`} className="no-underline">{d.symbol}</Link> : null}{d.symbol ? " · " : ""}{r.action ?? "Recommendation"}</span>
                <span className="t-xs">{d.kind === "historical" ? "Recommended" : "Decided"} {shortDate(d.decided_at)}{d.research_as_of ? ` · research ${shortDate(d.research_as_of)}` : ""}{d.imported_at ? ` · imported ${shortDate(d.imported_at)}` : ""}</span>
              </div>
              <div className="flex flex-wrap justify-end gap-1.5">
                <Pill small>{KIND_LABEL(d.kind)}</Pill>
                {d.status === "wait_review" && <Pill small tone="warn">Conditional / wait</Pill>}
                {d.status === "actionable" && <Pill small tone="copper">Actionable</Pill>}
              </div>
            </div>
            {r.summary && <p className="t-sm">{r.summary}</p>}
            {r.to_verify && r.to_verify.length > 0 && <p className="t-xs">Open at the time: {r.to_verify.join("; ")}</p>}
            <div className="flex flex-wrap gap-1.5">
              {d.user_action ? <Pill small tone="gain" dot="solid">{ACTION_LABEL[d.user_action] ?? d.user_action}</Pill> : d.kind === "historical" ? <Pill small dot="hollow">Your action not recorded</Pill> : null}
              {d.kind === "historical" && <span className="t-xs self-center">archive gives one date for recommendation and research</span>}
            </div>
            {exec?.description && <p className="t-sm">Traded: {exec.description}</p>}
            {d.user_note && <p className="t-sm">Your note: {d.user_note}</p>}
            {outcomes.length > 0 && (
              <div className="t-sm num flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-2">
                <span className="t-xs self-center">Since then ({days} days, price only):</span>
                {outcomes.map((o) => <span key={o.s}>{o.s} <span className={toneOf(o.ret)}>{pctStr(o.ret, 1, true)}</span></span>)}
                {spyRet !== null && <span>S&amp;P 500 <span className={toneOf(spyRet)}>{pctStr(spyRet, 1, true)}</span></span>}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
