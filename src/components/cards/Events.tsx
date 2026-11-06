import Link from "next/link";
import { loadEventAlerts } from "@/lib/alerts/events";
import { Card, CardHead, Dot, Skel } from "@/components/ui";

const ORDER = { high: 0, medium: 1, low: 2 };
const COLOR = { high: "var(--loss)", medium: "var(--warn-ink)", low: "var(--muted)" };

/** Market Event card: filings and expected reports for held stocks. Streams in after the page. */
export async function EventsCard({ symbols, now }: { symbols: string[]; now: Date }) {
  const { alerts } = await loadEventAlerts(symbols, now);
  const rows = [...alerts].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]).slice(0, 6);
  return (
    <Card tight labelledBy="ev-h">
      <CardHead id="ev-h" title={<span className="text-[15px]">Coming up</span>} right={<span className="src"><i>SEC</i>filings</span>} />
      {rows.length === 0 ? (
        <p className="t-sm">No new filings or expected reports in the next 10 days.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {rows.map((a) => (
            <li key={a.id}>
              <Link href={a.href} className="flex items-start gap-2.5 no-underline min-h-9">
                <Dot kind={a.severity === "low" ? "hollow" : "solid"} className="mt-[7px]" style={{ color: COLOR[a.severity] }} />
                <span className="flex-1 min-w-0 flex flex-col">
                  <span className="t-sm text-ink">{a.title}</span>
                  <span className="t-xs line-clamp-2">{a.detail}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="t-xs">Report dates marked expected are estimates from past filing dates.</p>
    </Card>
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
