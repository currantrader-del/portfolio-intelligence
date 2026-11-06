"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Markdown } from "./Markdown";
import { titleOf } from "./shell/nav";

type Evidence = { name: string; input: unknown; ok: boolean; preview: string };
type Msg = { role: "user" | "assistant"; content: string; model?: string; evidence?: Evidence[]; error?: boolean };

const SUGGESTIONS: [RegExp, string[]][] = [
  [/^\/research\/[^/]+/, ["What would change the call?", "Is the research still current?", "What are the biggest risks?"]],
  [/^\/decisions\/review\//, ["Should I trim, hold or add?", "What does the policy say here?"]],
  [/^\/decisions\/new-capital/, ["What is blocking a recommendation?", "What would make this actionable?"]],
  [/^\/portfolio/, ["Am I too concentrated anywhere?", "What is missing before these numbers are verified?"]],
  [/^\/risk/, ["What is my biggest risk?", "How bad could a 20% market drop be?"]],
  [/^\/research/, ["Which research is stale?", "Which ideas are worth researching next?"]],
  [/^\/decisions/, ["Which past decisions have worked out?", "Summarize my open checks"]],
  [/^\/policy/, ["Explain my policy limit conflicts", "Which limits are still placeholders?"]],
  [/^\/$/, ["Why am I up or down today?", "What needs my attention?", "Where should $1,250 go?"]],
];

const TOOL_LABEL: Record<string, string> = {
  get_portfolio: "Portfolio", get_research: "Research", get_policy: "Policy", get_quote: "Quote", simulate_new_capital: "New-cash engine",
  get_filings: "SEC filings", get_fundamentals: "SEC financials", get_news: "Headlines", get_pipeline: "Pipeline", screen_company: "Screen",
  get_risk: "Risk model", get_events: "Company events", get_decisions: "Decisions", get_alerts: "Alerts",
};
const toolLabel = (n: string) => TOOL_LABEL[n] ?? n.replace(/^get_/, "").replace(/_/g, " ");

const STORE = "pi.ask.v1";

function symbolFromPath(path: string): string | null {
  const m = path.match(/^\/(?:research|decisions\/review)\/([A-Za-z0-9.\-]+)/);
  return m ? decodeURIComponent(m[1]).toUpperCase() : null;
}

export function AskPanel() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [deep, setDeep] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const symbol = symbolFromPath(path);

  // The conversation survives navigation (this panel lives in the layout) and a page refresh.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORE);
      if (saved) setMsgs(JSON.parse(saved));
    } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => {
    try { sessionStorage.setItem(STORE, JSON.stringify(msgs.slice(-30))); } catch { /* storage unavailable */ }
  }, [msgs]);

  const close = useCallback(() => { setOpen(false); fabRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === "Escape") setOpen((o) => { if (o) fabRef.current?.focus(); return false; });
    };
    const onOpen = (e: Event) => {
      setOpen(true);
      const q = (e as CustomEvent<string | undefined>).detail;
      if (q) setInput(q);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pi:ask", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pi:ask", onOpen); };
  }, []);
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus({ preventScroll: true });
    // Stop the page behind the sheet from scrolling on phones.
    const prev = document.body.style.overflow;
    if (window.matchMedia("(max-width: 1023px)").matches) document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);
  useEffect(() => { if (open) endRef.current?.scrollIntoView({ block: "end" }); }, [msgs, busy, open]);
  useEffect(() => {
    const t = inputRef.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(140, t.scrollHeight)}px`;
  }, [input, open]);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: question }];
    setMsgs(next);
    setInput("");
    setBusy("Thinking");
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.filter((m) => !m.error).map(({ role, content }) => ({ role, content })), page: path, symbol, deep }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        setMsgs([...next, { role: "assistant", content: j.error ?? "The assistant is unavailable right now.", error: true }]);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "status") setBusy(ev.text);
          if (ev.type === "answer") {
            const evidence: Evidence[] = ev.evidence ?? (ev.tools ?? []).map((name: string) => ({ name, input: null, ok: true, preview: "" }));
            setMsgs([...next, { role: "assistant", content: ev.text, model: String(ev.model ?? ""), evidence }]);
          }
          if (ev.type === "error") setMsgs([...next, { role: "assistant", content: ev.text, error: true }]);
        }
      }
    } catch {
      setMsgs([...next, { role: "assistant", content: "Network error. Try again.", error: true }]);
    } finally {
      setBusy(null);
    }
  }

  const suggestions = SUGGESTIONS.find(([re]) => re.test(path))?.[1] ?? SUGGESTIONS[SUGGESTIONS.length - 1][1];
  const context = symbol ? `Company · ${symbol}` : titleOf(path);

  return (
    <>
      {!open && (
        <button ref={fabRef} type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={symbol ? `Ask about ${symbol}` : "Ask the assistant"}
          className="fixed z-40 right-4 lg:right-6 bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+14px)] lg:bottom-6 h-12 px-[18px] rounded-full bg-ink text-ground font-semibold inline-flex items-center gap-2 shadow-[0_8px_24px_rgba(0,0,0,.5)] hover:bg-white active:scale-[0.98] transition-transform">
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 15l-1 3 3.5-1.5A7 7 0 1 0 4 15z" /></svg>
          {symbol ? `Ask about ${symbol}` : "Ask"}
          <span className="hidden lg:inline text-xs font-medium opacity-60">⌘J</span>
        </button>
      )}
      {open && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Assistant">
          <button type="button" aria-label="Close assistant" tabIndex={-1} className="absolute inset-0 bg-black/50 lg:bg-black/30 animate-[fade_150ms_ease]" onClick={close} />
          <section className="absolute inset-x-0 bottom-0 top-[max(56px,env(safe-area-inset-top))] lg:inset-y-0 lg:left-auto lg:right-0 lg:top-0 lg:w-[440px] bg-surface border border-line lg:border-y-0 lg:border-r-0 rounded-t-[22px] lg:rounded-none flex flex-col animate-[rise_200ms_ease-out] lg:animate-[slide_180ms_ease-out]">
            <div className="flex justify-center pt-2 pb-1 lg:hidden" aria-hidden="true"><span className="w-10 h-[5px] rounded-full bg-line-strong" /></div>
            <div className="flex items-center justify-between gap-3 px-4 pb-2.5 lg:pt-4 border-b border-line">
              <div className="min-w-0">
                <div className="font-semibold">Ask</div>
                <div className="t-xs">Knows this page · conversation kept while you browse</div>
              </div>
              <div className="flex items-center">
                {msgs.length > 0 && <button type="button" onClick={() => setMsgs([])} className="btn btn-ghost btn-sm">New chat</button>}
                <button type="button" onClick={close} className="btn btn-ghost btn-sm min-h-10 w-10 px-0" aria-label="Close assistant">
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3.5 flex flex-col gap-3.5" aria-live="polite">
              <div className="flex flex-wrap gap-1.5">
                <span className={`pill ${symbol ? "pill-copper" : ""}`}>{context}</span>
                <span className="pill">Portfolio included</span>
              </div>
              {msgs.map((m, i) => (
                m.role === "user" ? (
                  <div key={i} className="self-end max-w-[85%] bg-surface-2 rounded-[16px_16px_4px_16px] px-3 py-2.5 whitespace-pre-wrap">{m.content}</div>
                ) : (
                  <div key={i} className="flex flex-col gap-2.5">
                    <div className={`text-[15px] leading-relaxed ${m.error ? "text-warn-ink" : ""}`}><Markdown text={m.content} /></div>
                    {!m.error && (
                      <div className="flex flex-wrap gap-1.5">
                        <span className="src"><i>{m.model?.includes("opus") ? "Deep review" : "Standard"}</i>AI judgment</span>
                        {[...new Set((m.evidence ?? []).map((e) => e.name))].map((n) => <span key={n} className="src"><i>{toolLabel(n)}</i></span>)}
                      </div>
                    )}
                    {!!m.evidence?.length && (
                      <details className="disclose">
                        <summary className="!min-h-9 text-[13px]"><span>Show evidence ({m.evidence.length} tool result{m.evidence.length > 1 ? "s" : ""})</span><svg className="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg></summary>
                        <ol className="disclose-body text-xs">
                          {m.evidence.map((e, j) => (
                            <li key={j} className="card card-tight bg-surface-2 gap-1">
                              <div className="flex justify-between gap-2"><span className="font-semibold text-ink-2">{toolLabel(e.name)}</span><span className={e.ok ? "text-muted" : "text-warn-ink"}>{e.ok ? "returned data" : "failed"}</span></div>
                              {e.input != null && Object.keys(e.input as object).length > 0 && <code className="text-muted break-all">{JSON.stringify(e.input)}</code>}
                              {e.preview && <pre className="whitespace-pre-wrap break-all text-muted max-h-40 overflow-auto font-sans">{e.preview}{e.preview.length >= 1200 ? "…" : ""}</pre>}
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </div>
                )
              ))}
              {busy && (
                <div className="flex items-center gap-2 t-sm" role="status">
                  <span className="inline-flex gap-1" aria-hidden="true">{[0, 1, 2].map((d) => <span key={d} className="w-1.5 h-1.5 rounded-full bg-muted animate-pulse" style={{ animationDelay: `${d * 150}ms` }} />)}</span>
                  {busy}…
                </div>
              )}
              {!busy && (
                <div className="flex flex-wrap gap-2">
                  {suggestions.map((s) => <button key={s} type="button" onClick={() => ask(s)} className="chip text-left h-auto min-h-9 py-1.5 whitespace-normal">{s}</button>)}
                </div>
              )}
              <div ref={endRef} />
            </div>

            <form className="border-t border-line px-3 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom))] flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
              <div className="flex gap-2 items-end">
                <label htmlFor="ask-input" className="sr-only">Message</label>
                <textarea id="ask-input" ref={inputRef} rows={1} value={input} onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input); } }}
                  placeholder={symbol ? `Ask about ${symbol} or your portfolio` : "Ask about your portfolio"}
                  className="input flex-1 resize-none rounded-[14px] py-[11px] leading-snug" />
                <button type="submit" disabled={!!busy || !input.trim()} aria-label="Send" className="btn btn-primary w-11 px-0 shrink-0">
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4" /></svg>
                </button>
              </div>
              <label className="t-xs inline-flex items-center gap-2 min-h-8">
                <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} className="w-[18px] h-[18px] accent-[var(--accent)]" /> Think harder (slower, uses the larger model)
              </label>
            </form>
          </section>
        </div>
      )}
    </>
  );
}

/** Opens the assistant with a question prefilled. */
export function AskButton({ question, children, className }: { question: string; children: React.ReactNode; className?: string }) {
  return (
    <button type="button" className={className} onClick={() => window.dispatchEvent(new CustomEvent("pi:ask", { detail: question }))}>
      {children}
    </button>
  );
}
