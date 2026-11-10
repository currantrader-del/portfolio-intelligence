import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardHead, Pill } from "@/components/ui";
import { shortDate } from "@/lib/format";
import type { Connection } from "@/lib/schwab/client";
import type { SyncResult } from "@/lib/schwab/sync";
import { disconnectSchwab, syncSchwabNow } from "@/app/(app)/portfolio/actions";

const NOTE: Record<string, string> = {
  connected: "Schwab is connected and your positions were synced.",
  connected_sync_failed: "Schwab is connected, but the first sync failed. Try Sync now.",
  signin_failed: "Schwab sign-in did not finish. Try Connect again; if it keeps failing, check that the app shows Ready For Use on Schwab's dashboard.",
  state_mismatch: "The sign-in link expired or was opened twice. Tap Connect again.",
  not_configured: "Schwab keys are not in Netlify yet (SCHWAB_APP_KEY and SCHWAB_APP_SECRET).",
};
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** Read-only Schwab connection: status, the weekly sign-in, the last sync. */
export function SchwabCard({ c, last, note }: { c: Connection; last: SyncResult | null; note?: string }) {
  const tone = c.connected ? (c.daysLeft !== null && c.daysLeft < 1.5 ? "warn" : "gain") : "neutral";
  return (
    <Card labelledBy="sw-h" className="lg:col-span-12 !gap-2">
      <CardHead id="sw-h" title="Schwab connection" right={<Pill small tone={tone}>{c.connected ? "Connected · read-only" : c.configured ? "Not connected" : "Not set up"}</Pill>} />
      {note && NOTE[note] && <p role="status" className="t-sm">{NOTE[note]}</p>}
      <p className="t-xs">Reads your Schwab balances, cash and positions each weekday morning. It cannot trade: the app only makes read requests, and the Schwab app has an order limit of 0. Schwab asks you to sign in again every 7 days.</p>
      {c.connected && c.expiresAt && <p className="t-sm">Sign-in expires {shortDate(c.expiresAt)} ({c.daysLeft} days left).</p>}
      {last && (
        <p className="t-sm">Last sync {shortDate(last.at)}: {last.ok ? last.synced.map((s) => `${s.account}, ${s.positions} positions, cash ${usd(s.cash)}`).join("; ") : `failed (${last.error})`}
          {last.unmatched ? ` · ${last.unmatched} Schwab account not matched` : ""}{last.skipped.length ? ` · skipped ${last.skipped.join(", ")}` : ""}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {c.configured && <a href="/api/schwab/connect" className="btn btn-sm">{c.connected ? "Sign in again" : "Connect Schwab"}</a>}
        {c.connected && <ActionForm action={syncSchwabNow} success="Synced from Schwab"><SubmitButton className="btn btn-sm" pendingText="Syncing…">Sync now</SubmitButton></ActionForm>}
        {c.connected && <ActionForm action={disconnectSchwab} success="Disconnected"><SubmitButton className="btn btn-sm" pendingText="Disconnecting…">Disconnect</SubmitButton></ActionForm>}
      </div>
    </Card>
  );
}
