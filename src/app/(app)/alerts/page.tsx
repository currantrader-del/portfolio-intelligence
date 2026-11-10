import { ActionForm, SubmitButton } from "@/components/forms";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHead, Disclose, Pill } from "@/components/ui";
import { watchRuns, watchSettings } from "@/lib/watch/job";
import { shortDate } from "@/lib/format";
import { checkNow, feedback, reportMissed, resetTopic, saveAlertPreferences, setEnabled, test } from "./actions";
import { loadAlertPrefs, MOVE_CLASS_LABEL, moveClassOf, DEFAULT_ALERT_PREFS } from "@/lib/watch/priceMoves";
import { getWorkspace } from "@/lib/workspace";
import { loadFeedback, VERDICT_LABEL, type Verdict } from "@/lib/eval/log";

export const dynamic = "force-dynamic";

const time = (iso: string) => `${shortDate(iso)} ${new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET`;
const MSG: Record<string, string> = {
  on: "Phone alerts are on. Subscribe to the topic below in the ntfy app, then send a test.",
  off: "Phone alerts are paused.",
  newtopic: "New topic made. Subscribe to it in the ntfy app and remove the old one.",
  test: "Test sent. It should arrive on your phone within a few seconds.",
  quiet: "Checked just now: nothing new that needs you.",
  feedback: "Thanks: noted for the 30-day evaluation.",
  prefs: "Alert preferences saved. They apply from the next check.",
  missed: "Missed event noted for the 30-day evaluation.",
};

