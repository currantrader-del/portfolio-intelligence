import Link from "next/link";
import { EVENT_WINDOW, loadEventAlerts, type ResearchDate } from "@/lib/alerts/events";
import type { Alert } from "@/lib/alerts/rules";
import { Card, CardHead, Dot, Skel } from "@/components/ui";
import { buildItems, loadReviewState } from "@/lib/alerts/review";
import { createClient } from "@/lib/supabase/server";
import { FilingReviewList } from "@/components/FilingReview";

const ORDER = { high: 0, medium: 1, low: 2 };
const COLOR = { high: "var(--loss)", medium: "var(--warn-ink)", low: "var(--muted)" };

/**
 * Market Event card for held stocks, in two lists that never mix: "Coming up" holds only future
 * dates (estimated unless confirmed); "Filed recently" holds documents already filed, to review.
 */
export async function EventsCard({ symbols, now, dates }: { symbols: string[]; now: Date; dates?: Map<string, ResearchDate> }) {
  const { alerts } = await loadEventAlerts(symbols, now, dates);
  const sort = (xs: Alert[]) => [...xs].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const upcoming = sort(alerts.filter((a) => a.timing === "upcoming")).slice(0, 4);
  const filed = alerts.filter((a) => a.timing !== "upcoming");
  const recent = filed.length ? buildItems(filed, await loadReviewState(await createClient(), filed)).slice(0, 8) : [];
  return (
    <Card tight labelledBy="ev-h">
      <CardHead id="ev-h" title={<span className="text-[15px]">Coming up</span>} right={<span className="src"><i>SEC</i>filings</span>} />
      {upcoming.length === 0 ? <p className="t-sm">No expected reports in the next {EVENT_WINDOW.upcomingDays} days.</p> : <Rows rows={upcoming} />}
      {recent.length > 0 && (
        <>
          <div className="divider" />
          <span className="t-sm text-ink font-semibold" id="ev-r">Filed recently</span>
          <FilingReviewList items={recent} back="/" />
        </>
      )}
      <p className="t-xs">A date marked &quot;from the research&quot; is the one the research read in the company&apos;s announcement; others are estimates from past filing dates. Filed documents are classified by form and item only; an item clears when your research has read it in full or you mark it reviewed.</p>
    </Card>
  );
}

function Rows({ rows }: { rows: Alert[] }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((a) => (
        <li key={a.id}>
          <Link href={a.href} className="flex items-start gap-2.5 no-underline min-h-11 active:opacity-70">
            <Dot kind={a.severity === "low" ? "hollow" : "solid"} className="mt-[7px]" style={{ color: COLOR[a.severity] }} />
            <span className="flex-1 min-w-0 flex flex-col">
              <span className="t-sm text-ink">{a.title}</span>
              <span className="t-xs line-clamp-2">{a.detail}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function EventsSkeleton() {
  return (
    <Card tight label="Coming up">
      <span className="text-[15px] font-semibold">Coming up</span>
      <Skel w="80%" /><Skel w="65%" /><Skel w="72%" />
    </Card>
  );
}
