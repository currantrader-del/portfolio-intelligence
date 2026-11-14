"use client";

import { useState, type FormEvent } from "react";
import { Spinner } from "@/components/forms";
import { Card, CardHead } from "@/components/ui";
import { shortDate } from "@/lib/format";

type Opt = { id: string; research_as_of: string } | null;

/**
 * "Share full research": downloads the complete saved investigation as a PDF for someone else, with
 * holdings, cost basis, cash, savings, limits and account details removed. Nothing is re-run.
 */
export function ShareResearchCard({ symbol, latest, approved }: { symbol: string; latest: Opt; approved: Opt }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!latest && !approved) return null;

  // The server sends the redacted report; the PDF is drawn here in the browser (no server time limit).
  async function download(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const version = String(new FormData(e.currentTarget).get("version") ?? "latest");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/share-pdf/${encodeURIComponent(symbol)}?version=${version}&format=json`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.text()).slice(0, 400) || `The server answered ${res.status}.`);
      const report = await res.json();
      // Built separately (scripts/build-share-pdf.mjs) and loaded outside the Next.js bundle on purpose:
      // bundling the PDF engine into the app stalled every page of the live site.
      const src = "/share-pdf/renderer.js";
      const { renderSharePdfBlob } = (await import(/* webpackIgnore: true */ src)) as { renderSharePdfBlob: (r: unknown) => Promise<Blob> };
      const blob = await renderSharePdfBlob(report);
      const date = (report.facts as [string, string][]).find((f) => f[0] === "Research date")?.[1] ?? "";
      const iso = /\d{4}/.test(date) ? new Date(`${date} UTC`).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${symbol}-research-${iso}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError((err as Error).message || "The PDF could not be made.");
    } finally {
      setBusy(false);
    }
  }

  const same = !!latest && !!approved && latest.id === approved.id;
  return (
    <Card labelledBy="share-h" className="!gap-2">
      <CardHead id="share-h" cap="Share full research" />
      <form onSubmit={download} className="flex flex-col gap-2">
        {same || !approved || !latest ? (
          <>
            <input type="hidden" name="version" value={latest ? "latest" : "approved"} />
            <p className="t-sm">{latest ? `Most recent full investigation, ${shortDate(latest.research_as_of)}` : `Approved research, ${shortDate(approved!.research_as_of)}`}{same ? " (also your approved research)" : approved ? "" : " · not approved"}</p>
          </>
        ) : (
          <fieldset className="flex flex-col gap-1.5 t-sm">
            <label className="flex items-start gap-2"><input type="radio" name="version" value="latest" defaultChecked className="mt-1" /><span>Most recent investigation, {shortDate(latest.research_as_of)} <span className="t-xs">· not approved</span></span></label>
            <label className="flex items-start gap-2"><input type="radio" name="version" value="approved" className="mt-1" /><span>Approved research, {shortDate(approved.research_as_of)}</span></label>
          </fieldset>
        )}
        <button type="submit" disabled={busy} aria-busy={busy || undefined} className={`btn btn-sm self-start ${busy ? "is-pending" : ""}`}>{busy ? <><Spinner />Making PDF…</> : "Download PDF"}</button>
        {error && <p className="t-sm text-loss" role="alert">{error} Nothing was shared.</p>}
        <p className="t-xs">The complete saved research: all six phases, valuation workings, skeptical review, reviewer corrections and sources. Your holdings, share counts, cost basis, cash, savings, limits and account details are removed and marked. Built from saved data only, with no AI cost.</p>
      </form>
    </Card>
  );
}