/** Phone alerts: turn on, connect the phone, and see what was sent. */
export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const db = await createClient();
  const [s, runs, { msg }, fb, prefs, ws] = await Promise.all([watchSettings(db), watchRuns(db, 14), searchParams, loadFeedback(db).catch(() => ({ byAlert: new Map<string, Verdict>(), all: [] })), loadAlertPrefs(db).catch(() => DEFAULT_ALERT_PREFS), getWorkspace().catch(() => null)]);
  const kinds = (ws?.portfolio.holdings ?? []).map((h) => ({ symbol: h.symbol, t: prefs.thresholds[moveClassOf(h.symbol, h.bucket, prefs.classOverrides)] }));
  const missed = fb.all.filter((f) => f.verdict === "missed");
  const last = runs[0];
  // Each run's notifications: investment alerts plus price moves that were sent or held for the summary.
  const items = (r: (typeof runs)[number]) => [
    ...r.sent.map((x) => x.alert),
    ...(r.moves ?? []).filter((m) => m.pushed || m.queued).map((m) => ({ id: m.alert.id, symbol: m.alert.symbol, title: `Price move: ${m.alert.title}`, detail: `${m.alert.body}${m.queued ? " (Held for the daily summary.)" : ""}`, href: m.alert.href })),
  ];
  const sent = runs.filter((r) => items(r).length);
  const note = !msg ? null : msg.startsWith("error:") ? { warn: true, text: msg.slice(6) } : msg.startsWith("sent:") ? { warn: false, text: `Checked just now: sent ${msg.slice(5)} alert${msg.slice(5) === "1" ? "" : "s"} to your phone.` } : MSG[msg] ? { warn: false, text: MSG[msg] } : null;

  return (
    <div className="flex flex-col gap-3 lg:gap-4 max-w-3xl">
      <div className="flex flex-col gap-1">
        <span className="cap">Watch for me</span>
        <h1 className="h1">Phone alerts</h1>
        <p className="t-sm">Every 30 minutes while the market is open, the app checks your holdings and the companies you researched and sends two kinds of notification. <b className="text-ink">Price moves</b>: an owned stock or ETF passed your percentage level today. It is information, not a buy or sell signal. <b className="text-ink">Investment alerts</b>: a buy opportunity, an opportunity approaching, a material development (results, reports, financings), an urgent risk, or a trim review. Each says what changed, why it matters, the supported action, what is uncertain and when it was verified. The checks are code; a one-line AI note costs well under a cent and runs only when an investment alert fires.</p>
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

      <Card labelledBy="al-prefs" className="!gap-3">
        <CardHead id="al-prefs" title="What to send" />
        <ActionForm action={saveAlertPreferences} success={null} className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="t-sm text-ink font-semibold">Price moves</legend>
            <label className="flex items-center gap-2 t-sm"><input type="checkbox" name="priceMoves" defaultChecked={prefs.priceMoves} /> Your holdings, when a day&apos;s move passes your level</label>
            <label className="flex items-center gap-2 t-sm"><input type="checkbox" name="watchlistMoves" defaultChecked={prefs.watchlistMoves} /> Watchlist stocks too</label>
            <div className="grid grid-cols-3 gap-2">
              {(["broad_etf", "stock", "speculative"] as const).map((k) => (
                <label key={k} className="field t-xs">{MOVE_CLASS_LABEL[k]} (%)<input name={`t_${k}`} inputMode="decimal" defaultValue={prefs.thresholds[k]} className="input" required /></label>
              ))}
            </div>
            <p className="t-xs">One alert when a move passes the level, another at 2x and 3x, and a fresh start each trading day. A price move is information, not a buy or sell signal.</p>
            {kinds.length > 0 && <p className="t-xs">Your holdings: {kinds.map((k) => `${k.symbol} ${k.t}%`).join(" · ")}</p>}
            <label className="field t-xs">Change a stock&apos;s kind (for example IREN=speculative, NVDA=stock, VHT=etf)<input name="overrides" defaultValue={Object.entries(prefs.classOverrides).map(([s, c]) => `${s}=${c === "broad_etf" ? "etf" : c}`).join(", ")} className="input" /></label>
            <label className="field t-xs">Send price moves<select name="priceDelivery" defaultValue={prefs.priceDelivery} className="input"><option value="immediate">Right away</option><option value="daily">In one summary at about 3:45 PM ET</option></select></label>
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="t-sm text-ink font-semibold">Investment alerts</legend>
            <label className="flex items-center gap-2 t-sm"><input type="checkbox" name="intelligence" defaultChecked={prefs.intelligence} /> Buy opportunity, approaching entry, material development, urgent risk, trim review</label>
            <label className="field t-xs">Send investment alerts<select name="intelligenceDelivery" defaultValue={prefs.intelligenceDelivery} className="input"><option value="immediate">Right away</option><option value="daily">In one summary at about 3:45 PM ET</option></select></label>
          </fieldset>
          <SubmitButton className="btn btn-sm self-start" pendingText="Saving…">Save</SubmitButton>
        </ActionForm>
      </Card>

      <Card labelledBy="al-hist" className="!gap-0" flush>
        <div className="px-4 pt-4 pb-2 lg:px-5"><CardHead id="al-hist" title="Sent in the last two weeks" /></div>
        {!sent.length ? <p className="t-sm px-4 pb-4 lg:px-5">Nothing yet. Quiet is normal: most days nothing needs you.</p> : (
          <ul className="flex flex-col">
            {sent.map((r) => (
              <li key={r.id} className="border-t border-line">
                <Disclose summary={
                  <span className="flex items-center justify-between gap-2 w-full min-w-0">
                    <span className="text-ink truncate">{items(r).length === 1 ? items(r)[0].title : `${items(r).length} alerts: ${[...new Set(items(r).map((x) => x.symbol).filter(Boolean))].join(", ")}`}</span>
                    <span className="t-xs shrink-0">{time(r.at)}{r.pushed || (r.moves ?? []).some((m) => m.pushed) ? "" : r.queued || (r.moves ?? []).some((m) => m.queued) ? " · in the daily summary" : " · not delivered"}</span>
                  </span>
                }>
                  <div className="flex flex-col gap-2 t-sm">
                    {r.summary && <p className="text-ink">{r.summary}</p>}
                    {items(r).map((a) => {
                      const v = fb.byAlert.get(`${r.id}|${a.id}`);
                      return (
                        <div key={a.id} className="flex flex-col gap-1">
                          <a href={a.href} className="text-ink font-semibold">{a.title}</a>
                          <p className="t-xs">{a.detail}</p>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="t-xs">{v ? `Your verdict: ${VERDICT_LABEL[v]}.` : "Was this worth it?"}</span>
                            {(["useful", "false", "repetitive"] as const).map((k) => (
                              <ActionForm key={k} action={feedback} success={null}>
                                <input type="hidden" name="verdict" value={k} /><input type="hidden" name="runId" value={r.id} /><input type="hidden" name="alertId" value={a.id} /><input type="hidden" name="symbol" value={a.symbol ?? ""} />
                                <SubmitButton className={`btn btn-sm ${v === k ? "btn-primary" : ""}`} pendingText="Saving…">{k === "useful" ? "Useful" : k === "false" ? "False" : "Repetitive"}</SubmitButton>
                              </ActionForm>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Disclose>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card labelledBy="al-missed" className="!gap-2">
        <CardHead id="al-missed" title="Missed something?" right={missed.length ? <span className="t-xs">{missed.length} reported</span> : null} />
        <p className="t-xs">If something mattered and no alert came, note it here. It counts in the 30-day evaluation.</p>
        <ActionForm action={reportMissed} success={null} className="flex flex-col gap-2">
          <label className="field">Company (optional)<input name="symbol" maxLength={12} className="input" /></label>
          <label className="field">What was missed<input name="note" required maxLength={500} className="input" /></label>
          <SubmitButton className="btn btn-sm self-start" pendingText="Saving…">Report missed event</SubmitButton>
        </ActionForm>
        {missed.length > 0 && <ul className="t-xs list-disc pl-4">{missed.slice(-5).reverse().map((m) => <li key={m.id}>{shortDate(m.at)}{m.symbol ? ` · ${m.symbol}` : ""} · {m.note}</li>)}</ul>}
      </Card>
    </div>
  );
}
