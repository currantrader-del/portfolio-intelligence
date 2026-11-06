import { getWorkspace } from "@/lib/workspace";
import { freshness, type Freshness as F } from "@/lib/freshness";
import { nyTimeLabel } from "@/lib/market/hours";
import { Freshness } from "@/components/ui";

/** Price freshness for the shell. Streams in after the page so it never holds up navigation. */
export async function Status() {
  const ws = await getWorkspace();
  const latest = [...ws.quotes.values()].map((q) => q.asOf).sort().at(-1);
  if (!latest) return <Freshness state="missing">No prices</Freshness>;
  const state: F = freshness("quote", new Date(latest), ws.now, { marketOpen: ws.marketOpen });
  const time = nyTimeLabel(new Date(latest));
  const label = ws.marketOpen ? `${state === "live" ? "Live" : "Delayed"} · ${time}` : `Closed · ${time}`;
  return <span title={ws.marketOpen ? "Prices from delayed quotes" : "Market closed; last available price"}><Freshness state={state}>{label}</Freshness></span>;
}
