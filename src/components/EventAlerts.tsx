import { loadEventAlerts } from "@/lib/alerts/events";
import { buildItems, loadReviewState } from "@/lib/alerts/review";
import { createClient } from "@/lib/supabase/server";
import { FilingReviewList } from "@/components/FilingReview";

/** Filing-driven events for held stocks, as review items. Streams in so the page renders even if SEC is slow. */
export async function EventAlerts({ symbols, now }: { symbols: string[]; now: Date }) {
  const { alerts } = await loadEventAlerts(symbols, now);
  if (!alerts.length) return null;
  const db = await createClient();
  const items = buildItems(alerts, await loadReviewState(db, alerts));
  return (
    <section aria-labelledby="ev-h" className="flex flex-col gap-2">
      <h2 id="ev-h" className="text-lg font-semibold">Company events</h2>
      <FilingReviewList items={items} back="/brief" />
      <p className="text-xs text-muted">From SEC filings. Filed documents are classified by form and item; offering documents by their cover page. An item clears when your research has read it in full or you mark it reviewed.</p>
    </section>
  );
}
