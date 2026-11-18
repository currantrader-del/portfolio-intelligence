import { getWorkspace } from "@/lib/workspace";
import { freshness, type Freshness as F } from "@/lib/freshness";
import { nyTimeLabel } from "@/lib/market/hours";
import { Freshness } from "@/components/ui";

/** Price freshness for the shell. Streams in after the page so it never holds up navigation. */
export async function Status() {
  // This sits in the shell, outside every page's error screen: if loading fails here, show nothing
  // rather than let the whole app crash. The page itself still shows its own "didn't load" card.
  let ws: Awaited<ReturnType<typeof getWorkspace>>;
  try {
    ws = await getWorkspace();
  } catch (e) {
    console.error("Status: workspace failed to load", e);
    return null;
  }
  const latest = [...ws.quotes.values()].map((q) => q.asOf).sort().at(-1);
  if (!latest) return <Freshness state="missing">No prices</Freshness>;
  const state: F = freshness("quote", new Date(latest), ws.now, { marketOpen: ws.marketOpen });
  const time = nyTimeLabel(new Date(latest));
  const label = ws.marketOpen ? `${state === "live" ? "Live" : "Delayed"} · ${time}` : `Closed · ${time}`;
  return <span title={ws.marketOpen ? "Prices from delayed quotes" : "Market closed; last available price"}><Freshness state={state}>{label}</Freshness></span>;
}
