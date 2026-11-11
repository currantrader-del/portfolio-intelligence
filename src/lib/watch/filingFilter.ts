/**
 * Which SEC filings are worth a phone push. A filing is pushed only when it is new and nobody has read it:
 *  - research that read it in full or in part (an investigation's document list) covers it;
 *  - a filing you marked "reviewed, no change" is done;
 *  - a debt offering (read from the cover page) does not change a thesis by itself;
 *  - a filing first seen more than a few days after it was filed is not news any more: it stays listed on the
 *    Events page and in the brief, but does not buzz the phone (Nov 10 pushed six filings from Nov 3-5).
 */
import type { Alert } from "@/lib/alerts/rules";
import { accFromUrl, accKey, type ReviewState } from "@/lib/alerts/review";

export const FILING_PUSH_MAX_DAYS = 3;

export function filingsToPush(alerts: Alert[], state: ReviewState, now: Date, maxDays = FILING_PUSH_MAX_DAYS): Alert[] {
  const today = now.toISOString().slice(0, 10);
  const cutoff = new Date(now.getTime() - maxDays * 86_400_000).toISOString().slice(0, 10);
  return alerts.filter((a) => {
    if (!a.source || a.timing === "upcoming") return true;
    const acc = accKey(accFromUrl(a.source.url) ?? a.id.split("-").slice(3).join("-"));
    if (acc && (state.covered.has(acc) || state.reviewed.has(acc))) return false;
    if (a.source.form.startsWith("424B") && state.offerings.get(acc) === "debt") return false;
    const filed = a.source.filed;
    return !filed || (filed >= cutoff && filed <= today);
  });
}
