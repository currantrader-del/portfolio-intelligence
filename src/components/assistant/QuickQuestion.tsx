"use client";

import { useEffect, useRef, useState } from "react";
import { AnswerView } from "@/components/AnswerView";
import { Spinner } from "@/components/forms";
import { requestJSON } from "@/lib/client/request";

export type StoredAnswer = { question: string; answer: string; at: string; ms: number; costUsd: number; searches: number } | null;

/** One saved question: editable text, an Ask button, and its latest answer (summary first, full analysis collapsed). */
export function QuickQuestion({ slot, initial, last }: { slot: number; initial: string; last: StoredAnswer }) {
  const [q, setQ] = useState(initial);
  const [ans, setAns] = useState<StoredAnswer>(last);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function ask() {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true); setError(null);
    const r = await requestJSON<{ requestId?: string }>("/api/ask", { json: { messages: [{ role: "user", content: question }], page: "/assistant", slot } });
    const j = r.data;
    if (!r.ok || !j.requestId) { setBusy(false); setError(r.ok ? "The question didn't start. Try again." : r.error); return; }
    const started = Date.now();
    const poll = async () => {
      const r = await fetch(`/api/ask?id=${j.requestId}`, { cache: "no-store" }).then((x) => x.json()).catch(() => null) as { status?: string; answer?: { answer?: string; error?: string; ms?: number; costUsd?: number; searches?: number } } | null;
      if (r?.status === "done") {
        setBusy(false);
        if (r.answer?.error || !r.answer?.answer) setError(r.answer?.error ?? "No answer came back.");
        else setAns({ question, answer: r.answer.answer, at: new Date().toISOString(), ms: r.answer.ms ?? Date.now() - started, costUsd: r.answer.costUsd ?? 0, searches: r.answer.searches ?? 0 });
        return;
      }
      if (Date.now() - started > 12 * 60_000) { setBusy(false); setError("This is taking too long. Try again later."); return; }
      timer.current = setTimeout(poll, 3000);
    };
    timer.current = setTimeout(poll, 3000);
  }

  return (
    <section className="card !gap-3" aria-label={`Question ${slot + 1}`}>
      <label className="field">
        <span className="sr-only">Question</span>
        <textarea id={`quick-q-${slot}`} className="input min-h-[92px] py-2 leading-snug resize-y" value={q} onChange={(e) => setQ(e.target.value)} maxLength={1000} rows={3} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={`btn btn-sm btn-primary ${busy ? "is-pending" : ""}`} onClick={ask} disabled={busy || !q.trim()} aria-busy={busy || undefined}>{busy ? <><Spinner />Thinking… (1–4 min)</> : ans ? "Ask again" : "Ask"}</button>
        {q !== initial && !busy && <button type="button" className="btn btn-sm" onClick={() => setQ(initial)}>Reset</button>}
        {ans && !busy && <span className="t-xs">Last answer {new Date(ans.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {Math.round(ans.ms / 1000)}s · ${ans.costUsd.toFixed(2)}</span>}
      </div>
      {error && <p role="alert" className="form-note form-note-error">{error}</p>}
      {ans && (
        <div className="flex flex-col gap-1 border-t border-line pt-3">
          {ans.question !== q && <span className="t-xs">Answer to: “{ans.question}”</span>}
          <AnswerView text={ans.answer} />
        </div>
      )}
    </section>
  );
}
