import { AppHeader } from "@/components/AppHeader";
import { MobileNav } from "@/components/MobileNav";
import { FreshnessDot } from "@/components/FreshnessDot";
import { getWorkspace } from "@/lib/workspace";
import { freshness, type Freshness } from "@/lib/freshness";
import { nyTimeLabel } from "@/lib/market/hours";
import { pctStr } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ws = await getWorkspace();
  const p = ws.portfolio;
  const latestQuote = [...ws.quotes.values()].map((q) => q.asOf).sort().at(-1);
  let state: Freshness = "missing";
  let label = "No prices available";
  if (latestQuote) {
    state = freshness("quote", new Date(latestQuote), ws.now, { marketOpen: ws.marketOpen });
    label = ws.marketOpen ? `Prices ${state === "live" ? "live" : "delayed"} ${nyTimeLabel(new Date(latestQuote))}` : `Market closed · last price ${nyTimeLabel(new Date(latestQuote))}`;
  }
  if (!p.holdings.length) label += " · no holdings yet";

  const ticker = (
    <div className="hidden md:flex gap-4 font-mono text-xs text-chrome-muted">
      {ws.benchmarks.map((b) => (
        <span key={b.symbol} title={`${b.label} (${b.symbol})`}>
          {b.symbol} <span className={b.dayPct === null ? "" : b.dayPct >= 0 ? "text-[#6fcf97]" : "text-[#ff8a80]"}>{pctStr(b.dayPct, 1, true)}</span>
        </span>
      ))}
    </div>
  );

  return (
    <>
      <AppHeader freshness={<FreshnessDot state={state} label={label} />} ticker={ticker} />
      <main className="mx-auto max-w-[1280px] px-4 sm:px-8 py-7 pb-24 md:pb-7">{children}</main>
      <MobileNav />
    </>
  );
}
