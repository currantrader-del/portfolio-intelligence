import Link from "next/link";
import { loadEventAlerts } from "@/lib/alerts/events";
import { Tag } from "@/components/Tag";

const TONE = { high: "alert", medium: "warn", low: "neutral" } as const;

/** Filing-driven events for held stocks. Streams in so Today renders even if SEC is slow. */
export async function EventAlerts({ symbols, now }: { symbols: string[]; now: Date }) {
  const { alerts } = await loadEventAlerts(symbols, now);
  if (!alerts.length) return null;
  const order = { high: 0, medium: 1, low: 2 };
  return (
    <section aria-labelledby="ev-h" className="flex flex-col gap-2">
      <h2 id="ev-h" className="text-lg font-semibold">Company events</h2>
      {alerts.sort((a, b) => order[a.severity] - order[b.severity]).map((a) => (
        <Link key={a.id} href={a.href} className="bg-surface border border-line rounded-2xl p-4 no-underline text-ink hover:border-line-strong flex flex-col gap-1">
          <div className="flex items-center justify-between gap-3"><span className="font-semibold">{a.title}</span><Tag tone={TONE[a.severity]}>{a.severity === "low" ? "UPCOMING" : a.severity.toUpperCase()}</Tag></div>
          <span className="text-sm text-ink-2">{a.detail}</span>
        </Link>
      ))}
      <p className="text-xs text-muted">From SEC filings. Report dates marked expected are estimates.</p>
    </section>
  );
}
