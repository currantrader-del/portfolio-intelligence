import Link from "next/link";
import type { Alert } from "@/lib/alerts/rules";
import { Chevron, Dot } from "@/components/ui";

const SEV_COLOR = { high: "var(--loss)", medium: "var(--warn-ink)", low: "var(--muted)" } as const;

/** One alert as a tappable row: severity dot, title, one line of detail, chevron. */
export function AlertRow({ a, wrap }: { a: Alert; wrap?: boolean }) {
  return (
    <Link href={a.href} className="li">
      <Dot kind={a.severity === "low" ? "hollow" : "solid"} style={{ color: SEV_COLOR[a.severity] }} />
      <span className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="font-semibold leading-snug">{a.title}</span>
        <span className={`t-xs ${wrap ? "" : "truncate"}`}>{a.detail}</span>
      </span>
      <span className="sr-only">{a.severity === "high" ? "High priority" : a.severity === "medium" ? "Medium priority" : "Routine"}</span>
      <Chevron />
    </Link>
  );
}

export function AlertList({ alerts, wrap }: { alerts: Alert[]; wrap?: boolean }) {
  return <div className="list">{alerts.map((a) => <AlertRow key={a.id} a={a} wrap={wrap} />)}</div>;
}
