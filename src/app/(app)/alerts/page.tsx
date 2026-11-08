import { ActionForm, SubmitButton } from "@/components/forms";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHead, Disclose, Pill } from "@/components/ui";
import { watchRuns, watchSettings } from "@/lib/watch/job";
import { shortDate } from "@/lib/format";
import { checkNow, resetTopic, setEnabled, test } from "./actions";

export const dynamic = "force-dynamic";

const time = (iso: string) => `${shortDate(iso)} ${new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET`;
const MSG: Record<string, string> = {
  on: "Phone alerts are on. Subscribe to the topic below in the ntfy app, then send a test.",
  off: "Phone alerts are paused.",
  newtopic: "New topic made. Subscribe to it in the ntfy app and remove the old one.",
  test: "Test sent. It should arrive on your phone within a few seconds.",
  quiet: "Checked just now: nothing new that needs you.",
};

/** Phone alerts: turn on, connect the phone, and see what was sent. */
export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const db = await createClient();
  const [s, runs, { msg }] = await Promise.all([watchSettings(db), watchRuns(db, 14), searchParams]);
  const last = runs[0];
  const sent = runs.filter((r) => r.sent.length);
  const note = !msg ? null : msg.startsWith("error:") ? { warn: true, text: msg.slice(6) } : msg.startsWith("sent:") ? { warn: false, text: `Checked just now: sent ${msg.slice(5)} alert${msg.slice(5) === "1" ? "" : "s"} to your phone.` } : MSG[msg] ? { warn: false, text: MSG[msg] } : null;

  return (
    <div className="flex flex-col gap-3 lg:gap-4 max-w-3xl">
      <div className="flex flex-col gap-1">
        <span className="cap">Watch for me</span>
        <h1 className="h1">Phone alerts</h1>
        <p className="t-sm">Every 30 minutes while the market is open, the app checks your holdings and the companies you researched. It sends a notification only when something needs a look: a big move against the market, a price reaching one of your research bands, a position over its limit, or a new filing such as results or an offering. Each alert comes once, with one line on whether it touches your thesis. The checks are code; the AI line costs well under a cent and only runs when something fires.</p>
      </div>

      {note && <p role={note.warn ? "alert" : "status"} className={`t-sm ${note.warn ? "warn" : "text-ink"}`}>{note.text}</p>}

      <Card labelledBy="al-set" className="!gap-3">
        <CardHead id="al-set" title="Your phone" right={<Pill small tone={s.enabled ? "gain" : "neutral"}>{s.enabled ? "On" : s.topic ? "Paused" : "Off"}</Pill>} />
        {!s.topic ? (
          <ActionForm action={setEnabled} success={null}><input type="hidden" name="on" value="1" /><SubmitButton className="btn btn-primary" pendingText="Turning on…">Turn on phone alerts</SubmitButton></ActionForm>
        ) : (
          <>
            <ol className="list-decimal pl-5 flex flex-col gap-1.5 t-sm text-ink">
              <li>Install the free <span className="font-semibold">ntfy</span> app (<a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noreferrer">iPhone</a> or <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noreferrer">Android</a>). No account needed.</li>
              <li>Tap <span className="font-semibold">+</span> and subscribe to this topic (leave the server as ntfy.sh):
                <div className="mt-1 px-3 py-2 rounded-lg border border-line bg-surface-2 font-mono text-[15px] select-all break-all">{s.topic}</div>
              </li>
              <li>Send a test below. If it arrives, you are done.</li>
            </ol>
            <div className="flex flex-wrap gap-2">
              <ActionForm action={test} success={null}><SubmitButton className="btn btn-sm btn-primary" pendingText="Sending…">Send a test</SubmitButton></ActionForm>
              <ActionForm action={checkNow} success={null}><SubmitButton className="btn btn-sm" pendingText="Checking…">Check now</SubmitButton></ActionForm>
              <ActionForm action={setEnabled} success={null}><input type="hidden" name="on" value={s.enabled ? "0" : "1"} /><SubmitButton className="btn btn-sm" pendingText={s.enabled ? "Pausing…" : "Resuming…"}>{s.enabled ? "Pause alerts" : "Resume alerts"}</SubmitButton></ActionForm>
            </div>
            <ActionForm action={resetTopic} success={null} className="t-xs">Keep the topic private: anyone who knows it can read these notifications. If it leaks, <SubmitButton className="underline min-h-11 px-1 -mx-1" pendingText="making a new topic…">make a new topic</SubmitButton>.</ActionForm>
          </>
        )}
        {last && <p className="t-xs">Last check {time(last.at)}{last.trigger === "manual" ? " (by you)" : ""}{last.error ? ` · could not send: ${last.error}` : ""}</p>}
      </Card>

      <Card labelledBy="al-hist" className="!gap-0" flush>
        <div className="px-4 pt-4 pb-2 lg:px-5"><CardHead id="al-hist" title="Sent in the last two weeks" /></div>
        {!sent.length ? <p className="t-sm px-4 pb-4 lg:px-5">Nothing yet. Quiet is normal: most days nothing needs you.</p> : (
          <ul className="flex flex-col">
            {sent.map((r) => (
              <li key={r.id} className="border-t border-line">
                <Disclose summary={
                  <span className="flex items-center justify-between gap-2 w-full min-w-0">
                    <span className="text-ink truncate">{r.sent.length === 1 ? r.sent[0].alert.title : `${r.sent.length} alerts: ${[...new Set(r.sent.map((x) => x.alert.symbol).filter(Boolean))].join(", ")}`}</span>
                    <span className="t-xs shrink-0">{time(r.at)}{r.pushed ? "" : " · not delivered"}</span>
                  </span>
                }>
                  <div className="flex flex-col gap-2 t-sm">
                    {r.summary && <p className="text-ink">{r.summary}</p>}
                    {r.sent.map(({ alert: a }) => (
                      <div key={a.id}>
                        <a href={a.href} className="text-ink font-semibold">{a.title}</a>
                        <p className="t-xs">{a.detail}</p>
                      </div>
                    ))}
                  </div>
                </Disclose>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
