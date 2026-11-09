import Link from "next/link";
import type { EventItem } from "@/lib/alerts/review";
import { markReviewed } from "@/app/(app)/events/actions";
import { SubmitButton } from "@/components/forms";
import { shortDate } from "@/lib/format";

const TONE = { high: "pill-alert", medium: "pill-warn", low: "" } as const;

/**
 * Filed-recently items as review items: tap to open what it is, what it could change, the SEC
 * documents, and two choices (mark reviewed, or update the research, which shows its cost first).
 * Items the research already read, or that were marked reviewed, are folded away underneath.
 */
export function FilingReviewList({ items, back }: { items: EventItem[]; back: string }) {
  const open = items.filter((i) => i.timing === "recent" && i.status === "to_review");
  const done = items.filter((i) => i.timing === "recent" && i.status !== "to_review");
  return (
    <div className="flex flex-col gap-2">
      {open.length === 0 && <p className="t-sm">Nothing filed recently needs your review.</p>}
      {open.map((i) => <ReviewItem key={i.key} item={i} back={back} />)}
      {done.length > 0 && (
        <details className="group">
          <summary className="t-sm cursor-pointer min-h-11 flex items-center">Already covered or reviewed ({done.length})</summary>
          <ul className="flex flex-col gap-2 pt-1">
            {done.map((i) => (
              <li key={i.key} className="t-sm flex flex-col">
                <span className="text-ink">{i.title}</span>
                <span className="t-xs">{i.status === "covered" ? `Read in full by ${i.coveredBy}.` : "You marked it reviewed, no change."} {i.filings.map((f, n) => <a key={f.accession || n} href={f.url} target="_blank" rel="noreferrer" className="mr-2">{f.form} on SEC</a>)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ReviewItem({ item: i, back }: { item: EventItem; back: string }) {
  return (
    <details className="bg-surface border border-line rounded-2xl group">
      <summary className="p-4 cursor-pointer list-none flex flex-col gap-1 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center justify-between gap-3">
          <span className="font-semibold text-ink">{i.title}</span>
          <span className={`pill pill-sm ${TONE[i.severity]}`}>TO REVIEW</span>
        </span>
        <span className="text-sm text-ink-2">{i.detail}</span>
        <span className="t-xs group-open:hidden">Tap to review</span>
      </summary>
      <div className="px-4 pb-4 flex flex-col gap-3 border-t border-line pt-3">
        <p className="t-sm text-ink"><span className="font-semibold">What it could change: </span>{i.couldChange}</p>
        <ul className="flex flex-col gap-1">
          {i.filings.map((f, n) => (
            <li key={f.accession || n} className="t-sm"><a href={f.url} target="_blank" rel="noreferrer">Open the {f.form} on SEC.gov</a> <span className="t-xs">filed {shortDate(f.filed)}</span></li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <form action={markReviewed}>
            <input type="hidden" name="symbol" value={i.symbol} />
            <input type="hidden" name="accessions" value={i.filings.map((f) => f.accession).join(",")} />
            <input type="hidden" name="back" value={back} />
            <SubmitButton className="btn btn-sm" pendingText="Saving…">Reviewed, no change</SubmitButton>
          </form>
          <Link href={`/research/${i.symbol}#inv-h`} className="btn btn-sm">Update research with it</Link>
        </div>
        <p className="t-xs">&ldquo;Reviewed&rdquo; is free and just clears this item. &ldquo;Update research&rdquo; opens {i.symbol}&apos;s research, which shows what an update would read and its cost before anything runs; nothing replaces your research until you approve it. For a quick question, use Ask.</p>
      </div>
    </details>
  );
}
